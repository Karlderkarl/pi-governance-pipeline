# Governance Files

Structure and update rules for the four files. Generation order matters — each builds on the previous.

## Contents

- [SOUL.md](#soulmd)
- [AGENTS.md](#agentsmd)
- [SYSTEM.md and harness config](#systemmd-and-harness-config)
- [MEMORY.md](#memorymd)
- [Audit mode](#audit-mode)

These are structural blueprints, not rigid forms. Drop sections that a small project does not need; do not pad them with placeholders.

## SOUL.md

Project identity. Stable — changes only when the project itself changes direction.

Sections: purpose and scope · stack with concrete versions · architecture and module boundaries · coding standards · security requirements · compliance obligations.

Write versions and names as found in the repository, not as stated in the PRD. When they disagree, record both and mark the conflict. The research, implement and review prompts excerpt this file (the first 120 lines), so the coding standards and the security requirements belong near the top.

## AGENTS.md

Agent behaviour, and the only file the pipeline reads for configuration. pi loads it natively from the project directory and its ancestors, so it doubles as the standing instruction file.

pi's candidate list is `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` — first hit wins, walked from cwd through every ancestor. **`AGENTS.override.md` therefore replaces `AGENTS.md` in every child `pi -p` process.** The pipeline still routes from `AGENTS.md` (or `AGENTS_FILE`) and warns at start when the override exists. Reviewer processes pass `-nc` so they load no context file at all; that is what keeps panel size and the implementer model out of the review prompt.

Sections: roles and responsibilities · workflow · review rules · prohibited actions · phase plan · **the machine-readable contract block**.

The contract block holds `contract_version: 2`, `models`, `budgets`, `review`, `issues` and `gates` exactly as specified in `contract.md`. Fence it as `yaml pipeline-contract` so an example block above it cannot become the routing. `issues.source` and `gates` come from the repository inspection in govern: the dev commands you found (`package.json` scripts, `Makefile`, `pyproject.toml`, `Cargo.toml`, `go.mod`) become gates; the place issues live becomes the source. Where you cannot decide, write the marker — the pipeline refuses to start on it, which is the intended failure.

Prohibited actions deserve care: they are the last line of defence in a harness without permission prompts. Be specific — "never force-push to main", not "be careful with git".

## SYSTEM.md and harness config

Harness-specific, and the only vendor-coupled part of governance. One extraction, one renderer per harness in use.

Keep a short `SYSTEM.md` at the repository root as the human-readable source of truth, next to `SOUL.md`, `AGENTS.md`, and `MEMORY.md`. pi does **not** load a root `SYSTEM.md`. It loads:

- `.pi/SYSTEM.md` (project) or `~/.pi/agent/SYSTEM.md` (global) — **replaces** the default system prompt
- `.pi/APPEND_SYSTEM.md` or `~/.pi/agent/APPEND_SYSTEM.md` — **appends** without replacing

Replacing the default prompt is a much larger step than appending. Govern writes the root file and copies it to `.pi/APPEND_SYSTEM.md` so it takes effect. Do not write `.pi/SYSTEM.md` unless the project genuinely needs to replace pi's prompt. `doctor` warns when the root file exists and the `.pi` copy does not.

When any role runs through Claude Code (`--harness anthropic=claude-code`), render the same facts as `CLAUDE.md`. Claude Code reads `CLAUDE.md`, not `AGENTS.md`; the contract still lives in `AGENTS.md`, which the pipeline reads itself. Reviewers under Claude Code run with `--safe-mode`, which skips `CLAUDE.md`.

Also record here: dev commands, environment variables, and tool preferences using the harness's tool names (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` for pi).

**Never put pipeline internals in `SYSTEM.md`, `.pi/APPEND_SYSTEM.md` or `CLAUDE.md`**: panel size, the role-to-model mapping, reviewer role names, or which model implements. The pipeline keeps those files out of the reviewers (`--no-approve` / `--safe-mode`), but an operator who runs a role by hand would put every one of those facts into a reviewer's system prompt. They belong in `AGENTS.md`, which reviewers already do not load.

## MEMORY.md

Living status. The only file that changes on nearly every run — and only the harness writes it during a run (blockers); a role that edits it loses the attempt.

Sections: completed work · key decisions with dates and rationale · open blockers · next steps · drift notes.

Blockers are load-bearing. An aborted issue writes its blocker here as `## Blocker — <id> (<date>)` with the unresolved review findings as prose (file and title, no line numbers) and the tail of the tool log. The state file already skips `blocked` / `done` issues; the *content* is fed back into the research and implement prompts for that issue (last `BLOCKER_HISTORY_MAX` entries, capped at `BLOCKER_HISTORY_MAX_BYTES`).

When history grows unwieldy, archive completed phases to `memory/completed-phases.md` and leave a pointer. Do not let `MEMORY.md` become a changelog — it is a status file, and every line should still be relevant.

## Audit mode

Compare governance against both the PRD and the actual repository state, then report drift before changing anything.

Report in three buckets: PRD says X but governance says Y · governance says X but the repo does Y · governance is silent where it should not be. Run `pipeline doctor` for the mechanical part: contract validity, gates, issue source, wrapper pin, trust state.

Ask per file whether to overwrite, merge, or skip. Merging is the usual answer for `MEMORY.md` and rarely right for `SOUL.md`.

Under `pi -p` there is no UI to ask with. Report the drift, write nothing, and exit non-zero. An unattended audit that rewrites governance on its own defeats the purpose of having governance.
