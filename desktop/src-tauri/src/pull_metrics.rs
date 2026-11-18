//! Metrics for an explicit image pull, before containers or provider sign-in start.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::time::Instant;

use serde::Deserialize;

use crate::engine::Address;
use crate::problem::Problem;
use serde::Serialize;

/// How an image download ended.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Success,
    Failure,
}

/// No image names, layer IDs, engine output, or credentials cross this boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PullMetrics {
    pub outcome: Outcome,
    /// Wall time of the pull command, excluding capability detection and container startup.
    pub duration_ms: u64,
    /// Download counters actually observed. None means the provider supplied no byte counters.
    /// This excludes extraction, cached image sizes, and unobserved bytes between progress updates.
    pub bytes: Option<u64>,
}

/// None preserves the existing implicit pull on providers without a missing-only pull policy.
/// Such a provider gets no pull metric: timing the later `up` would also measure startup.
/// Some(false) still measures explicit pulls, but the older progress format has unknown bytes.
/// Podman delegates to its selected external Compose provider through this same command path.
pub(crate) fn compose_pull_progress(engine: &Address) -> Option<bool> {
    let policy_help = engine
        .command()
        .args(["compose", "pull", "--help"])
        .output()
        .ok()?;
    if !policy_help.status.success()
        || !(option_advertises(&policy_help.stdout, "--policy", "missing")
            || option_advertises(&policy_help.stderr, "--policy", "missing"))
    {
        return None;
    }
    Some(
        engine
            .command()
            .args(["compose", "--help"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .is_some_and(|output| {
                supports_json_progress(&output.stdout) || supports_json_progress(&output.stderr)
            }),
    )
}

fn supports_json_progress(help: &[u8]) -> bool {
    option_advertises(help, "--progress", "json")
}

fn option_advertises(help: &[u8], flag: &str, value: &str) -> bool {
    let text = String::from_utf8_lossy(help);
    let Some((_, option)) = text.split_once(flag) else {
        return false;
    };
    option
        .split("--")
        .next()
        .unwrap_or_default()
        .split(|character: char| !character.is_ascii_alphabetic())
        .any(|word| word == value)
}

#[derive(Deserialize)]
struct Progress {
    id: String,
    parent_id: Option<String>,
    text: String,
    current: Option<u64>,
}

#[derive(Default)]
struct DownloadBytes(HashMap<String, u64>);

impl DownloadBytes {
    fn observe(&mut self, progress: Progress) {
        if progress.text == "Downloading"
            && !progress.id.is_empty()
            && !progress.parent_id.as_deref().unwrap_or_default().is_empty()
        {
            if let Some(current) = progress.current {
                self.0
                    .entry(progress.id)
                    .and_modify(|maximum| *maximum = (*maximum).max(current))
                    .or_insert(current);
            }
        }
    }

    fn total(&self) -> Option<u64> {
        if self.0.is_empty() {
            return None;
        }
        self.0
            .values()
            .try_fold(0_u64, |sum, current| sum.checked_add(*current))
    }
}

/// Compose's JSON writer carries Docker's byte counters as integers:
/// https://github.com/docker/compose/blob/v2.39.2/pkg/compose/pull.go#L391-L440
/// The same layer can appear beneath multiple services. Keep its maximum download counter,
/// regardless of parent, and never add extraction progress or the advertised total size.
fn download_bytes(stdout: &[u8], stderr: &[u8]) -> Option<u64> {
    let mut layers = DownloadBytes::default();
    for output in [stdout, stderr] {
        for line in output.split(|byte| *byte == b'\n') {
            let Ok(progress) = serde_json::from_slice::<Progress>(line) else {
                continue;
            };
            layers.observe(progress);
        }
    }
    layers.total()
}

/// Pull a provider sign-in image without starting its CLI or creating a container.
/// A tiny stdin Compose project gives the same missing-only policy and JSON progress as setup.
/// Older Compose providers use an explicit native pull after a local presence check.
pub fn pull_image(
    engine: &Address,
    image: &str,
    on_progress: impl FnMut(u64),
    on_complete: impl FnOnce(PullMetrics),
) -> Result<(), Problem> {
    if crate::preparation::image_present(engine, image)? {
        return Ok(());
    }
    let Some(json_progress) = compose_pull_progress(engine) else {
        let mut command = engine.command();
        command.args(["pull", image]);
        return run_with_progress(command, None, false, on_progress, on_complete);
    };
    let mut command = engine.command();
    command.arg("compose");
    if json_progress {
        command.args(["--progress", "json"]);
    }
    command.args([
        "--project-name",
        "openbot-image-pull",
        "-f",
        "-",
        "pull",
        "--policy",
        "missing",
    ]);
    let project = serde_json::json!({"services": {"image": {"image": image}}}).to_string();
    run_with_progress(
        command,
        Some(project.as_bytes()),
        json_progress,
        on_progress,
        on_complete,
    )
}

/// Complete one explicit pull and report its outcome before the caller can start containers.
/// A failed pull is returned as the same two-part Problem used by the existing startup path.
pub(crate) fn run(
    command: Command,
    input: Option<&[u8]>,
    json_progress: bool,
    on_complete: impl FnOnce(PullMetrics),
) -> Result<(), Problem> {
    run_with_progress(command, input, json_progress, |_| {}, on_complete)
}

fn run_with_progress(
    mut command: Command,
    input: Option<&[u8]>,
    json_progress: bool,
    mut on_progress: impl FnMut(u64),
    on_complete: impl FnOnce(PullMetrics),
) -> Result<(), Problem> {
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let started = Instant::now();
    let output = (|| {
        let mut child = command.spawn()?;
        if let Some(input) = input {
            let result = child
                .stdin
                .take()
                .expect("piped pull stdin")
                .write_all(input);
            if let Err(error) = result {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        }
        // Drain both pipes concurrently, just as wait_with_output does, while forwarding only
        // structured byte counters. Raw engine output stays in the existing error diagnostics.
        let stdout = child.stdout.take().expect("piped pull stdout");
        let stderr = child.stderr.take().expect("piped pull stderr");
        std::thread::scope(|scope| {
            let (sender, receiver) = sync_channel(64);
            let stdout_sender = sender.clone();
            let out = scope.spawn(move || read_output(stdout, json_progress, stdout_sender));
            let err = scope.spawn(move || read_output(stderr, json_progress, sender));
            let mut layers = DownloadBytes::default();
            let mut last = None;
            for progress in receiver {
                layers.observe(progress);
                let total = layers.total();
                if total != last {
                    if let Some(bytes) = total {
                        on_progress(bytes);
                    }
                    last = total;
                }
            }
            let stdout = out
                .join()
                .map_err(|_| std::io::Error::other("pull stdout reader panicked"));
            let stderr = err
                .join()
                .map_err(|_| std::io::Error::other("pull stderr reader panicked"));
            // Always reap the child, including when reading a pipe failed.
            let status = child.wait()?;
            Ok(Output {
                status,
                stdout: stdout??,
                stderr: stderr??,
            })
        })
    })();
    let duration_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    let success = output.as_ref().is_ok_and(|output| output.status.success());
    let bytes = if json_progress {
        output
            .as_ref()
            .ok()
            .and_then(|output| download_bytes(&output.stdout, &output.stderr))
    } else {
        None
    };
    on_complete(PullMetrics {
        outcome: if success {
            Outcome::Success
        } else {
            Outcome::Failure
        },
        duration_ms,
        bytes,
    });
    let output = output.map_err(|error| {
        Problem::plain(format!("Could not pull the images ArkAgent needs: {error}"))
    })?;
    if output.status.success() {
        return Ok(());
    }
    let raw = crate::quiet::said(if output.stderr.is_empty() {
        &output.stdout
    } else {
        &output.stderr
    });
    Err(Problem::with(crate::problem::said_about(&raw), raw))
}

fn read_output(
    pipe: impl Read,
    json_progress: bool,
    sender: SyncSender<Progress>,
) -> std::io::Result<Vec<u8>> {
    let mut reader = BufReader::new(pipe);
    let mut output = Vec::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line)? == 0 {
            return Ok(output);
        }
        output.extend_from_slice(&line);
        if json_progress {
            if let Ok(progress) = serde_json::from_slice(&line) {
                sender
                    .send(progress)
                    .map_err(|_| std::io::Error::other("pull progress receiver closed"))?;
            }
        }
    }
}

/// Where a set of image downloads has got to, for the setup window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImagesProgress {
    /// Images finished, including those that were already on this computer.
    pub done: usize,
    pub total: usize,
    /// Bytes downloaded so far across all images, when the engine reports them at all.
    pub bytes: Option<u64>,
}

impl ImagesProgress {
    /// The sentence the window shows. Its Greek is in `shared/i18n/el/desktop.ts`.
    pub fn detail(&self) -> String {
        format!(
            "Downloading local software ({} of {} done).",
            self.done, self.total
        )
    }
}

/// Pulls every image with a few workers taking the next one off a shared list, and reports progress.
///
/// Progress is reported when the work starts, whenever the byte count moves, and every time an image
/// is finished, so the count moves even on an engine that reports no bytes at all (DT Lab, #109: 25
/// minutes of nothing moving on Windows). `stop` is asked before each image: an error from it, or the
/// first failed pull, stops anything new from starting and is what is returned. A pull already running
/// is let finish, because stopping one half-way only leaves a partial layer behind.
pub fn pull_all(
    images: &[String],
    workers: usize,
    stop: impl Fn() -> Result<(), Problem> + Sync,
    pull: impl Fn(&str, &mut dyn FnMut(u64)) -> Result<(), Problem> + Sync,
    report: impl Fn(ImagesProgress) + Sync,
) -> Result<(), Problem> {
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering::SeqCst};
    use std::sync::Mutex;
    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let fetched: Vec<AtomicU64> = images.iter().map(|_| AtomicU64::new(0)).collect();
    let any_bytes = AtomicBool::new(false);
    let failure: Mutex<Option<Problem>> = Mutex::new(None);
    // One report at a time, so the window never sees the count go backwards.
    let reporting = Mutex::new(());
    let tell = || {
        let _one = reporting.lock().unwrap();
        report(ImagesProgress {
            done: done.load(SeqCst),
            total: images.len(),
            bytes: any_bytes
                .load(SeqCst)
                .then(|| fetched.iter().map(|part| part.load(SeqCst)).sum()),
        });
    };
    let fail = |problem: Problem| {
        let mut slot = failure.lock().unwrap();
        if slot.is_none() {
            *slot = Some(problem);
        }
    };
    let stopped = || failure.lock().unwrap().is_some();

    tell();
    std::thread::scope(|scope| {
        for _ in 0..workers.max(1).min(images.len()) {
            scope.spawn(|| loop {
                if stopped() {
                    break;
                }
                if let Err(problem) = stop() {
                    fail(problem);
                    break;
                }
                let index = next.fetch_add(1, SeqCst);
                let Some(image) = images.get(index) else {
                    break;
                };
                let mut on_bytes = |bytes: u64| {
                    fetched[index].store(bytes, SeqCst);
                    any_bytes.store(true, SeqCst);
                    tell();
                };
                match pull(image, &mut on_bytes) {
                    Ok(()) => {
                        done.fetch_add(1, SeqCst);
                        tell();
                    }
                    Err(problem) => {
                        fail(problem);
                        break;
                    }
                }
            });
        }
    });
    match failure.into_inner().unwrap() {
        Some(problem) => Err(problem),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn images(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("image-{i}")).collect()
    }

    /// DT Lab (#109): the first start after an update from v0.1.40 pulled images for about 25
    /// minutes on Windows with nothing moving, because the count was only ever sent along with a
    /// byte counter, and that engine reported none.
    #[test]
    fn progress_is_reported_per_image_even_when_the_engine_reports_no_bytes() {
        let reports = std::sync::Mutex::new(Vec::new());
        pull_all(
            &images(3),
            1,
            || Ok(()),
            |_, _| Ok(()),
            |progress| reports.lock().unwrap().push(progress),
        )
        .unwrap();
        let reports = reports.into_inner().unwrap();
        let counts: Vec<_> = reports.iter().map(|p| (p.done, p.total)).collect();
        assert_eq!(counts, vec![(0, 3), (1, 3), (2, 3), (3, 3)]);
        assert!(reports.iter().all(|p| p.bytes.is_none()));
        assert_eq!(
            reports[1].detail(),
            "Downloading local software (1 of 3 done)."
        );
    }

    #[test]
    fn bytes_are_added_up_across_images_when_the_engine_reports_them() {
        let reports = std::sync::Mutex::new(Vec::new());
        pull_all(
            &images(2),
            1,
            || Ok(()),
            |image, on_bytes| {
                on_bytes(if image == "image-0" { 100 } else { 50 });
                Ok(())
            },
            |progress| reports.lock().unwrap().push(progress),
        )
        .unwrap();
        let reports = reports.into_inner().unwrap();
        let last = reports.last().unwrap();
        assert_eq!((last.done, last.total, last.bytes), (2, 2, Some(150)));
        assert!(reports.iter().any(|p| p.done == 0 && p.bytes == Some(100)));
    }

    #[test]
    fn the_first_failure_is_returned_and_nothing_new_is_started() {
        let started = std::sync::Mutex::new(Vec::new());
        let result = pull_all(
            &images(4),
            1,
            || Ok(()),
            |image, _| {
                started.lock().unwrap().push(image.to_string());
                if image == "image-1" {
                    Err(Problem::plain("no network"))
                } else {
                    Ok(())
                }
            },
            |_| {},
        );
        assert_eq!(result.unwrap_err().said, "no network");
        assert_eq!(started.into_inner().unwrap(), vec!["image-0", "image-1"]);
    }

    #[test]
    fn a_start_that_was_replaced_stops_the_pulls() {
        let result = pull_all(
            &images(2),
            2,
            || Err(Problem::plain("replaced")),
            |_, _| panic!("nothing should be pulled"),
            |_| {},
        );
        assert_eq!(result.unwrap_err().said, "replaced");
    }

    #[test]
    fn streams_download_bytes_before_the_child_exits() {
        let root = crate::test_support::temp_root("live-pull-progress");
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("progress.rs");
        let binary = root.join(format!("progress{}", std::env::consts::EXE_SUFFIX));
        let acknowledgement = root.join("progress-observed");
        std::fs::write(
            &source,
            r#"
use std::io::Write;
fn main() {
    let acknowledgement = std::env::args().nth(1).unwrap();
    println!("{{\"id\":\"a\",\"parent_id\":\"image\",\"text\":\"Downloading\",\"current\":7}}");
    std::io::stdout().flush().unwrap();
    eprintln!("{{\"id\":\"b\",\"parent_id\":\"image\",\"text\":\"Downloading\",\"current\":5}}");
    for _ in 0..300 {
        if std::path::Path::new(&acknowledgement).exists() { return; }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    eprintln!("progress was not delivered while the pull was running");
    std::process::exit(71);
}
"#,
        )
        .unwrap();
        crate::test_support::compile_fixture(&source, &binary);
        let mut command = crate::quiet::command(&binary);
        command.arg(&acknowledgement);
        let mut updates = Vec::new();
        let mut metrics = Vec::new();
        let result = run_with_progress(
            command,
            None,
            true,
            |bytes| {
                updates.push(bytes);
                if bytes == 12 {
                    std::fs::write(&acknowledgement, "received").unwrap();
                }
            },
            |metric| metrics.push(metric),
        );
        std::fs::remove_dir_all(root).unwrap();
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(updates.last(), Some(&12));
        assert_eq!(metrics.len(), 1);
        assert_eq!(metrics[0].bytes, Some(12));
        assert_eq!(metrics[0].outcome, Outcome::Success);
    }

    #[test]
    fn older_compose_explicitly_downloads_missing_images_and_reuses_cached_images() {
        if crate::test_support::isolated_process("pull_metrics::tests::older_compose_explicitly_downloads_missing_images_and_reuses_cached_images") { return; }
        let root = crate::test_support::temp_root("explicit-image-install");
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("docker.rs");
        std::fs::write(&source, r#"
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let executable = std::env::current_exe().unwrap();
    let root = executable.parent().unwrap();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["image", "inspect", image] => std::process::exit(if root.join(image).is_file() {0} else {1}),
        ["compose", "pull", "--help"] => println!("--include-deps"),
        ["pull", "synthetic-image"] => { std::fs::write(root.join("synthetic-image"), "installed").unwrap(); },
        ["pull", "missing-image"] => { eprintln!("synthetic download failure"); std::process::exit(71); },
        _ => panic!("no services or authentication may start while installing: {args:?}"),
    }
}
"#).unwrap();
        crate::test_support::compile_fixture(
            &source,
            &root.join(format!("docker{}", std::env::consts::EXE_SUFFIX)),
        );
        std::env::set_var("PATH", &root);
        let address = Address::new(crate::engine::Engine::Docker, None);
        let mut outcomes = Vec::new();
        pull_image(
            &address,
            "synthetic-image",
            |_| {},
            |metric| outcomes.push(metric.outcome),
        )
        .unwrap();
        pull_image(
            &address,
            "synthetic-image",
            |_| {},
            |_| panic!("cached image must not be downloaded again"),
        )
        .unwrap();
        assert!(pull_image(
            &address,
            "missing-image",
            |_| {},
            |metric| outcomes.push(metric.outcome)
        )
        .is_err());
        assert_eq!(outcomes, [Outcome::Success, Outcome::Failure]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn counts_each_shared_layer_once_and_ignores_extraction() {
        let output = br#"
{"id":"layer-a","parent_id":"service-a","text":"Downloading","current":20,"total":100}
{"id":"layer-a","parent_id":"service-b","text":"Downloading","current":80,"total":100}
{"id":"layer-a","parent_id":"service-a","text":"Downloading","current":60,"total":100}
{"id":"layer-b","parent_id":"service-a","text":"Downloading","current":7,"total":7}
{"id":"layer-a","parent_id":"service-a","text":"Extracting","current":900,"total":900}
{"id":"layer-a","parent_id":"service-a","text":"Download complete"}
"#;
        assert_eq!(download_bytes(output, b""), Some(87));
    }

    #[test]
    fn missing_download_counters_are_unknown_even_after_a_successful_pull() {
        // Observed with Docker 29.5.2 / hello-world:latest: download completion has no
        // byte counters, while extraction reports current=1. That is not one downloaded byte.
        let output = br#"
{"id":"layer-a","parent_id":"image","text":"Download complete","details":"0B","percent":100}
{"id":"layer-a","parent_id":"image","text":"Extracting","current":1}
{"id":"image","text":"Pulled"}
"#;
        assert_eq!(download_bytes(output, b""), None);
        assert_eq!(
            download_bytes(b"", b"image Skipped - Image is already present locally"),
            None
        );
    }

    #[test]
    fn accepts_counters_on_either_pipe_without_counting_noise_or_totals() {
        let stdout =
            br#"{"id":"layer-a","parent_id":"image","text":"Downloading","current":5,"total":50}"#;
        let stderr = br#"
Executing external compose provider
{"id":"layer-a","parent_id":"image","text":"Downloading","current":8,"total":50}
{"id":"layer-b","parent_id":"image","text":"Downloading","total":999}
{"id":"layer-c","parent_id":"image","text":"Downloading","current":-1}
{"id":"image","text":"Downloading","current":10000}
"#;
        assert_eq!(download_bytes(stdout, stderr), Some(8));
    }

    #[test]
    fn json_capability_requires_the_progress_option_to_advertise_json() {
        assert!(supports_json_progress(
            b"--progress string  Set type of progress output (auto,\n                 tty, plain, json, quiet)\n--project-directory string"
        ));
        assert!(!supports_json_progress(
            b"--progress string (auto, tty, plain)\n--format string (json)"
        ));
        assert!(!supports_json_progress(b"--format string (json)"));
    }

    #[test]
    fn missing_policy_must_be_advertised_before_an_explicit_pull() {
        assert!(option_advertises(
            b"--policy string  Apply pull policy (\"missing\"|\"always\")\n--quiet",
            "--policy",
            "missing"
        ));
        // Compose v2.20 has no --policy; leave its existing implicit pull alone.
        assert!(!option_advertises(
            b"--include-deps  Also pull dependencies\n--quiet",
            "--policy",
            "missing"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn reports_failure_and_observed_bytes_once_before_returning_the_problem() {
        let mut command = crate::quiet::command("sh");
        command.args(["-c", "printf '%s\\n' '{\"id\":\"layer\",\"parent_id\":\"image\",\"text\":\"Downloading\",\"current\":12}' >&2; exit 1"]);
        let mut reports = Vec::new();
        let result = run(command, None, true, |metrics| reports.push(metrics));
        assert!(result.is_err());
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].outcome, Outcome::Failure);
        assert_eq!(reports[0].bytes, Some(12));
    }

    #[cfg(unix)]
    #[test]
    fn measures_the_child_operation_and_closes_its_stdin() {
        let mut command = crate::quiet::command("sh");
        command.args(["-c", "cat; sleep 0.02"]);
        let mut reports = Vec::new();
        let input = br#"{"id":"layer","parent_id":"image","text":"Downloading","current":9}"#;
        assert!(run(command, Some(input), true, |metrics| reports.push(metrics)).is_ok());
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].outcome, Outcome::Success);
        assert!(reports[0].duration_ms >= 10);
        assert_eq!(reports[0].bytes, Some(9));
    }

    #[cfg(unix)]
    #[test]
    fn non_json_provider_keeps_bytes_unknown() {
        let mut command = crate::quiet::command("sh");
        command.args(["-c", "cat"]);
        let mut reports = Vec::new();
        let input = br#"{"id":"layer","parent_id":"image","text":"Downloading","current":9}"#;
        assert!(run(command, Some(input), false, |metrics| reports.push(metrics)).is_ok());
        assert_eq!(reports[0].outcome, Outcome::Success);
        assert_eq!(reports[0].bytes, None);
    }

    #[test]
    fn reports_spawn_failure_once() {
        let command = crate::quiet::command("openbot-test-missing-pull-executable");
        let mut reports = Vec::new();
        assert!(run(command, None, true, |metrics| reports.push(metrics)).is_err());
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].outcome, Outcome::Failure);
        assert_eq!(reports[0].bytes, None);
    }
}
