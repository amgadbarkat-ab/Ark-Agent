import { useQuery } from "@tanstack/react-query";
import { memo } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { cn } from "@/lib/utils";

/**
 * Memoized roster avatar. Row updates usually change preview/timestamp only, and
 * `use-channel-events` preserves participant id arrays for unchanged rows.
 *
 * IT SHOWS THE DIGITAL EMPLOYEE'S OWN PICTURE, the one its owner chose or hired it with, and ArkAgent's
 * icon until there is one. A generated pattern keyed on its id used to stand here, which is why every
 * conversation in the list wore a different colour and none of them looked like the employee it was
 * with. The picture comes from the same list the rest of the app reads, so changing it on the profile
 * changes it here.
 *
 * `size-full` opts the picture out of ancestor icon selectors such as
 * `[&_svg:not([class*='size-'])]:size-4`.
 *
 * `typing` overlays a working indicator at the bottom-right — three bouncing dots, so a channel
 * whose agent is mid-turn reads as busy from the roster without moving the row's layout.
 */
export const ChannelAvatar = memo(function ChannelAvatar({
  participantIds,
  size = 32,
  typing = false,
  lookup = true,
}: {
  participantIds: string[];
  size?: number;
  typing?: boolean;
  /** False for a sample that stands for nobody, such as a preview: it shows the default picture and asks for nothing. */
  lookup?: boolean;
}) {
  const { data: agents } = useQuery({
    ...agentListQueryOptions(),
    enabled: lookup,
  });
  const channelSize = participantIds?.length;
  const faceOf = (id: string) => {
    const agent = agents?.find((candidate) => candidate.id === id);
    return { name: agent?.name ?? id, image: agent?.avatarImage ?? null };
  };

  const avatar =
    channelSize === 1 ? (
      <AbstractAvatar {...faceOf(participantIds[0] as string)} size={size} />
    ) : (
      <div className="flex flex-row items-center size-full">
        {participantIds.slice(0, 3).map((c, i, shown) => (
          <div
            className="shrink-0 border-2 border-sidebar rounded-full flex items-center justify-center"
            key={c}
            style={{
              height: size / (shown.length / 2),
              width: size / (shown.length / 2),
              transform: `translateX(${i * -75}%)`,
            }}
          >
            <AbstractAvatar {...faceOf(c)} size={size / (shown.length / 2)} />
          </div>
        ))}
      </div>
    );

  return (
    <div className="relative" style={{ height: size, width: size }}>
      {avatar}
      {typing ? <TypingBadge /> : null}
    </div>
  );
});

/**
 * Three bouncing dots in a small badge, ringed in the sidebar's own colour so it sits on the
 * avatar as a badge rather than floating over it. The staggered negative delays start each dot at
 * a different point in the same bounce, which is what makes the three read as one wave.
 */
function TypingBadge() {
  return (
    <div className="absolute -bottom-0.5 -right-0.5 flex items-center gap-0.5 rounded-full bg-sidebar p-0.5 ring-2 ring-sidebar">
      <span className="sr-only">Working…</span>
      <Dot className="[animation-delay:-0.3s]" />
      <Dot className="[animation-delay:-0.15s]" />
      <Dot />
    </div>
  );
}

function Dot({ className }: { className?: string }) {
  return (
    <span
      className={cn("size-1 rounded-full bg-primary animate-bounce", className)}
    />
  );
}
