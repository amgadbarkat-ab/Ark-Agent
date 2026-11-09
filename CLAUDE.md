# ArkAgent: notes for coding agents

## Agent skills

Two spec-and-build toolkits are installed for this repo, approved by Amgad on 9 Nov 2026 (desk #91). Use
**one or the other per feature, never both on the same feature**, and say which in the feature's first
commit or PR.

### Matt Pocock's skills (plugin `mattpocock-skills@claude-plugins-official`)

Pinned: plugin version **1.3.1**, source `github.com/mattpocock/skills` at commit
`49dd158d1076134a641b33efb035946536778336` (as the official marketplace lists it). Enabled in
`.claude/settings.json`.

- Start with: `/grill-with-docs`, `/to-spec`, `/tdd`, `/code-review`, `/diagnosing-bugs`.
- `/implement` only on a feature branch (`claude/<topic>`), never on `main`.
- Not used here: `/implement-spec`, `/triage`, `/to-tickets` with GitHub, and anything that writes to
  GitHub Issues.

#### Issue tracker

Local markdown under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

#### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the root, created only when a term or decision is
settled. See `docs/agents/domain.md`.

### Spec Kit (`specify` CLI)

Pinned: **v1.2.5** (`uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@v1.2.5`).
Set up with `specify init --here --integration claude --integration-options="--no-model-invocation"`, so
every `/speckit-*` command runs only when a person types it. No extensions and no hooks: do not add any.
Specs go under `specs/NNN-<name>/`; the git branch is still `claude/<topic>`.

- `/speckit-taskstoissues` is not used (it writes GitHub Issues).

## Standing rules that still hold

- Feature branches only; nothing reaches `main` without a PR that a person can review.
- Device control (anything that drives a person's own browser or computer): no merge, release or
  customer announcement without Amgad's separate yes.
- No installs, keys, purchases or outbound services beyond what Amgad has said yes to.
