import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { SkillAgents } from "@/components/skills/skill-agents";
import { SkillFields } from "@/components/skills/skill-fields";
import { saveSkillMutationOptions } from "@/lib/plugins/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";

/**
 * Editing a skill, in the same panel that writes one.
 *
 * THERE IS NO EDIT ENDPOINT, AND NONE IS NEEDED. `POST /api/plugins/skills` with the skill's `id`
 * rewrites it and deliberately leaves its owner and name alone, so a re-save changes the words and
 * never quietly changes whose skill it is. The route has already refused anyone editing a skill that
 * is not theirs before it gets that far.
 *
 * `reference` is what the link carried: an id, or a name (the Bot that drafts a skill links by the
 * name it saved). A name means the person's own skill first, then the deployment's, the same as
 * their list does.
 */
export function EditSkill({ reference }: { reference: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data, isPending } = useQuery(pluginsPageQueryOptions());
  const { data: me } = useQuery(currentUserQueryOptions());

  /*
   * Read from the list already on screen rather than fetched again. It is the same request the page
   * behind this panel just made, so react-query serves it from cache and the form is filled on the
   * first frame instead of flashing empty fields at somebody who came here to change one word.
   */
  const skills = data?.skills ?? [];
  const skill =
    skills.find((candidate) => candidate.id === reference) ??
    skills.find(
      (candidate) =>
        candidate.slug === reference && candidate.ownerUserId === me?.id,
    ) ??
    skills.find(
      (candidate) =>
        candidate.slug === reference && candidate.ownerUserId === null,
    ) ??
    skills.find((candidate) => candidate.slug === reference);

  const saveSkill = useMutation(saveSkillMutationOptions(queryClient));

  /* Nothing while it loads. "Missing" and "not yet arrived" must not read the same. */
  if (isPending) return null;

  if (!skill) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
        {/*
         * Said plainly rather than shown as an empty form. A skill can be missing because it was
         * deleted in another tab, or because the link names one that is somebody else's — and an
         * empty form here would invite them to write it back into existence under a slug they may
         * not own.
         */}
        <p className="text-muted-foreground text-sm">
          That skill no longer exists, or it is not yours to edit.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">Edit skill</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Changes apply the next time <code>/{skill.slug}</code> is used. Agents
          already carrying it keep it.
        </p>
      </header>

      <SkillFields
        defaultValues={{
          slug: skill.slug,
          title: skill.title,
          summary: skill.summary ?? "",
          instructions: skill.instructions,
          // Defaulted, so a skill written before this field existed opens with nothing ticked rather
          // than with an undefined the form would refuse to submit.
          tools: skill.tools ?? [],
        }}
        error={saveSkill.error}
        /*
         * Passed down rather than rendered after the form, so it lands above Save changes. Granting
         * still saves on its own the instant a button is pressed — `SkillFields` keeps it out of the
         * form's state and only decides where it sits.
         */
        footer={
          <SkillAgents
            grantedTo={skill.grantedTo}
            skillId={skill.id}
            slug={skill.slug}
          />
        }
        onSubmit={async (values) => {
          await saveSkill.mutateAsync({ ...values, id: skill.id });
          await navigate({ search: {}, to: "/skills" });
        }}
        slugLocked
        submitLabel="Save changes"
      />
    </div>
  );
}
