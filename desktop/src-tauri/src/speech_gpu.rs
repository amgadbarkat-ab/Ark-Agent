//! Whether this computer may be offered Read aloud's speech engine (docs/ark/27-read-aloud.md).
//!
//! GPU-ONLY, AND ONLY NVIDIA. The approved model was measured on a processor at about eight times
//! slower than real time and about 6.2 GB of memory, which is not a voice anybody waits for, so the
//! desktop must never offer it to a computer without a graphics card. And the card has to be NVIDIA's:
//! the `speech` Compose service reserves its GPU through the NVIDIA device driver, which is the one a
//! container engine can hand to a container on Linux and on Windows (through WSL). `local_model`'s
//! `has_graphics_card` is not this question — it counts AMD and Intel cards, and only asks Windows.
//!
//! NOT WIRED TO A SWITCH YET. This is the check the desktop's Read aloud switch will make before it
//! shows itself; until that switch exists the engine is started by hand, as the document above says,
//! and the desktop starts nothing (its `up` names its services, and `speech` is not one of them).
//!
//! The card is found by asking `nvidia-smi`, which NVIDIA's driver installs on both systems. Where it
//! is missing or says nothing the answer is "no card", which is the safe answer: the engine then simply
//! is not offered.

use serde::Serialize;

/// One NVIDIA card, as the driver describes it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NvidiaGpu {
    pub name: String,
    /// Total memory on the card, in MiB, or 0 where the driver did not say.
    pub memory_mib: u64,
}

/// What the desktop may say about Read aloud on this computer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SpeechOffer {
    /// No NVIDIA card: Read aloud is not offered at all, never on the processor.
    NoNvidiaGpu,
    /// A card, but no engine image has been built and named in `SPEECH_IMAGE`; nothing is pulled.
    NoEngineImage,
    /// A card and an image: the switch may be shown.
    Available,
}

/// The NVIDIA cards on this computer, or none where they cannot be read.
///
/// macOS is not asked: no Mac sold for years has an NVIDIA card a container can use.
pub fn nvidia_gpus() -> Vec<NvidiaGpu> {
    if std::env::consts::OS == "macos" {
        return Vec::new();
    }
    crate::quiet::command("nvidia-smi")
        .args([
            "--query-gpu=name,memory.total",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| parse_nvidia_smi(&String::from_utf8_lossy(&output.stdout)))
        .unwrap_or_default()
}

/// Read `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`, one card per line.
pub fn parse_nvidia_smi(output: &str) -> Vec<NvidiaGpu> {
    output
        .lines()
        .filter_map(|line| {
            let (name, memory) = line.rsplit_once(',')?;
            let name = name.trim();
            if name.is_empty() {
                return None;
            }
            Some(NvidiaGpu {
                name: name.to_owned(),
                memory_mib: memory.trim().parse().unwrap_or(0),
            })
        })
        .collect()
}

/// Whether Read aloud may be offered, from the cards found and the engine image named.
///
/// The card is checked first: with no card the answer is no whatever image is named, because an image
/// on a computer without a card would run on the processor, which is the thing this refuses.
pub fn speech_offer(gpus: &[NvidiaGpu], image: Option<&str>) -> SpeechOffer {
    if gpus.is_empty() {
        return SpeechOffer::NoNvidiaGpu;
    }
    match image.map(str::trim) {
        Some(image) if !image.is_empty() => SpeechOffer::Available,
        _ => SpeechOffer::NoEngineImage,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cards_are_read_from_nvidia_smi() {
        assert_eq!(
            parse_nvidia_smi("NVIDIA GeForce RTX 4070 Laptop GPU, 8188\r\nNVIDIA A10G, 23028\n"),
            vec![
                NvidiaGpu {
                    name: "NVIDIA GeForce RTX 4070 Laptop GPU".into(),
                    memory_mib: 8188
                },
                NvidiaGpu {
                    name: "NVIDIA A10G".into(),
                    memory_mib: 23028
                },
            ]
        );
        // A card whose memory the driver will not report is still a card.
        assert_eq!(
            parse_nvidia_smi("Tesla T4, [N/A]\n"),
            vec![NvidiaGpu {
                name: "Tesla T4".into(),
                memory_mib: 0
            }]
        );
    }

    #[test]
    fn nothing_from_the_driver_is_no_card() {
        assert!(parse_nvidia_smi("").is_empty());
        assert!(parse_nvidia_smi("\n\n").is_empty());
        assert!(parse_nvidia_smi(
            "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.\n"
        )
        .is_empty());
    }

    #[test]
    fn read_aloud_is_never_offered_without_an_nvidia_card() {
        let card = [NvidiaGpu {
            name: "NVIDIA GeForce RTX 4070".into(),
            memory_mib: 12282,
        }];
        assert_eq!(
            speech_offer(&[], Some("speech:local")),
            SpeechOffer::NoNvidiaGpu
        );
        assert_eq!(speech_offer(&[], None), SpeechOffer::NoNvidiaGpu);
        assert_eq!(speech_offer(&card, None), SpeechOffer::NoEngineImage);
        assert_eq!(speech_offer(&card, Some("  ")), SpeechOffer::NoEngineImage);
        assert_eq!(
            speech_offer(&card, Some("speech:local")),
            SpeechOffer::Available
        );
    }
}
