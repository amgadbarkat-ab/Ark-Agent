import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { Ask } from "./Ask";
import { DatabaseReset } from "./DatabaseReset";
import { DownloadBar, formatBytes } from "./DownloadProgress";
import {
  DEFAULT_HARNESS,
  FrameworkChoice,
  frameworkReady,
  type HarnessChoice,
  needsAnthropicKey,
} from "./HarnessPicker";
import { isHttpEndpointUrl } from "./http-endpoint-url";
import { asProblem, Failure, type Problem } from "./Problem";
import {
  type HeldConfiguration,
  type ModelChoice,
  ProviderPicker,
  recordedModel,
} from "./ProviderPicker";
import { Welcome } from "./Welcome";

type EngineStatus = {
  engine: "docker" | "podman" | null;
  responding: boolean;
  engine_socket: string | null;
  detail: string;
};

/** Where in setup the person is. */
type SetupStep =
  | "welcome"
  // The one page where the AI is chosen: where it comes from, the key, and the agent framework.
  | "model"
  // Installing, with the model downloading beside it; ArkAgent starts by itself when both are done.
  | "install"
  | "ask"
  // Where the person lands once ArkAgent is set up: running, or stopped and ready to start again.
  | "home";

type Blocker =
  | "wsl-absent"
  | "wsl-one"
  | "virtual-machine-platform-disabled"
  | "virtualization-disabled"
  | "not-administrator";

type Progress = {
  step: string;
  ok: boolean;
  detail: string;
  running?: boolean;
  downloadBytes?: number;
  /** When the size of the download is known, so the panel can show a bar and a time left. */
  downloadTotal?: number;
};

type AlreadyConfigured = {
  values: Record<string, string>;
  saved: NonNullable<HeldConfiguration["saved"]>;
  launch?: { harness: HarnessChoice | null } | null;
  installation?: { harness: HarnessChoice | null } | null;
  autoStart?: boolean;
};

/**
 * Whether a start was refused because this app is newer than the software it would run.
 *
 * An update used to replace this window and nothing behind it, so every fix in a new version was
 * missing from the server and the digital employees until somebody reinstalled from nothing.
 */
function updateNeeded(problem: Problem): boolean {
  return /was updated to/i.test(problem.said);
}

function installationKeyFor(root: string, harness: HarnessChoice | null) {
  return JSON.stringify([
    root.trim(),
    harness?.id ?? DEFAULT_HARNESS,
    harness?.agentUrl?.trim() ?? "",
  ]);
}

/**
 * What the last screen offers to ask, mirroring `ask::SUGGESTED`.
 *
 * Two copies of one sentence, and a test in `ask.rs` pins what it has to contain. The window needs
 * it before it calls anything, and the Rust side needs it for the case where somebody clears the
 * field, so neither can be the only one that has it.
 */
const SUGGESTED_QUESTION = "What is 17 times 23?";

export function App() {
  // The engine is looked at so the window knows it is answering; nothing on screen reads the answer now.
  const [, setEngine] = useState<EngineStatus | null>(null);
  const [blocker, setBlocker] = useState<Blocker | null>(null);
  const [blockerFailure, setBlockerFailure] = useState<Problem | null>(null);
  const [instruction, setInstruction] = useState("");
  const [root, setRoot] = useState("");
  /*
   * Which Bot and which model, as two separate answers.
   *
   * Held here rather than inside the screens so going Back does not lose what was already chosen:
   * the flow is resumable at the screen it stopped on, and a wizard that asks twice is one nobody
   * finishes. `null` means not answered yet, which is what decides the screen below.
   */
  const [harness, setHarness] = useState<HarnessChoice | null>({
    id: DEFAULT_HARNESS,
  });
  const [model, setModel] = useState<ModelChoice | null>(null);
  /** Model credentials a previous run already wrote, so the provider screen arrives filled in. */
  const [alreadyHeld, setAlreadyHeld] = useState<HeldConfiguration>({});
  const [step, setStep] = useState<SetupStep>("welcome");
  const [steps, setSteps] = useState<Progress[]>([]);
  const [busy, setBusy] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [checkingResume, setCheckingResume] = useState(true);
  const savedLaunch = useRef<string | null>(null);
  const [preparation, setPreparation] = useState<{
    key: string;
    status: "preparing" | "complete" | "failed";
  } | null>(null);
  const installationKey = installationKeyFor(root, harness);
  const installationReady =
    preparation?.key === installationKey && preparation.status === "complete";
  const returningToInstallation = savedLaunch.current === installationKey;
  const [running, setRunning] = useState(false);
  const configuredRunRef = useRef(0);
  /*
   * A failure, in both registers.
   *
   * `said` is what a person reads and `detail` is the real output, kept behind a disclosure. One
   * string could not serve both: the plain sentence alone throws away the evidence, and the raw
   * engine output alone is how "pull access denied ... may require 'docker login'" ended up as the
   * headline on a setup screen. See `problem.rs`.
   */
  const [failure, setFailure] = useState<Problem | null>(null);
  // A supervisor notice belongs to the interrupted run, not to the form being hydrated.
  const [recoveryFailure, setRecoveryFailure] = useState<Problem | null>(null);
  const recoverFromStart = useCallback((error: unknown) => {
    const problem = asProblem(error);
    setSteps((current) => settleProgress(current, problem));
    setRecoveryFailure(problem);
    // A start that found what it needs missing says the installation cannot be trusted any more, so the
    // next attempt installs again instead of starting on top of it.
    if (/Return to Install/i.test(problem.said) || updateNeeded(problem))
      setPreparation(null);
    if (problem.connection === "model") setStep("model");
  }, []);
  const displayedFailure = failure ?? recoveryFailure;
  // The app is newer than the software it runs: one press downloads that and starts.
  const updating = !!displayedFailure && updateNeeded(displayedFailure);
  const credentialContext = useRef([root, model, harness, step]);
  useEffect(() => {
    const next = [root, model, harness, step];
    if (
      next.some((value, index) => value !== credentialContext.current[index])
    ) {
      credentialContext.current = next;
      setFailure(null);
    }
  }, [root, model, harness, step]);

  const clearRootScopedSavedState = useCallback(() => {
    savedLaunch.current = null;
    setAlreadyHeld({});
  }, []);

  const loadConfiguredRoot = useCallback(
    async (nextRoot: string) => {
      const trimmedRoot = nextRoot.trim();
      const run = configuredRunRef.current + 1;
      configuredRunRef.current = run;
      clearRootScopedSavedState();
      if (!trimmedRoot) return;
      try {
        const configured = await invoke<AlreadyConfigured>(
          "already_configured",
          { root: trimmedRoot },
        );
        if (configuredRunRef.current !== run) return;
        const { values, saved } = configured;
        setAlreadyHeld({ ...values, saved });
        return configured;
      } catch {
        if (configuredRunRef.current === run) {
          setAlreadyHeld({});
        }
      }
    },
    [clearRootScopedSavedState],
  );

  useEffect(() => {
    let active = true;
    invoke<EngineStatus>("detect_engine")
      .then(setEngine)
      .catch(() => undefined);
    const windowsReady = invoke<Blocker | null>("windows_blocker")
      .then(async (found) => {
        setBlocker(found);
        if (found) {
          setInstruction(
            await invoke<string>("windows_blocker_instruction", {
              blocker: found,
            }),
          );
        }
        return found === null;
      })
      .catch((error) => {
        setBlockerFailure(asProblem(error));
        return false;
      });
    // A supervisor that stopped retrying must stay stopped when it returns to this window.
    const interruptedRun = invoke<Problem | null>("last_failure")
      .then((found) => {
        if (found) setRecoveryFailure(found);
        return found;
      })
      .catch(() => null);
    Promise.all([
      invoke<string | null>("selected_root").catch(() => null),
      invoke<string>("default_root"),
      windowsReady,
      interruptedRun,
    ])
      .then(async ([selected, fallback, canResume, interrupted]) => {
        if (!active) return;
        const found = selected || fallback;
        setRoot(found);
        /*
         * Arrive filled in when a previous run already wrote these.
         *
         * The alternative is asking somebody to find a key again, and "find it again" means opening
         * a dotfile in a text editor — the exact thing this product exists not to require. Their own
         * file, read back to them on their own machine.
         */
        const configured = await loadConfiguredRoot(found);
        if (!active) return;
        const installed = configured?.launch ?? configured?.installation;
        const resumedModel = configured
          ? recordedModel({
              ...configured.values,
              saved: configured.saved,
            })
          : null;
        if (installed) {
          const key = installationKeyFor(found, installed.harness);
          setHarness(installed.harness);
          setModel(resumedModel);
          setPreparation({ key, status: "complete" });
          if (configured?.launch) savedLaunch.current = key;
          setStep(resumedModel ? "home" : "model");
        }
        if (interrupted?.connection) {
          recoverFromStart(interrupted);
          return;
        }
        // A stack this app started may still be up from a previous window. Ask, rather than
        // offering to set up something that is already running.
        if (
          await invoke<boolean>("already_running", { root: found }).catch(
            () => false,
          )
        ) {
          // Already up from a previous window: show it, rather than a screen about it.
          await invoke("show_openbot");
          setRunning(true);
          return;
        }
        if (!active || !canResume || !configured?.launch || !resumedModel)
          return;
        const resumedHarness = configured.launch.harness;
        // An interrupted run needs an explicit Start, with its saved setup still available.
        if (interrupted || configured.autoStart === false) return;
        setBusy(true);
        setResuming(true);
        try {
          // Only a successful previous setup supplies launch intent. Reopening uses its saved
          // connections and already installed assets; the native start still validates both.
          await invoke("start_stack", {
            root: found,
            model: resumedModel,
            harness: resumedHarness,
          });
          if (!active) return;
          setSteps((current) => settleProgress(current));
          setRunning(true);
          setRecoveryFailure(null);
          await invoke("show_openbot");
        } catch (error) {
          if (active) recoverFromStart(error);
        } finally {
          if (active) {
            setBusy(false);
            setResuming(false);
          }
        }
      })
      .catch((error) => {
        if (active) recoverFromStart(error);
      })
      .finally(() => {
        if (active) setCheckingResume(false);
      });
    const stop = listen<Progress>("setup:progress", (event) => {
      // One row per step, updated in place. A step that reports twice is the same step saying
      // more, and a list that grows a line each time reads as a log rather than as progress.
      setSteps((current) => {
        const at = current.findIndex(
          (step) => step.step === event.payload.step,
        );
        if (at === -1) return [...current, event.payload];
        const next = [...current];
        next[at] = event.payload;
        return next;
      });
    });
    // The model on this computer downloads beside the install, so its progress is a row of its own.
    const stopModel = listen<{
      stage: "engine" | "model";
      downloaded: number;
      total: number;
    }>("local-model:progress", (event) => {
      const { stage, downloaded, total } = event.payload;
      // The engine is a few tens of megabytes; only the model is worth a bar.
      if (stage !== "model") return;
      const finished = downloaded >= total;
      const row: Progress = {
        step: "model",
        ok: true,
        running: !finished,
        detail: finished
          ? "The model is on this computer."
          : "Downloading the model. This happens once.",
        downloadBytes: downloaded,
        downloadTotal: total,
      };
      setSteps((current) => {
        const at = current.findIndex((entry) => entry.step === "model");
        if (at === -1) return [...current, row];
        const next = [...current];
        next[at] = row;
        return next;
      });
    });
    return () => {
      active = false;
      stop.then((unlisten) => unlisten());
      stopModel.then((unlisten) => unlisten());
    };
  }, [loadConfiguredRoot, recoverFromStart]);

  /**
   * Install what ArkAgent needs, and, where the AI is the model on this computer, download that model at
   * the same time: the two take as long as the slower of them, not the sum. True when both are done.
   */
  async function install(
    choice: ModelChoice | null,
    nextHarness: HarnessChoice | null,
    // True when a start follows at once, so the screen does not show an idle moment between the two.
    keepBusyForStart = false,
  ): Promise<boolean> {
    if (busy || !root.trim()) return false;
    const key = installationKeyFor(root, nextHarness);
    setBusy(true);
    setFailure(null);
    setSteps([
      {
        step: "engine",
        ok: true,
        running: true,
        detail: "Checking the software ArkAgent needs.",
      },
    ]);
    setPreparation({ key, status: "preparing" });
    // Started first and not waited for: a failure here is read after the install has had its turn.
    const modelDownload: Promise<unknown> =
      choice?.provider === "local"
        ? invoke("local_model_prepare", {
            root: root.trim(),
            model: choice.model ?? null,
          }).then(
            () => null,
            (error) => error ?? new Error("The model could not be downloaded."),
          )
        : Promise.resolve(null);
    let installed = false;
    try {
      await invoke("prepare_installation", {
        root: root.trim(),
        harness: nextHarness,
      });
      setSteps((current) => settleProgress(current));
      setPreparation({ key, status: "complete" });
      installed = true;
    } catch (error) {
      const problem = asProblem(error);
      setSteps((current) => settleProgress(current, problem));
      setPreparation({ key, status: "failed" });
      setFailure(problem);
    }
    const modelProblem = await modelDownload;
    if (!(keepBusyForStart && installed && !modelProblem)) setBusy(false);
    if (modelProblem) {
      // The install is kept: only the model is outstanding, and trying again picks it up where it stopped.
      const problem = asProblem(modelProblem);
      setSteps((current) => settleProgress(current, problem));
      setFailure((existing) => existing ?? problem);
      return false;
    }
    return installed;
  }

  /** Raise the stack with the model chosen, once everything it needs is installed. */
  async function launch(
    nextModel: ModelChoice | null,
    nextHarness: HarnessChoice | null,
  ) {
    setBusy(true);
    setFailure(null);
    setSteps([]);
    try {
      await invoke("start_stack", {
        root: root.trim(),
        // The whole answer from the model screen, so the Rust side decides which keys that
        // implies. Sending a bare key here is what made two different providers' keys
        // expressible at the same time.
        model: nextModel,
        // By id only. The image, the port and how it is dialled are facts about the harness, and
        // the window carrying them would be a second list to keep in step with the catalogue.
        harness: nextHarness,
      });
      setSteps((current) => settleProgress(current));
      setRunning(true);
      setRecoveryFailure(null);
      // Changing the AI connection does not turn an existing installation into a first run.
      if (savedLaunch.current === installationKeyFor(root, nextHarness)) {
        setStep("home");
        await invoke("show_openbot");
        return;
      }
      /*
       * One screen short of the handover, on purpose.
       *
       * The window used to become ArkAgent here, the moment the stack was up. But up is not the
       * same as working: a refused key or a lapsed plan gives a stack that starts clean and a Bot
       * that cannot answer, and handing over at this point means somebody discovers that inside
       * the product with no idea which of their answers caused it. So the last screen asks a
       * question, and the handover waits for an answer to come back.
       */
      setStep("ask");
    } catch (error) {
      recoverFromStart(error);
    } finally {
      setBusy(false);
      invoke<EngineStatus>("detect_engine")
        .then(setEngine)
        .catch(() => undefined);
    }
  }

  /** Try again: start straight away if everything is installed, and install first if it is not. */
  async function retry(choice: ModelChoice) {
    if (installationReady) await launch(choice, harness);
    else await installThenStart(choice, harness);
  }

  /** Install, then start by itself: the person has already said everything setup needs to know. */
  async function installThenStart(
    choice: ModelChoice,
    nextHarness: HarnessChoice | null,
  ) {
    setStep("install");
    if (await install(choice, nextHarness, true)) {
      await launch(choice, nextHarness);
    }
  }

  /** Run the installation again, to put back whatever a failed start found missing. */
  async function repair() {
    await install(model, harness);
  }

  async function start(nextModel = model) {
    if (!installationReady) {
      if (nextModel) await installThenStart(nextModel, harness);
      else setStep("model");
      return;
    }
    await launch(nextModel, harness);
  }

  async function resetLeftoverDatabase(volume: string) {
    setBusy(true);
    try {
      await invoke("reset_leftover_database", {
        root: root.trim(),
        volume,
        confirmed: true,
      });
      setFailure(null);
      setRecoveryFailure(null);
      setSteps([]);
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      setBusy(false);
    }
  }

  function modelCanStart() {
    if (!model) return false;
    if (!model.saved) return true;
    if (model.provider === "google" || model.provider === "xai") {
      return model.login === "oauth" && Boolean(model.model?.trim());
    }
    if (model.provider === "openai-compatible") {
      return (
        model.login === "endpoint" &&
        isHttpEndpointUrl(model.baseUrl ?? "") &&
        Boolean(model.model?.trim())
      );
    }
    if (model.provider !== "openai" && model.provider !== "anthropic") {
      return false;
    }
    return model.login === "api-key";
  }

  async function stop() {
    setBusy(true);
    try {
      await invoke("stop_stack", { root });
      setRunning(false);
      setRecoveryFailure(null);
      setStep("home");
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      setBusy(false);
    }
  }

  async function changeModelAfterAskFailure() {
    setBusy(true);
    setFailure(null);
    try {
      await invoke("stop_stack", { root });
      setRunning(false);
      setRecoveryFailure(null);
      setStep("model");
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      setBusy(false);
    }
  }

  // Nothing else on this screen can be done until the machine allows it, so nothing else is shown.
  if (blockerFailure) {
    return (
      <main>
        <h1>ArkAgent could not check Windows setup</h1>
        <Failure problem={blockerFailure} />
      </main>
    );
  }

  if (blocker) {
    return (
      <main>
        <h1>ArkAgent needs one thing first</h1>
        <div className="blocker">
          <h2>{titleFor(blocker)}</h2>
          <p>{instruction}</p>
        </div>
      </main>
    );
  }

  if (resuming || checkingResume) {
    return (
      <main>
        <h1>{resuming ? "Starting ArkAgent" : "Opening ArkAgent"}</h1>
        <p role="status">
          {resuming
            ? "Opening your saved setup…"
            : "Checking your saved setup…"}
        </p>
        <SetupProgress steps={steps} />
      </main>
    );
  }

  /*
   * Install local software before asking for anything. A completed installation is retained
   * while somebody changes or retries their connection; changing its folder or Bot invalidates it.
   *
   * Skipped entirely when a stack is already up: somebody returning to a running ArkAgent is not
   * setting one up, and asking them to pick a Bot again would be the wizard asking twice.
   */
  if (!running && step === "welcome") {
    return (
      <main className="welcome-main">
        <Welcome onStart={() => setStep("model")} />
        {displayedFailure && <Failure problem={displayedFailure} />}
      </main>
    );
  }

  /*
   * Installing, and starting by itself afterwards. Reached from the AI page once everything setup needs to
   * know has been answered, so there is nothing to press here: a person watches it work, and the only
   * buttons are for when it did not.
   */
  if (!running && step === "install") {
    return (
      <main>
        <div className="sheet">
          <p className="steps-of">Step 2 of 2</p>
          <h1>
            {displayedFailure
              ? "ArkAgent is not ready yet"
              : installationReady
                ? "Starting ArkAgent"
                : "Installing ArkAgent"}
          </h1>
          <p className="lede">
            {displayedFailure
              ? "Nothing you chose is lost. Try again, or go back and change the AI."
              : model?.provider === "local"
                ? "ArkAgent is installing what it needs and downloading the model beside it. It starts by itself when both are done."
                : "ArkAgent is installing what it needs. It starts by itself when that is done."}
          </p>
          <SetupProgress steps={steps} />
          {displayedFailure && <Failure problem={displayedFailure} />}
          {displayedFailure?.database_reset && (
            <DatabaseReset
              key={`${root}:${displayedFailure.database_reset}`}
              busy={busy}
              volume={displayedFailure.database_reset}
              onReset={resetLeftoverDatabase}
            />
          )}
          <div className="row">
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => setStep("model")}
            >
              Change the AI
            </button>
            {/* Not while a first attempt is simply in progress, and still there, held, while a recovery
                is: it is the button that carries on once the recovery is done. */}
            {model && (!busy || displayedFailure) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void retry(model)}
              >
                Try again
              </button>
            )}
          </div>
        </div>
      </main>
    );
  }

  /*
   * Shown while the stack is running, which every other screen is skipped for. This is the one
   * screen that needs a running stack: it is the proof, and there is nothing to ask before there
   * is something to ask.
   */
  if (step === "ask") {
    return (
      <main>
        <Ask
          suggestion={SUGGESTED_QUESTION}
          onAsk={(question) =>
            invoke<string>("ask_the_bot", { root, question })
          }
          onOpen={() => {
            savedLaunch.current = installationKey;
            invoke("show_openbot").catch((error) => recoverFromStart(error));
          }}
          onBack={changeModelAfterAskFailure}
        />
        {displayedFailure && <Failure problem={displayedFailure} />}
      </main>
    );
  }

  if (!running && step === "model") {
    return (
      <main>
        <ProviderPicker
          held={alreadyHeld}
          root={root}
          chosen={model}
          returning={returningToInstallation}
          busy={busy}
          canContinue={frameworkReady(harness)}
          // The last answer ArkAgent needs: choosing installs and starts it, so there is nothing left to
          // sign in to and no second page about the framework.
          onChoose={(choice) => {
            // A framework that can only run on an Anthropic key does not follow somebody to another AI.
            const kept =
              harness?.id === "byo-url"
                ? { ...harness, agentUrl: harness.agentUrl?.trim() }
                : harness;
            const nextHarness =
              needsAnthropicKey(harness?.id) &&
              !(choice.provider === "anthropic" && choice.login === "api-key")
                ? { id: DEFAULT_HARNESS }
                : kept;
            if (nextHarness !== harness) setHarness(nextHarness);
            setModel(choice);
            const ready =
              preparation?.key === installationKeyFor(root, nextHarness) &&
              preparation.status === "complete";
            if (ready) void launch(choice, nextHarness);
            else void installThenStart(choice, nextHarness);
          }}
          onBack={() => {
            setSteps([]);
            setStep(returningToInstallation ? "home" : "welcome");
          }}
          advanced={(selection) => (
            <div className="advanced">
              <FrameworkChoice
                chosen={harness}
                anthropicKey={
                  selection.provider === "anthropic" &&
                  selection.login === "api-key"
                }
                onChoose={(choice) => {
                  if (
                    choice.id !== harness?.id ||
                    choice.agentUrl !== harness?.agentUrl
                  ) {
                    setPreparation(null);
                    setSteps([]);
                  }
                  setHarness(choice);
                }}
              />
              <details>
                <summary>Where ArkAgent is installed</summary>
                <div className="field" style={{ marginTop: "0.6rem" }}>
                  <label htmlFor="root">Installation folder</label>
                  <input
                    id="root"
                    disabled={busy}
                    value={root}
                    onChange={(event) => {
                      configuredRunRef.current += 1;
                      setRoot(event.target.value);
                      setModel(null);
                      setPreparation(null);
                      setSteps([]);
                      clearRootScopedSavedState();
                    }}
                    onBlur={(event) => loadConfiguredRoot(event.target.value)}
                    spellCheck={false}
                  />
                </div>
              </details>
            </div>
          )}
        />
        <SetupProgress steps={steps} />
        {displayedFailure?.database_reset && (
          <DatabaseReset
            key={`${root}:${displayedFailure.database_reset}`}
            busy={busy}
            volume={displayedFailure.database_reset}
            onReset={resetLeftoverDatabase}
          />
        )}
        {displayedFailure && <Failure problem={displayedFailure} />}
      </main>
    );
  }

  if (!running) {
    return (
      <main>
        <h1>ArkAgent is stopped</h1>
        <p className="lede">
          Your installation and saved connections are ready to reopen.
        </p>
        <SetupProgress steps={steps} />
        {displayedFailure?.database_reset && (
          <DatabaseReset
            key={`${root}:${displayedFailure.database_reset}`}
            busy={busy}
            volume={displayedFailure.database_reset}
            onReset={resetLeftoverDatabase}
          />
        )}
        {displayedFailure && <Failure problem={displayedFailure} />}
        <button
          type="button"
          disabled={
            busy || (!installationReady && !updating) || !modelCanStart()
          }
          onClick={() => start()}
        >
          {busy
            ? "Starting…"
            : updating
              ? "Update and start"
              : "Start ArkAgent"}
        </button>
        <button
          type="button"
          className="quiet"
          disabled={busy}
          onClick={() => setStep("model")}
        >
          Change AI connection
        </button>
        {displayedFailure && (
          <button
            type="button"
            className="quiet"
            disabled={busy}
            onClick={() => void repair()}
          >
            Repair installation
          </button>
        )}
        <details>
          <summary>Installation options</summary>
          <button
            type="button"
            className="quiet"
            disabled={busy}
            onClick={() => {
              // Not a refresh of a working connection any more: a new installation is being chosen.
              savedLaunch.current = null;
              setPreparation(null);
              setSteps([]);
              setStep("model");
            }}
          >
            Change installation
          </button>
        </details>
      </main>
    );
  }

  return (
    <main>
      <div className="sheet connection-sheet">
        {/* A failure outranks `running`. The supervisor gives up on a process and sends the window
          back here, and a heading that still says everything is running while the box underneath
          names the process that stopped is a screen arguing with itself. */}
        <h1>
          {displayedFailure
            ? "ArkAgent needs attention"
            : "ArkAgent is running"}
        </h1>
        {!displayedFailure && (
          <p className="lede">
            The stack is up. ArkAgent is in this window; the menu bar has it
            too, and stops it.
          </p>
        )}

        <SetupProgress steps={steps} />

        {displayedFailure && <Failure problem={displayedFailure} />}

        <div className="row">
          <button
            type="button"
            /*
             * The refusal is shown, not swallowed.
             *
             * `show_openbot` answers with "ArkAgent is not answering on port 3010 yet, so there
             * is nothing to show" when the app host process is not up, and this button dropped
             * it on the floor. Clicking it then did nothing at all, on a screen headed "ArkAgent
             * is running", which is the worst of both: a true sentence was available and the
             * window threw it away. The Ask screen's copy of this call always showed it.
             */
            onClick={() =>
              invoke("show_openbot").catch((error) => recoverFromStart(error))
            }
          >
            Show ArkAgent
          </button>
          <button
            type="button"
            className="quiet"
            onClick={stop}
            disabled={busy}
          >
            Stop ArkAgent
          </button>
        </div>
      </div>
    </main>
  );
}

function settleProgress(steps: Progress[], problem?: Problem): Progress[] {
  return steps.map((step) =>
    step.running
      ? {
          ...step,
          running: false,
          ok: !problem,
          detail: problem?.said ?? "Finished.",
        }
      : step,
  );
}

function SetupProgress({ steps }: { steps: Progress[] }) {
  if (steps.length === 0) return null;
  return (
    <ol className="steps" aria-label="Setup progress" aria-live="polite">
      {steps.map((step) => (
        <SetupProgressRow key={step.step} step={step} />
      ))}
    </ol>
  );
}

function SetupProgressRow({ step }: { step: Progress }) {
  const [elapsed, setElapsed] = useState(0);
  const running = step.running ?? false;
  // The first byte count this download reported, to measure a speed from. Cleared when the step stops.
  const [measured, setMeasured] = useState<{
    at: number;
    bytes: number;
  } | null>(null);
  const bytesNow = step.downloadBytes;
  useEffect(() => {
    if (!running) {
      setMeasured(null);
    } else if (bytesNow != null) {
      setMeasured((first) => first ?? { at: Date.now(), bytes: bytesNow });
    }
  }, [running, bytesNow]);
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [running]);
  return (
    <li className="step" aria-label={label(step.step)}>
      <span
        className={`mark ${running ? "active" : step.ok ? "good" : "bad"}`}
        aria-hidden="true"
      >
        {running ? <span className="step-spinner" /> : step.ok ? "✓" : "✗"}
      </span>
      <span className="step-label">{label(step.step)}</span>
      <span className="step-status">
        {running ? "In progress" : step.ok ? "Complete" : "Failed"}
        {running && (
          <span className="step-elapsed" aria-hidden="true" aria-live="off">
            {" · "}
            {elapsed < 60
              ? `${elapsed}s`
              : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}{" "}
            elapsed
          </span>
        )}
      </span>
      <span className="detail">
        {step.detail}
        {step.downloadBytes != null &&
          step.downloadTotal == null &&
          ` ${formatBytes(step.downloadBytes)} downloaded.`}
        {running && step.downloadBytes != null && step.downloadTotal ? (
          <DownloadBar
            downloaded={step.downloadBytes}
            total={step.downloadTotal}
            measured={measured}
          />
        ) : null}
      </span>
    </li>
  );
}

function titleFor(blocker: Blocker): string {
  switch (blocker) {
    case "wsl-absent":
      return "Windows Subsystem for Linux is not installed";
    case "wsl-one":
      return "Windows Subsystem for Linux is at version 1";
    case "virtual-machine-platform-disabled":
      return "Virtual Machine Platform is switched off";
    case "virtualization-disabled":
      return "Virtualization is off in this machine's firmware";
    case "not-administrator":
      return "This account cannot install Windows components";
  }
}

function label(step: string): string {
  switch (step) {
    case "engine":
    case "install-engine":
      return "Container engine";
    case "create-machine":
      return "Engine machine";
    case "start-machine":
      return "Starting the machine";
    case "health-gate":
      return "Engine answering";
    case "deployment":
      return "Deployment";
    case "env":
      return "Settings";
    case "ports":
      return "Ports";
    case "dependencies":
      return "Dependencies";
    case "images":
      return "Local software";
    case "installation":
      return "Installation";
    case "answering":
      return "Answering";
    case "services":
      return "Containers";
    case "migrate":
      return "Database";
    case "model":
      return "Model on this computer";
    default:
      return step;
  }
}
