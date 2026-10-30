//! The person's own Chrome or Edge, for digital employees (device control, phase 1; desk #27).
//!
//! OFF BY DEFAULT, AND SWITCHED ONLY HERE. The setting is a file in this app's own configuration
//! folder, written only by the native menu item "Let digital employees use my browser". Nothing the
//! web app shows and nothing a digital employee says can reach it: the server can be told the
//! browser exists, never asked to start one.
//!
//! WHAT SWITCHING IT ON DOES. Finds the installed Chrome or Edge, and starts `agent-computer` (the
//! same program that drives each employee's sandboxed browser) on this computer's loopback, telling
//! it which browser to open and with which profile. It opens that browser with a pipe, not a
//! debugging port, so nothing else on the computer can attach to it. The profile is a folder of
//! ArkAgent's own, never the person's everyday profile with its saved passwords and sign-ins. Then
//! this announces the address to the local server every few seconds; the server routes an employee
//! there only when the person has also chosen that for the employee, and every action still goes
//! through its gateway (snapshot-resolved element, policy, approval, audit).
//!
//! ON WINDOWS `agent-computer` runs under Node rather than Bun, because Bun there cannot drive the
//! browser at all ([`runs_on_node`]). Until a Node comes with ArkAgent, switching it on there says so.
//!
//! WHAT SWITCHING IT OFF DOES, and closing the browser window, and Stop, and Quit: the announcement
//! becomes "off" (the server forgets every choice), and the process and its browser end.
//!
//! Phase 1 is the browser only. `agent-computer` refuses files, commands and reset in this mode.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::quiet::command;

/// The file in the app's configuration folder that holds the switch.
pub const SETTING_FILE: &str = "own-browser.json";

/// The dedicated profile's folder, under the app's own data folder.
pub const PROFILE_FOLDER: &str = "ArkAgent browser profile";

/// How often the address is repeated. The server's lease is 20 seconds, so a missed one is harmless
/// and three in a row means this app is gone.
pub const ANNOUNCE_EVERY: Duration = Duration::from_secs(5);

/// Whether the person has switched it on. Missing, unreadable or malformed all mean off.
pub fn enabled(config_dir: &Path) -> bool {
    std::fs::read(config_dir.join(SETTING_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value.get("enabled").and_then(serde_json::Value::as_bool))
        .unwrap_or(false)
}

pub fn set_enabled(config_dir: &Path, on: bool) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    std::fs::write(
        config_dir.join(SETTING_FILE),
        serde_json::json!({ "enabled": on }).to_string(),
    )
}

/// Where Chrome and Edge are installed, in the order they are tried, for one platform.
///
/// Chrome first, because it is the browser most people already sign in to; Edge is on every Windows
/// computer, so a Windows machine always has an answer. Per-user installs as well as machine-wide.
pub fn candidates(os: &str, env: impl Fn(&str) -> Option<String>) -> Vec<PathBuf> {
    match os {
        "windows" => {
            let mut found = Vec::new();
            let roots = [
                env("PROGRAMFILES"),
                env("PROGRAMFILES(X86)"),
                env("LOCALAPPDATA"),
            ];
            for root in roots.iter().flatten() {
                found.push(
                    Path::new(root)
                        .join("Google")
                        .join("Chrome")
                        .join("Application")
                        .join("chrome.exe"),
                );
            }
            for root in roots.iter().flatten() {
                found.push(
                    Path::new(root)
                        .join("Microsoft")
                        .join("Edge")
                        .join("Application")
                        .join("msedge.exe"),
                );
            }
            found
        }
        "macos" => {
            let mut found = vec![PathBuf::from(
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            )];
            if let Some(home) = env("HOME") {
                found.push(
                    Path::new(&home)
                        .join("Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
                );
            }
            found.push(PathBuf::from(
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            ));
            found
        }
        _ => [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/opt/google/chrome/chrome",
            "/usr/bin/microsoft-edge",
            "/usr/bin/microsoft-edge-stable",
            "/opt/microsoft/msedge/msedge",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
        ]
        .into_iter()
        .map(PathBuf::from)
        .collect(),
    }
}

/// The installed Chrome or Edge on this computer, if there is one.
///
/// `ARKAGENT_OWN_BROWSER` names one explicitly, for somebody whose browser is somewhere unusual (and
/// for testing with a stand-in). It is read from this app's own environment, which a page cannot set.
pub fn find_browser(
    os: &str,
    env: impl Fn(&str) -> Option<String>,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if let Some(named) = env("ARKAGENT_OWN_BROWSER").filter(|value| !value.trim().is_empty()) {
        let named = PathBuf::from(named.trim());
        return exists(&named).then_some(named);
    }
    candidates(os, env).into_iter().find(|path| exists(path))
}

/// The dedicated profile folder: under this app's data folder, which no browser uses for itself.
pub fn profile_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(PROFILE_FOLDER)
}

/// What Bun runs: `agent-computer`'s source, as it is.
const BUN_ENTRY: &str = "src/index.ts";

/// What Node runs: the single file `bun run build:node` makes from that source, beside it so Node
/// finds the same installed packages.
pub const NODE_ENTRY: &str = "dist/own-browser.mjs";

/// What a person on Windows is told when the Node the installer ships (node-runtime.json) is not
/// where it should be: a damaged or partial installation, which installing again repairs.
pub const NODE_MISSING: &str = "Device control on Windows needs the Node that comes with ArkAgent, and it is missing from this installation. Install ArkAgent again to repair it.";

/// Whether `agent-computer` runs under Node here rather than Bun.
///
/// Windows only. Playwright drives the browser over a pipe on extra file descriptors, and Bun on
/// Windows cannot hand a child those: the launch times out, where under Node the same browser opens
/// and loads a page in seconds. Connecting over a debugging port or to a Playwright server hangs
/// under Bun there too (docs/ark/25-device-control.md). macOS and Linux work under Bun and stay on it.
pub fn runs_on_node(os: &str) -> bool {
    os == "windows"
}

/// Where a Node shipped inside ArkAgent would be. Nothing puts one there yet: whether Node comes in
/// the installer or is downloaded on first switch-on is still open, and either lands here.
pub fn bundled_node(resource_dir: &Path, os: &str) -> PathBuf {
    resource_dir
        .join("node")
        .join(if os == "windows" { "node.exe" } else { "node" })
}

/// The Node to run `agent-computer` with: the shipped one if it is there, else the one
/// `ARKAGENT_NODE` names, read from this app's own environment as `ARKAGENT_OWN_BROWSER` is.
///
/// Never a `node` found on the PATH. Whatever happens to be installed there is a version nobody
/// tested this with, and the person did not choose it for this.
pub fn find_node(
    bundled: Option<&Path>,
    env: impl Fn(&str) -> Option<String>,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if let Some(bundled) = bundled.filter(|path| exists(path)) {
        return Some(bundled.to_path_buf());
    }
    let named = env("ARKAGENT_NODE").filter(|value| !value.trim().is_empty())?;
    let named = PathBuf::from(named.trim());
    exists(&named).then_some(named)
}

/// The program that runs `agent-computer` and the file it is given, or why it cannot start here.
pub fn launcher(
    os: &str,
    bun: &Path,
    node: Option<&Path>,
) -> Result<(PathBuf, &'static str), String> {
    if !runs_on_node(os) {
        return Ok((bun.to_path_buf(), BUN_ENTRY));
    }
    node.map(|node| (node.to_path_buf(), NODE_ENTRY))
        .ok_or_else(|| NODE_MISSING.to_string())
}

/// The settings `agent-computer` is started with. A function of its inputs so a test can read it.
///
/// No debugging port and no address to connect to: the browser is opened by that process over a
/// pipe. The token is the deployment's computer token, which the server already presents to every
/// computer, so the person's browser is locked the same way a sandbox is.
pub fn computer_env(
    browser: &Path,
    profile: &Path,
    port: u16,
    computer_token: &str,
) -> Vec<(&'static str, String)> {
    vec![
        (
            "COMPUTER_OWN_BROWSER_EXECUTABLE",
            browser.display().to_string(),
        ),
        (
            "COMPUTER_OWN_BROWSER_PROFILE",
            profile.display().to_string(),
        ),
        ("PORT", port.to_string()),
        ("COMPUTER_TOKEN", computer_token.to_string()),
    ]
}

/// What starting needs, gathered when the stack starts so the menu can switch it on later.
#[derive(Clone, Debug)]
pub struct Config {
    pub root: PathBuf,
    pub bun: PathBuf,
    /// Node, where this platform runs `agent-computer` under it (see [`runs_on_node`]).
    pub node: Option<PathBuf>,
    pub logs: PathBuf,
    pub server_port: u16,
    pub desktop_token: String,
    pub computer_token: String,
    pub browser: PathBuf,
    pub profile: PathBuf,
}

/// Install `agent-computer`'s own packages, the first time only.
///
/// Not part of the ordinary install: most people never switch this on, and Playwright is not small.
/// `--ignore-scripts` for the reason `stack::install_dependencies` gives, and it also means no browser
/// is downloaded: this mode opens the one already installed.
pub fn ensure_dependencies(root: &Path, bun: &Path) -> Result<(), String> {
    let directory = root.join("agent-computer");
    if !directory.join("src").join("index.ts").is_file() {
        return Err(
            "This installation of ArkAgent does not include the part that drives your browser. Update ArkAgent and try again."
                .into(),
        );
    }
    if directory
        .join("node_modules")
        .join("playwright")
        .join("package.json")
        .is_file()
    {
        return Ok(());
    }
    let output = command(bun)
        .current_dir(&directory)
        .args([
            "install",
            "--frozen-lockfile",
            "--ignore-scripts",
            "--production",
        ])
        .output()
        .map_err(|error| format!("could not run bun install: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "installing what drives your browser failed: {}",
        crate::quiet::said(&output.stderr)
    ))
}

/// Make what Node runs from the source beside it.
///
/// On every start rather than once. Updating ArkAgent replaces the source and leaves this folder's
/// other files alone, so a build kept from the last version would run old code next to new; Bun
/// builds it in well under a second. Built here rather than shipped so a checkout and a release
/// take the same path, and Bun is already on every computer this app runs on.
pub fn build_for_node(root: &Path, bun: &Path) -> Result<(), String> {
    let output = command(bun)
        .current_dir(root.join("agent-computer"))
        .args(["run", "build:node"])
        .output()
        .map_err(|error| format!("could not run bun build: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "preparing what drives your browser failed: {}",
        crate::quiet::said(&output.stderr)
    ))
}

fn free_loopback_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        // The server is on this computer. A proxy configured for the internet must not see this.
        .no_proxy()
        .build()
        .map_err(|error| error.to_string())
}

/// Tell the local server where the person's browser is driven from, or that it is off.
pub fn announce(server_port: u16, desktop_token: &str, url: Option<&str>) -> Result<(), String> {
    let response = client()?
        .put(format!(
            "http://127.0.0.1:{server_port}/api/own-browser/desktop"
        ))
        .bearer_auth(desktop_token)
        .json(&serde_json::json!({ "url": url }))
        .send()
        .map_err(|error| error.to_string())?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("the server answered {}", response.status()))
    }
}

/// The browser, while it is switched on.
pub struct OwnBrowser {
    child: Arc<Mutex<Child>>,
    stopping: Arc<AtomicBool>,
    announcer: Option<JoinHandle<()>>,
    server_port: u16,
    desktop_token: String,
}

impl OwnBrowser {
    /// Start it, wait until it answers, and begin announcing it.
    ///
    /// `on_gone` is called once if it ends without being asked to: the person closed the window, or
    /// the browser could not keep running. The caller treats that as the switch going off.
    pub fn start(config: &Config, on_gone: impl FnOnce() + Send + 'static) -> Result<Self, String> {
        Self::start_on(std::env::consts::OS, config, on_gone)
    }

    /// [`Self::start`] as it is on `os`, so the Node path can be run on a machine that is not Windows.
    fn start_on(
        os: &str,
        config: &Config,
        on_gone: impl FnOnce() + Send + 'static,
    ) -> Result<Self, String> {
        // Asked first: nothing is installed for a start that cannot happen.
        let (program, entry) = launcher(os, &config.bun, config.node.as_deref())?;
        ensure_dependencies(&config.root, &config.bun)?;
        if runs_on_node(os) {
            build_for_node(&config.root, &config.bun)?;
        }
        std::fs::create_dir_all(&config.profile)
            .map_err(|error| format!("could not make the ArkAgent browser profile: {error}"))?;
        std::fs::create_dir_all(&config.logs).map_err(|error| error.to_string())?;
        let port = free_loopback_port().map_err(|error| error.to_string())?;
        let log = std::fs::File::create(config.logs.join("own-browser.log"))
            .map_err(|error| error.to_string())?;
        let err = log.try_clone().map_err(|error| error.to_string())?;

        let mut process = command(&program);
        process
            .current_dir(config.root.join("agent-computer"))
            .arg(entry)
            .envs(computer_env(
                &config.browser,
                &config.profile,
                port,
                &config.computer_token,
            ))
            // Nothing of the desktop's own credentials goes to this process.
            .env_remove("OPENBOT_DESKTOP_HOST_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(err));
        let mut child = process
            .spawn()
            .map_err(|error| format!("could not start what drives your browser: {error}"))?;

        let url = format!("http://127.0.0.1:{port}");
        let deadline = Instant::now() + Duration::from_secs(60);
        let health = client()?;
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!(
                    "your browser could not be opened ({status}). The details are in .logs/own-browser.log."
                ));
            }
            if health
                .get(format!("{url}/health"))
                .send()
                .is_ok_and(|response| response.status().is_success())
            {
                break;
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err("your browser did not open in time.".into());
            }
            std::thread::sleep(Duration::from_millis(250));
        }

        let child = Arc::new(Mutex::new(child));
        let stopping = Arc::new(AtomicBool::new(false));
        let announcer = {
            let child = Arc::clone(&child);
            let stopping = Arc::clone(&stopping);
            let token = config.desktop_token.clone();
            let server_port = config.server_port;
            std::thread::spawn(move || {
                let mut last = Instant::now() - ANNOUNCE_EVERY;
                loop {
                    if stopping.load(Ordering::SeqCst) {
                        return;
                    }
                    let ended = matches!(child.lock().unwrap().try_wait(), Ok(Some(_)));
                    if ended {
                        let _ = announce(server_port, &token, None);
                        if !stopping.load(Ordering::SeqCst) {
                            on_gone();
                        }
                        return;
                    }
                    if last.elapsed() >= ANNOUNCE_EVERY {
                        // Missed announcements are not fatal: the server holds each for 20 seconds.
                        let _ = announce(server_port, &token, Some(&url));
                        last = Instant::now();
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
            })
        };
        Ok(Self {
            child,
            stopping,
            announcer: Some(announcer),
            server_port: config.server_port,
            desktop_token: config.desktop_token.clone(),
        })
    }

    /// Switch it off: the server is told first, so no action is routed to a browser that is closing.
    pub fn stop(mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        let _ = announce(self.server_port, &self.desktop_token, None);
        {
            let mut child = self.child.lock().unwrap();
            terminate(&mut child);
        }
        if let Some(announcer) = self.announcer.take() {
            let _ = announcer.join();
        }
    }
}

/// Ask the process to close the browser itself, so the profile is written out, then make sure.
fn terminate(child: &mut Child) {
    #[cfg(unix)]
    {
        // SIGTERM is what `agent-computer` closes its browser gracefully on.
        if unsafe { libc::kill(child.id() as i32, libc::SIGTERM) } == 0 {
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
    // On Windows there is no polite signal for a console process without a console. Killing it
    // closes the pipe, and Chrome and Edge exit when the pipe they were opened on closes.
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        move |key| map.get(key).cloned()
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "arkagent-own-browser-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn it_is_off_until_the_person_switches_it_on() {
        let dir = scratch("setting");
        assert!(!enabled(&dir), "no file is off");
        std::fs::write(dir.join(SETTING_FILE), "{ not json").unwrap();
        assert!(!enabled(&dir), "a broken file is off");
        std::fs::write(dir.join(SETTING_FILE), r#"{"enabled":"yes"}"#).unwrap();
        assert!(!enabled(&dir), "anything but true is off");
        set_enabled(&dir, true).unwrap();
        assert!(enabled(&dir));
        set_enabled(&dir, false).unwrap();
        assert!(!enabled(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn chrome_or_edge_is_found_where_each_platform_installs_it() {
        let windows = candidates(
            "windows",
            env_of(&[
                ("PROGRAMFILES", r"C:\Program Files"),
                ("PROGRAMFILES(X86)", r"C:\Program Files (x86)"),
                ("LOCALAPPDATA", r"C:\Users\Maria\AppData\Local"),
            ]),
        );
        let windows: Vec<String> = windows.iter().map(|p| p.display().to_string()).collect();
        assert!(windows[0].contains("Google") && windows[0].ends_with("chrome.exe"));
        assert!(windows
            .iter()
            .any(|p| p.contains("Microsoft") && p.ends_with("msedge.exe")));
        assert!(
            windows.iter().any(|p| p.contains("Maria")),
            "per-user Chrome"
        );

        let mac = candidates("macos", env_of(&[("HOME", "/Users/maria")]));
        assert_eq!(
            mac[0],
            PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        );
        assert!(mac.iter().any(|p| p.ends_with("Microsoft Edge")));

        let linux = candidates("linux", env_of(&[]));
        assert!(linux.contains(&PathBuf::from("/usr/bin/google-chrome")));
        assert!(linux.contains(&PathBuf::from("/usr/bin/microsoft-edge")));
    }

    #[test]
    fn the_first_installed_browser_wins_and_an_explicit_one_must_exist() {
        let installed = PathBuf::from("/usr/bin/microsoft-edge");
        let found = find_browser("linux", env_of(&[]), |path| path == installed);
        assert_eq!(found, Some(installed.clone()));
        assert_eq!(find_browser("linux", env_of(&[]), |_| false), None);
        let named = find_browser(
            "linux",
            env_of(&[("ARKAGENT_OWN_BROWSER", "/opt/stand-in/chrome")]),
            |path| path == Path::new("/opt/stand-in/chrome"),
        );
        assert_eq!(named, Some(PathBuf::from("/opt/stand-in/chrome")));
        // Named and missing is an answer, not a reason to go looking elsewhere.
        assert_eq!(
            find_browser(
                "linux",
                env_of(&[("ARKAGENT_OWN_BROWSER", "/nowhere/chrome")]),
                |path| path == installed
            ),
            None
        );
    }

    #[test]
    fn the_profile_is_arkagents_own_and_never_a_browsers() {
        let data = Path::new("/home/maria/.local/share/ai.arkagent.desktop");
        let profile = profile_dir(data);
        assert!(profile.starts_with(data));
        assert!(profile.ends_with(PROFILE_FOLDER));
        for browsers_own in [
            ".config/google-chrome",
            ".config/microsoft-edge",
            "Google/Chrome",
        ] {
            assert!(!profile.display().to_string().contains(browsers_own));
        }
    }

    #[test]
    fn the_process_is_told_the_browser_the_profile_and_nothing_to_connect_to() {
        let env = computer_env(
            Path::new("/usr/bin/google-chrome"),
            Path::new("/data/ArkAgent browser profile"),
            41234,
            "computer-token",
        );
        let names: Vec<&str> = env.iter().map(|(name, _)| *name).collect();
        assert_eq!(
            names,
            [
                "COMPUTER_OWN_BROWSER_EXECUTABLE",
                "COMPUTER_OWN_BROWSER_PROFILE",
                "PORT",
                "COMPUTER_TOKEN"
            ]
        );
        assert!(
            !env.iter()
                .any(|(_, value)| value.contains("remote-debugging")),
            "no debugging port is ever opened"
        );
    }

    #[test]
    fn announcing_carries_the_desktop_token_and_the_address() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 4096];
            let read = std::io::Read::read(&mut stream, &mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            std::io::Write::write_all(
                &mut stream,
                b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
            )
            .unwrap();
            request
        });
        announce(port, "desktop-token", Some("http://127.0.0.1:41234")).unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("PUT /api/own-browser/desktop "));
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer desktop-token"));
        assert!(request.contains(r#""url":"http://127.0.0.1:41234""#));
    }

    #[test]
    fn an_installation_without_the_browser_driver_says_so() {
        let root = scratch("no-driver");
        let error = ensure_dependencies(&root, Path::new("bun")).unwrap_err();
        assert!(error.contains("does not include"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn node_is_the_shipped_copy_else_the_named_one_and_never_a_guess() {
        let resources = Path::new(r"C:\Program Files\ArkAgent\resources");
        let shipped = bundled_node(resources, "windows");
        assert!(shipped.starts_with(resources) && shipped.ends_with("node.exe"));
        let named = PathBuf::from(r"C:\Tools\node\node.exe");
        let env = env_of(&[("ARKAGENT_NODE", r"C:\Tools\node\node.exe")]);

        // Shipped and present wins over a named one.
        let found = find_node(Some(&shipped), &env, |path| {
            path == shipped || path == named
        });
        assert_eq!(found, Some(shipped.clone()));
        // No shipped copy: the named one, if it is there.
        assert_eq!(
            find_node(Some(&shipped), &env, |path| path == named),
            Some(named.clone())
        );
        // Named and missing, or nothing named: none, whatever else is installed.
        assert_eq!(find_node(Some(&shipped), &env, |_| false), None);
        assert_eq!(
            find_node(None, env_of(&[("ARKAGENT_NODE", "  ")]), |_| true),
            None
        );
    }

    #[test]
    fn windows_runs_it_under_node_and_says_so_when_there_is_none() {
        let bun = Path::new("/usr/local/bin/bun");
        let node = Path::new(r"C:\Tools\node\node.exe");
        assert_eq!(
            launcher("windows", bun, Some(node)),
            Ok((node.to_path_buf(), NODE_ENTRY))
        );
        let refused = launcher("windows", bun, None).unwrap_err();
        assert_eq!(refused, NODE_MISSING);
        assert!(refused.contains("Install ArkAgent again"));
        // macOS and Linux stay on Bun, with the source, even when a Node is configured.
        for os in ["macos", "linux"] {
            assert_eq!(
                launcher(os, bun, Some(node)),
                Ok((bun.to_path_buf(), "src/index.ts"))
            );
        }
    }

    #[test]
    fn what_node_runs_is_what_agent_computer_builds() {
        let manifest =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../agent-computer/package.json");
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(manifest).unwrap()).unwrap();
        let build = manifest["scripts"]["build:node"].as_str().unwrap();
        assert!(
            build.contains(&format!("--outfile={NODE_ENTRY}")),
            "build:node must write {NODE_ENTRY}: {build}"
        );
    }

    #[test]
    fn a_refused_start_installs_nothing() {
        // No Node on Windows is answered before anything is installed or built: the root here has no
        // agent-computer at all, and the answer is still the Node one.
        let root = scratch("no-node");
        let config = Config {
            root: root.clone(),
            bun: PathBuf::from("bun"),
            node: None,
            logs: root.join("logs"),
            server_port: 1,
            desktop_token: "desktop-token".into(),
            computer_token: "computer-token".into(),
            browser: PathBuf::from("chrome"),
            profile: profile_dir(&root),
        };
        let error = OwnBrowser::start_on("windows", &config, || {})
            .err()
            .expect("it refuses");
        assert_eq!(error, NODE_MISSING);
        assert!(!config.profile.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A server that answers every request 200 and keeps the bodies of the announcements.
    fn announcement_sink() -> (u16, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let kept = Arc::clone(&bodies);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut buffer = [0u8; 8192];
                let read = std::io::Read::read(&mut stream, &mut buffer).unwrap_or(0);
                let text = String::from_utf8_lossy(&buffer[..read]).to_string();
                if let Some((_, body)) = text.split_once("\r\n\r\n") {
                    kept.lock().unwrap().push(body.to_string());
                }
                let _ = std::io::Write::write_all(
                    &mut stream,
                    b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
                );
            }
        });
        (port, bodies)
    }

    /// The desktop's half end to end: the real `agent-computer` from this checkout, opening a
    /// Chromium standing in for the person's Chrome. Asked for by name, because it needs bun,
    /// `agent-computer`'s packages and a Chromium:
    ///
    ///   OPENBOT_OWN_BROWSER=1 OWN_BROWSER_STAND_IN=/path/to/chrome cargo test --lib own_browser
    ///
    /// With OWN_BROWSER_RUNTIME=node it starts as Windows does, under Node (ARKAGENT_NODE, or `node`).
    #[test]
    fn switching_on_opens_the_browser_announces_it_and_switching_off_ends_it() {
        if std::env::var("OPENBOT_OWN_BROWSER").as_deref() != Ok("1") {
            return;
        }
        let stand_in = std::env::var("OWN_BROWSER_STAND_IN")
            .expect("OWN_BROWSER_STAND_IN names a Chromium to stand in for the person's browser");
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let scratch = scratch("live");
        // This container has no user namespaces and no screen; a person's computer has both.
        let wrapper = scratch.join("chrome");
        std::fs::write(
            &wrapper,
            format!("#!/bin/sh\nexec \"{stand_in}\" --no-sandbox --headless=new \"$@\"\n"),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let bun = std::env::var("BUN").unwrap_or_else(|_| "bun".into());
        let on_node = std::env::var("OWN_BROWSER_RUNTIME").as_deref() == Ok("node");
        let os = if on_node {
            "windows"
        } else {
            std::env::consts::OS
        };
        let node = on_node.then(|| {
            PathBuf::from(std::env::var("ARKAGENT_NODE").unwrap_or_else(|_| "node".into()))
        });
        let (server_port, bodies) = announcement_sink();
        let config = Config {
            root,
            bun: PathBuf::from(bun),
            node,
            logs: scratch.join("logs"),
            server_port,
            desktop_token: "desktop-token".into(),
            computer_token: "computer-token".into(),
            browser: wrapper,
            profile: profile_dir(&scratch),
        };
        let browser = OwnBrowser::start_on(os, &config, || {}).expect("it starts");
        std::thread::sleep(Duration::from_millis(500));
        let announced = bodies.lock().unwrap().clone();
        let url = announced
            .iter()
            .find_map(|body| {
                serde_json::from_str::<serde_json::Value>(body)
                    .ok()?
                    .get("url")?
                    .as_str()
                    .map(str::to_string)
            })
            .expect("the address was announced");
        assert!(url.starts_with("http://127.0.0.1:"));
        let health: serde_json::Value = client()
            .unwrap()
            .get(format!("{url}/health"))
            .send()
            .unwrap()
            .json()
            .unwrap();
        assert_eq!(health["target"], "own-browser");
        // The browser wrote its profile where it was told: ArkAgent's own folder.
        // The window opens as the process starts, a moment after it answers.
        let deadline = Instant::now() + Duration::from_secs(20);
        while !config.profile.join("Default").exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(200));
        }
        assert!(
            config.profile.join("Default").exists(),
            "{}",
            std::fs::read_to_string(config.logs.join("own-browser.log")).unwrap_or_default()
        );

        browser.stop();
        assert_eq!(
            bodies.lock().unwrap().last().map(String::as_str),
            Some(r#"{"url":null}"#)
        );
        assert!(client()
            .unwrap()
            .get(format!("{url}/health"))
            .send()
            .is_err());
        let _ = std::fs::remove_dir_all(&scratch);
    }
}
