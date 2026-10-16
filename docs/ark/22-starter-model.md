# The free starter model

Written 2026-10-15. The decision, how it works in the code, how to run the server it talks to, and what
has not been done. Decided by the owner on 2026-10-15; the model was chosen by engineering.

> **Update 2026-10-16.** The owner dropped Oracle Cloud's free tier (Oracle halved it to 2 OCPU and 12 GB in
> mid 2026, which made the model slow and left no room for more than one user at a time). The server code
> below does not depend on Oracle: it speaks to any OpenAI-compatible address. What changes is where the
> model runs. See "Where it runs, now" for the options and the direction chosen.

## Why

A new person who has not added an API key gets "open Settings, then Models" on their first message. For
most people that is where the first five minutes end. The starter model is a small model we host
ourselves on hardware that costs nothing per request, so the first answer needs nothing from them. It
also makes the 30-day free trial cost us nothing.

## What it is, and is not

- A deployment-level model, **not** a person's connection. Nobody adds it and nobody can remove it. It
  answers for a person who has added no model of their own, **before** the deployment's own model.
- **Not a plan, a quota or a bill.** No usage count, no daily allowance, no price: there is no per-request
  cost to recover (owner decision, 2026-10-15).
- It has one limit that cannot be argued with: a small server answers one or two people at a time. So
  requests **queue in order**, and a request that would wait longer than the configured maximum (120 seconds by
  default) is turned away with a sentence and `Retry-After`, instead of hanging until some other timeout
  gives a worse message. That is a capacity rule, not a usage rule. It applies to everybody equally.
- A person who **has** added a model of their own never gets the starter model in its place. If theirs
  cannot be opened that is an error with a sentence, as before.

## The model

Chosen by engineering on 2026-10-16 for what the bots do (follow instructions, call tools, write and summarise in the
person's language), from the Gemma 4 family, which has an Apache 2.0 licence (decision D6) and native tool use:

| Where it runs | Model | Why |
| --- | --- | --- |
| A customer's computer, 12 GB of memory or more (option 1) | **Gemma 4 E4B**, quantisation-aware 4-bit (about 5 GB) | The best small model that fits an ordinary laptop. |
| A customer's computer with 8 GB (option 1) | **Gemma 4 E2B** (about 3 GB) | Faster and weaker; the only one that fits. |
| The company's own server (option 2) | **Gemma 4 26B A4B** (about 14.4 GB; a mixture-of-experts model that uses about 4 B of its 26 B parameters per word) | Much stronger answers and tool use than E4B, and as fast as a small model because only 4 B parameters work per word. Needs a 24 GB graphics card, see below. |

Alternate if Gemma's tool calls prove unreliable: Qwen3.5 4B for the small tier. Too slow or too big for the places
above: Qwen3.5 9B and gpt-oss-20b (about 14 GB). The comparison is in the competitor workbook of 2026-10-15.

The licence (Apache 2.0, which decision D6 requires) and the tool-use claim were read from Google's model card on
2026-10-16. Weights only from Google's own Hugging Face repositories, checked against the SHA-256 below.

### The pinned files (read 2026-10-16)

Google's own repositories, Apache 2.0 on the model card and in Hugging Face's metadata, both with Google's
quantisation-aware 4-bit build, which keeps more quality at 4 bits than a plain quantisation. The model card says the
small models have a 128K context and "native support for structured tool use", and that Gemma 4 is pre-trained on 140+
languages with out-of-the-box support for 35+; **Greek is not named, so Greek quality has to be tested**, not assumed.

| Model | Repository | File | Size in bytes | SHA-256 |
| --- | --- | --- | --- | --- |
| Gemma 4 E4B | `google/gemma-4-E4B-it-qat-q4_0-gguf` | `gemma-4-E4B_q4_0-it.gguf` | 5,154,941,280 | `676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee` |
| Gemma 4 E2B | `google/gemma-4-E2B-it-qat-q4_0-gguf` | `gemma-4-E2B_q4_0-it.gguf` | 3,349,516,256 | `fa401b55b07ee70a54c6dae3903c783a6e65064312529ea57175cb5f8dec6634` |
| Gemma 4 26B A4B (company server only) | `google/gemma-4-26B-A4B-it-qat-q4_0-gguf` | `gemma-4-26B_q4_0-it.gguf` | 14,439,363,584 | `3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d` |

Each repository also holds an `mmproj` file for images; text work does not need it, so it is not downloaded. The
memory the files need is the file size plus working memory and the operating system: E2B suits a computer with 8 GB,
E4B one with 12 GB or more. Still to check by running them: that tool calls through llama.cpp are reliable with our bot
prompt, Greek answers, and speed on a typical laptop.

## Where it runs, now

There is no free hosted model that has no ceiling and no catch. What was found on 2026-10-16:

| Option | Cost | The catch |
| --- | --- | --- |
| **On the customer's own computer** (llama.cpp, managed by the desktop app) | Nothing, for ever | Speed depends on the computer; needs about 8 GB of memory for E2B and about 12 GB for E4B. Private, works offline, no token to leak, no queue. |
| Oracle Always Free (the original plan) | Nothing | 2 OCPU and 12 GB since mid 2026, no GPU: roughly 4 to 8 tokens a second, one person at a time. Dropped by the owner. |
| Free hosted APIs: Groq, Cerebras, Cloudflare Workers AI | Nothing | One key means one shared allowance for all our customers (Groq about 200,000 tokens a day, Cloudflare 10,000 "neurons" a day); limits change; commercial terms vary. 04-llm-providers.md already ruled out a shared key. |
| Mistral's free tier (an EU provider) | Nothing | Reported to require opting in to training on prompts: not acceptable for customer data. |
| Hugging Face Spaces, free CPU | Nothing | Sleeps when idle, and Hugging Face points always-on use at paid hardware. Not for production. |
| Azure credits through Microsoft for Startups Founders Hub | Credits, not free for ever: reported as USD 1,000 for 90 days, up to about 5,000 within 180 days | Runs in West Europe beside everything else, but ends when the credits do. An application, with review time. |
| A machine the company already owns, behind a tunnel | Electricity | Uptime is a home or office connection. |

**Direction chosen (2026-10-16, engineering's recommendation, awaiting the owner's word on the hosted part):**

1. **Desktop: a managed local model.** This is the starter model for the main product. It matches decision D6
   (local and free by default, so a person pays Ark and nothing else) and removes the three problems of a
   hosted model for the desktop: no queue, no token on customers' computers, no per-request cost to anybody.
   The desktop app detects memory, suggests E2B or E4B, downloads a pinned llama.cpp and the weights with a
   checksum, runs it on the loopback address and registers it as the person's default connection.
2. **Web, phone and cloud: no hosted starter at launch.** A person there adds their own key, or uses the cloud
   add-on. A hosted starter can be added later from Azure credits if the owner applies to Founders Hub; the
   queue, gateway and status route built for it work unchanged against any OpenAI-compatible address.

## The choice at setup (decided 2026-10-16)

At first run the desktop asks how the person wants their first model, once, and they can change it later in
Settings, then Models:

1. **On this computer** (option 1). The app reads the computer's memory, picks E4B or E2B, shows the download size
   and what it will use, and fetches it. Free for ever, private, works offline, no queue. Slower on a modest laptop.
   A computer with less than 8 GB is told so in a sentence and offered 2 or 3.
2. **On ArkAgent's server** (option 2). Nothing to download; answers come from the company's Gemma 4 26B A4B.
   Needs an Ark account (the desktop asks for one) and, while the server is shared, a queue. **Shown but not
   selectable until the company server exists and the cloud is live**; the screen says "arrives with your ArkAgent
   account" instead of hiding it, so the choice is already visible.
3. **My own key or server** (OpenAI, Anthropic, Google, xAI, any compatible address). Exactly as today.

The decision is stored with the rest of the person's model choice, not as a plan or a quota. Option 2 never puts a
token on the customer's computer: it goes through Ark's cloud, signed in (below).

## What the company has to run for option 2

Nothing is needed for option 1. For option 2 the company needs **one machine that stays on**:

| | Minimum that works | Recommended |
| --- | --- | --- |
| Graphics card | One NVIDIA card with **24 GB** (RTX 3090 or 4090; L4 or A10 in a rack). The model file is 14.4 GB; with working memory sources put it at about 17 to 22 GB, so 24 GB is the least that works and has little room for more than two answers at once. | **32 GB** (RTX 5090) or a 48 GB workstation card, for room to answer three or four people at once. |
| Or, instead of a card | An Apple Silicon Mac with **48 GB** unified memory (Mac mini M4 Pro, Mac Studio). Quiet and cheap to run; slower than the card for several people at once. | Mac Studio with 64 GB. |
| Computer | 8 cores, **64 GB** RAM, 1 TB NVMe, Ubuntu LTS | The same. |
| Network | Wired, 100 Mbps up, a fixed address or a tunnel, a UPS | A rented dedicated server in the EU instead of a machine in an office. |
| Software | llama.cpp's `llama-server` and the 14.4 GB file above. Nothing else; Ark's cloud is the only thing that talks to it. | |

Speed, from other people's tests of this model on a 3090 or 4090 with llama.cpp at 4 bits: roughly 85 to 130
tokens a second for one answer, which is faster than anybody reads. The sources disagree and none is ours, so it has to be
measured with `scripts/starter-model-benchmark.ts` before launch. Gemma 4 turns a reasoning trace on by default, which
costs time and tool-call tidiness; the server is started with it off (check the flag name in `llama-server --help`).

**How many people.** One card answers a few people at the same moment, and a person is only waiting while their bot is
generating, which is a few seconds in most turns. On those numbers one machine plausibly serves a few hundred active
trial users; a big launch week needs a second. This is an estimate, to be replaced by the benchmark.

**Buy or rent.** Buying a 24 GB card and a PC is a one-off cost in the low thousands of euros (an estimate, not a quote).
Renting: Hetzner's GPU line was being rebuilt in October 2026 (the GEX44 can no longer be ordered, its replacement
GEX45 is listed at about EUR 214 a month net plus a setup fee, and its graphics memory was not confirmed) so look at
the current list before ordering; only a card with at least 24 GB is any use for this model. A rented server is a new
sub-processor, to go in the DPA and in 14-data-protection.md before it serves a customer. Azure has 24 GB cards
(the NVadsA10 v5 size) in West Europe, but a 24-hour GPU there costs far more than the credits cover.

**The smaller alternative.** If the company wants to start smaller: a 16 GB card (RTX 4060 Ti or 5060 Ti) runs E4B,
the same model as option 1, fast, for several people. Weaker answers; the machine is cheaper. It is the fallback if
26B A4B cannot be afforded.

**Nothing on a customer's computer holds the server's token.** With no cap, a token read out of an installed app would
be free compute for anybody. The desktop reaches the company server only through Ark's cloud, after signing in.

## If a hosted starter is built later

Run llama.cpp's server on a machine we pay for or have credits on: `llama-server -m <file>.gguf --alias
gemma-4-e4b --host 127.0.0.1 --port 8080 --jinja --ctx-size 8192 --parallel 1 --threads <cores> --api-key <token>`
(flag names as of llama.cpp when this was written; check `--help`), behind a TLS reverse proxy open only to
Ark's servers, since the model has no cap and a public endpoint would be free compute for anybody. Set the five
variables above. Measure with `scripts/starter-model-benchmark.ts` before choosing E4B or E2B: below about 3
tokens a second for one person is too slow. Before it serves customers, add the host as a sub-processor in the
DPA and in 14-data-protection.md, and say so in the privacy notice.

## What has been verified

- The queue: one at a time, in order, held through the whole stream, given back on cancel, error, a
  failed connection and a body-less answer; a person who walks away leaves the line; a request that waits
  too long gets a sentence and `Retry-After`; two answers at once when the operator allows it. Mutating
  the code (releasing at the first byte; letting a caller's `Authorization` through) makes tests fail.
- Through a real HTTP server: the operator's token reaches it and the bot's grant never does; the person's
  own connection still goes to their own address; a model run on the starter really reaches the server;
  a down server and a busy server each produce their own sentence, and the sentence does not name the address.
- Settings: absent, defaults, every limit, a stray token, a password in the address, plain http in production.

## What has not been done

- **No model server exists**, and nothing here has run against Gemma 4 E4B. Speeds are estimates. Tool calling on
  this model through llama.cpp is unproven.
- **The desktop's managed local model** is in progress. Done and tested: memory detection, the pinned file list, the
  resumable download checked against size and SHA-256 (`desktop/src-tauri/src/local_model.rs`). Not done: the
  llama.cpp runtime itself (pinned by a CI job, see below), running it on the loopback address, registering it as the
  person's connection, and the setup screen with the three choices. It is the "local models with detection" item in
  05-build-plan.md, moved up to launch scope.
- **Nothing has run against a real model.** The sandbox cannot reach llama.cpp's release page, so the engine could not
  be fetched here; the runner is tested against a stand-in server and the real run happens on the owner's Windows
  computer.
- **The screen.** Settings > Models does not yet show the starter model or its queue (the endpoint is there).
- **The desktop and a hosted starter.** A desktop must not be given a hosted model's token: with no cap, anyone who
  read it from an installed app would have free compute. A desktop reaches a hosted model only through Ark's own cloud,
  signed in (decided 2026-10-16: the desktop asks for an Ark account), after the first Azure deployment.
- **Per-bot choice of the starter model** (`bot_model_choices` holds connection rows only).
- **Usage metering** of it, which is deliberately absent.
