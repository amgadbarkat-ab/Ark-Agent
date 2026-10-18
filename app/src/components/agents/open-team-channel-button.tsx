import { IconUsersGroup } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { openTeamChannelMutationOptions } from "@/lib/channels/mutations";
import { queryClient } from "@/query-client";

/**
 * Opens the channel with the whole team: the lead answers, and asks its colleagues when the work is
 * theirs. The same channel every time, with whoever is on the team now.
 */
export function OpenTeamChannelButton() {
  const navigate = useNavigate();
  const open = useMutation({
    ...openTeamChannelMutationOptions(queryClient),
    onSuccess: async (channel) => {
      await queryClient.invalidateQueries({ queryKey: ["channels"] });
      void navigate({
        to: "/channel/$channelId",
        params: { channelId: channel.id },
      });
    },
  });
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        disabled={open.isPending}
        onClick={() => open.mutate()}
        size="sm"
        variant="ghost"
      >
        <IconUsersGroup />
        Team channel
      </Button>
      {open.error ? (
        <p className="text-destructive text-xs" role="alert">
          {open.error.message}
        </p>
      ) : null}
    </div>
  );
}
