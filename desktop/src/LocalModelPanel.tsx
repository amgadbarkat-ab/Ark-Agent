import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { asProblem, InlineFailure, type Problem } from "./Problem";

/** What `local_model_plan` says about this computer. Mirrors `local_setup::Plan`. */
export type LocalModelPlan = {
  ramGib: number;
  cores: number;
  recommendation:
    | {
        kind: "model";
        model: {
          id: string;
          label: string;
          sizeBytes: number;
        };
      }
    | { kind: "tooSmall"; said: string; ramGib: number; needsGib: number };
  toDownloadBytes: number;
  ready: boolean;
  engine: string;
};

type Progress = {
  stage: "engine" | "model";
  downloaded: number;
  total: number;
};

/** 5,154,941,280 bytes as "5.2 GB": the unit a download is quoted in everywhere else. */
export function gigabytes(bytes: number): string {
  const gb = bytes / 1_000_000_000;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

/**
 * "On this computer".
 *
 * Says what ArkAgent found, what it will download, and what to expect; downloads on request with a
 * progress bar and a Cancel; and reports whether the model is ready, so Continue lights up only when
 * pressing it will not leave a person watching a multi-gigabyte download on the next screen.
 */
export function LocalModelPanel({
  root,
  onReady,
}: {
  root: string;
  onReady: (ready: boolean) => void;
}) {
  const [plan, setPlan] = useState<LocalModelPlan | null>(null);
  const [failure, setFailure] = useState<Problem | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [ready, setReady] = useState(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    let active = true;
    setPlan(null);
    setFailure(null);
    setReady(false);
    onReadyRef.current(false);
    invoke<LocalModelPlan>("local_model_plan", { root: root.trim() })
      .then((found) => {
        if (!active) return;
        setPlan(found);
        setReady(found.ready);
        onReadyRef.current(found.ready);
      })
      .catch((error) => {
        if (active) setFailure(asProblem(error));
      });
    return () => {
      active = false;
    };
  }, [root]);

  useEffect(() => {
    const stop = listen<Progress>("local-model:progress", (event) => {
      setProgress(event.payload);
    });
    return () => {
      stop.then((unlisten) => unlisten());
    };
  }, []);

  async function download() {
    setDownloading(true);
    setFailure(null);
    setProgress(null);
    try {
      await invoke("local_model_prepare", { root: root.trim() });
      setReady(true);
      onReadyRef.current(true);
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      setDownloading(false);
    }
  }

  function cancel() {
    void invoke("local_model_cancel");
  }

  if (!plan) {
    return failure ? (
      <InlineFailure problem={failure} />
    ) : (
      <p role="status">Looking at this computer…</p>
    );
  }

  if (plan.recommendation.kind === "tooSmall") {
    return (
      <p className="caution" role="alert">
        {plan.recommendation.said}
      </p>
    );
  }

  const { model } = plan.recommendation;
  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.floor((100 * progress.downloaded) / progress.total))
      : 0;

  return (
    <div className="local-model">
      <p className="lede">
        This computer has about {Math.round(plan.ramGib)} GB of memory, so
        ArkAgent will use <strong>{model.label}</strong>, a free model from
        Google.
      </p>
      <p className="footnote">
        It runs only on this computer, so what you write stays here. It is
        smaller than the models from OpenAI or Anthropic: it is good at everyday
        writing, replies and simple tasks, and slower or less sure on long,
        complicated ones. You can switch to your own key at any time.
      </p>

      {ready ? (
        <p role="status">Ready. Nothing more to download.</p>
      ) : downloading ? (
        <>
          <progress
            max={100}
            value={percent}
            aria-label="Download progress"
            className="download-progress"
          />
          <p role="status">
            {progress
              ? `${progress.stage === "engine" ? "Getting the engine" : "Downloading the model"}: ${gigabytes(progress.downloaded)} of ${gigabytes(progress.total)}`
              : "Starting the download…"}
          </p>
          <button type="button" className="quiet" onClick={cancel}>
            Cancel download
          </button>
        </>
      ) : (
        <>
          <p className="footnote">
            One download of {gigabytes(plan.toDownloadBytes)}, then it works
            without internet.
          </p>
          <button type="button" onClick={() => void download()}>
            Download {gigabytes(plan.toDownloadBytes)}
          </button>
        </>
      )}
      {failure && <InlineFailure problem={failure} />}
    </div>
  );
}
