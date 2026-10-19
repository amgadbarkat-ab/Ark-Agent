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
    /// A graphics card the model program can use (an NVIDIA, AMD or Intel Arc card on Windows). Read
    /// from the operating system's own list of video controllers; where it cannot be read this is false,
    /// which is the safe answer, because the CPU build runs on every machine.
    pub gpu: bool,
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

/// Gemma 4 E4B: the first of the small pair, for a computer with 12 GB or more.
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

/// Gemma 4 12B: the first size that does tool use and long tasks well, for a computer with 16 GB or more.
pub const G12B: LocalModel = LocalModel {
    id: "gemma-4-12b",
    label: "Gemma 4 12B",
    repo: "google/gemma-4-12B-it-qat-q4_0-gguf",
    file: "gemma-4-12b-it-qat-q4_0.gguf",
    size_bytes: 6_975_879_296,
    sha256: "93567e57a8fe10b23569b9d9ec38cd005deedf71e29477c421a4b83f418a538b",
    min_ram_gib: 15.0,
};

/// Gemma 4 26B A4B: a mixture of experts, 26 billion parameters of which about 4 billion work on any one word,
/// so it answers about as fast as the small models while being far more capable. It is the best a computer
/// with 28 GB or more can run, and the one to use for an agent that has to plan and use tools.
pub const G26B: LocalModel = LocalModel {
    id: "gemma-4-26b-a4b",
    label: "Gemma 4 26B A4B",
    repo: "google/gemma-4-26B-A4B-it-qat-q4_0-gguf",
    file: "gemma-4-26B_q4_0-it.gguf",
    size_bytes: 14_439_363_584,
    sha256: "3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d",
    min_ram_gib: 27.0,
};

/// Best first.
pub const MODELS: [&LocalModel; 4] = [&G26B, &G12B, &E4B, &E2B];

/// Every model this computer can run, best first: what the setup screen offers, with the first one
/// recommended.
pub fn fitting(machine: &Machine) -> Vec<&'static LocalModel> {
    let ram = machine.ram_gib();
    MODELS
        .iter()
        .copied()
        .filter(|model| ram >= model.min_ram_gib)
        .collect()
}

/// A model by the name the setup screen sends.
pub fn by_id(id: &str) -> Option<&'static LocalModel> {
    MODELS.iter().copied().find(|model| model.id == id)
}

/// What the setup screen is told about this computer.
#[derive(Debug, PartialEq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
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
    Ok(Machine {
        ram_bytes,
        cores,
        gpu: has_graphics_card(),
    })
}

/// Whether this computer has a graphics card worth handing the model to.
///
/// Only Windows is asked, because it is the one place the choice of program depends on it (macOS on Apple
/// silicon always uses its graphics chip, and the other builds are CPU). A card is recognised by its maker's
/// name in the list of video controllers; Microsoft's basic display adapter and a virtual machine's
/// adapter are not cards.
fn has_graphics_card() -> bool {
    if std::env::consts::OS != "windows" {
        return false;
    }
    crate::quiet::command("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-CimInstance Win32_VideoController).Name",
        ])
        .output()
        .map(|output| names_a_graphics_card(&String::from_utf8_lossy(&output.stdout)))
        .unwrap_or(false)
}

/// Whether a list of video controller names, one per line, includes a card.
pub fn names_a_graphics_card(names: &str) -> bool {
    names.lines().any(|line| {
        let name = line.to_ascii_lowercase();
        name.contains("nvidia")
            || name.contains("geforce")
            || name.contains("quadro")
            || name.contains("radeon")
            || name.contains("amd ")
            || name.contains("arc(tm)")
            || name.contains("intel arc")
            || name.contains("intel(r) arc")
    })
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

/// The sentence for a download that lost its connection. A constant, because the retrying wrapper recognises a
/// connection problem by it and a permanent one (a wrong digest, a full disk) by its absence.
const CONNECTION_LOST: &str =
    "ArkAgent could not download the model. Check the internet connection and try \
     again; what has been downloaded is kept.";

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

/// How hard to try before telling a person a download has paused.
#[derive(Clone, Copy, Debug)]
pub struct Persistence {
    /// Attempts in a row that moved the download on by not one byte, before giving up. An attempt that
    /// made progress resets the count, so a poor connection that keeps advancing is never abandoned.
    pub fruitless: u32,
    /// The wait after the first failure; it doubles up to `longest_pause`.
    pub first_pause: Duration,
    pub longest_pause: Duration,
}

impl Persistence {
    /// A home connection: a file of five or fifteen gigabytes is not fetched in one unbroken stream by
    /// every router and every provider, and the person is not there to press the button each time.
    pub const PATIENT: Self = Self {
        fruitless: 6,
        first_pause: Duration::from_secs(2),
        longest_pause: Duration::from_secs(30),
    };
}

/// Whether a failure is one more attempt could cure: the connection, and not the file or the disk.
fn is_transient(problem: &Problem) -> bool {
    if problem.said != CONNECTION_LOST {
        return false;
    }
    // A server that says the file is not there, or that we may not have it, will say so again.
    let detail = problem.detail.as_deref().unwrap_or("");
    let refused = detail.contains(": HTTP 4")
        && !detail.contains(": HTTP 408")
        && !detail.contains(": HTTP 429");
    !refused
}

fn pause_unless_cancelled(wait: Duration, cancel: &AtomicBool) {
    let step = Duration::from_millis(100);
    let mut left = wait;
    while !left.is_zero() && !cancel.load(Ordering::Relaxed) {
        let now = left.min(step);
        std::thread::sleep(now);
        left -= now;
    }
}

fn bytes_on_disk(dest: &Path) -> u64 {
    fs::metadata(part_path(dest))
        .map(|meta| meta.len())
        .unwrap_or(0)
}

/// `download_verified`, trying again by itself when the connection drops.
///
/// Every attempt resumes from the bytes already on disk, so a drop at 4.3 GB of 5.2 costs a pause and not a
/// restart, and costs the person nothing: they are told only if it has stopped moving altogether, in a
/// sentence that says how far it got and that pressing Continue picks it up again.
pub fn download_with_retries(
    url: &str,
    dest: &Path,
    expected_size: u64,
    sha256: &str,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(Progress),
    persistence: Persistence,
) -> Result<PathBuf, Problem> {
    let mut fruitless = 0u32;
    let mut pause = persistence.first_pause;
    loop {
        let before = bytes_on_disk(dest);
        let problem = match download_verified(url, dest, expected_size, sha256, cancel, on_progress)
        {
            Ok(path) => return Ok(path),
            Err(problem) => problem,
        };
        if !is_transient(&problem) || cancel.load(Ordering::Relaxed) {
            return Err(problem);
        }
        let after = bytes_on_disk(dest);
        if after > before {
            fruitless = 0;
            pause = persistence.first_pause;
        } else {
            fruitless += 1;
        }
        if fruitless >= persistence.fruitless {
            let (got, of) = (after as f64 / 1e9, expected_size as f64 / 1e9);
            return Err(Problem::with(
                format!(
                    "The download paused at {got:.1} GB of {of:.1} GB because the connection kept dropping. \
                     Press Continue and it picks up where it stopped."
                ),
                problem.detail.unwrap_or_default(),
            ));
        }
        pause_unless_cancelled(pause, cancel);
        pause = (pause * 2).min(persistence.longest_pause);
    }
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
    let offline = |detail: String| Problem::with(CONNECTION_LOST, detail);
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
            gpu: false,
        }
    }

    // ---- the recommendation -------------------------------------------------------------------

    #[test]
    fn a_bigger_computer_gets_the_bigger_model() {
        for gib in [11.0, 12.0, 14.9] {
            assert_eq!(
                recommend(&machine(gib)),
                Recommendation::Model { model: &E4B },
                "{gib} GiB"
            );
        }
        for gib in [15.0, 16.0, 26.9] {
            assert_eq!(
                recommend(&machine(gib)),
                Recommendation::Model { model: &G12B },
                "{gib} GiB"
            );
        }
        // A computer sold as 32 GB reports about 31.7.
        for gib in [27.0, 31.7, 63.0] {
            assert_eq!(
                recommend(&machine(gib)),
                Recommendation::Model { model: &G26B },
                "{gib} GiB"
            );
        }
    }

    #[test]
    fn every_model_that_fits_is_offered_best_first() {
        let ids = |gib: f64| {
            fitting(&machine(gib))
                .iter()
                .map(|model| model.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            ids(31.7),
            [
                "gemma-4-26b-a4b",
                "gemma-4-12b",
                "gemma-4-e4b",
                "gemma-4-e2b"
            ]
        );
        assert_eq!(ids(16.0), ["gemma-4-12b", "gemma-4-e4b", "gemma-4-e2b"]);
        assert_eq!(ids(7.7), ["gemma-4-e2b"]);
        assert!(ids(4.0).is_empty());
        assert_eq!(by_id("gemma-4-12b"), Some(&G12B));
        assert_eq!(by_id("gemma-9"), None);
    }

    #[test]
    fn graphics_cards_are_told_from_the_rest() {
        assert!(names_a_graphics_card(
            "NVIDIA GeForce RTX 4070 Laptop GPU\r\nIntel(R) UHD Graphics\r\n"
        ));
        assert!(names_a_graphics_card("AMD Radeon RX 7800 XT\n"));
        assert!(names_a_graphics_card("Intel(R) Arc(TM) A770 Graphics\n"));
        assert!(!names_a_graphics_card("Microsoft Basic Display Adapter\n"));
        assert!(!names_a_graphics_card("Intel(R) UHD Graphics 620\r\n"));
        assert!(!names_a_graphics_card("Microsoft Hyper-V Video\n"));
        assert!(!names_a_graphics_card(""));
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
    fn the_recommendation_reaches_the_window_in_camel_case() {
        let value = serde_json::to_value(recommend(&Machine {
            ram_bytes: 12 * GIB,
            cores: 8,
            gpu: false,
        }))
        .unwrap();
        assert_eq!(value["kind"], "model");
        assert_eq!(value["model"]["id"], "gemma-4-e4b");
        assert_eq!(value["model"]["sizeBytes"], 5_154_941_280u64);
        let small = serde_json::to_value(recommend(&Machine {
            ram_bytes: 4 * GIB,
            cores: 2,
            gpu: false,
        }))
        .unwrap();
        assert_eq!(small["kind"], "tooSmall");
        assert!(small["said"].as_str().unwrap().contains("8 GB"));
        assert!(small["ramGib"].as_f64().unwrap() > 3.0);
        assert!(small["needsGib"].as_f64().unwrap() > 6.0);
    }

    #[test]
    fn the_models_are_pinned_and_best_first() {
        let ids: Vec<_> = MODELS.iter().map(|model| model.id).collect();
        assert_eq!(
            ids,
            [
                "gemma-4-26b-a4b",
                "gemma-4-12b",
                "gemma-4-e4b",
                "gemma-4-e2b"
            ]
        );
        for model in MODELS {
            assert_eq!(model.sha256.len(), 64, "{}", model.id);
            assert!(model.sha256.chars().all(|c| c.is_ascii_hexdigit()));
            assert!(model.url().starts_with("https://huggingface.co/google/"));
            assert!(model.url().ends_with(model.file));
            // Google's own repositories, never a third party's repackaging.
            assert!(model.repo.starts_with("google/"), "{}", model.id);
        }
        // Each better model needs more memory and is a bigger file, or the order would be a lie.
        for pair in MODELS.windows(2) {
            let (better, smaller) = (pair[0], pair[1]);
            assert!(better.min_ram_gib > smaller.min_ram_gib, "{}", better.id);
            assert!(better.size_bytes > smaller.size_bytes, "{}", better.id);
        }
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

    // ---- trying again by itself ---------------------------------------------------------------

    const QUICK: Persistence = Persistence {
        fruitless: 3,
        first_pause: Duration::from_millis(1),
        longest_pause: Duration::from_millis(2),
    };

    fn fetch_patiently(
        url: &str,
        dest: &Path,
        body: &[u8],
        persistence: Persistence,
    ) -> Result<PathBuf, Problem> {
        download_with_retries(
            url,
            dest,
            body.len() as u64,
            &sha(body),
            &AtomicBool::new(false),
            &mut |_| {},
            persistence,
        )
    }

    #[test]
    fn a_dropped_connection_is_retried_without_anybody_pressing_anything() {
        let body = sample(2_000_000);
        let behaviour = Arc::new(Behaviour::default());
        *behaviour.drop_after.lock().unwrap() = Some(700_000);
        let url = serve(body.clone(), behaviour.clone());
        let dir = scratch("auto-resume");
        let dest = dir.join("m.gguf");
        let path = fetch_patiently(&url, &dest, &body, QUICK).expect("finishes on its own");
        assert_eq!(fs::read(path).unwrap(), body);
        // The second request asked only for the rest.
        let ranges = behaviour.ranges_seen.lock().unwrap().clone();
        assert_eq!(ranges.len(), 1, "{ranges:?}");
        assert!(ranges[0].trim_end_matches('-').parse::<u64>().unwrap() > 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_connection_that_never_comes_back_is_reported_as_paused_with_how_far_it_got() {
        let dir = scratch("paused");
        let dest = dir.join("m.gguf");
        fs::create_dir_all(&dir).unwrap();
        fs::write(part_path(&dest), vec![1u8; 4_300_000]).unwrap();
        let error = download_with_retries(
            "http://127.0.0.1:1/model.gguf",
            &dest,
            5_200_000,
            &sha(b"x"),
            &AtomicBool::new(false),
            &mut |_| {},
            QUICK,
        )
        .unwrap_err();
        assert!(
            error
                .said
                .starts_with("The download paused at 0.0 GB of 0.0 GB"),
            "{}",
            error.said
        );
        assert!(error.said.contains("Press Continue"));
        assert!(part_path(&dest).exists(), "what was downloaded is kept");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_wrong_file_is_not_retried() {
        let body = sample(120_000);
        let behaviour = Arc::new(Behaviour::default());
        let url = serve(body.clone(), behaviour.clone());
        let dir = scratch("no-retry");
        let dest = dir.join("m.gguf");
        let error = download_with_retries(
            &url,
            &dest,
            body.len() as u64,
            &"0".repeat(64),
            &AtomicBool::new(false),
            &mut |_| {},
            QUICK,
        )
        .unwrap_err();
        assert!(
            error.said.contains("not what it was expecting"),
            "{}",
            error.said
        );
        assert_eq!(behaviour.requests.load(Ordering::SeqCst), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn only_the_connection_is_worth_another_attempt() {
        let lost = |detail: &str| Problem::with(CONNECTION_LOST, detail);
        assert!(is_transient(&lost(
            "https://h/f: error sending request for url"
        )));
        assert!(is_transient(&lost(
            "https://h/f: HTTP 503 Service Unavailable"
        )));
        assert!(is_transient(&lost(
            "https://h/f: HTTP 429 Too Many Requests"
        )));
        assert!(!is_transient(&lost("https://h/f: HTTP 404 Not Found")));
        assert!(!is_transient(&lost("https://h/f: HTTP 403 Forbidden")));
        assert!(!is_transient(&Problem::plain("The download was stopped.")));
    }
}
