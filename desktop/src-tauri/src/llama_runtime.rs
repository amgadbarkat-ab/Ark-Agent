//! The llama.cpp program the desktop runs a local model with: which build, fetched how, unpacked where.
//!
//! The same discipline as Podman, Compose and Bun in `install.rs`: a build is fetched by digest, not by name.
//! The digests live in `llama-runtime.json`, written by `scripts/pin-llama-runtime.ts` from a hosted
//! run that downloaded and hashed every file, and reviewed in a commit before any customer is given
//! one. This module reads that file, fetches the one build that suits this computer, refuses it unless it
//! is the size and SHA-256 recorded, unpacks it without letting the archive choose where anything goes,
//! and checks the program starts.
//!
//! CPU everywhere except Apple silicon, where the one build uses the graphics chip through Metal. A
//! graphics-card build for Windows is a later option once it has been tried on real machines.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::local_model::{download_verified, Progress};
use crate::problem::Problem;

/// Compiled in, so a build of the app can only fetch what a person reviewed.
const MANIFEST: &str = include_str!("../llama-runtime.json");

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Asset {
    pub os: String,
    pub arch: String,
    pub backend: String,
    pub file: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub tag: String,
    pub source: String,
    pub assets: Vec<Asset>,
}

impl Asset {
    pub fn url(&self, tag: &str) -> String {
        format!(
            "https://github.com/ggml-org/llama.cpp/releases/download/{tag}/{}",
            self.file
        )
    }
}

pub fn manifest() -> &'static Manifest {
    static PARSED: OnceLock<Manifest> = OnceLock::new();
    PARSED.get_or_init(|| serde_json::from_str(MANIFEST).expect("llama-runtime.json is valid"))
}

/// The build for this kind of computer, or a sentence saying there is none.
pub fn asset_for<'a>(manifest: &'a Manifest, os: &str, arch: &str) -> Result<&'a Asset, Problem> {
    manifest
        .assets
        .iter()
        .find(|asset| asset.os == os && asset.arch == arch)
        .ok_or_else(|| {
            Problem::with(
                "ArkAgent cannot run a model on this kind of computer yet. You can still use your own \
                 model key or server.",
                format!("no llama.cpp {} build for {os} on {arch}", manifest.tag),
            )
        })
}

/// Where the local model's files live: under the same cache as the other pinned downloads.
pub fn dir(cache: &Path) -> PathBuf {
    cache.join("local-model")
}

fn server_name() -> &'static str {
    if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    }
}

/// The `llama-server` program inside an unpacked build, wherever the archive put it.
pub fn find_server(root: &Path) -> Option<PathBuf> {
    fn walk(dir: &Path, depth: usize) -> Option<PathBuf> {
        let mut folders = Vec::new();
        for entry in fs::read_dir(dir).ok()?.flatten() {
            let path = entry.path();
            let kind = entry.file_type().ok()?;
            if kind.is_file() && entry.file_name() == server_name() {
                return Some(path);
            }
            if kind.is_dir() && depth < 4 {
                folders.push(path);
            }
        }
        folders
            .into_iter()
            .find_map(|folder| walk(&folder, depth + 1))
    }
    walk(root, 0)
}

/// Unpacked and ready, or fetched, checked, unpacked and ready. Returns the program to run.
pub fn install(
    cache: &Path,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(Progress),
) -> Result<PathBuf, Problem> {
    let manifest = manifest();
    let asset = asset_for(manifest, std::env::consts::OS, std::env::consts::ARCH)?;
    install_with(
        cache,
        &manifest.tag,
        asset,
        &asset.url(&manifest.tag),
        cancel,
        on_progress,
        verify_server,
    )
}

fn install_with(
    cache: &Path,
    tag: &str,
    asset: &Asset,
    url: &str,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(Progress),
    verify: impl Fn(&Path) -> Result<(), Problem>,
) -> Result<PathBuf, Problem> {
    let root = dir(cache).join(format!("llama-{tag}"));
    if let Some(server) = find_server(&root) {
        verify(&server)?;
        return Ok(server);
    }
    let archive = download_verified(
        url,
        &dir(cache).join("downloads").join(&asset.file),
        asset.size,
        &asset.sha256,
        cancel,
        on_progress,
    )?;

    let staging = dir(cache).join(format!("llama-{tag}.partial"));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|error| unwritable(&staging, &error))?;
    let unpacked = extract(&archive, &staging).and_then(|()| {
        let server = find_server(&staging).ok_or_else(|| {
            Problem::with(
                "ArkAgent could not find the model engine inside what it downloaded. Try again.",
                format!("{}: no {} inside", asset.file, server_name()),
            )
        })?;
        verify(&server)
    });
    if let Err(problem) = unpacked {
        let _ = fs::remove_dir_all(&staging);
        return Err(problem);
    }
    // An earlier, broken attempt at the same place is not worth keeping.
    let _ = fs::remove_dir_all(&root);
    fs::rename(&staging, &root).map_err(|error| unwritable(&root, &error))?;
    let _ = fs::remove_file(&archive);
    find_server(&root).ok_or_else(|| {
        Problem::plain("ArkAgent could not find the model engine it had just unpacked.")
    })
}

/// The program starts and says what it is. It is not run on a model: only started.
pub fn verify_server(server: &Path) -> Result<(), Problem> {
    let mut command = crate::quiet::command(server);
    command.arg("--version");
    // The libraries ship beside the program; a Linux loader needs telling to look there.
    if let Some(folder) = server.parent() {
        command.current_dir(folder);
        #[cfg(target_os = "linux")]
        command.env("LD_LIBRARY_PATH", folder);
    }
    let output = command.output().map_err(|error| {
        Problem::with(
            "ArkAgent could not start its model engine on this computer.",
            format!("{}: {error}", server.display()),
        )
    })?;
    if output.status.success() {
        return Ok(());
    }
    let hint = if cfg!(windows) {
        " Windows may need the Microsoft Visual C++ runtime; installing it from Microsoft usually fixes this."
    } else {
        ""
    };
    Err(Problem::with(
        format!("ArkAgent's model engine did not start on this computer.{hint}"),
        format!(
            "{} --version: {}; stdout: {}; stderr: {}",
            server.display(),
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ),
    ))
}

// ---- unpacking ----------------------------------------------------------------------------------

fn unsafe_archive(file: &Path, entry: &str) -> Problem {
    Problem::with(
        "What ArkAgent downloaded for the model engine has an unexpected layout, so it has not been \
         used.",
        format!("{}: entry {entry} would be written outside its folder", file.display()),
    )
}

fn unpack_error(file: &Path, error: &dyn std::fmt::Display) -> Problem {
    Problem::with(
        "ArkAgent could not unpack its model engine. Try again.",
        format!("{}: {error}", file.display()),
    )
}

/// Unpack `.zip` or `.tar.gz` into `into`, which must exist. Nothing the archive names can land outside
/// it: absolute paths and `..` are refused, not trimmed.
pub fn extract(archive: &Path, into: &Path) -> Result<(), Problem> {
    let name = archive
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if name.ends_with(".zip") {
        extract_zip(archive, into)
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        extract_tar_gz(archive, into)
    } else {
        Err(unpack_error(archive, &"not a .zip or .tar.gz file"))
    }
}

/// A relative path that stays under its folder.
fn contained(path: &Path) -> bool {
    path.components()
        .all(|part| matches!(part, Component::Normal(_) | Component::CurDir))
}

fn extract_zip(archive: &Path, into: &Path) -> Result<(), Problem> {
    let file = fs::File::open(archive).map_err(|error| unpack_error(archive, &error))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|error| unpack_error(archive, &error))?;
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|error| unpack_error(archive, &error))?;
        let listed = entry.name().to_string();
        let relative = entry
            .enclosed_name()
            .filter(|path| contained(path))
            .ok_or_else(|| unsafe_archive(archive, &listed))?;
        let target = into.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|error| unwritable(&target, &error))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| unwritable(parent, &error))?;
        }
        #[cfg(unix)]
        let mode = entry.unix_mode();
        #[cfg(unix)]
        if mode.is_some_and(|mode| mode & 0o170000 == 0o120000) {
            // A link: its content is where it points. Only a link that stays inside is made.
            let mut destination = String::new();
            entry
                .read_to_string(&mut destination)
                .map_err(|error| unpack_error(archive, &error))?;
            let destination = PathBuf::from(destination);
            let resolved = relative
                .parent()
                .unwrap_or(Path::new(""))
                .join(&destination);
            if destination.is_absolute() || !stays_inside(&resolved) {
                return Err(unsafe_archive(archive, &listed));
            }
            std::os::unix::fs::symlink(&destination, &target)
                .map_err(|error| unwritable(&target, &error))?;
            continue;
        }
        let mut out = fs::File::create(&target).map_err(|error| unwritable(&target, &error))?;
        std::io::copy(&mut entry, &mut out).map_err(|error| unpack_error(archive, &error))?;
        drop(out);
        #[cfg(unix)]
        if let Some(mode) = mode {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&target, fs::Permissions::from_mode(mode & 0o777))
                .map_err(|error| unwritable(&target, &error))?;
        }
    }
    Ok(())
}

/// Whether a path made of normal parts and `..` ends up no higher than where it started.
#[cfg(unix)]
fn stays_inside(path: &Path) -> bool {
    let mut depth: i64 = 0;
    for part in path.components() {
        match part {
            Component::Normal(_) => depth += 1,
            Component::ParentDir => depth -= 1,
            Component::CurDir => {}
            _ => return false,
        }
        if depth < 0 {
            return false;
        }
    }
    true
}

fn extract_tar_gz(archive: &Path, into: &Path) -> Result<(), Problem> {
    let file = fs::File::open(archive).map_err(|error| unpack_error(archive, &error))?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    tar.set_preserve_permissions(true);
    tar.set_unpack_xattrs(false);
    for entry in tar
        .entries()
        .map_err(|error| unpack_error(archive, &error))?
    {
        let mut entry = entry.map_err(|error| unpack_error(archive, &error))?;
        let listed = entry
            .path()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default();
        let kind = entry.header().entry_type();
        if !(kind.is_file() || kind.is_dir() || kind.is_symlink()) {
            // Devices, hard links and the like have no business in a program archive.
            return Err(unsafe_archive(archive, &listed));
        }
        let path = entry
            .path()
            .map_err(|error| unpack_error(archive, &error))?;
        if !contained(&path) {
            return Err(unsafe_archive(archive, &listed));
        }
        if kind.is_symlink() {
            let link = entry
                .link_name()
                .map_err(|error| unpack_error(archive, &error))?
                .ok_or_else(|| unsafe_archive(archive, &listed))?
                .into_owned();
            #[cfg(unix)]
            {
                let resolved = path.parent().unwrap_or(Path::new("")).join(&link);
                if link.is_absolute() || !stays_inside(&resolved) {
                    return Err(unsafe_archive(archive, &listed));
                }
            }
            #[cfg(not(unix))]
            let _ = link;
        }
        let unpacked = entry
            .unpack_in(into)
            .map_err(|error| unpack_error(archive, &error))?;
        if !unpacked {
            return Err(unsafe_archive(archive, &listed));
        }
    }
    Ok(())
}

fn unwritable(path: &Path, error: &dyn std::fmt::Display) -> Problem {
    Problem::with(
        "ArkAgent could not save the model engine. Check that the disk has room, then try again.",
        format!("{}: {error}", path.display()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::Write;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "arkagent-llama-runtime-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sha(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    // ---- the pinned manifest ------------------------------------------------------------------

    #[test]
    fn the_manifest_names_every_supported_computer_with_real_digests() {
        let manifest = manifest();
        assert!(!manifest.tag.is_empty());
        for (os, arch) in [
            ("windows", "x86_64"),
            ("windows", "aarch64"),
            ("macos", "aarch64"),
            ("macos", "x86_64"),
            ("linux", "x86_64"),
            ("linux", "aarch64"),
        ] {
            let asset = asset_for(manifest, os, arch).unwrap();
            assert_eq!(asset.sha256.len(), 64, "{asset:?}");
            assert!(
                asset
                    .sha256
                    .chars()
                    .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)),
                "{asset:?}"
            );
            assert!(asset.size > 1_000_000, "{asset:?}");
            // The tag is in the file name, so a file cannot be paired with another release's tag.
            assert!(asset.file.contains(&manifest.tag), "{asset:?}");
            assert!(
                asset.file.ends_with(".zip") || asset.file.ends_with(".tar.gz"),
                "{asset:?}"
            );
        }
    }

    #[test]
    fn windows_gets_the_cpu_build_and_apple_silicon_the_metal_one() {
        let manifest = manifest();
        assert_eq!(
            asset_for(manifest, "windows", "x86_64").unwrap().backend,
            "cpu"
        );
        assert_eq!(
            asset_for(manifest, "macos", "aarch64").unwrap().backend,
            "metal"
        );
    }

    #[test]
    fn urls_point_at_llama_cpp_releases_under_the_pinned_tag() {
        let manifest = manifest();
        let asset = asset_for(manifest, "linux", "x86_64").unwrap();
        assert_eq!(
            asset.url(&manifest.tag),
            format!(
                "https://github.com/ggml-org/llama.cpp/releases/download/{}/{}",
                manifest.tag, asset.file
            )
        );
    }

    #[test]
    fn a_kind_of_computer_with_no_build_is_a_sentence() {
        let problem = asset_for(manifest(), "plan9", "riscv").unwrap_err();
        assert!(problem
            .said
            .contains("cannot run a model on this kind of computer"));
        assert!(problem.detail.unwrap().contains("plan9"));
    }

    // ---- unpacking ----------------------------------------------------------------------------

    fn tar_gz(files: &[(&str, &[u8], u32)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (path, body, mode) in files {
            let mut header = tar::Header::new_gnu();
            header.set_path(path).unwrap();
            header.set_size(body.len() as u64);
            header.set_mode(*mode);
            header.set_cksum();
            builder.append(&header, *body).unwrap();
        }
        let bytes = builder.into_inner().unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(&bytes).unwrap();
        encoder.finish().unwrap()
    }

    /// A tar written by hand, so a path the tar crate's own writer would refuse (`..`) can be tested.
    fn raw_tar_gz(path: &str, body: &[u8]) -> Vec<u8> {
        let mut header = [0u8; 512];
        header[..path.len()].copy_from_slice(path.as_bytes());
        header[100..107].copy_from_slice(b"0000644");
        header[108..115].copy_from_slice(b"0000000");
        header[116..123].copy_from_slice(b"0000000");
        header[124..135].copy_from_slice(format!("{:011o}", body.len()).as_bytes());
        header[136..147].copy_from_slice(b"00000000000");
        header[156] = b'0';
        header[257..262].copy_from_slice(b"ustar");
        header[148..156].copy_from_slice(b"        ");
        let sum: u32 = header.iter().map(|b| u32::from(*b)).sum();
        header[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
        let mut out = header.to_vec();
        out.extend_from_slice(body);
        out.resize(out.len().div_ceil(512) * 512, 0);
        out.extend_from_slice(&[0u8; 1024]);
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(&out).unwrap();
        encoder.finish().unwrap()
    }

    fn zip_of(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (path, body) in files {
            writer
                .start_file(*path, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(body).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn unpacks_a_tar_gz_and_finds_the_server_in_a_subfolder() {
        let dir = scratch("tar");
        let archive = dir.join("llama-bX-bin-ubuntu-x64.tar.gz");
        fs::write(
            &archive,
            tar_gz(&[
                ("build/bin/llama-server", b"#!/bin/sh\nexit 0\n", 0o755),
                ("build/bin/libggml.so", b"lib", 0o644),
            ]),
        )
        .unwrap();
        let into = dir.join("out");
        fs::create_dir_all(&into).unwrap();
        extract(&archive, &into).unwrap();
        let server = find_server(&into).unwrap();
        assert!(
            server.ends_with("build/bin/llama-server")
                || server.ends_with("build\\bin\\llama-server")
        );
        assert_eq!(fs::read(into.join("build/bin/libggml.so")).unwrap(), b"lib");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&server).unwrap().permissions().mode() & 0o111,
                0o111
            );
        }
    }

    #[test]
    fn unpacks_a_zip() {
        let dir = scratch("zip");
        let archive = dir.join("llama-bX-bin-win-cpu-x64.zip");
        let name = server_name();
        fs::write(&archive, zip_of(&[(name, b"x"), ("ggml.dll", b"y")])).unwrap();
        let into = dir.join("out");
        fs::create_dir_all(&into).unwrap();
        extract(&archive, &into).unwrap();
        assert_eq!(fs::read(into.join(name)).unwrap(), b"x");
        assert_eq!(fs::read(into.join("ggml.dll")).unwrap(), b"y");
        assert!(find_server(&into).is_some());
    }

    #[test]
    fn an_archive_cannot_write_outside_its_folder() {
        let dir = scratch("escape");
        let into = dir.join("out");
        fs::create_dir_all(&into).unwrap();
        let outside = dir.join("escaped.txt");

        let archive = dir.join("evil.tar.gz");
        fs::write(&archive, raw_tar_gz("../escaped.txt", b"owned")).unwrap();
        let problem = extract(&archive, &into).unwrap_err();
        assert!(problem.said.contains("unexpected layout"), "{problem:?}");
        assert!(!outside.exists());

        let archive = dir.join("evil2.tar.gz");
        fs::write(
            &archive,
            raw_tar_gz("/tmp/escaped-by-absolute-path.txt", b"owned"),
        )
        .unwrap();
        assert!(extract(&archive, &into).is_err());
        assert!(!Path::new("/tmp/escaped-by-absolute-path.txt").exists());

        let archive = dir.join("evil.zip");
        fs::write(&archive, zip_of(&[("../escaped.txt", b"owned")])).unwrap();
        assert!(extract(&archive, &into).is_err());
        assert!(!outside.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_that_points_out_of_the_folder_is_refused_and_one_that_stays_in_is_made() {
        let dir = scratch("links");
        let into = dir.join("out");
        fs::create_dir_all(&into).unwrap();

        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o777);
        header.set_path("libllama.so").unwrap();
        header.set_link_name("libllama.so.1").unwrap();
        header.set_cksum();
        builder.append(&header, std::io::empty()).unwrap();
        let mut real = tar::Header::new_gnu();
        real.set_path("libllama.so.1").unwrap();
        real.set_size(3);
        real.set_mode(0o644);
        real.set_cksum();
        builder.append(&real, &b"lib"[..]).unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(&builder.into_inner().unwrap()).unwrap();
        let good = dir.join("good.tar.gz");
        fs::write(&good, encoder.finish().unwrap()).unwrap();
        extract(&good, &into).unwrap();
        assert_eq!(fs::read(into.join("libllama.so")).unwrap(), b"lib");

        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o777);
        header.set_path("sneaky").unwrap();
        header.set_link_name("../../etc/passwd").unwrap();
        header.set_cksum();
        builder.append(&header, std::io::empty()).unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(&builder.into_inner().unwrap()).unwrap();
        let bad = dir.join("bad.tar.gz");
        fs::write(&bad, encoder.finish().unwrap()).unwrap();
        let into2 = dir.join("out2");
        fs::create_dir_all(&into2).unwrap();
        assert!(extract(&bad, &into2).is_err());
        assert!(!into2.join("sneaky").exists());
    }

    #[test]
    fn a_file_that_is_neither_zip_nor_tar_gz_is_refused() {
        let dir = scratch("kind");
        let file = dir.join("llama.rar");
        fs::write(&file, b"x").unwrap();
        assert!(extract(&file, &dir).is_err());
    }

    // ---- installing, end to end against a local web server ------------------------------------

    use crate::test_support::serve_bytes as serve_once;

    fn asset_for_bytes(file: &str, bytes: &[u8]) -> Asset {
        Asset {
            os: "linux".into(),
            arch: "x86_64".into(),
            backend: "cpu".into(),
            file: file.into(),
            size: bytes.len() as u64,
            sha256: sha(bytes),
        }
    }

    #[test]
    fn installs_by_digest_unpacks_checks_and_does_not_fetch_twice() {
        let archive = tar_gz(&[("bin/llama-server", b"#!/bin/sh\nexit 0\n", 0o755)]);
        let (url, hits) = serve_once(archive.clone());
        let asset = asset_for_bytes("llama-bX-bin-ubuntu-x64.tar.gz", &archive);
        let cache = scratch("install");
        let cancel = AtomicBool::new(false);
        let verified = std::cell::Cell::new(0);
        let server = install_with(&cache, "bX", &asset, &url, &cancel, &mut |_| {}, |_| {
            verified.set(verified.get() + 1);
            Ok(())
        })
        .unwrap();
        assert!(server.starts_with(dir(&cache).join("llama-bX")));
        assert!(server.is_file());
        // The archive is not kept, and no half-unpacked folder is left behind.
        assert!(!dir(&cache).join("downloads").join(&asset.file).exists());
        assert!(!dir(&cache).join("llama-bX.partial").exists());
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);

        // The second time nothing is fetched; the program is only checked.
        let again =
            install_with(&cache, "bX", &asset, &url, &cancel, &mut |_| {}, |_| Ok(())).unwrap();
        assert_eq!(again, server);
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn a_download_with_the_wrong_digest_is_refused_and_nothing_is_unpacked() {
        let archive = tar_gz(&[("bin/llama-server", b"x", 0o755)]);
        let (url, _hits) = serve_once(archive.clone());
        let mut asset = asset_for_bytes("llama-bX-bin-ubuntu-x64.tar.gz", &archive);
        asset.sha256 = "0".repeat(64);
        let cache = scratch("wrong-digest");
        let problem = install_with(
            &cache,
            "bX",
            &asset,
            &url,
            &AtomicBool::new(false),
            &mut |_| {},
            |_| Ok(()),
        )
        .unwrap_err();
        assert!(
            problem.said.contains("not what it was expecting"),
            "{problem:?}"
        );
        assert!(!dir(&cache).join("llama-bX").exists());
    }

    #[test]
    fn an_archive_with_no_server_in_it_is_a_sentence_and_leaves_nothing() {
        let archive = tar_gz(&[("bin/readme.txt", b"hello", 0o644)]);
        let (url, _hits) = serve_once(archive.clone());
        let asset = asset_for_bytes("llama-bX-bin-ubuntu-x64.tar.gz", &archive);
        let cache = scratch("no-server");
        let problem = install_with(
            &cache,
            "bX",
            &asset,
            &url,
            &AtomicBool::new(false),
            &mut |_| {},
            |_| Ok(()),
        )
        .unwrap_err();
        assert!(
            problem.said.contains("could not find the model engine"),
            "{problem:?}"
        );
        assert!(!dir(&cache).join("llama-bX").exists());
        assert!(!dir(&cache).join("llama-bX.partial").exists());
    }

    #[test]
    fn a_program_that_will_not_start_is_refused_and_not_kept() {
        let archive = tar_gz(&[("bin/llama-server", b"x", 0o755)]);
        let (url, _hits) = serve_once(archive.clone());
        let asset = asset_for_bytes("llama-bX-bin-ubuntu-x64.tar.gz", &archive);
        let cache = scratch("wont-start");
        let problem = install_with(
            &cache,
            "bX",
            &asset,
            &url,
            &AtomicBool::new(false),
            &mut |_| {},
            |_| Err(Problem::plain("did not start")),
        )
        .unwrap_err();
        assert_eq!(problem.said, "did not start");
        assert!(!dir(&cache).join("llama-bX").exists());
    }

    #[cfg(unix)]
    #[test]
    fn verify_runs_the_program_and_reports_one_that_fails() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("verify");
        let good = dir.join("llama-server");
        fs::write(&good, "#!/bin/sh\necho 'version: 1 (abc)' >&2\nexit 0\n").unwrap();
        fs::set_permissions(&good, fs::Permissions::from_mode(0o755)).unwrap();
        verify_server(&good).unwrap();

        let bad = dir.join("broken");
        fs::create_dir_all(&bad).unwrap();
        let bad = bad.join("llama-server");
        fs::write(
            &bad,
            "#!/bin/sh\necho 'libggml.so: cannot open' >&2\nexit 127\n",
        )
        .unwrap();
        fs::set_permissions(&bad, fs::Permissions::from_mode(0o755)).unwrap();
        let problem = verify_server(&bad).unwrap_err();
        assert!(problem.said.contains("did not start"), "{problem:?}");
        assert!(problem.detail.unwrap().contains("cannot open"));
    }
}
