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

Write versions and names as found in the repository, not as stated in the PRD. When they disagree, record both and mark the conflict.

## AGENTS.md

Agent behaviour, and the only file the pipeline reads for configuration. pi loads it natively from the project directory and its ancestors, so it doubles as the standing instruction file.

Sections: roles and responsibilities · workflow · review rules · prohibited actions · phase plan · **the machine-readable config block**.

The config block holds `models:`, `budgets:`, and `review:` exactly as specified in `contract.md`. Keep it in one fenced YAML block so it can be extracted without parsing prose around it.

Prohibited actions deserve care: they are the last line of defence in a harness without permission prompts. Be specific — "never force-push to main", not "be careful with git".

## SYSTEM.md and harness config

Harness-specific, and the only vendor-coupled part of governance.

For pi: `SYSTEM.md` replaces or extends the system prompt for this project. Keep it short — pi's base prompt is deliberately minimal, and a long project prompt competes with it rather than complementing it. Put durable project facts in `SOUL.md` and behavioural rules in `AGENTS.md`; reserve `SYSTEM.md` for what genuinely must sit in the system prompt.

For Claude Code, the same extracted facts render as `CLAUDE.md` instead. One extraction, two renderers — never two extraction paths.

Also record here: dev commands, environment variables, and tool preferences using this harness's tool names (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`).

## MEMORY.md

Living status. The only file that changes on nearly every run.

Sections: completed work · key decisions with dates and rationale · open blockers · next steps · drift notes.

Blockers are load-bearing. An aborted issue writes its blocker here, and issue creation reads it back, so a failed issue is not picked up naively on the next run. A blocker entry names the issue, the attempt count reached, and the findings that were never resolved.

When history grows unwieldy, archive completed phases to `memory/completed-phases.md` and leave a pointer. Do not let `MEMORY.md` become a changelog — it is a status file, and every line should still be relevant.

## Audit mode

Compare governance against both the PRD and the actual repository state, then report drift before changing anything.

Report in three buckets: PRD says X but governance says Y · governance says X but the repo does Y · governance is silent where it should not be.

Ask per file whether to overwrite, merge, or skip. Merging is the usual answer for `MEMORY.md` and rarely right for `SOUL.md`.

Under `pi -p` there is no UI to ask with. Report the drift, write nothing, and exit non-zero. An unattended audit that rewrites governance on its own defeats the purpose of having governance.
