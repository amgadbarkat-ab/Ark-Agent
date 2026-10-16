//! The model that runs on the customer's own computer: the starter model for the desktop.
//!
//! WHY. A new person who has not got an API key should still get an answer to their first message.
//! A hosted free model has a ceiling and a token that cannot be given to every installed app
//! (docs/ark/22-starter-model.md), so the starter model for the desktop is one that runs here: free for
//! ever, private, offline, with no queue and nothing to sign up for. This is "option 1" at setup; the
//! company's hosted model is "option 2", and a person's own key or server is the third way in.
//!
//! WHAT THIS FILE DOES, and the order a first run needs it in:
//!
//! 1. [`detect`] reads how much memory the computer has.
//! 2. [`recommend`] answers which model fits it, or that none does and why.
//! 3. [`download_verified`] fetches the model's file, resumably, and refuses it unless its SHA-256 is the
//!    pinned one. A half-finished 5 GB download is the normal case on a home connection, not the
//!    exception, so a restart picks up where it stopped.
//!
//! Running the model server and registering it as the person's model come next, in later pieces.
//!
//! THE MODELS ARE PINNED, for the reason `install.rs` pins the container engine: a name is what somebody
//! hopes is there, a digest is what was tested. They are Google's own builds, Apache 2.0 (decision D6
//! requires a permissive licence), with the quantisation-aware 4-bit weights, read from Hugging Face on
//! 2026-10-16. The memory each needs is the file plus working memory plus the operating system, which is
//! why E2B is offered from 8 GB and E4B from 12 GB.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::problem::Problem;

const GIB: u64 = 1024 * 1024 * 1024;

/// What the computer has that decides which model it can run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    /// Physical memory, in bytes.
    pub ram_bytes: u64,
    /// Logical processors.
    pub cores: usize,
}

impl Machine {
    pub fn ram_gib(&self) -> f64 {
        self.ram_bytes as f64 / GIB as f64
    }
}

/// A model the desktop can fetch and run.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    /// The name the model server answers to, and the name the stack is told to use.
    pub id: &'static str,
    /// For the setup screen.
    pub label: &'static str,
    /// Hugging Face repository.
    pub repo: &'static str,
    /// The file in that repository. Named here, not taken from a redirect.
    pub file: &'static str,
    pub size_bytes: u64,
    pub sha256: &'static str,
    /// The smallest memory it is offered at, in GiB as the operating system reports it. A computer sold
    /// as "8 GB" reports about 7.7, which is why these sit a little under the round numbers.
    pub min_ram_gib: f64,
}

impl LocalModel {
    pub fn url(&self) -> String {
        format!(
            "https://huggingface.co/{}/resolve/main/{}",
            self.repo, self.file
        )
    }

    /// The download size in the units a person understands.
    pub fn size_gb(&self) -> f64 {
        self.size_bytes as f64 / 1_000_000_000.0
    }
}

/// Gemma 4 E4B: the better of the two, for a computer with 12 GB or more.
pub const E4B: LocalModel = LocalModel {
    id: "gemma-4-e4b",
    label: "Gemma 4 E4B",
    repo: "google/gemma-4-E4B-it-qat-q4_0-gguf",
    file: "gemma-4-E4B_q4_0-it.gguf",
    size_bytes: 5_154_941_280,
    sha256: "676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee",
    min_ram_gib: 11.0,
};

/// Gemma 4 E2B: smaller and quicker, weaker, for a computer with 8 GB.
pub const E2B: LocalModel = LocalModel {
    id: "gemma-4-e2b",
    label: "Gemma 4 E2B",
    repo: "google/gemma-4-E2B-it-qat-q4_0-gguf",
    file: "gemma-4-E2B_q4_0-it.gguf",
    size_bytes: 3_349_516_256,
    sha256: "fa401b55b07ee70a54c6dae3903c783a6e65064312529ea57175cb5f8dec6634",
    min_ram_gib: 7.0,
};

/// Best first.
pub const MODELS: [&LocalModel; 2] = [&E4B, &E2B];

/// What the setup screen is told about this computer.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Recommendation {
    /// This model fits.
    Model { model: &'static LocalModel },
    /// Nothing fits, and the sentence that says so, with what would.
    TooSmall {
        ram_gib: f64,
        needs_gib: f64,
        said: String,
    },
}

/// The best model this computer can run.
///
/// "Can run" is generous on purpose: a person who has chosen to run a model here would rather have a
/// slow answer than none. The screen says what to expect (a small model is weaker at using tools and
/// browsing than the large hosted ones, and slower on a computer without a graphics card).
pub fn recommend(machine: &Machine) -> Recommendation {
    let ram = machine.ram_gib();
    for model in MODELS {
        if ram >= model.min_ram_gib {
            return Recommendation::Model { model };
        }
    }
    let needs = E2B.min_ram_gib;
    Recommendation::TooSmall {
        ram_gib: ram,
        needs_gib: needs,
        said: format!(
            "This computer has about {ram:.0} GB of memory, and the smallest model needs about 8 GB. \
             Use ArkAgent's server or your own key instead."
        ),
    }
}

// ---- reading the machine ----------------------------------------------------------------------------

/// This computer's memory and processors, or a sentence saying it could not be read.
pub fn detect() -> Result<Machine, Problem> {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    let ram_bytes = physical_memory_bytes()?;
    Ok(Machine { ram_bytes, cores })
}

fn physical_memory_bytes() -> Result<u64, Problem> {
    let unreadable = |detail: String| {
        Problem::with(
            "ArkAgent could not tell how much memory this computer has, so it cannot choose a model \
             for it.",
            detail,
        )
    };
    match std::env::consts::OS {
        "linux" => {
            let text = fs::read_to_string("/proc/meminfo")
                .map_err(|error| unreadable(format!("/proc/meminfo: {error}")))?;
            parse_meminfo(&text).ok_or_else(|| unreadable("no MemTotal in /proc/meminfo".into()))
        }
        "macos" => {
            let output = crate::quiet::command("sysctl")
                .args(["-n", "hw.memsize"])
                .output()
                .map_err(|error| unreadable(format!("sysctl: {error}")))?;
            parse_plain_bytes(&String::from_utf8_lossy(&output.stdout))
                .ok_or_else(|| unreadable("sysctl hw.memsize gave no number".into()))
        }
        "windows" => {
            let output = crate::quiet::command("powershell")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
                ])
                .output()
                .map_err(|error| unreadable(format!("powershell: {error}")))?;
            parse_plain_bytes(&String::from_utf8_lossy(&output.stdout)).ok_or_else(|| {
                unreadable("PowerShell gave no number for TotalPhysicalMemory".into())
            })
        }
        other => Err(unreadable(format!("no way to read memory on {other}"))),
    }
}

/// `MemTotal:       16318464 kB` from `/proc/meminfo`, in bytes.
pub fn parse_meminfo(text: &str) -> Option<u64> {
    let line = text.lines().find(|line| line.starts_with("MemTotal:"))?;
    let kilobytes: u64 = line
        .trim_start_matches("MemTotal:")
        .trim()
        .trim_end_matches("kB")
        .trim()
        .parse()
        .ok()?;
    kilobytes.checked_mul(1024)
}

/// A command that prints one number of bytes, with whatever whitespace the shell added.
pub fn parse_plain_bytes(text: &str) -> Option<u64> {
    let bytes: u64 = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())?
        .parse()
        .ok()?;
    (bytes > 0).then_some(bytes)
}

// ---- fetching a model -------------------------------------------------------------------------------

/// How far a download has got.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub downloaded: u64,
    pub total: u64,
}

const CHUNK: usize = 256 * 1024;

/// Fetch `url` into `dest`, resumably, and refuse it unless it is `expected_size` bytes with this
/// SHA-256.
///
/// **Resumable**, because the file is gigabytes: bytes already on disk are kept in `<dest>.part` and the
/// next attempt asks for the rest with a `Range` header. A server that ignores the range and sends the
/// whole file again is handled by starting the part over, not by appending a second copy to the first.
///
/// **Verified before it is trusted**, never as it streams: a resumed file is hashed whole, once, at the
/// end, so the check covers every byte whichever attempt wrote it. A file that fails is deleted, since
/// resuming from corrupt bytes would fail the same way every time.
///
/// **Cancellable**: `cancel` is checked between chunks, and a cancelled download leaves its part file
/// for the next attempt.
///
/// A finished, verified file already at `dest` is returned without a request.
pub fn download_verified(
    url: &str,
    dest: &Path,
    expected_size: u64,
    sha256: &str,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(Progress),
) -> Result<PathBuf, Problem> {
    if let Ok(meta) = fs::metadata(dest) {
        if meta.len() == expected_size && hash_file(dest).is_ok_and(|got| got == sha256) {
            on_progress(Progress {
                downloaded: expected_size,
                total: expected_size,
            });
            return Ok(dest.to_path_buf());
        }
        // The wrong size or digest: not ours to keep.
        let _ = fs::remove_file(dest);
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|error| unwritable(parent, &error))?;
    }
    let part = part_path(dest);

    let mut have = fs::metadata(&part).map(|meta| meta.len()).unwrap_or(0);
    if have > expected_size {
        // More than the file can be: not a prefix of it.
        let _ = fs::remove_file(&part);
        have = 0;
    }

    if have < expected_size {
        stream_into(url, &part, have, expected_size, cancel, on_progress)?;
    }

    let got_size = fs::metadata(&part).map(|meta| meta.len()).unwrap_or(0);
    if got_size != expected_size {
        let _ = fs::remove_file(&part);
        return Err(Problem::with(
            "What ArkAgent downloaded is not the size it was expecting, so it has not been used. \
             Try again.",
            format!("{url}: expected {expected_size} bytes, have {got_size}"),
        ));
    }
    let got = hash_file(&part).map_err(|error| unwritable(&part, &error))?;
    if got != sha256 {
        let _ = fs::remove_file(&part);
        return Err(Problem::with(
            "What ArkAgent downloaded is not what it was expecting, so it has not been used. Try \
             again.",
            format!("{url}: expected sha256 {sha256}, got {got}"),
        ));
    }
    fs::rename(&part, dest).map_err(|error| unwritable(dest, &error))?;
    Ok(dest.to_path_buf())
}

fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.as_os_str().to_os_string();
    name.push(".part");
    PathBuf::from(name)
}

fn stream_into(
    url: &str,
    part: &Path,
    mut have: u64,
    expected_size: u64,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(Progress),
) -> Result<(), Problem> {
    let offline = |detail: String| {
        Problem::with(
            "ArkAgent could not download the model. Check the internet connection and try again; \
             what has been downloaded is kept.",
            detail,
        )
    };
    // No overall timeout: a 5 GB file takes as long as it takes. A stalled connection is caught by
    // the read timeout instead.
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(None::<Duration>)
        .build()
        .map_err(|error| offline(error.to_string()))?;

    let mut request = client.get(url);
    if have > 0 {
        request = request.header("Range", format!("bytes={have}-"));
    }
    let mut response = request
        .send()
        .map_err(|error| offline(format!("{url}: {error}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(offline(format!("{url}: HTTP {status}")));
    }
    let resumed = status.as_u16() == 206;
    if have > 0 && !resumed {
        // The server sent the whole file again: start the part over rather than append to it.
        have = 0;
    }

    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(have == 0)
        .open(part)
        .map_err(|error| unwritable(part, &error))?;
    file.seek(SeekFrom::Start(have))
        .map_err(|error| unwritable(part, &error))?;

    let mut buffer = vec![0u8; CHUNK];
    let mut downloaded = have;
    on_progress(Progress {
        downloaded,
        total: expected_size,
    });
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(Problem::plain("The download was stopped."));
        }
        let read = response
            .read(&mut buffer)
            .map_err(|error| offline(format!("{url}: {error}")))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|error| unwritable(part, &error))?;
        downloaded += read as u64;
        on_progress(Progress {
            downloaded,
            total: expected_size,
        });
    }
    file.flush().map_err(|error| unwritable(part, &error))?;
    Ok(())
}

/// The SHA-256 of a file, streamed, so a multi-gigabyte model is not held in memory.
pub fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; CHUNK];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// One sentence for every "could not write here", with the disk-full case named because it is the
/// likely one for a file this size.
fn unwritable(path: &Path, error: &dyn std::fmt::Display) -> Problem {
    let text = error.to_string();
    let full = text.contains("No space left")
        || text.contains("not enough space")
        || text.contains("disk is full")
        || text.contains("os error 28")
        || text.contains("os error 112")
        || text.contains("os error 39");
    let said = if full {
        "There is not enough free disk space for the model. Free some space and try again."
    } else {
        "ArkAgent could not save the model it downloaded. Check there is free disk space and try again."
    };
    Problem::with(said, format!("{}: {text}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    use std::sync::atomic::AtomicUsize;
    use std::sync::{Arc, Mutex};

    fn machine(gib: f64) -> Machine {
        Machine {
            ram_bytes: (gib * GIB as f64) as u64,
            cores: 8,
        }
    }

    // ---- the recommendation -------------------------------------------------------------------

    #[test]
    fn a_big_computer_gets_the_better_model() {
        for gib in [11.0, 15.8, 31.9, 63.0] {
            assert_eq!(
                recommend(&machine(gib)),
                Recommendation::Model { model: &E4B },
                "{gib} GiB"
            );
        }
    }

    #[test]
    fn a_computer_sold_as_eight_gigabytes_gets_the_smaller_one() {
        // Windows reports an "8 GB" machine as about 7.7 GiB, and a "12 GB" one as about 11.7.
        assert_eq!(
            recommend(&machine(7.7)),
            Recommendation::Model { model: &E2B }
        );
        assert_eq!(
            recommend(&machine(10.9)),
            Recommendation::Model { model: &E2B }
        );
        assert_eq!(
            recommend(&machine(11.7)),
            Recommendation::Model { model: &E4B }
        );
    }

    #[test]
    fn a_small_computer_is_told_so_and_pointed_elsewhere() {
        match recommend(&machine(4.0)) {
            Recommendation::TooSmall {
                ram_gib,
                needs_gib,
                said,
            } => {
                assert!((ram_gib - 4.0).abs() < 0.01);
                assert!(needs_gib >= 7.0);
                assert!(said.contains("4 GB"));
                assert!(said.contains("server"));
            }
            other => panic!("expected TooSmall, got {other:?}"),
        }
    }

    #[test]
    fn the_models_are_pinned_and_best_first() {
        assert_eq!(MODELS[0].id, "gemma-4-e4b");
        assert_eq!(MODELS[1].id, "gemma-4-e2b");
        for model in MODELS {
            assert_eq!(model.sha256.len(), 64, "{}", model.id);
            assert!(model.sha256.chars().all(|c| c.is_ascii_hexdigit()));
            assert!(model.url().starts_with("https://huggingface.co/google/"));
            assert!(model.url().ends_with(model.file));
            // Google's own repositories, never a third party's repackaging.
            assert!(model.repo.starts_with("google/"), "{}", model.id);
        }
        // The better model needs more memory, or the order would be a lie.
        let (better, smaller) = (MODELS[0], MODELS[1]);
        assert!(better.min_ram_gib > smaller.min_ram_gib);
        assert!(better.size_bytes > smaller.size_bytes);
    }

    // ---- reading the machine ------------------------------------------------------------------

    #[test]
    fn reads_a_linux_meminfo() {
        let text = "MemTotal:       16318464 kB\nMemFree:         1234 kB\n";
        assert_eq!(parse_meminfo(text), Some(16_318_464 * 1024));
        assert_eq!(parse_meminfo("MemFree: 1 kB\n"), None);
        assert_eq!(parse_meminfo("MemTotal: lots kB\n"), None);
    }

    #[test]
    fn reads_the_one_number_a_shell_command_prints() {
        assert_eq!(parse_plain_bytes("17179869184\n"), Some(17_179_869_184));
        assert_eq!(
            parse_plain_bytes("\r\n  8589934592  \r\n"),
            Some(8_589_934_592)
        );
        assert_eq!(parse_plain_bytes(""), None);
        assert_eq!(parse_plain_bytes("0\n"), None);
        assert_eq!(parse_plain_bytes("not a number\n"), None);
    }

    #[test]
    fn this_computer_can_be_read() {
        // Whatever runs the tests has memory and processors.
        let detected = detect().expect("detect");
        assert!(detected.ram_bytes > 0);
        assert!(detected.cores >= 1);
    }

    // ---- a small web server that can be made to misbehave -------------------------------------

    #[derive(Default)]
    struct Behaviour {
        /// Close the connection after this many body bytes, once.
        drop_after: Mutex<Option<usize>>,
        /// Answer 200 with the whole file even when a range is asked for.
        ignore_range: bool,
        ranges_seen: Mutex<Vec<String>>,
        requests: AtomicUsize,
    }

    fn serve(body: Vec<u8>, behaviour: Arc<Behaviour>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let behaviour = behaviour.clone();
                let body = body.clone();
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut range: Option<u64> = None;
                    let mut line = String::new();
                    loop {
                        line.clear();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 {
                            return;
                        }
                        let lower = line.to_ascii_lowercase();
                        if let Some(value) = lower.strip_prefix("range: bytes=") {
                            behaviour
                                .ranges_seen
                                .lock()
                                .unwrap()
                                .push(value.trim().into());
                            range = value.trim().trim_end_matches('-').parse().ok();
                        }
                        if line == "\r\n" {
                            break;
                        }
                    }
                    behaviour.requests.fetch_add(1, Ordering::SeqCst);
                    let (status, slice, extra) = match range {
                        Some(start) if !behaviour.ignore_range && (start as usize) < body.len() => {
                            (
                                "206 Partial Content",
                                &body[start as usize..],
                                format!(
                                    "Content-Range: bytes {start}-{}/{}\r\n",
                                    body.len() - 1,
                                    body.len()
                                ),
                            )
                        }
                        _ => ("200 OK", &body[..], String::new()),
                    };
                    let head = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n",
                        slice.len()
                    );
                    let _ = stream.write_all(head.as_bytes());
                    let cut = behaviour.drop_after.lock().unwrap().take();
                    match cut {
                        Some(n) => {
                            let _ = stream.write_all(&slice[..n.min(slice.len())]);
                            let _ = stream.flush();
                            // Hang up mid-body, the way a dropped connection does.
                        }
                        None => {
                            let _ = stream.write_all(slice);
                        }
                    }
                });
            }
        });
        format!("http://{address}/model.gguf")
    }

    fn sha(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    fn sample(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i * 31 % 251) as u8).collect()
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "arkagent-local-model-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn fetch(url: &str, dest: &Path, body: &[u8], cancel: &AtomicBool) -> Result<PathBuf, Problem> {
        download_verified(
            url,
            dest,
            body.len() as u64,
            &sha(body),
            cancel,
            &mut |_| {},
        )
    }

    #[test]
    fn downloads_and_verifies_a_file() {
        let body = sample(1_000_000);
        let url = serve(body.clone(), Arc::new(Behaviour::default()));
        let dir = scratch("whole");
        let dest = dir.join("m.gguf");
        let mut last = Progress {
            downloaded: 0,
            total: 0,
        };
        let path = download_verified(
            &url,
            &dest,
            body.len() as u64,
            &sha(&body),
            &AtomicBool::new(false),
            &mut |p| {
                assert!(p.downloaded >= last.downloaded, "progress went backwards");
                last = p;
            },
        )
        .expect("download");
        assert_eq!(fs::read(&path).unwrap(), body);
        assert_eq!(
            last,
            Progress {
                downloaded: body.len() as u64,
                total: body.len() as u64
            }
        );
        assert!(
            !part_path(&dest).exists(),
            "the part file is gone once it is the file"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_file_with_the_wrong_digest_is_refused_and_deleted() {
        let body = sample(300_000);
        let url = serve(body.clone(), Arc::new(Behaviour::default()));
        let dir = scratch("wrong-digest");
        let dest = dir.join("m.gguf");
        let error = download_verified(
            &url,
            &dest,
            body.len() as u64,
            &sha(b"something else"),
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap_err();
        assert!(error.said.contains("not what it was expecting"));
        assert!(error.detail.unwrap().contains("expected sha256"));
        assert!(
            !dest.exists(),
            "never leaves an unverified file where the real one goes"
        );
        assert!(
            !part_path(&dest).exists(),
            "and does not keep bytes it cannot trust"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_file_of_the_wrong_size_is_refused() {
        let body = sample(300_000);
        let url = serve(body.clone(), Arc::new(Behaviour::default()));
        let dir = scratch("wrong-size");
        let dest = dir.join("m.gguf");
        let error = download_verified(
            &url,
            &dest,
            body.len() as u64 + 10,
            &sha(&body),
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap_err();
        assert!(error.said.contains("not the size"));
        assert!(!dest.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_dropped_connection_is_picked_up_where_it_stopped() {
        let body = sample(2_000_000);
        let behaviour = Arc::new(Behaviour::default());
        *behaviour.drop_after.lock().unwrap() = Some(700_000);
        let url = serve(body.clone(), behaviour.clone());
        let dir = scratch("resume");
        let dest = dir.join("m.gguf");

        let first = fetch(&url, &dest, &body, &AtomicBool::new(false));
        assert!(first.is_err(), "the first attempt lost its connection");
        let kept = fs::metadata(part_path(&dest)).unwrap().len();
        assert!(kept > 0 && kept < body.len() as u64, "kept {kept} bytes");

        let path = fetch(&url, &dest, &body, &AtomicBool::new(false)).expect("resume");
        assert_eq!(fs::read(path).unwrap(), body);
        let ranges = behaviour.ranges_seen.lock().unwrap().clone();
        assert_eq!(
            ranges.len(),
            1,
            "the second attempt asked for the rest: {ranges:?}"
        );
        assert_eq!(
            ranges[0].trim_end_matches('-').parse::<u64>().unwrap(),
            kept
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_server_that_ignores_the_range_does_not_get_a_second_copy_appended() {
        let body = sample(800_000);
        let behaviour = Arc::new(Behaviour {
            ignore_range: true,
            ..Behaviour::default()
        });
        let url = serve(body.clone(), behaviour);
        let dir = scratch("ignore-range");
        let dest = dir.join("m.gguf");
        fs::create_dir_all(&dir).unwrap();
        // A part file that is the right prefix.
        fs::write(part_path(&dest), &body[..300_000]).unwrap();
        let path = fetch(&url, &dest, &body, &AtomicBool::new(false)).expect("restart");
        assert_eq!(fs::read(path).unwrap(), body);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_part_file_longer_than_the_file_is_discarded() {
        let body = sample(200_000);
        let url = serve(body.clone(), Arc::new(Behaviour::default()));
        let dir = scratch("overlong");
        let dest = dir.join("m.gguf");
        fs::create_dir_all(&dir).unwrap();
        fs::write(part_path(&dest), sample(900_000)).unwrap();
        let path = fetch(&url, &dest, &body, &AtomicBool::new(false)).expect("fresh start");
        assert_eq!(fs::read(path).unwrap(), body);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_finished_verified_file_is_not_fetched_again() {
        let body = sample(150_000);
        let behaviour = Arc::new(Behaviour::default());
        let url = serve(body.clone(), behaviour.clone());
        let dir = scratch("cached");
        let dest = dir.join("m.gguf");
        fetch(&url, &dest, &body, &AtomicBool::new(false)).expect("first");
        assert_eq!(behaviour.requests.load(Ordering::SeqCst), 1);
        fetch(&url, &dest, &body, &AtomicBool::new(false)).expect("second");
        assert_eq!(
            behaviour.requests.load(Ordering::SeqCst),
            1,
            "no second request"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_corrupt_file_already_there_is_replaced() {
        let body = sample(150_000);
        let url = serve(body.clone(), Arc::new(Behaviour::default()));
        let dir = scratch("corrupt");
        let dest = dir.join("m.gguf");
        fs::create_dir_all(&dir).unwrap();
        fs::write(&dest, vec![0u8; body.len()]).unwrap();
        let path = fetch(&url, &dest, &body, &AtomicBool::new(false)).expect("replace");
        assert_eq!(fs::read(path).unwrap(), body);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_cancelled_download_stops_and_keeps_what_it_has() {
        let body = sample(3_000_000);
        let url = serve(body.clone(), Arc::new(Behaviour::default()));
        let dir = scratch("cancel");
        let dest = dir.join("m.gguf");
        let cancel = AtomicBool::new(false);
        let error = download_verified(
            &url,
            &dest,
            body.len() as u64,
            &sha(&body),
            &cancel,
            &mut |p| {
                if p.downloaded > 400_000 {
                    cancel.store(true, Ordering::Relaxed);
                }
            },
        )
        .unwrap_err();
        assert_eq!(error.said, "The download was stopped.");
        assert!(!dest.exists());
        assert!(part_path(&dest).exists(), "kept for the next attempt");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn an_unreachable_server_is_a_sentence_about_the_connection() {
        let dir = scratch("offline");
        let dest = dir.join("m.gguf");
        let error = download_verified(
            "http://127.0.0.1:1/model.gguf",
            &dest,
            10,
            &sha(b"x"),
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap_err();
        assert!(error.said.contains("internet connection"));
        assert!(error.said.contains("kept"));
        let _ = fs::remove_dir_all(dir);
    }
}
