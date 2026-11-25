import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogBody, DialogFooter } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { AgentProfile } from "@/lib/agents/queries";
import { sentenceNow, tNow, useT } from "@/lib/i18n";
import {
  addSubprofileMutationOptions,
  setSubprofileAgentsMutationOptions,
  type TeamConflict,
  TeamRequestError,
} from "@/lib/team/mutations";
import type { TeamMember } from "@/lib/team/queries";
import { queryClient } from "@/query-client";

/**
 * Adding a sub-profile, or changing which digital employees it has (Amgad, 24 Nov 2026). Nothing is
 * chosen for the administrator: they tick each employee. One another person has is moved only after
 * the administrator sees who loses it and confirms.
 */
export function MemberForm({
  agents,
  member,
  onClose,
}: {
  agents: AgentProfile[];
  member?: TeamMember;
  onClose: (checkoutUrl?: string | null) => void;
}) {
  const t = useT();
  const add = useMutation(addSubprofileMutationOptions(queryClient));
  const change = useMutation(setSubprofileAgentsMutationOptions(queryClient));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(
    new Set(member?.agentIds ?? []),
  );
  const [conflicts, setConflicts] = useState<TeamConflict[]>([]);
  const [error, setError] = useState<string | null>(null);
  const names = new Map(agents.map((a) => [a.id, a.name]));

  async function save(move: boolean) {
    setError(null);
    try {
      if (member) {
        await change.mutateAsync({
          userId: member.userId,
          agentIds: [...chosen],
          move,
        });
        onClose();
      } else {
        const answer = await add.mutateAsync({
          name,
          email,
          password,
          agentIds: [...chosen],
          move,
        });
        onClose(answer.checkoutUrl ?? null);
      }
    } catch (failure) {
      if (failure instanceof TeamRequestError && failure.conflicts.length) {
        setConflicts(failure.conflicts);
        return;
      }
      setError(sentenceNow((failure as Error).message));
    }
  }

  return (
    <>
      <DialogBody className="flex flex-col gap-3">
        {member ? null : (
          <>
            <Field>
              <FieldLabel htmlFor="member-name">{t("Name")}</FieldLabel>
              <Input
                id="member-name"
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="member-email">{t("Email")}</FieldLabel>
              <Input
                id="member-email"
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                value={email}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="member-password">
                {t("First password (they choose their own at first sign-in)")}
              </FieldLabel>
              <Input
                id="member-password"
                minLength={10}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                value={password}
              />
            </Field>
          </>
        )}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">
            {t("Digital employees")}
          </legend>
          {agents.map((agent) => (
            <div className="flex items-center gap-2 text-sm" key={agent.id}>
              <Checkbox
                checked={chosen.has(agent.id)}
                id={`member-agent-${agent.id}`}
                onCheckedChange={(on) => {
                  const next = new Set(chosen);
                  if (on) next.add(agent.id);
                  else next.delete(agent.id);
                  setChosen(next);
                }}
              />
              <label htmlFor={`member-agent-${agent.id}`}>{agent.name}</label>
            </div>
          ))}
        </fieldset>
        {conflicts.length ? (
          <div className="rounded-md border p-3 text-sm" role="alert">
            <p className="font-medium">{t("Move these digital employees?")}</p>
            <ul className="mt-1 list-disc pl-5">
              {conflicts.map((one) => (
                <li key={one.agentId}>
                  {tNow("{agent}: from {person}", {
                    agent: names.get(one.agentId) ?? one.agentId,
                    person: one.fromName,
                  })}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-muted-foreground">
              {t("They lose these digital employees when you confirm.")}
            </p>
          </div>
        ) : null}
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button onClick={() => onClose()} variant="outline">
          {t("Cancel")}
        </Button>
        <Button
          disabled={add.isPending || change.isPending || chosen.size === 0}
          onClick={() => save(conflicts.length > 0)}
        >
          {conflicts.length
            ? t("Move them and save")
            : member
              ? t("Save")
              : t("Add and pay €15 a month")}
        </Button>
      </DialogFooter>
    </>
  );
}
