# Read aloud: a digital employee's answer in a synthetic voice

Written 2026-10-29 (desk #82). **A draft for review. It is off by default, it is in no build, and
nothing in a release turns it on.**

What the owner approved: "GPU-only Arabic + English opt-in for Read aloud" with KittenTTS 2. Not on a
processor, not Greek, and built so a model that speaks Greek can be added later without rewriting it.

## What it is

Under a digital employee's answer, a **Read aloud** control plays the answer in a synthetic voice.
The control only appears where pressing it can work: the deployment has Read aloud on, the answer is
in Arabic or English, there is a voice set up for that language, and the answer has finished arriving.
While it plays, the control says **Synthetic voice**; its tooltip says so all the time, with the
model's credit. Settings → Preferences has a **Read aloud** section, shown only where it is on, which
explains it and carries the credit ("Powered by KittenML").

It is not live voice (server/src/voice/) and not dictation (server/src/dictation/). Those turn speech
into text or hold a conversation; this turns one finished answer into audio, once, on request.

## Rules, and where each is enforced

| Rule | Where |
| --- | --- |
| Off unless configured | `server/src/speech/config.ts`: every `SPEECH_` setting unset means no feature. `POST /api/speech` answers 404 and `/api/capabilities` reports `readAloud: null`, so the app draws nothing. |
| Signed in, own conversations only | `server/src/speech/routes.ts`: the browser sends a conversation and a message id, never text. The server checks the person is a member of the conversation (`ChannelStore.get`), reads **their own** thread from Ark Hub, and only accepts a digital employee's message (`role: assistant`). Anything else is 404. |
| Arabic and English only, Greek never sent | `shared/speech.ts`, run by the server on the text it loaded. Language is decided by script: Arabic letters are Arabic, Latin letters are English, and a single letter of any other script (Greek, Cyrillic, Hebrew, Chinese...) refuses the whole message with "Read aloud speaks Arabic and English only..." before anything leaves the server. The browser runs the same function only to decide whether to draw the control. |
| Length cap | 4,000 characters after markdown is removed (code blocks, links' addresses and formatting marks are not read). Longer is refused with 413, not cut short. |
| Timeout and failures | 60 seconds per message. Timeout is 504; an engine error or an unreachable engine is 502 with a fixed sentence (the engine's own reply is never passed on, it can contain internals). The answer must be audio (MP3, WAV, Ogg/Opus, AAC, FLAC, WebM) and at most 32 MiB, or it is refused. One message at a time per person, four per server process. |
| Text never logged | Nothing logs the message. A failure writes one line, `{"type":"speech-failed","reason":...,"language":...,"characters":...}`. There is no audit row: like dictation, reading aloud changes nothing and acts on nothing. |
| GPU only | Not something the server can see, so it is enforced where the engine is started: the `speech` Compose service reserves an NVIDIA GPU and Compose refuses to start it without one. The desktop's check (`desktop/src-tauri/src/speech_gpu.rs`) never offers it without an NVIDIA card. Pointing `SPEECH_URL` at an engine running on a processor yourself is not prevented by the server; do not. |
| Engine-pluggable | The server speaks OpenAI's `POST /v1/audio/speech` contract (`{model, input, voice}`, audio back) to whatever `SPEECH_URL` names. KittenTTS appears only in this document, `.env.example` and the configured values. |

### Why not Greek

KittenTTS 2 does not speak Greek. Given Greek text it spells the letters out as English words
("alpha", "beta"), which is worse than silence for a Greek customer. So Greek is refused, and refused
before sending rather than after: a Greek answer never reaches the engine. A single Greek letter inside
an English answer (a σ in a statistic) also refuses that answer, for the same reason.

Adding a model that does speak Greek: add `"el"` to `SPEECH_LANGUAGES` and teach `speechVerdict` the
Greek script (both in `shared/speech.ts`), add a `SPEECH_VOICE_EL` setting in
`server/src/speech/config.ts`, and point `SPEECH_URL` at an engine that has that voice (or run a second
engine and route by language). Routes, the browser and the tests follow from the language list.

## What was measured

By the owner, before this was built, on KittenTTS 2 (pip `kittenml`, model `KittenML/kitten-tts-2`,
1.7B parameters):

- **On a processor: about 8 times slower than real time, and about 6.2 GB of memory.** A one-minute
  answer would take about eight minutes to start playing. This is why it is GPU-only.
- Voices that worked: `NewsAnchorFemale` (English), `ArabicNews` (Arabic).
- Greek: letters spelled out in English, as above.

Not measured: speed and memory on a graphics card, how much card memory is needed, and how long the
engine takes to load. The 60-second timeout and the 4,000-character cap are guesses to check on a real
card.

## Licence obligations

KittenTTS's **code** (the `kittenml` package) is Apache-2.0. The **model weights** are under the
**Stellon Labs Community License**, which is not an open-source licence:

- **Attribution.** "Powered by KittenML" must be shown in the app, the documentation, or an about page.
  ArkAgent shows `SPEECH_ATTRIBUTION` in Preferences → Read aloud and in the control's tooltip; set it
  to `Powered by KittenML`. This document is the documentation half.
- **Licence and notice file.** Anyone distributing the weights (including inside a container image)
  must ship Stellon Labs' licence text and notice file with them. We publish no image; an operator
  who builds one and passes it on must include both.
- **Revenue limit.** The community licence applies only below USD 1 million in annual revenue or
  funding, counted **including affiliates**. Above that a commercial licence from Stellon Labs is
  needed. This must be checked for the company before any customer use.
- **Revocable.** Stellon Labs can revoke the licence. Because the engine is pluggable, revocation means
  turning Read aloud off (unset the `SPEECH_` settings) or pointing it at another engine; nothing else
  in ArkAgent depends on it.

The licence text itself is not copied into this repository; the exact wording should be read from
Stellon Labs before enabling this for anyone.

## How to turn it on (for review, not for customers)

1. **A graphics card.** An NVIDIA card with its driver, and a container engine that can pass it to a
   container: Docker with the NVIDIA Container Toolkit on Linux, or Docker Desktop with WSL 2 GPU
   support on Windows. `nvidia-smi` should list the card. Podman's handling of Compose's GPU
   reservation has not been checked.
2. **Build the engine image yourself.** We do not publish one and the Compose file names none. Build
   KittenTTS's OpenAI-compatible server from KittenML's own repository, following their instructions,
   with the Stellon Labs licence and notice file inside it. It must answer `POST /v1/audio/speech`.
3. **Start it**, in the installation's `.env`:

   ```
   SPEECH_IMAGE=<the tag you built, e.g. kittentts-server:local>
   SPEECH_CONTAINER_PORT=<the port that server listens on inside the container>
   # SPEECH_PORT=4210   (the loopback port on this computer)
   ```

   then `docker compose --profile speech up -d speech`. `pull_policy: never` means a wrong tag fails
   instead of downloading something. Without an NVIDIA GPU Compose refuses to start it.
4. **Point the server at it**, in the server's environment:

   ```
   SPEECH_URL=http://127.0.0.1:4210/v1
   SPEECH_MODEL=KittenML/kitten-tts-2
   SPEECH_VOICE_EN=NewsAnchorFemale
   SPEECH_VOICE_AR=ArabicNews
   SPEECH_ATTRIBUTION=Powered by KittenML
   # SPEECH_API_KEY=   (only if the engine requires one)
   ```

   and restart the server. A voice left unset turns that language off.
5. **Stop it** with `docker compose --profile speech stop speech`. The desktop's Stop does not stop it
   (it names only the `harness` profile), and the desktop never starts it.

### The desktop

The desktop app does not offer Read aloud yet. `desktop/src-tauri/src/speech_gpu.rs` has the check
the switch will use: an NVIDIA card reported by `nvidia-smi` (never on macOS) and an engine image
named. **To do:** the switch itself (shown only when that check says `Available`), passing
`--profile speech` and the `speech` service to the desktop's start and stop, and the `SPEECH_`
settings to the server process it runs.

## What is verified and what is not

Verified by tests, with a stand-in engine: the language rules (Greek and other scripts refused and
never sent, Arabic and English to their own voices, mixed text, markdown removed), the length cap,
conversation and message scoping, off meaning 404, engine errors and timeouts, the concurrency limit,
that the message is not logged, that `/api/capabilities` reveals no endpoint, model, voice or key, the
app drawing the control only where it should, the Compose service being opt-in and GPU-reserving with
no default image, and the desktop's NVIDIA detection.

Not verified: KittenTTS itself behind this route (no GPU was available), its real port and audio
format, playback on Safari and mobile browsers, that the message ids the browser holds for a
just-finished answer match the ones Ark Hub stores (they are the same AG-UI ids by design, but this
was not run end to end), the GPU speed and memory, and the licence terms beyond the summary above.
