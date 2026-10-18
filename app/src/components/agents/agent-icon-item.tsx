import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { ICON_FILE_TYPES, iconFromFile } from "@/lib/agents/icon-image";
import { setAgentIconMutationOptions } from "@/lib/agents/mutations";

/** The coworker's picture, with a way to choose another or go back to ArkAgent's own. */
export function AgentIconItem({
  agentId,
  canManage,
  image,
  name,
}: {
  agentId: string;
  canManage: boolean;
  image: string | null;
  name: string;
}) {
  const queryClient = useQueryClient();
  const setIcon = useMutation(setAgentIconMutationOptions(queryClient));
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function choose(file: File | undefined) {
    if (!file) return;
    setProblem(null);
    try {
      setIcon.mutate({ agentId, image: await iconFromFile(file) });
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : "That picture could not be used.",
      );
    }
  }

  return (
    <Item variant="muted">
      <ItemMedia>
        <AbstractAvatar image={image} name={name} size={48} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>Icon</ItemTitle>
        <ItemDescription>
          {image
            ? "A picture you chose."
            : "ArkAgent's icon, until you choose a picture."}
        </ItemDescription>
        {problem || setIcon.error ? (
          <ItemDescription className="text-destructive" role="alert">
            {problem ?? setIcon.error?.message}
          </ItemDescription>
        ) : null}
      </ItemContent>
      {canManage ? (
        <ItemActions>
          <input
            accept={ICON_FILE_TYPES.join(",")}
            aria-label="Choose an icon picture"
            className="hidden"
            onChange={(event) => {
              void choose(event.target.files?.[0]);
              // The same file chosen again after removing it must still count as a change.
              event.target.value = "";
            }}
            ref={input}
            type="file"
          />
          <Button
            disabled={setIcon.isPending}
            onClick={() => input.current?.click()}
            size="sm"
            variant="ghost"
          >
            {image ? "Change" : "Choose picture"}
          </Button>
          {image ? (
            <Button
              disabled={setIcon.isPending}
              onClick={() => setIcon.mutate({ agentId, image: null })}
              size="sm"
              variant="ghost"
            >
              Use default
            </Button>
          ) : null}
        </ItemActions>
      ) : null}
    </Item>
  );
}
