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
//!
//! PODMAN (desk #40) is asked rather than assumed, because where its containers land on this
//! computer depends on how its network is set up, and none of it can be read from a setting:
//!
//! - `podman machine` (macOS, and Windows with the user-mode networking ArkAgent turns on) runs
//!   gvproxy, which hands traffic for the host's address (192.168.127.254) to the host's loopback, the
//!   way Docker Desktop does. A loopback-only server is reachable there with no relay.
//! - Rootless Podman on Linux, which is what ArkAgent installs there, uses pasta or slirp4netns. By
//!   default neither delivers to the host's loopback: pasta maps `host.containers.internal` to the
//!   host's own network address, which is reachable from the local network too, so a relay there would
//!   undo the point of listening on loopback. It is not relayed.
//!
//! So `loopback_reach_from_containers` runs one throwaway container from the deployment's own server
//! image and has it fetch a one-time answer from a listener on `127.0.0.1`, through
//! `host.docker.internal`, which is how every Bot reaches the server and the model. Only an answer
//! carrying that run's token makes the server loopback-only; anything else keeps every interface, as
//! before.

use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

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

/// What came of relaying a port again for a stack this window did not start.
pub enum Relayed {
    /// Relaying now, until the returned relay is dropped.
    Relaying(Forwarder),
    /// Something on this machine already answers the containers there: a server started before
    /// the relays existed, or when they could not be made, listens on every interface.
    AlreadyReachable,
    /// The address is not this machine's (Docker Desktop on Linux keeps the bridge inside its VM),
    /// so the start that raised this stack could not have relayed it either and kept every
    /// interface instead. Nothing to restore.
    NotThisMachine,
}

/// Relay `port` again for a running stack, telling a port that needs nothing apart from one that
/// cannot be reached.
///
/// Desk #71: closing the window ends this process and every relay with it, while the containers,
/// the desktop server and the model keep running. A window opened afterwards adopts that stack and
/// has to put the relays back, or every digital employee gets "connection refused" while every
/// health check (all of them made over loopback) says the stack is fine. `forward` and `reachable`
/// are parameters so a test can stand in for the bridge.
pub fn relay_again(
    listen_ip: Ipv4Addr,
    port: u16,
    forward: impl FnOnce(Ipv4Addr, u16) -> io::Result<Forwarder>,
    reachable: impl FnOnce(SocketAddr) -> bool,
) -> io::Result<Relayed> {
    match forward(listen_ip, port) {
        Ok(relay) => Ok(Relayed::Relaying(relay)),
        Err(error) if error.kind() == io::ErrorKind::AddrNotAvailable => {
            Ok(Relayed::NotThisMachine)
        }
        Err(error)
            if error.kind() == io::ErrorKind::AddrInUse
                && reachable(SocketAddr::new(IpAddr::V4(listen_ip), port)) =>
        {
            Ok(Relayed::AlreadyReachable)
        }
        Err(error) => Err(error),
    }
}

/// Whether something accepts a connection at `address` within a second.
pub fn answers(address: SocketAddr) -> bool {
    TcpStream::connect_timeout(&address, Duration::from_secs(1)).is_ok()
}

/// What a container on this engine said when asked to reach this computer's loopback.
#[derive(Debug, PartialEq, Eq)]
pub enum LoopbackReach {
    /// It fetched this run's token from a listener on `127.0.0.1`: loopback is enough.
    Reached,
    /// It ran and could not reach that listener: anything on loopback is out of its reach.
    NotReached,
    /// The question could not be asked (no image, an engine too old for `host-gateway`, a timeout).
    /// Nothing is known, so nothing changes.
    Unknown(String),
}

/// How long the throwaway container may take. Starting one in a `podman machine` VM takes a few
/// seconds; this is a ceiling, not a wait.
const PROBE_WITHIN: Duration = Duration::from_secs(60);

/// Ask a container started from `image` on `address` whether it reaches this computer's loopback
/// through `host.docker.internal`, as the deployment's containers reach the server and the model.
///
/// See the module comment for why Podman is asked this rather than told.
pub fn loopback_reach_from_containers(address: &Address, image: &str) -> LoopbackReach {
    let token = crate::local_server::mint_key();
    let answering = match OneAnswer::serve(&token) {
        Ok(answering) => answering,
        Err(error) => return LoopbackReach::Unknown(format!("no loopback listener: {error}")),
    };
    let mut command = address.command();
    command
        .args(probe_arguments(image, answering.port))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return LoopbackReach::Unknown(format!("could not run the engine: {error}")),
    };
    let deadline = Instant::now() + PROBE_WITHIN;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return LoopbackReach::Unknown("the container did not finish in time".into());
            }
        }
    }
    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(error) => return LoopbackReach::Unknown(error.to_string()),
    };
    let reach = read_probe(&String::from_utf8_lossy(&output.stdout), &token);
    match reach {
        LoopbackReach::Unknown(_) => LoopbackReach::Unknown(
            String::from_utf8_lossy(&output.stderr)
                .lines()
                .last()
                .unwrap_or("the container said nothing")
                .to_string(),
        ),
        known => known,
    }
}

/// The engine's command line: a throwaway container from the deployment's own server image (bun is
/// in it, and Install already put it on this engine, so nothing is pulled), mapped to the host the
/// way `docker-compose.yml` maps every Bot.
fn probe_arguments(image: &str, port: u16) -> Vec<String> {
    vec![
        "run".into(),
        "--rm".into(),
        "--pull=never".into(),
        "--add-host".into(),
        "host.docker.internal:host-gateway".into(),
        "--entrypoint".into(),
        "bun".into(),
        image.into(),
        "-e".into(),
        probe_script("host.docker.internal", port),
    ]
}

/// What the container runs. It always prints exactly one of two lines, so a container that printed
/// neither did not run this at all.
fn probe_script(host: &str, port: u16) -> String {
    format!(
        "try {{ const r = await fetch('http://{host}:{port}/', {{ signal: AbortSignal.timeout(8000) }}); \
         console.log('answer:' + (await r.text())); }} catch {{ console.log('unreachable'); }}"
    )
}

fn read_probe(stdout: &str, token: &str) -> LoopbackReach {
    for line in stdout.lines().map(str::trim) {
        if let Some(answer) = line.strip_prefix("answer:") {
            // Something answered, and only this run's listener knows the token: anything else that
            // answered was not this computer's loopback.
            return if answer == token {
                LoopbackReach::Reached
            } else {
                LoopbackReach::NotReached
            };
        }
        if line == "unreachable" {
            return LoopbackReach::NotReached;
        }
    }
    LoopbackReach::Unknown(String::new())
}

/// A listener on `127.0.0.1` that answers every HTTP request with one token, until dropped.
struct OneAnswer {
    stop: Arc<AtomicBool>,
    port: u16,
}

impl OneAnswer {
    fn serve(token: &str) -> io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{token}",
            token.len()
        );
        thread::Builder::new()
            .name("loopback-probe".into())
            .spawn(move || {
                while !stopping.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            let _ = stream.set_nonblocking(false);
                            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                            let mut request = [0u8; 4096];
                            let _ = stream.read(&mut request);
                            let _ = stream.write_all(response.as_bytes());
                        }
                        Err(_) => thread::sleep(Duration::from_millis(50)),
                    }
                }
            })?;
        Ok(Self { stop, port })
    }
}

impl Drop for OneAnswer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
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

    // Linux only, where the relay is used: macOS has 127.0.0.1 alone on its loopback, so binding
    // the stand-in address there fails with "Can't assign requested address".
    #[cfg(target_os = "linux")]
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

    /// Desk #71. Each way a relay can come out for an adopted stack, with the bridge stood in for.
    #[cfg(target_os = "linux")]
    #[test]
    fn relaying_again_tells_a_port_that_needs_nothing_from_one_nobody_can_reach() {
        let bridge = Ipv4Addr::new(127, 0, 0, 3);
        let free = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = free.local_addr().unwrap().port();
        drop(free);

        // The usual case: the port is free on the bridge, and the relay is made.
        match relay_again(bridge, port, forward, answers).unwrap() {
            Relayed::Relaying(relay) => assert_eq!(relay.listening.port(), port),
            _ => panic!("expected a relay"),
        }

        // A server already listening there (every interface, as before relays existed) needs none.
        // (The dropped relay's thread lets go of the address within one of its 50 ms polls.)
        let everywhere = (0..40)
            .find_map(|_| {
                TcpListener::bind((bridge, port))
                    .inspect_err(|_| thread::sleep(Duration::from_millis(50)))
                    .ok()
            })
            .expect("the dropped relay lets go of its address");
        assert!(matches!(
            relay_again(bridge, port, forward, answers).unwrap(),
            Relayed::AlreadyReachable
        ));
        drop(everywhere);

        // An address that is not this machine's, as on Docker Desktop: nothing to restore.
        let elsewhere = |_: Ipv4Addr, _: u16| -> io::Result<Forwarder> {
            Err(io::ErrorKind::AddrNotAvailable.into())
        };
        assert!(matches!(
            relay_again(bridge, port, elsewhere, |_| panic!("not asked")).unwrap(),
            Relayed::NotThisMachine
        ));

        // Held by something that does not answer: a real failure, said as one.
        let held =
            |_: Ipv4Addr, _: u16| -> io::Result<Forwarder> { Err(io::ErrorKind::AddrInUse.into()) };
        assert!(relay_again(bridge, port, held, |_| false).is_err());
        let refused = |_: Ipv4Addr, _: u16| -> io::Result<Forwarder> {
            Err(io::ErrorKind::PermissionDenied.into())
        };
        assert!(relay_again(bridge, port, refused, |_| true).is_err());
    }

    #[test]
    fn only_this_runs_token_says_the_containers_reach_loopback() {
        assert_eq!(read_probe("answer:abc\n", "abc"), LoopbackReach::Reached);
        assert_eq!(
            read_probe("some log line\n  answer:abc  \n", "abc"),
            LoopbackReach::Reached
        );
        // Something else answered on that port: not this computer's loopback.
        assert_eq!(
            read_probe("answer:other\n", "abc"),
            LoopbackReach::NotReached
        );
        assert_eq!(read_probe("answer:\n", "abc"), LoopbackReach::NotReached);
        assert_eq!(
            read_probe("unreachable\n", "abc"),
            LoopbackReach::NotReached
        );
        // Neither line: the script never ran (no bun, no image, an engine error).
        assert!(matches!(read_probe("", "abc"), LoopbackReach::Unknown(_)));
        assert!(matches!(
            read_probe("Error: image not known\n", "abc"),
            LoopbackReach::Unknown(_)
        ));
    }

    #[test]
    fn the_probe_container_is_mapped_like_the_bots_and_pulls_nothing() {
        let args = probe_arguments("ghcr.io/example/server@sha256:1", 41234);
        assert_eq!(args[0], "run");
        assert!(args.contains(&"--rm".to_string()));
        assert!(args.contains(&"--pull=never".to_string()));
        let mapped = args.iter().position(|arg| arg == "--add-host").unwrap();
        // The same mapping `docker-compose.yml` gives every Bot.
        assert_eq!(args[mapped + 1], "host.docker.internal:host-gateway");
        let image = args
            .iter()
            .position(|arg| arg == "ghcr.io/example/server@sha256:1")
            .unwrap();
        assert_eq!(args[image - 2], "--entrypoint");
        assert_eq!(args[image - 1], "bun");
        assert_eq!(args[image + 1], "-e");
        assert!(args[image + 2].contains("http://host.docker.internal:41234/"));
    }

    #[test]
    fn the_loopback_listener_answers_with_the_token_and_only_on_loopback() {
        let answering = OneAnswer::serve("tok-123").unwrap();
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, answering.port)).unwrap();
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
            .unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).unwrap();
        assert!(answer.starts_with("HTTP/1.1 200 OK"));
        assert!(answer.ends_with("\r\n\r\ntok-123"));
    }

    /// The script itself, run by the bun on this machine where there is one, against the listener
    /// (reached) and against a port nothing listens on (not reached).
    #[test]
    fn the_probe_script_reports_both_answers() {
        let Ok(bun) = which_bun() else {
            eprintln!("bun is not on PATH; the script is not run here");
            return;
        };
        let token = "tok-456";
        let answering = OneAnswer::serve(token).unwrap();
        let run = |port: u16| {
            let output = std::process::Command::new(&bun)
                .args(["-e", &probe_script("127.0.0.1", port)])
                .output()
                .unwrap();
            read_probe(&String::from_utf8_lossy(&output.stdout), token)
        };
        assert_eq!(run(answering.port), LoopbackReach::Reached);
        let closed = TcpListener::bind("127.0.0.1:0").unwrap();
        let closed_port = closed.local_addr().unwrap().port();
        drop(closed);
        assert_eq!(run(closed_port), LoopbackReach::NotReached);
    }

    fn which_bun() -> Result<std::path::PathBuf, ()> {
        let name = if cfg!(windows) { "bun.exe" } else { "bun" };
        std::env::var_os("PATH")
            .and_then(|path| {
                std::env::split_paths(&path)
                    .map(|dir| dir.join(name))
                    .find(|candidate| candidate.is_file())
            })
            .ok_or(())
    }

    #[test]
    fn nothing_is_relayed_off_linux_or_for_podman() {
        let podman = Address::new(Engine::Podman, None);
        assert_eq!(gateway(&podman), None);
    }
}
