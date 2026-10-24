//! Running the local model: `llama-server` on this computer's loopback address, for this app only.
//!
//! WHO CAN TALK TO IT. Nobody but this computer, and nobody on it without the key. It listens on
//! `127.0.0.1` (never the network), on a port picked fresh each time, and refuses any request that does
//! not carry a random key minted for this run (`LLAMA_API_KEY`, never the command line). The key is handed to the bots as their model
//! key and exists nowhere else, so another program on the same computer cannot spend the processor on it
//! and a page in a browser cannot reach it.
//!
//! WHEN IT RUNS. From Start to Stop, with the rest of the app. The model is gigabytes in memory, so it
//! is not left running behind a closed app: `stop` is called from the same places the stack is stopped, and
//! a process left over from a crash is found by the file this writes beside it and stopped at the next
//! start.

use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rand::RngCore;

use crate::problem::Problem;

/// What to run, and how big a conversation to leave room for.
#[derive(Clone, Debug)]
pub struct Settings {
    pub server: PathBuf,
    pub model_file: PathBuf,
    /// The name the model answers to; also what the bots are told to ask for.
    pub alias: String,
    /// Words of conversation held in memory. Memory grows with it, so this is not left to the default.
    pub context: u32,
    /// Processor threads for answering; the program's own default when `None`.
    pub threads: Option<usize>,
}

/// Words of conversation held in memory. A bot's instructions and tool descriptions alone can run to
/// thousands, so 8192 would have been tight; Gemma 4 keeps most of its memory use small at this size.
pub const DEFAULT_CONTEXT: u32 = 16384;

/// The rest of the command line, shared with the CI run that tests the real model.
const FLAGS: &str = include_str!("../local-server-flags.json");

#[derive(serde::Deserialize)]
struct Flags {
    flags: Vec<String>,
}

fn fixed_flags() -> Vec<String> {
    serde_json::from_str::<Flags>(FLAGS)
        .expect("local-server-flags.json is valid")
        .flags
}

/// A running model.
pub struct Running {
    child: Child,
    pub port: u16,
    pub api_key: String,
    pub alias: String,
}

impl Running {
    /// Where this computer's own programs reach it.
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }

    /// Where a bot in a container reaches it: the host, as the container engine names it.
    pub fn container_base_url(&self) -> String {
        format!("http://host.docker.internal:{}/v1", self.port)
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Whether the program is still there.
    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Stop it and wait for it to be gone, so its memory is back before the caller goes on.
    pub fn stop(&mut self, root: &Path) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_file(record_path(root));
    }
}

/// The variable llama-server reads its key from, in place of `--api-key` on the command line.
pub const API_KEY_VARIABLE: &str = "LLAMA_API_KEY";

/// A new key: 32 random bytes, so there is nothing to guess.
pub fn mint_key() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// The command line. A function of its inputs so a test can read it.
///
/// The flags that do not vary live in `local-server-flags.json`. `--jinja` makes the model's own chat
/// template format tool calls; without it, tools are ignored. `--parallel 1` because the app is one
/// person's and a second slot would halve each answer's share of the processor. `--reasoning off`
/// because Gemma 4 otherwise thinks aloud before every answer: measured on 2026-10-16, an answer with
/// thinking on spent all of its first 300 words thinking and had none left to answer with
/// (`--reasoning-budget 0` did not stop it).
///
/// The key is not here: a command line can be read by every account on the computer (`ps`). It goes
/// to the program as `LLAMA_API_KEY`, which llama-server reads in place of `--api-key`; see `start`.
pub fn arguments(settings: &Settings, port: u16) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![
        "-m".into(),
        settings.model_file.clone().into_os_string(),
        "--alias".into(),
        settings.alias.clone().into(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string().into(),
        "--ctx-size".into(),
        settings.context.to_string().into(),
    ];
    args.extend(fixed_flags().into_iter().map(OsString::from));
    if let Some(threads) = settings.threads {
        args.push("--threads".into());
        args.push(threads.to_string().into());
    }
    args
}

/// A port nothing on this computer is listening on right now.
fn free_loopback_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

pub fn record_path(root: &Path) -> PathBuf {
    root.join("local-model.pid")
}

fn log_path(logs: &Path) -> PathBuf {
    logs.join("local-model.log")
}

/// Start the model and wait until it answers.
///
/// A big model takes a while to read from disk, so `ready_within` is generous. The wait ends early, with
/// the program's last words, if it exits; and at once if `cancel` is set.
pub fn start(
    settings: &Settings,
    root: &Path,
    logs: &Path,
    ready_within: Duration,
    cancel: &AtomicBool,
) -> Result<Running, Problem> {
    reap_stale(root, &settings.server);
    fs::create_dir_all(logs).map_err(|error| unwritable(logs, &error))?;
    let log = log_path(logs);
    let api_key = mint_key();

    let mut last = None;
    // A port chosen and released can be taken by someone else before the program binds it: rare, so
    // a couple of tries rather than a loop.
    for _ in 0..3 {
        let port = free_loopback_port().map_err(|error| {
            Problem::with(
                "ArkAgent could not find a free port to run the model on.",
                error.to_string(),
            )
        })?;
        let out = fs::File::create(&log).map_err(|error| unwritable(&log, &error))?;
        let err = out.try_clone().map_err(|error| unwritable(&log, &error))?;
        let mut command = crate::quiet::command(&settings.server);
        command
            .args(arguments(settings, port))
            // The key, where only this account can read it. See `arguments`.
            .env(API_KEY_VARIABLE, &api_key)
            .stdin(Stdio::null())
            .stdout(Stdio::from(out))
            .stderr(Stdio::from(err));
        if let Some(folder) = settings.server.parent() {
            command.current_dir(folder);
            #[cfg(target_os = "linux")]
            command.env("LD_LIBRARY_PATH", folder);
        }
        let child = command.spawn().map_err(|error| {
            Problem::with(
                "ArkAgent could not start the model on this computer.",
                format!("{}: {error}", settings.server.display()),
            )
        })?;
        record(root, &child, &settings.server);
        let mut running = Running {
            child,
            port,
            api_key: api_key.clone(),
            alias: settings.alias.clone(),
        };
        match wait_until_ready(&mut running, &log, ready_within, cancel) {
            Ok(()) => return Ok(running),
            Err(Wait::Exited(tail)) if tail.contains("address already in use") => {
                running.stop(root);
                last = Some(tail);
            }
            Err(Wait::Exited(tail)) => {
                running.stop(root);
                return Err(Problem::with(
                    "The model stopped as it was starting. This computer may not have enough free memory for it; \
                     closing other programs can help, or choose a smaller model.",
                    tail,
                ));
            }
            Err(Wait::TooSlow) => {
                running.stop(root);
                return Err(Problem::with(
                    "The model took too long to start. Try again; if it keeps happening, choose a smaller model.",
                    tail_of(&log),
                ));
            }
            Err(Wait::Cancelled) => {
                running.stop(root);
                return Err(Problem::plain("Starting the model was cancelled."));
            }
        }
    }
    Err(Problem::with(
        "ArkAgent could not find a free port to run the model on.",
        last.unwrap_or_default(),
    ))
}

#[derive(Debug)]
enum Wait {
    Exited(String),
    TooSlow,
    Cancelled,
}

fn wait_until_ready(
    running: &mut Running,
    log: &Path,
    within: Duration,
    cancel: &AtomicBool,
) -> Result<(), Wait> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|_| Wait::TooSlow)?;
    let url = format!("http://127.0.0.1:{}/health", running.port);
    let deadline = Instant::now() + within;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(Wait::Cancelled);
        }
        if let Ok(Some(status)) = running.child.try_wait() {
            return Err(Wait::Exited(format!(
                "exited with {status}\n{}",
                tail_of(log)
            )));
        }
        let answered = client
            .get(&url)
            .bearer_auth(&running.api_key)
            .send()
            .is_ok_and(|response| response.status().is_success());
        if answered {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(Wait::TooSlow);
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

/// The last lines the program wrote, for whoever is working out why it stopped.
fn tail_of(log: &Path) -> String {
    let text = fs::read_to_string(log).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(25)..].join("\n")
}

/// Written beside the app's files so a crash that leaves the program running can be cleaned up.
fn record(root: &Path, child: &Child, server: &Path) {
    let body = format!("{}\n{}\n", child.id(), server.display());
    if let Ok(mut file) = fs::File::create(record_path(root)) {
        let _ = file.write_all(body.as_bytes());
    }
}

/// Stop a model a previous run left behind, if the record names a process that is still our program.
///
/// The check that matters is the second: a process id alone can belong to anything by now. It is only
/// stopped if its executable is the one we started. Anything else is left alone and the record dropped.
pub fn reap_stale(root: &Path, server: &Path) {
    let path = record_path(root);
    let Ok(text) = fs::read_to_string(&path) else {
        return;
    };
    let _ = fs::remove_file(&path);
    let mut lines = text.lines();
    let (Some(pid), Some(recorded)) = (
        lines
            .next()
            .and_then(|line| line.trim().parse::<u32>().ok()),
        lines.next(),
    ) else {
        return;
    };
    if Path::new(recorded.trim()) != server {
        return;
    }
    if process_runs(pid, server) {
        kill_process(pid);
    }
}

/// Whether `pid` is alive and running exactly `server`.
#[cfg(target_os = "linux")]
fn process_runs(pid: u32, server: &Path) -> bool {
    let Ok(wanted) = fs::canonicalize(server) else {
        return false;
    };
    fs::read_link(format!("/proc/{pid}/exe")).is_ok_and(|exe| exe == wanted)
}

#[cfg(target_os = "macos")]
fn process_runs(pid: u32, server: &Path) -> bool {
    // `ps -o comm=` prints the full path of the executable on macOS.
    crate::quiet::command("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).trim() == server.to_string_lossy())
}

#[cfg(windows)]
fn process_runs(pid: u32, server: &Path) -> bool {
    let script = format!("(Get-Process -Id {pid} -ErrorAction SilentlyContinue).Path");
    crate::quiet::command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .is_ok_and(|out| {
            String::from_utf8_lossy(&out.stdout)
                .trim()
                .eq_ignore_ascii_case(&server.to_string_lossy())
        })
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn process_runs(_pid: u32, _server: &Path) -> bool {
    false
}

#[cfg(unix)]
fn kill_process(pid: u32) {
    let _ = crate::quiet::command("kill")
        .args(["-TERM", &pid.to_string()])
        .status();
}

#[cfg(windows)]
fn kill_process(pid: u32) {
    let _ = crate::quiet::command("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();
}

#[cfg(not(any(unix, windows)))]
fn kill_process(_pid: u32) {}

fn unwritable(path: &Path, error: &dyn std::fmt::Display) -> Problem {
    Problem::with(
        "ArkAgent could not write a file it needs to run the model.",
        format!("{}: {error}", path.display()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> Settings {
        Settings {
            server: PathBuf::from("/opt/llama/llama-server"),
            model_file: PathBuf::from("/models/gemma-4-E4B_q4_0-it.gguf"),
            alias: "gemma-4-e4b".into(),
            context: DEFAULT_CONTEXT,
            threads: None,
        }
    }

    fn text(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    fn after(args: &[String], flag: &str) -> Option<String> {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1).cloned())
    }

    #[test]
    fn the_command_line_is_loopback_only_keyed_and_single_slot() {
        let args = text(&arguments(&settings(), 51234));
        assert_eq!(after(&args, "--host").as_deref(), Some("127.0.0.1"));
        assert_eq!(after(&args, "--port").as_deref(), Some("51234"));
        // Never on the command line, where every account on the computer can read it.
        assert!(!args.iter().any(|arg| arg.starts_with("--api-key")));
        assert_eq!(API_KEY_VARIABLE, "LLAMA_API_KEY");
        assert_eq!(after(&args, "--alias").as_deref(), Some("gemma-4-e4b"));
        assert_eq!(after(&args, "--ctx-size").as_deref(), Some("16384"));
        assert_eq!(after(&args, "--parallel").as_deref(), Some("1"));
        // The switch that works; the budget flag was measured not to stop Gemma 4 thinking.
        assert_eq!(after(&args, "--reasoning").as_deref(), Some("off"));
        assert!(!args.contains(&"--reasoning-budget".to_string()));
        assert_eq!(
            after(&args, "-m").as_deref(),
            Some("/models/gemma-4-E4B_q4_0-it.gguf")
        );
        assert!(args.contains(&"--jinja".to_string()));
        assert!(args.contains(&"--no-webui".to_string()));
        // Never a wildcard or LAN address.
        assert!(!args.iter().any(|a| a == "0.0.0.0" || a == "::"));
        assert!(!args.contains(&"--threads".to_string()));
    }

    #[test]
    fn threads_are_passed_when_chosen() {
        let mut chosen = settings();
        chosen.threads = Some(6);
        let args = text(&arguments(&chosen, 1));
        assert_eq!(after(&args, "--threads").as_deref(), Some("6"));
    }

    #[test]
    fn keys_are_long_random_and_url_safe() {
        let a = mint_key();
        let b = mint_key();
        assert_ne!(a, b);
        assert_eq!(a.len(), 43);
        assert!(a
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn urls_name_the_host_and_the_container_view_of_it() {
        let dir = std::env::temp_dir();
        let _ = dir;
        // Built without a process: only the formatting is under test.
        let child = if cfg!(windows) {
            crate::quiet::command("cmd").args(["/C", "exit 0"]).spawn()
        } else {
            crate::quiet::command("true").spawn()
        }
        .unwrap();
        let running = Running {
            child,
            port: 4242,
            api_key: "k".into(),
            alias: "m".into(),
        };
        assert_eq!(running.base_url(), "http://127.0.0.1:4242/v1");
        assert_eq!(
            running.container_base_url(),
            "http://host.docker.internal:4242/v1"
        );
    }

    // ---- a stand-in server, so the lifecycle is tested without a model -------------------------

    mod with_a_stand_in {
        use super::*;
        use crate::test_support::{compile_fixture, temp_root};

        /// Behaves like `llama-server` for the parts the app depends on: reads `--port` and the key
        /// from `LLAMA_API_KEY`, serves `/health` only to a request carrying the key, and says what it was started
        /// with. What it does is read from `behaviour.txt` beside it, because the app starts it with a
        /// fixed command line. A real compiled program, so its executable path is its own, as the real
        /// one's is.
        const STAND_IN: &str = r#"
use std::io::{Read, Write};
use std::net::TcpListener;
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let get = |flag: &str| args.iter().position(|a| a == flag).map(|i| args[i + 1].clone());
    let port = get("--port").expect("--port");
    let key = std::env::var("LLAMA_API_KEY").expect("LLAMA_API_KEY");
    println!("started with {:?}", args);
    let behaviour = std::fs::read_to_string("behaviour.txt").unwrap_or_default();
    match behaviour.trim() {
        "exit" => {
            eprintln!("error: failed to load model: out of memory");
            std::process::exit(3);
        }
        "slow" => {
            std::thread::sleep(std::time::Duration::from_secs(60));
            return;
        }
        _ => {}
    }
    let listener = TcpListener::bind(format!("127.0.0.1:{port}")).expect("bind");
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let mut buffer = [0u8; 4096];
        let n = stream.read(&mut buffer).unwrap_or(0);
        let request = String::from_utf8_lossy(&buffer[..n]).to_string();
        let allowed = request.contains(&format!("Bearer {key}"));
        let response = if allowed {
            "HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{\"status\":\"ok\"}"
        } else {
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        };
        let _ = stream.write_all(response.as_bytes());
    }
}
"#;

        fn scratch(name: &str) -> PathBuf {
            let dir = temp_root(&format!("local-server-{name}"));
            fs::create_dir_all(&dir).unwrap();
            dir
        }

        fn stand_in(dir: &Path, behaviour: &str) -> PathBuf {
            let source = dir.join("stand_in.rs");
            fs::write(&source, STAND_IN).unwrap();
            let binary = dir.join(if cfg!(windows) {
                "llama-server.exe"
            } else {
                "llama-server"
            });
            compile_fixture(&source, &binary);
            fs::write(dir.join("behaviour.txt"), behaviour).unwrap();
            binary
        }

        fn settings_for(server: PathBuf) -> Settings {
            Settings {
                server,
                model_file: PathBuf::from("model.gguf"),
                alias: "stand-in".into(),
                context: 4096,
                threads: Some(2),
            }
        }

        #[test]
        fn starts_waits_for_health_with_the_key_and_stops_cleanly() {
            let dir = scratch("lifecycle");
            let logs = dir.join("logs");
            let server = stand_in(&dir, "ok");
            let cancel = AtomicBool::new(false);
            let mut running = start(
                &settings_for(server.clone()),
                &dir,
                &logs,
                Duration::from_secs(20),
                &cancel,
            )
            .unwrap();
            assert!(running.alive());
            assert!(record_path(&dir).exists());

            // The key is required: the same address without it is refused.
            let client = reqwest::blocking::Client::new();
            let health = format!("http://127.0.0.1:{}/health", running.port);
            assert_eq!(client.get(&health).send().unwrap().status().as_u16(), 401);
            assert!(client
                .get(&health)
                .bearer_auth(&running.api_key)
                .send()
                .unwrap()
                .status()
                .is_success());

            // What it was started with is in the log.
            let log = fs::read_to_string(log_path(&logs)).unwrap();
            // Started with no key on its command line, and answering only to the key it was given.
            assert!(!log.contains("--api-key"), "{log}");
            assert!(!log.contains(&running.api_key), "{log}");
            assert!(log.contains("127.0.0.1"), "{log}");

            running.stop(&dir);
            assert!(!running.alive());
            assert!(!record_path(&dir).exists());
            // The port is free again.
            assert!(TcpListener::bind(("127.0.0.1", running.port)).is_ok());
        }

        #[test]
        fn a_program_that_exits_while_starting_gives_a_sentence_and_its_last_words() {
            let dir = scratch("exits");
            let server = stand_in(&dir, "exit");
            let problem = start(
                &settings_for(server),
                &dir,
                &dir.join("logs"),
                Duration::from_secs(20),
                &AtomicBool::new(false),
            )
            .err()
            .unwrap();
            assert!(
                problem.said.contains("stopped as it was starting"),
                "{problem:?}"
            );
            assert!(problem.said.contains("memory"), "{problem:?}");
            let detail = problem.detail.unwrap();
            assert!(detail.contains("out of memory"), "{detail}");
            assert!(!record_path(&dir).exists());
        }

        #[test]
        fn a_program_that_never_answers_is_stopped_after_the_wait() {
            let dir = scratch("slow");
            let server = stand_in(&dir, "slow");
            let started = Instant::now();
            let problem = start(
                &settings_for(server),
                &dir,
                &dir.join("logs"),
                Duration::from_secs(2),
                &AtomicBool::new(false),
            )
            .err()
            .unwrap();
            assert!(problem.said.contains("took too long"), "{problem:?}");
            assert!(started.elapsed() < Duration::from_secs(10));
            assert!(!record_path(&dir).exists());
        }

        #[test]
        fn cancelling_stops_the_wait_and_the_program() {
            let dir = scratch("cancel");
            let server = stand_in(&dir, "slow");
            let cancel = AtomicBool::new(true);
            let problem = start(
                &settings_for(server),
                &dir,
                &dir.join("logs"),
                Duration::from_secs(30),
                &cancel,
            )
            .err()
            .unwrap();
            assert!(problem.said.contains("cancelled"), "{problem:?}");
            assert!(!record_path(&dir).exists());
        }

        #[test]
        fn a_program_missing_is_a_sentence() {
            let dir = scratch("missing");
            let problem = start(
                &settings_for(dir.join("nope")),
                &dir,
                &dir.join("logs"),
                Duration::from_secs(1),
                &AtomicBool::new(false),
            )
            .err()
            .unwrap();
            assert!(
                problem.said.contains("could not start the model"),
                "{problem:?}"
            );
        }

        #[cfg(target_os = "linux")]
        #[test]
        fn a_model_left_running_by_a_crash_is_stopped_but_a_stranger_with_the_same_id_is_not() {
            let dir = scratch("reap");
            let server = stand_in(&dir, "ok");

            // A leftover: really our program, recorded.
            let cancel = AtomicBool::new(false);
            let leftover = start(
                &settings_for(server.clone()),
                &dir,
                &dir.join("logs"),
                Duration::from_secs(20),
                &cancel,
            )
            .unwrap();
            let pid = leftover.pid();
            // The app "crashed": no stop, so the record stays. (The handle is dropped without
            // killing, which is what a crash does.)
            let leftover_port = leftover.port;
            drop(leftover);
            assert!(record_path(&dir).exists());
            assert!(TcpListener::bind(("127.0.0.1", leftover_port)).is_err());
            reap_stale(&dir, &server);
            for _ in 0..40 {
                if TcpListener::bind(("127.0.0.1", leftover_port)).is_ok() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            assert!(
                TcpListener::bind(("127.0.0.1", leftover_port)).is_ok(),
                "the leftover (pid {pid}) should be gone"
            );
            assert!(!record_path(&dir).exists());

            // A stranger: the record names a live process that is not our program.
            let mut other = std::process::Command::new("sleep")
                .arg("30")
                .spawn()
                .unwrap();
            fs::write(
                record_path(&dir),
                format!("{}\n{}\n", other.id(), server.display()),
            )
            .unwrap();
            reap_stale(&dir, &server);
            assert!(
                other.try_wait().unwrap().is_none(),
                "a stranger must be left alone"
            );
            let _ = other.kill();
            let _ = other.wait();
            assert!(!record_path(&dir).exists());
        }
    }
}
