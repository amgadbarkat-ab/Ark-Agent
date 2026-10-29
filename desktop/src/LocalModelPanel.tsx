import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { asProblem, InlineFailure, type Problem } from "./Problem";

/** One model this computer can run. Mirrors `local_setup::PlanModel`. */
export type LocalModelOption = {
  id: string;
  label: string;
  sizeBytes: number;
  /** The licence's name, such as "Apache 2.0". */
  licence?: string;
  /** Offered, never chosen for anybody: runs only when the person picks it. */
  optIn?: boolean;
  /** The best this computer can run. */
  recommended: boolean;
  /** Already on this computer, whole and checked. */
  ready: boolean;
};

/** What `local_model_plan` says about this computer. Mirrors `local_setup::Plan`. */
export type LocalModelPlan = {
  ramGib: number;
  cores: number;
  gpu: boolean;
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
  models: LocalModelOption[];
  chosen: string | null;
  toDownloadBytes: number;
  ready: boolean;
  engine: string;
};

/** 5,154,941,280 bytes as "5.2 GB": the unit a download is quoted in everywhere else. */
export function gigabytes(bytes: number): string {
  const gb = bytes / 1_000_000_000;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

/** What each size is for, in a few words, because a name like "12B" tells a person nothing. */
function purpose(model: LocalModelOption): string {
  // Before "e4b", which its name also contains.
  if (model.id.includes("bolt")) {
    return "Gemma 4 E4B tuned by NVIDIA for tool use, only if you choose it";
  }
  if (model.id.includes("26b")) {
    return "Best for agents: plans and uses tools well";
  }
  if (model.id.includes("12b")) return "Strong at tools and long tasks";
  if (model.id.includes("e4b")) return "Everyday writing and replies";
  return "Smallest and quickest";
}

/**
 * "On this computer".
 *
 * Says what ArkAgent found, offers every model this computer can run with the best one chosen, and says what
 * will be downloaded. It does not download anything itself: the download starts when setup does, alongside
 * the install, so the two overlap instead of one waiting for the other. The person can carry on at once.
 */
export function LocalModelPanel({
  root,
  chosen,
  onChoose,
  onReady,
}: {
  root: string;
  /** The model asked for, or null before there is a choice. */
  chosen: string | null;
  onChoose: (id: string) => void;
  /** Whether there is a model to run: false on a computer too small for any. */
  onReady: (ready: boolean) => void;
}) {
  const [plan, setPlan] = useState<LocalModelPlan | null>(null);
  const [failure, setFailure] = useState<Problem | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onChooseRef = useRef(onChoose);
  onChooseRef.current = onChoose;

  useEffect(() => {
    let active = true;
    setFailure(null);
    onReadyRef.current(false);
    invoke<LocalModelPlan>("local_model_plan", {
      root: root.trim(),
      model: chosen,
    })
      .then((found) => {
        if (!active) return;
        setPlan(found);
        const usable = found.recommendation.kind === "model";
        onReadyRef.current(usable && found.chosen !== null);
        // The first time through, the choice is made for them: the best that fits.
        if (chosen === null && found.chosen) onChooseRef.current(found.chosen);
      })
      .catch((error) => {
        if (active) setFailure(asProblem(error));
      });
    return () => {
      active = false;
    };
  }, [root, chosen]);

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

  const selected = plan.models.find((model) => model.id === plan.chosen);

  return (
    <div className="local-model">
      <p className="lede">
        This computer has about {Math.round(plan.ramGib)} GB of memory
        {plan.gpu ? " and a graphics card" : ""}. Choose the model ArkAgent
        should run here.
      </p>
      <fieldset className="picker">
        <legend className="sr-only">Model to run on this computer</legend>
        {plan.models.map((model) => (
          <label
            key={model.id}
            className={`tile${plan.chosen === model.id ? " chosen" : ""}`}
          >
            <input
              type="radio"
              name="local-model"
              className="tile-input"
              value={model.id}
              checked={plan.chosen === model.id}
              onChange={() => onChoose(model.id)}
            />
            <span className="mark-tile" aria-hidden="true">
              <span>{model.label.charAt(0) || "G"}</span>
            </span>
            <span className="tile-name">{model.label}</span>
            <span className="tile-summary">
              {purpose(model)}
              {model.licence ? ` · ${model.licence} licence` : ""} ·{" "}
              {gigabytes(model.sizeBytes)}
            </span>
            {model.recommended && (
              <span className="tile-note">Recommended for this computer</span>
            )}
            {model.ready && (
              <span className="tile-note">Already on this computer</span>
            )}
          </label>
        ))}
      </fieldset>
      <p className="footnote">
        {selected?.ready && plan.ready
          ? "It is already on this computer, so there is nothing to download."
          : `ArkAgent downloads ${gigabytes(plan.toDownloadBytes)} while it installs, once, and then it works without internet.`}{" "}
        It runs only on this computer, so what you write stays here, and it uses
        the same tools and browser as any other AI. Bigger models plan and
        follow long tasks much better; smaller ones download sooner.
        {plan.gpu ? " Your graphics card is used to make it faster." : ""} You
        can switch to your own key at any time.
      </p>
      {failure && <InlineFailure problem={failure} />}
    </div>
  );
}
