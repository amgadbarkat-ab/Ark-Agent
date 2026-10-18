import { useRenderTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { HANDED_OVER } from "@/lib/copilot/markers";
import { saidItWentAhead } from "@/lib/plugins/tool-result";

/**
 * How a Bot handing work to another Bot reads in the transcript.
 *
 * RENDER ONLY. `message_bot` runs on the server, where the grant, the caps and the audit row are, so
 * nothing here registers a tool or decides anything. What it registers is a line, because a hop that
 * happens off-screen is the thing the issue asks to avoid: a conversation that quietly fans out to
 * four Bots and bills for all of them should say so while it is doing it.
 *
 * Without this the call still appears, as a generic tool call named `message_bot` with its arguments
 * as JSON. That is technically visible and practically not: the point is that a person can see their
 * Bot bringing in another one and read what it asked for.
 */
const parameters = z.object({
  bot: z.string().optional(),
  task: z.string().optional(),
  constraints: z.string().optional(),
  expecting: z.string().optional(),
});

/**
 * Whether the deployment refused the hop.
 *
 * The result is a sentence the Bot can say either way, because a refusal mid-run is an answer rather
 * than an exception. The transcript still has to tell the two apart: one is a Bot bringing in help,
 * the other is a boundary holding, and drawing them the same way would make a working cap look like
 * a working handoff.
 */
function refused(result: unknown): boolean {
  return !saidItWentAhead(result, HANDED_OVER);
}

/** A team member asked for work by name. Same line as a hand-off, the colleague being named differently. */
const teamAskParameters = z.object({
  colleague: z.string().optional(),
  task: z.string().optional(),
  constraints: z.string().optional(),
  expecting: z.string().optional(),
});

function AskedLine({
  asked,
  given,
  result,
  status,
}: {
  asked: string | undefined;
  given:
    | { task?: string; constraints?: string; expecting?: string }
    | undefined;
  result: unknown;
  status: string;
}) {
  const running = status !== "complete" && result === undefined;
  return (
    <ToolLine
      label={asked ? `Asked ${asked}` : "Asked another digital employee"}
      detail={given?.task}
      running={running}
      refused={!running && refused(result)}
    >
      {/*
       * The parts, kept as parts. The asking model was made to name them so the receiving one
       * need not infer them, and a person reading the conversation gets the same benefit: what
       * was asked, what bounded it, and what was wanted back.
       */}
      <div className="space-y-1 text-sm">
        {given?.task ? <p>{given.task}</p> : null}
        {given?.constraints ? (
          <p className="text-muted-foreground">
            Constraints: {given.constraints}
          </p>
        ) : null}
        {given?.expecting ? (
          <p className="text-muted-foreground">
            Wanted back: {given.expecting}
          </p>
        ) : null}
        {typeof result === "string" ? (
          <p className="text-muted-foreground">{result}</p>
        ) : null}
      </div>
    </ToolLine>
  );
}

export function HandoffTool() {
  useRenderTool({
    name: "message_bot",
    parameters,
    render: ({ parameters: given, result, status }) => (
      <AskedLine
        asked={given?.bot?.trim()}
        given={given}
        result={result}
        status={status}
      />
    ),
  });

  // The team's own way of asking a colleague. Rendered the same, because to the person it is the same
  // thing: a digital employee bringing in another.
  useRenderTool({
    name: "team_ask",
    parameters: teamAskParameters,
    render: ({ parameters: given, result, status }) => (
      <AskedLine
        asked={given?.colleague?.trim()}
        given={given}
        result={result}
        status={status}
      />
    ),
  });

  return null;
}
