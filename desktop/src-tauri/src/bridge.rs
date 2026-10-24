//! Where the containers reach this computer, on Linux with Docker Engine.
//!
//! A container reaches the host as `host.docker.internal`, which Docker maps to the default bridge's
//! gateway (`docker0`, usually 172.17.0.1). Docker Desktop on macOS and Windows carries that traffic
//! to the host's loopback for us; Docker Engine on Linux does not, so a program listening on
//! `127.0.0.1` cannot be reached from a container at all. The model on this computer listens there,
//! and every employee on a Linux box answered "could not reach the model provider".
//!
//! Listening on every interface instead would make the model, and the desktop server that treats
//! every request as its one administrator, reachable from the whole local network. So each stays on
//! loopback, and this relays the bridge's address to it: reachable from the containers on this
//! machine, from nothing else.

use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crate::engine::{Address, Engine};

/// The address containers use for this computer, when that needs relaying: Docker Engine on Linux.
///
/// None everywhere else, and whenever the answer cannot be read; the caller then keeps the earlier
/// behaviour rather than guessing an address.
pub fn gateway(address: &Address) -> Option<Ipv4Addr> {
    if !cfg!(target_os = "linux") || address.engine != Engine::Docker {
        return None;
    }
    let output = address
        .command()
        .args([
            "network",
            "inspect",
            "bridge",
            "--format",
            "{{range .IPAM.Config}}{{.Gateway}} {{end}}",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_gateway(&String::from_utf8_lossy(&output.stdout))
}

fn parse_gateway(text: &str) -> Option<Ipv4Addr> {
    text.split_whitespace()
        .filter_map(|word| word.parse::<Ipv4Addr>().ok())
        .find(|ip| !ip.is_loopback() && !ip.is_unspecified())
}

/// A relay from one address to a port on this computer's loopback, stopped when dropped.
pub struct Forwarder {
    stop: Arc<AtomicBool>,
    pub listening: SocketAddr,
}

impl Drop for Forwarder {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// Relay `listen_ip:port` to `127.0.0.1:port`.
///
/// Fails when the address is not this machine's (Docker Desktop on Linux keeps the bridge inside its
/// own VM) or the port there is taken; the caller then keeps the earlier behaviour.
pub fn forward(listen_ip: Ipv4Addr, port: u16) -> io::Result<Forwarder> {
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(listen_ip), port))?;
    listener.set_nonblocking(true)?;
    let listening = listener.local_addr()?;
    let target = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let stop = Arc::new(AtomicBool::new(false));
    let stopping = stop.clone();
    thread::Builder::new()
        .name(format!("bridge-{port}"))
        .spawn(move || {
            while !stopping.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((client, _)) => {
                        let _ = client.set_nonblocking(false);
                        thread::spawn(move || relay(client, target));
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(50));
                    }
                    Err(_) => thread::sleep(Duration::from_millis(200)),
                }
            }
        })?;
    Ok(Forwarder { stop, listening })
}

fn relay(client: TcpStream, target: SocketAddr) {
    let Ok(upstream) = TcpStream::connect_timeout(&target, Duration::from_secs(5)) else {
        let _ = client.shutdown(Shutdown::Both);
        return;
    };
    let _ = client.set_nodelay(true);
    let _ = upstream.set_nodelay(true);
    let (Ok(client_reader), Ok(upstream_reader)) = (client.try_clone(), upstream.try_clone())
    else {
        return;
    };
    let outbound = thread::spawn(move || pump(client_reader, upstream));
    pump(upstream_reader, client);
    let _ = outbound.join();
}

/// Copy until either side closes, then close the other's writing half so it sees the end too.
fn pump(mut from: TcpStream, mut to: TcpStream) {
    let mut buffer = [0u8; 16 * 1024];
    loop {
        match from.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                if to.write_all(&buffer[..read]).is_err() {
                    break;
                }
            }
        }
    }
    let _ = to.shutdown(Shutdown::Write);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bridge_gateway_is_read_from_dockers_answer() {
        assert_eq!(
            parse_gateway("172.17.0.1 \n"),
            Some(Ipv4Addr::new(172, 17, 0, 1))
        );
        assert_eq!(
            parse_gateway("fd00::1 172.18.0.1 "),
            Some(Ipv4Addr::new(172, 18, 0, 1))
        );
        assert_eq!(parse_gateway(""), None);
        assert_eq!(parse_gateway("<no value>"), None);
        assert_eq!(parse_gateway("127.0.0.1 0.0.0.0"), None);
    }

    #[test]
    fn traffic_to_the_relay_reaches_the_loopback_service_and_back() {
        // A service on loopback, as the model and the desktop server are.
        let service = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = service.local_addr().unwrap().port();
        thread::spawn(move || {
            for stream in service.incoming().take(2) {
                let mut stream = stream.unwrap();
                let mut asked = [0u8; 4];
                stream.read_exact(&mut asked).unwrap();
                stream.write_all(&[asked, *b"-ok!"].concat()).unwrap();
            }
        });
        // A second loopback address stands in for the bridge, which a test machine does not have:
        // the relay listens there on the same port and hands the connection to 127.0.0.1.
        let relay = forward(Ipv4Addr::new(127, 0, 0, 2), port).expect("relay");
        assert_eq!(relay.listening.port(), port);
        for _ in 0..2 {
            let mut client = TcpStream::connect(relay.listening).unwrap();
            client.write_all(b"ping").unwrap();
            let mut answer = [0u8; 8];
            client.read_exact(&mut answer).unwrap();
            assert_eq!(&answer, b"ping-ok!");
        }
    }

    #[test]
    fn nothing_is_relayed_off_linux_or_for_podman() {
        let podman = Address::new(Engine::Podman, None);
        assert_eq!(gateway(&podman), None);
    }
}
