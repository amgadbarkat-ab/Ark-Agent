import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useBotNames } from "@/lib/agents/bot-names";
import { releaseControl, takeControl } from "@/lib/computers/control";
import {
  isDriving,
  ownBrowserQueryOptions,
  stopOwnBrowserMutationOptions,
} from "@/lib/computers/own-browser";

/**
 * The band that says a digital employee may be working in the person's own browser (desk #27).
 *
 * On every screen of the app, not only on the Computers page, because the owner's rule is that the
 * person can see it and take over at any time, and "at any time" includes while they are reading a
 * conversation. Shown whenever the desktop switch is on and at least one employee is pointed at the
 * browser; it says "working now" while actions are arriving.
 *
 * Two controls. Take over hands the wheel to the person: the employees' actions are refused until
 * they hand it back, and they can drive the browser window directly in the meantime. Stop takes every
 * employee out of the browser and closes their tabs, which is the end of it until the person chooses
 * again. The desktop switch, in the desktop app's menu, turns the whole thing off.
 */
export function OwnBrowserIndicator() {
  const queryClient = useQueryClient();
  const nameFor = useBotNames();
  const status = useQuery(ownBrowserQueryOptions());
  const stop = useMutation(stopOwnBrowserMutationOptions(queryClient));
  const [heldBy, setHeldBy] = useState<string[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const employees = status.data?.employees ?? [];
  if (!status.data?.available || employees.length === 0) return null;

  const driving = employees.filter((choice) => isDriving(choice));
  const names = (driving.length > 0 ? driving : employees)
    .map((choice) => nameFor(choice.botId))
    .join(", ");

  const takeOver = async () => {
    setProblem(null);
    const ids = employees.map((choice) => choice.botId);
    const results = await Promise.all(ids.map((botId) => takeControl(botId)));
    if (results.some((state) => state === null)) {
      setProblem(
        "Not every digital employee could be paused. Use Stop to end it.",
      );
    }
    setHeldBy(ids);
  };

  const handBack = async () => {
    setProblem(null);
    await Promise.all((heldBy ?? []).map((botId) => releaseControl(botId)));
    setHeldBy(null);
  };

  return (
    <div
      aria-live="polite"
      className="flex flex-wrap items-center gap-3 border-amber-500/40 border-b bg-amber-500/10 px-4 py-2 text-sm"
      role="status"
    >
      <span className="relative flex size-2.5 shrink-0">
        {driving.length > 0 ? (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-500 opacity-75" />
        ) : null}
        <span className="relative inline-flex size-2.5 rounded-full bg-amber-500" />
      </span>
      <p className="min-w-0 flex-1">
        {heldBy ? (
          <>
            <span className="font-medium">
              You have taken over your browser.
            </span>{" "}
            {names} will wait until you hand it back.
          </>
        ) : driving.length > 0 ? (
          <>
            <span className="font-medium">{names}</span>{" "}
            {driving.length === 1 ? "is" : "are"} working in your browser now.
            Payments, sending, submitting and deleting wait for your approval.
          </>
        ) : (
          <>
            <span className="font-medium">{names}</span>{" "}
            {employees.length === 1 ? "can" : "can each"} use your browser.
          </>
        )}
        {problem ? (
          <span className="ml-2 text-destructive">{problem}</span>
        ) : null}
      </p>
      <div className="flex items-center gap-2">
        {heldBy ? (
          <Button onClick={() => void handBack()} size="sm" variant="outline">
            Hand back
          </Button>
        ) : (
          <Button onClick={() => void takeOver()} size="sm" variant="outline">
            Take over
          </Button>
        )}
        <Button
          disabled={stop.isPending}
          onClick={() => {
            setHeldBy(null);
            stop.mutate();
          }}
          size="sm"
          variant="destructive"
        >
          {stop.isPending ? "Stopping…" : "Stop"}
        </Button>
        <Link className="text-muted-foreground underline" to="/admin/audit">
          Activity
        </Link>
      </div>
    </div>
  );
}
