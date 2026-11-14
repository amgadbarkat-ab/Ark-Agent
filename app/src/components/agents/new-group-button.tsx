import { IconUsersPlus } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { AgentProfile } from "@/lib/agents/queries";
import {
  createChannelMutationOptions,
  renameChannelMutationOptions,
} from "@/lib/channels/mutations";
import { sentenceNow, tNow, useT } from "@/lib/i18n";
import { queryClient } from "@/query-client";

/**
 * A group conversation the person names and chooses the members of (DT Lab, #83: "no UI to name a
 * group, e.g. 'Test Group 1', or pick members"). The whole-team channel stays as it is; this is
 * for a smaller room.
 *
 * The first one picked leads: it answers the person and asks the others when the work is theirs,
 * exactly as the lead of the team channel does.
 */
export function NewGroupButton({ agents }: { agents: AgentProfile[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} size="sm" variant="ghost">
        <IconUsersPlus />
        {t("group.new")}
      </Button>
      {open ? (
        <Dialog onOpenChange={(next) => setOpen(next)} open>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("group.new")}</DialogTitle>
              <DialogDescription>{t("group.description")}</DialogDescription>
            </DialogHeader>
            <NewGroupForm agents={agents} onClose={() => setOpen(false)} />
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

/** The members in the order they were picked, which is the order the channel presents them in. */
export function toggled(picked: string[], id: string): string[] {
  return picked.includes(id)
    ? picked.filter((each) => each !== id)
    : [...picked, id];
}

export function NewGroupForm({
  agents,
  onClose,
}: {
  agents: AgentProfile[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const t = useT();
  const create = useMutation(createChannelMutationOptions(queryClient));
  const rename = useMutation(renameChannelMutationOptions(queryClient));
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = create.isPending || rename.isPending;
  const ready = name.trim() !== "" && picked.length >= 2;

  const save = async () => {
    if (!ready) return;
    setProblem(null);
    try {
      const channel = await create.mutateAsync(picked);
      await rename.mutateAsync({ channelId: channel.id, title: name.trim() });
      onClose();
      void navigate({
        to: "/channel/$channelId",
        params: { channelId: channel.id },
      });
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : tNow("Could not start the group."),
      );
    }
  };

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Input
        aria-label={t("group.name")}
        autoFocus
        maxLength={60}
        onChange={(event) => setName(event.target.value)}
        placeholder={t("Test Group 1")}
        value={name}
      />
      <fieldset className="flex max-h-72 min-w-0 flex-col gap-1 overflow-y-auto overflow-x-hidden">
        <legend className="mb-1 text-muted-foreground text-sm">
          {t("group.members")}
        </legend>
        {agents.map((agent) => {
          const position = picked.indexOf(agent.id);
          return (
            <div
              className="flex items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted"
              key={agent.id}
            >
              <Checkbox
                checked={position !== -1}
                id={`group-member-${agent.id}`}
                onCheckedChange={() =>
                  setPicked((current) => toggled(current, agent.id))
                }
              />
              <label
                className="min-w-0 flex-1 cursor-pointer truncate"
                htmlFor={`group-member-${agent.id}`}
              >
                {agent.name}
                {agent.title ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · {sentenceNow(agent.title)}
                  </span>
                ) : null}
              </label>
              {position === 0 ? (
                <span className="shrink-0 pr-2 text-muted-foreground text-xs">
                  {t("group.leads")}
                </span>
              ) : null}
            </div>
          );
        })}
      </fieldset>
      {picked.length === 1 ? (
        <p className="text-muted-foreground text-xs">{t("group.tooFew")}</p>
      ) : null}
      {problem ? (
        <p className="text-destructive text-sm" role="alert">
          {problem}
        </p>
      ) : null}
      <DialogFooter>
        <Button onClick={onClose} size="sm" type="button" variant="ghost">
          {t("common.cancel")}
        </Button>
        <Button disabled={busy || !ready} size="sm" type="submit">
          {busy ? t("group.starting") : t("group.start")}
        </Button>
      </DialogFooter>
    </form>
  );
}
