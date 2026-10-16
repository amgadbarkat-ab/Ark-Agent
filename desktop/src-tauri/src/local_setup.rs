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
use crate::local_model::{self, LocalModel, Machine, Progress, Recommendation};
use crate::local_server::{self, Running, Settings};
use crate::problem::Problem;

/// How long a model gets to load before it is called stuck. A slow disk reading 5 GB is the usual cause
/// of a long wait, and three minutes is generous for that.
pub const READY_WITHIN: Duration = Duration::from_secs(180);

/// What the setup screen shows before anything is downloaded.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub ram_gib: f64,
    pub cores: usize,
    pub recommendation: Recommendation,
    /// Bytes still to fetch for the engine and the model; 0 when both are already here.
    pub to_download_bytes: u64,
    /// Everything needed is on this computer already.
    pub ready: bool,
    /// The engine build the app will use, for support: `b11696 (cpu)`.
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

pub fn engine_ready(root: &Path) -> bool {
    let manifest = llama_runtime::manifest();
    llama_runtime::find_server(&llama_runtime::dir(root).join(format!("llama-{}", manifest.tag)))
        .is_some()
}

/// Look at this computer and the disk.
pub fn plan(root: &Path) -> Result<Plan, Problem> {
    Ok(plan_for(root, &local_model::detect()?))
}

pub fn plan_for(root: &Path, machine: &Machine) -> Plan {
    let recommendation = local_model::recommend(machine);
    let manifest = llama_runtime::manifest();
    let asset = llama_runtime::asset_for(manifest, std::env::consts::OS, std::env::consts::ARCH);
    let engine = match &asset {
        Ok(asset) => format!("{} ({})", manifest.tag, asset.backend),
        Err(_) => format!("{} (none for this computer)", manifest.tag),
    };
    let mut to_download = 0;
    let mut ready = false;
    if let Recommendation::Model { model } = &recommendation {
        let have_engine = engine_ready(root);
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
        recommendation,
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
    local_model::download_verified(
        url,
        &file,
        model.size_bytes,
        model.sha256,
        cancel,
        on_progress,
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

/// Fetch what is missing, checked, for the model that suits this computer.
pub fn prepare(
    root: &Path,
    machine: &Machine,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(Stage, Progress),
) -> Result<Prepared, Problem> {
    let model = match local_model::recommend(machine) {
        Recommendation::Model { model } => model,
        Recommendation::TooSmall { said, .. } => return Err(Problem::plain(said)),
    };
    let server = llama_runtime::install(root, cancel, &mut |progress| {
        on_progress(Stage::Engine, progress)
    })?;
    let model_file = ensure_model(root, model, &model.url(), cancel, &mut |progress| {
        on_progress(Stage::Model, progress)
    })?;
    Ok(Prepared {
        server,
        model_file,
        model,
    })
}

/// Start what `prepare` fetched, and wait until it answers.
pub fn start(
    root: &Path,
    logs: &Path,
    prepared: &Prepared,
    cancel: &AtomicBool,
) -> Result<Running, Problem> {
    let settings = Settings {
        server: prepared.server.clone(),
        model_file: prepared.model_file.clone(),
        alias: prepared.model.id.to_string(),
        context: local_server::DEFAULT_CONTEXT,
        threads: None,
    };
    local_server::start(&settings, root, logs, READY_WITHIN, cancel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_model::{E2B, E4B};
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
        let plan = plan_for(&dir, &machine(16));
        match &plan.recommendation {
            Recommendation::Model { model } => assert_eq!(model.id, "gemma-4-e4b"),
            other => panic!("{other:?}"),
        }
        assert!(!plan.ready);
        // The model and the engine, both.
        assert!(plan.to_download_bytes > E4B.size_bytes, "{plan:?}");
        assert!(plan.engine.starts_with('b'), "{}", plan.engine);
        assert_eq!(plan.cores, 8);
        assert!((plan.ram_gib - 16.0).abs() < 0.01);
    }

    #[test]
    fn an_eight_gigabyte_computer_gets_the_smaller_model() {
        let plan = plan_for(&root("plan-small"), &machine(8));
        match &plan.recommendation {
            Recommendation::Model { model } => assert_eq!(model.id, "gemma-4-e2b"),
            other => panic!("{other:?}"),
        }
        assert!(plan.to_download_bytes > E2B.size_bytes);
        assert!(plan.to_download_bytes < E4B.size_bytes + 1_000_000_000);
    }

    #[test]
    fn a_computer_too_small_has_nothing_to_download_and_a_sentence() {
        let plan = plan_for(&root("plan-tiny"), &machine(4));
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
        assert!(engine_ready(&dir));
        let after_engine = plan_for(&dir, &machine(16));
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
        let ready = plan_for(&dir, &machine(16));
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
        let problem =
            prepare(&dir, &machine(4), &AtomicBool::new(false), &mut |_, _| {}).unwrap_err();
        assert!(
            problem.said.contains("smallest model needs about 8 GB"),
            "{problem:?}"
        );
        // Nothing was fetched on the way to refusing.
        assert!(!llama_runtime::dir(&dir).exists());
    }
}
