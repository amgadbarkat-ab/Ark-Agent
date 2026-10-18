import { IconPencil, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
} from "@/components/ui/item";
import {
  addMemoryMutationOptions,
  deleteMemoryMutationOptions,
  updateMemoryMutationOptions,
} from "@/lib/memories/mutations";
import {
  type MemoryRecord,
  memoriesQueryOptions,
} from "@/lib/memories/queries";
import { queryClient } from "@/query-client";

const WHO: Record<MemoryRecord["source"], string> = {
  agent: "Kept by the digital employee",
  person: "Written by you",
  approved: "Changed by a request you approved",
};

/**
 * What this digital employee keeps in mind between conversations.
 *
 * It sees every line here at the start of every conversation, so what is written here is exactly what
 * it knows about you, and what is deleted here is gone from its next one. It adds to this list itself
 * when you ask it to remember something; you can add, correct and delete.
 */
export function MemoriesSection({
  agentId,
  canManage,
}: {
  agentId: string;
  canManage: boolean;
}) {
  const memories = useQuery(memoriesQueryOptions(agentId));
  const add = useMutation(addMemoryMutationOptions(queryClient));
  const update = useMutation(updateMemoryMutationOptions(queryClient));
  const remove = useMutation(deleteMemoryMutationOptions(queryClient));
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(
    null,
  );
  const failure = add.error ?? update.error ?? remove.error;
  const rows = memories.data ?? [];

  return (
    <>
      <p className="text-sm text-muted-foreground">
        What this digital employee keeps in mind. It reads all of this at the
        start of every conversation. Passwords, keys and card numbers are never
        kept.
      </p>

      {canManage ? (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const content = draft.trim();
            if (!content) return;
            add.mutate({ agentId, content }, { onSuccess: () => setDraft("") });
          }}
        >
          <Input
            aria-label="New memory"
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Something to keep in mind…"
            value={draft}
          />
          <Button
            disabled={add.isPending || !draft.trim()}
            size="sm"
            type="submit"
          >
            Add
          </Button>
        </form>
      ) : null}

      {failure ? (
        <p className="text-sm text-destructive" role="alert">
          {failure.message}
        </p>
      ) : null}

      {memories.isPending ? null : memories.error ? (
        <p className="text-sm text-destructive" role="alert">
          Its memories could not be loaded.
        </p>
      ) : rows.length === 0 ? (
        <Empty className="h-[160px] border border-dashed">
          <EmptyHeader>
            <EmptyTitle className="text-muted-foreground">
              Nothing kept in mind yet
            </EmptyTitle>
            <EmptyDescription>
              Ask it to remember something in a conversation, or add a line
              above.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) =>
            editing?.id === row.id ? (
              <Item key={row.id} variant="muted">
                <ItemContent>
                  <Input
                    aria-label="Edit memory"
                    autoFocus
                    onChange={(event) =>
                      setEditing({ id: row.id, text: event.target.value })
                    }
                    value={editing.text}
                  />
                </ItemContent>
                <ItemActions>
                  <Button
                    onClick={() => setEditing(null)}
                    size="sm"
                    variant="ghost"
                  >
                    Cancel
                  </Button>
                  <Button
                    disabled={update.isPending || !editing.text.trim()}
                    onClick={() =>
                      update.mutate(
                        { agentId, id: row.id, content: editing.text.trim() },
                        { onSuccess: () => setEditing(null) },
                      )
                    }
                    size="sm"
                  >
                    Save
                  </Button>
                </ItemActions>
              </Item>
            ) : (
              <Item key={row.id} variant="muted">
                <ItemContent>
                  <ItemDescription className="line-clamp-none text-foreground">
                    {row.content}
                  </ItemDescription>
                  <ItemDescription className="text-xs">
                    {WHO[row.source]}
                  </ItemDescription>
                </ItemContent>
                {canManage ? (
                  <ItemActions>
                    <Button
                      aria-label="Edit this memory"
                      onClick={() =>
                        setEditing({ id: row.id, text: row.content })
                      }
                      size="icon-sm"
                      variant="ghost"
                    >
                      <IconPencil />
                    </Button>
                    <Button
                      aria-label="Delete this memory"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate({ agentId, id: row.id })}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <IconTrash />
                    </Button>
                  </ItemActions>
                ) : null}
              </Item>
            ),
          )}
        </div>
      )}
    </>
  );
}
