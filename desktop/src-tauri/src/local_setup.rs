//! "On this computer": the whole path from a computer's memory to a model that is answering.
//!
//! The pieces are elsewhere and each is tested there: what the computer has and which model suits it
//! (`local_model`), the pinned program that runs a model (`llama_runtime`), and running it on the loopback
//! address with a key (`local_server`). This joins them in the order a person meets them: look at the
//! computer, fetch what is missing, start it.
//!
//! WHERE THE FILES LIVE. Under the deployment folder, beside the other things ArkAgent downloads, so
//! deleting that folder deletes them. The model is several gigabytes, which is why a verified model is
//! remembered with a small marker file and not hashed again at every start: hashing 5 GB takes long
//! enough to be noticed each time the app opens, and a file that was verified once and has the same size
//! has not changed under us in any way that matters (the program refuses a file it cannot load).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use serde::Serialize;

use crate::llama_runtime;
use crate::local_model::{self, LocalModel, Machine, Persistence, Progress, Recommendation};
use crate::local_server::{self, Running, Settings};
use crate::problem::Problem;

/// How long a model gets to load before it is called stuck. A slow disk reading 5 GB is the usual cause
/// of a long wait, and three minutes is generous for that.
pub const READY_WITHIN: Duration = Duration::from_secs(180);

/// A model the setup screen can offer this computer.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanModel {
    pub id: &'static str,
    pub label: &'static str,
    pub size_bytes: u64,
    /// The best this computer can run, which is what is chosen unless the person says otherwise.
    pub recommended: bool,
    /// Already on this computer, whole and checked.
    pub ready: bool,
}

/// What the setup screen shows before anything is downloaded.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub ram_gib: f64,
    pub cores: usize,
    /// A graphics card the model will be run on.
    pub gpu: bool,
    pub recommendation: Recommendation,
    /// Every model this computer can run, best first.
    pub models: Vec<PlanModel>,
    /// The model the figures below are for: the one asked about, or else what is already here, or else the
    /// best that fits.
    pub chosen: Option<&'static str>,
    /// Bytes still to fetch for the engine and the chosen model; 0 when both are already here.
    pub to_download_bytes: u64,
    /// Everything needed is on this computer already.
    pub ready: bool,
    /// The engine build the app will use, for support: `b11696 (vulkan)`.
    pub engine: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Stage {
    Engine,
    Model,
}

/// Fetched, checked and ready to start.
#[derive(Debug)]
pub struct Prepared {
    pub server: PathBuf,
    pub model_file: PathBuf,
    pub model: &'static LocalModel,
    /// Which build of the engine `server` is: `cpu`, `metal` or `vulkan`.
    pub backend: String,
}

pub fn models_dir(root: &Path) -> PathBuf {
    llama_runtime::dir(root).join("models")
}

pub fn model_path(root: &Path, model: &LocalModel) -> PathBuf {
    models_dir(root).join(model.file)
}

fn marker(file: &Path) -> PathBuf {
    let mut name = file.as_os_str().to_os_string();
    name.push(".verified");
    PathBuf::from(name)
}

/// The model file is here, whole, and was verified when it arrived.
pub fn model_ready(root: &Path, model: &LocalModel) -> bool {
    let file = model_path(root, model);
    fs::metadata(&file).is_ok_and(|meta| meta.len() == model.size_bytes)
        && fs::read_to_string(marker(&file))
            .is_ok_and(|text| text.trim() == format!("{} {}", model.size_bytes, model.sha256))
}

/// The engine for this kind of computer is unpacked and here. `gpu` is whether the graphics-card build is the
/// one wanted.
pub fn engine_ready(root: &Path, gpu: bool) -> bool {
    let manifest = llama_runtime::manifest();
    let Ok(asset) = llama_runtime::asset_for_computer(
        manifest,
        std::env::consts::OS,
        std::env::consts::ARCH,
        gpu,
    ) else {
        return false;
    };
    llama_runtime::find_server(
        &llama_runtime::dir(root).join(llama_runtime::engine_folder(&manifest.tag, &asset.backend)),
    )
    .is_some()
}

/// The model to run: the one asked for if this computer can run it, else one already here, else the best
/// that fits.
///
/// "Already here" before "best" matters on every start after the first: a person who chose a smaller model
/// to save a download must not find the app fetching a bigger one the next time it opens.
pub fn choose(
    root: &Path,
    machine: &Machine,
    requested: Option<&str>,
) -> Result<&'static LocalModel, Problem> {
    let fits = local_model::fitting(machine);
    if let Some(id) = requested.filter(|id| !id.is_empty()) {
        let model = local_model::by_id(id)
            .ok_or_else(|| Problem::plain("ArkAgent does not know that model."))?;
        return if fits.contains(&model) {
            Ok(model)
        } else {
            Err(Problem::plain(format!(
                "{} needs more memory than this computer has. Choose a smaller model.",
                model.label
            )))
        };
    }
    if let Some(here) = fits.iter().copied().find(|model| model_ready(root, model)) {
        return Ok(here);
    }
    match fits.first().copied() {
        Some(best) => Ok(best),
        None => match local_model::recommend(machine) {
            Recommendation::TooSmall { said, .. } => Err(Problem::plain(said)),
            Recommendation::Model { model } => Ok(model),
        },
    }
}

/// Look at this computer and the disk.
pub fn plan(root: &Path, requested: Option<&str>) -> Result<Plan, Problem> {
    Ok(plan_for(root, &local_model::detect()?, requested))
}

pub fn plan_for(root: &Path, machine: &Machine, requested: Option<&str>) -> Plan {
    let recommendation = local_model::recommend(machine);
    let manifest = llama_runtime::manifest();
    let asset = llama_runtime::asset_for_computer(
        manifest,
        std::env::consts::OS,
        std::env::consts::ARCH,
        machine.gpu,
    );
    let engine = match &asset {
        Ok(asset) => format!("{} ({})", manifest.tag, asset.backend),
        Err(_) => format!("{} (none for this computer)", manifest.tag),
    };
    let fits = local_model::fitting(machine);
    let chosen = choose(root, machine, requested).ok();
    let models = fits
        .iter()
        .enumerate()
        .map(|(index, model)| PlanModel {
            id: model.id,
            label: model.label,
            size_bytes: model.size_bytes,
            recommended: index == 0,
            ready: model_ready(root, model),
        })
        .collect();
    let mut to_download = 0;
    let mut ready = false;
    if let Some(model) = chosen {
        let have_engine = engine_ready(root, machine.gpu);
        let have_model = model_ready(root, model);
        if !have_engine {
            to_download += asset.as_ref().map(|asset| asset.size).unwrap_or(0);
        }
        if !have_model {
            to_download += model.size_bytes;
        }
        ready = have_engine && have_model;
    }
    Plan {
        ram_gib: machine.ram_gib(),
        cores: machine.cores,
        gpu: machine.gpu,
        recommendation,
        models,
        chosen: chosen.map(|model| model.id),
        to_download_bytes: to_download,
        ready,
        engine,
    }
}

/// Make sure the model is on disk and was checked. Cached models are not fetched or hashed again.
pub fn ensure_model(
    root: &Path,
    model: &LocalModel,
    url: &str,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(Progress),
) -> Result<PathBuf, Problem> {
    let file = model_path(root, model);
    if model_ready(root, model) {
        on_progress(Progress {
            downloaded: model.size_bytes,
            total: model.size_bytes,
        });
        return Ok(file);
    }
    // Not the marker's word, if the marker is missing or stale: the download is verified whole.
    let _ = fs::remove_file(marker(&file));
    local_model::download_with_retries(
        url,
        &file,
        model.size_bytes,
        model.sha256,
        cancel,
        on_progress,
        Persistence::PATIENT,
    )?;
    fs::write(
        marker(&file),
        format!("{} {}\n", model.size_bytes, model.sha256),
    )
    .map_err(|error| {
        Problem::with(
            "ArkAgent could not save a note about the model it downloaded.",
            format!("{}: {error}", marker(&file).display()),
        )
    })?;
    Ok(file)
}

/// The build of the engine `server` is, read from where it was unpacked.
fn backend_of(server: &Path) -> String {
    if server
        .components()
        .any(|part| part.as_os_str().to_string_lossy().ends_with("-vulkan"))
    {
        "vulkan".into()
    } else if std::env::consts::OS == "macos" && std::env::consts::ARCH == "aarch64" {
        "metal".into()
    } else {
        "cpu".into()
    }
}

/// Fetch what is missing, checked, for the model that suits this computer, or the one asked for.
///
/// The graphics-card engine is fetched first where there is a card; if it cannot even report its version
/// the CPU engine is used instead, so a driver problem costs speed and never the feature.
pub fn prepare(
    root: &Path,
    machine: &Machine,
    requested: Option<&str>,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(Stage, Progress),
) -> Result<Prepared, Problem> {
    let model = choose(root, machine, requested)?;
    let server = match llama_runtime::install(root, machine.gpu, cancel, &mut |progress| {
        on_progress(Stage::Engine, progress)
    }) {
        Ok(server) => server,
        Err(_) if machine.gpu && !cancel.load(std::sync::atomic::Ordering::Relaxed) => {
            llama_runtime::install(root, false, cancel, &mut |progress| {
                on_progress(Stage::Engine, progress)
            })?
        }
        Err(problem) => return Err(problem),
    };
    let model_file = ensure_model(root, model, &model.url(), cancel, &mut |progress| {
        on_progress(Stage::Model, progress)
    })?;
    Ok(Prepared {
        backend: backend_of(&server),
        server,
        model_file,
        model,
    })
}

fn settings_for(prepared: &Prepared) -> Settings {
    Settings {
        server: prepared.server.clone(),
        model_file: prepared.model_file.clone(),
        alias: prepared.model.id.to_string(),
        context: crate::local_model::context_for(prepared.model),
        threads: None,
    }
}

/// Start what `prepare` fetched, and wait until it answers.
///
/// A graphics-card engine that starts but never answers (a driver that cannot hold the model, a card too
/// small for it) is stopped and the CPU engine is started in its place, so the person gets an answer from the
/// model and not an error about a card they did not know mattered.
pub fn start(
    root: &Path,
    logs: &Path,
    prepared: &Prepared,
    cancel: &AtomicBool,
) -> Result<Running, Problem> {
    match local_server::start(&settings_for(prepared), root, logs, READY_WITHIN, cancel) {
        Ok(running) => Ok(running),
        Err(problem)
            if prepared.backend == "vulkan"
                && !cancel.load(std::sync::atomic::Ordering::Relaxed) =>
        {
            let cpu =
                llama_runtime::install(root, false, cancel, &mut |_| {}).map_err(|_| problem)?;
            let fallback = Prepared {
                backend: backend_of(&cpu),
                server: cpu,
                model_file: prepared.model_file.clone(),
                model: prepared.model,
            };
            local_server::start(&settings_for(&fallback), root, logs, READY_WITHIN, cancel)
        }
        Err(problem) => Err(problem),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_model::{E2B, E4B, G12B, G26B};
    use crate::test_support::{serve_bytes, temp_root};
    use sha2::{Digest, Sha256};

    fn root(name: &str) -> PathBuf {
        let dir = temp_root(&format!("local-setup-{name}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn machine(gib: u64) -> Machine {
        Machine {
            ram_bytes: gib * 1024 * 1024 * 1024,
            cores: 8,
            gpu: false,
        }
    }

    /// A model small enough to test with, with the digest of what a test server will send.
    fn tiny(bytes: &[u8]) -> LocalModel {
        let digest: String = Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        LocalModel {
            id: "tiny",
            label: "Tiny",
            repo: "test/tiny",
            file: "tiny.gguf",
            size_bytes: bytes.len() as u64,
            sha256: Box::leak(digest.into_boxed_str()),
            min_ram_gib: 1.0,
        }
    }

    #[test]
    fn a_new_computer_is_told_what_it_will_download() {
        let dir = root("plan-new");
        // 24 GB: the smallest computer 12B is offered on (see `local_model::G12B`).
        let plan = plan_for(&dir, &machine(24), None);
        match &plan.recommendation {
            Recommendation::Model { model } => assert_eq!(model.id, "gemma-4-12b"),
            other => panic!("{other:?}"),
        }
        assert_eq!(plan.chosen, Some("gemma-4-12b"));
        assert!(!plan.ready);
        // The model and the engine, both.
        assert!(plan.to_download_bytes > G12B.size_bytes, "{plan:?}");
        assert!(plan.engine.starts_with('b'), "{}", plan.engine);
        assert_eq!(plan.cores, 8);
        assert!((plan.ram_gib - 24.0).abs() < 0.01);
        // What else it could run, best first, with the best marked.
        let offered: Vec<_> = plan
            .models
            .iter()
            .map(|model| (model.id, model.recommended))
            .collect();
        assert_eq!(
            offered,
            [
                ("gemma-4-12b", true),
                ("gemma-4-e4b", false),
                ("gemma-4-e2b", false)
            ]
        );
    }

    #[test]
    fn a_thirty_two_gigabyte_computer_is_offered_the_biggest_model_and_every_smaller_one() {
        let plan = plan_for(&root("plan-big"), &machine(32), None);
        assert_eq!(plan.chosen, Some("gemma-4-26b-a4b"));
        assert_eq!(plan.models.len(), 4);
        assert!(plan.to_download_bytes > G26B.size_bytes);
        // Asking about a smaller one changes the figures and nothing else.
        let smaller = plan_for(&root("plan-big-small"), &machine(32), Some("gemma-4-e4b"));
        assert_eq!(smaller.chosen, Some("gemma-4-e4b"));
        assert!(smaller.to_download_bytes > E4B.size_bytes);
        assert!(smaller.to_download_bytes < G12B.size_bytes);
        assert_eq!(smaller.models.len(), 4);
    }

    #[test]
    fn a_model_the_computer_cannot_hold_is_refused_in_a_sentence() {
        let dir = root("choose-refuse");
        let problem = choose(&dir, &machine(16), Some("gemma-4-26b-a4b")).unwrap_err();
        assert!(
            problem.said.contains("needs more memory"),
            "{}",
            problem.said
        );
        let unknown = choose(&dir, &machine(16), Some("gemma-9")).unwrap_err();
        assert!(unknown.said.contains("does not know"));
    }

    #[test]
    fn a_smaller_model_already_here_is_kept_over_a_bigger_one_to_fetch() {
        let dir = root("choose-kept");
        let file = model_path(&dir, &E4B);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::File::create(&file)
            .unwrap()
            .set_len(E4B.size_bytes)
            .unwrap();
        fs::write(
            marker(&file),
            format!("{} {}\n", E4B.size_bytes, E4B.sha256),
        )
        .unwrap();
        // No choice made: what is on the disk, not a second multi-gigabyte download.
        assert_eq!(choose(&dir, &machine(32), None).unwrap().id, "gemma-4-e4b");
        // An explicit choice is honoured.
        assert_eq!(
            choose(&dir, &machine(32), Some("gemma-4-26b-a4b"))
                .unwrap()
                .id,
            "gemma-4-26b-a4b"
        );
        // Nothing on disk: the best that fits.
        assert_eq!(
            choose(&root("choose-fresh"), &machine(32), None)
                .unwrap()
                .id,
            "gemma-4-26b-a4b"
        );
    }

    #[test]
    fn an_eight_gigabyte_computer_gets_the_smaller_model() {
        let plan = plan_for(&root("plan-small"), &machine(8), None);
        match &plan.recommendation {
            Recommendation::Model { model } => assert_eq!(model.id, "gemma-4-e2b"),
            other => panic!("{other:?}"),
        }
        assert!(plan.to_download_bytes > E2B.size_bytes);
        assert!(plan.to_download_bytes < E4B.size_bytes + 1_000_000_000);
    }

    #[test]
    fn a_computer_too_small_has_nothing_to_download_and_a_sentence() {
        let plan = plan_for(&root("plan-tiny"), &machine(4), None);
        assert!(matches!(
            plan.recommendation,
            Recommendation::TooSmall { .. }
        ));
        assert_eq!(plan.to_download_bytes, 0);
        assert!(!plan.ready);
    }

    #[test]
    fn what_is_already_here_is_not_counted_again() {
        let dir = root("plan-have");
        // Pretend the engine and the model are on disk: only the model's marker and size matter.
        let manifest = llama_runtime::manifest();
        let engine_dir = llama_runtime::dir(&dir).join(format!("llama-{}", manifest.tag));
        fs::create_dir_all(&engine_dir).unwrap();
        fs::write(
            engine_dir.join(if cfg!(windows) {
                "llama-server.exe"
            } else {
                "llama-server"
            }),
            b"x",
        )
        .unwrap();
        assert!(engine_ready(&dir, false));
        let after_engine = plan_for(&dir, &machine(16), Some("gemma-4-e4b"));
        assert_eq!(after_engine.to_download_bytes, E4B.size_bytes);
        assert!(!after_engine.ready);

        // A file of the right size but no marker has not been verified: it still counts as to fetch.
        let file = model_path(&dir, &E4B);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        let handle = fs::File::create(&file).unwrap();
        handle.set_len(E4B.size_bytes).unwrap();
        assert!(!model_ready(&dir, &E4B));
        fs::write(
            marker(&file),
            format!("{} {}\n", E4B.size_bytes, E4B.sha256),
        )
        .unwrap();
        assert!(model_ready(&dir, &E4B));
        let ready = plan_for(&dir, &machine(16), Some("gemma-4-e4b"));
        assert!(ready.ready);
        assert_eq!(ready.to_download_bytes, 0);

        // A marker for a different digest, or a file that has changed size, is not trusted.
        fs::write(
            marker(&file),
            format!("{} {}\n", E4B.size_bytes, "0".repeat(64)),
        )
        .unwrap();
        assert!(!model_ready(&dir, &E4B));
        fs::write(
            marker(&file),
            format!("{} {}\n", E4B.size_bytes, E4B.sha256),
        )
        .unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&file)
            .unwrap()
            .set_len(E4B.size_bytes - 1)
            .unwrap();
        assert!(!model_ready(&dir, &E4B));
    }

    #[test]
    fn fetches_a_model_once_and_never_hashes_or_fetches_it_again() {
        let body: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        let (url, hits) = serve_bytes(body.clone());
        let model = tiny(&body);
        let dir = root("ensure");
        let cancel = AtomicBool::new(false);
        let mut seen = Vec::new();
        let file = ensure_model(&dir, &model, &url, &cancel, &mut |p| seen.push(p)).unwrap();
        assert_eq!(fs::read(&file).unwrap(), body);
        assert!(model_ready(&dir, &model));
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(seen.last().unwrap().downloaded, body.len() as u64);

        let again = ensure_model(&dir, &model, &url, &cancel, &mut |_| {}).unwrap();
        assert_eq!(again, file);
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn a_download_that_does_not_match_leaves_no_model_and_no_marker() {
        let body = vec![7u8; 100_000];
        let (url, _hits) = serve_bytes(body.clone());
        let mut model = tiny(&body);
        model.sha256 = Box::leak("0".repeat(64).into_boxed_str());
        let dir = root("ensure-bad");
        let problem =
            ensure_model(&dir, &model, &url, &AtomicBool::new(false), &mut |_| {}).unwrap_err();
        assert!(
            problem.said.contains("not what it was expecting"),
            "{problem:?}"
        );
        let file = model_path(&dir, &model);
        assert!(!file.exists());
        assert!(!marker(&file).exists());
        assert!(!model_ready(&dir, &model));
    }

    #[test]
    fn a_computer_too_small_cannot_prepare() {
        let dir = root("prepare-small");
        let problem = prepare(
            &dir,
            &machine(4),
            None,
            &AtomicBool::new(false),
            &mut |_, _| {},
        )
        .unwrap_err();
        assert!(
            problem.said.contains("smallest model needs about 8 GB"),
            "{problem:?}"
        );
        // Nothing was fetched on the way to refusing.
        assert!(!llama_runtime::dir(&dir).exists());
    }
}
