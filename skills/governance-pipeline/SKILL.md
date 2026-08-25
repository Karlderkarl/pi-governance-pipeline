---
name: governance-pipeline
description: Turns a PRD into project governance (SOUL.md, AGENTS.md, SYSTEM.md, MEMORY.md) and turns that governance into an issue-driven auto-develop pipeline with per-role model routing, independent multi-model review, and hard run budgets. Use this whenever the user mentions a PRD, governance files, SOUL.md, AGENTS.md, MEMORY.md, auto-develop, an agent pipeline, multi-model review, or wants to bootstrap or audit automated development for a repository — even if they do not name this skill.
compatibility: Requires pi with bash, read, write, edit, grep, find, ls. Model routing requires API keys for every provider referenced in AGENTS.md.
---

# Governance Pipeline

Two modes, one skill. Governance is the source of truth; the pipeline is generated from it and never hand-edited.

```
PRD ──▶ [Mode: govern] ──▶ SOUL.md · AGENTS.md · SYSTEM.md · MEMORY.md
                                        │
                                        ▼
                            [Mode: automate] ──▶ auto-develop.sh
```

## Bundled assets

Use these instead of writing equivalents from scratch. Paths are relative to this skill directory.

| Path | Use |
|---|---|
| `assets/auto-develop.sh` | Reference pipeline. Adapt `ISSUE_SOURCE`, `LINT_CMD`, `TEST_CMD`; keep the structure. |
| `assets/lib/governance.mjs` | Reads and validates the contract block in `AGENTS.md`, resolves a role to a model, owns the state file. Node built-ins only. |
| `assets/lib/gate.mjs` | Severity-based review gate over the reviewer JSON files. Exit 0 clear, 4 blocked. |
| `references/*.md` | The contract, file structure, pipeline blueprint, and prompt builders. |

Install the libraries next to the generated script:

```bash
mkdir -p .pipeline/lib && cp <skill>/assets/lib/*.mjs .pipeline/lib/
cp <skill>/assets/auto-develop.sh . && chmod +x auto-develop.sh
node .pipeline/lib/governance.mjs config AGENTS.md   # validate before the first run
./auto-develop.sh --dry-run                          # routing and prompts, zero model calls
```

**Reference scope.** The bundled script implements the full loop except issue splitting (it blocks instead), the clean-code gate (fold it into `LINT_CMD` — e.g. a complexity or duplication linter; there is no separate slot), and the commit/PR/governance-update step (a marked stub). Those are deliberate adaptation points — `references/pipeline-template.md` says what a generator must add. `/pipeline-audit` checks a *generated* pipeline against the invariants.

The package also ships `pipeline-guard`, an extension that blocks privileged bash commands and unconfirmed governance writes, exposes the `pipeline_state` tool, and adds `/pipeline-status`. It is the interactive counterpart to the script's startup gate — see the package README.

## Choosing a mode

| Situation | Mode |
|---|---|
| PRD exists, no governance files yet | `govern` (generate) |
| Governance exists, PRD or repo changed | `govern` (audit) |
| Governance is current, no pipeline yet | `automate` |
| Governance changed after a pipeline exists | `automate` (re-sync) |

If both are needed, always run `govern` to completion first. The pipeline reads governance; generating it from stale or absent governance produces a pipeline that silently encodes wrong assumptions.

## Mode: govern

Generates or audits the four governance files. Read `references/governance-files.md` before writing anything — it holds the structure and update rules for each file.

1. Determine the project root from the PRD location.
2. `read` the PRD. Extract stack, architecture, security, and compliance.
3. Inspect the repo for actual build config, dependencies, and structure. Use `find` and `grep`, not assumptions. Where the PRD and the repo disagree, report the conflict — do not silently prefer one.
4. Resolve open decisions (agent roles, model routing, git conventions, budgets).
5. Write concrete values, never vague placeholders. Anything unresolved gets an explicit marker: `[NEEDS PRD CLARIFICATION]`, `[USER DECISION REQUIRED]`.
6. Present a summary before writing.

**Never blindly overwrite.** If governance files already exist, audit first and ask per file whether to overwrite, merge, or skip.

**Interactivity:** step 4 needs a human. In the TUI, ask. Under `pi -p` there is no UI — do not ask, do not invent answers. Write the marker and continue. A pipeline built on invented decisions is worse than one that stops.

## Mode: automate

Generates `auto-develop.sh` plus its task source, prompt builders, and logging.

Read these first:
- `references/contract.md` — which governance fields are read, which are optional, what happens when one is absent. This is the versioned interface between the two modes.
- `references/pipeline-template.md` — the structural blueprint and its invariants.
- `references/prompt-builders.md` — the per-role prompts, including the reviewer JSON schema.

The generated pipeline runs this loop per issue:

```
research ─▶ implement/TDD ─▶ deterministic gates (lint, tests) ─▶ 3 parallel reviews
   ─▶ controller (aggregates, proposes) ─▶ master review (decides, always runs)
        ├─ approved  ─▶ governance update ─▶ next issue
        ├─ rejected  ─▶ back to implement  (max 3, then blocked — splitting is a
        │                                     generator's adaptation point; the
        │                                     bundled reference blocks instead)
        └─ 3x failed at master ─▶ abort: mark blocked, write blocker to MEMORY.md, notify human
```

## Non-negotiable invariants

These hold in every generated pipeline. If a requested change would break one, stop and say so.

**Each step is a separate `pi -p` process.** No sub-agents — pi has none, and separate processes are what make the reviews independent. Reviewers must not see each other's verdicts.

**The script picks the model, not the agent.** Read the mapping from `AGENTS.md`; never let a prompt choose its own model.

**Counters and budgets live in the harness.** `.pipeline/state/<root_id>.json`, never in a model context. A model may be told "you have N attempts left" and nothing more. Two distinct quantities:
- *attempts* — a quality signal, per issue, reset when an issue is split
- *budget* — a resource limit, held at the tree root, consumed across the whole tree, never reset

**Review gating is severity-based**, not a percentage. Any `critical` or `high` blocks; `medium` and `low` become follow-up tickets. Percentage thresholds over three reviewers collapse into unanimity and hide that fact.

**The controller proposes; the master decides.** The controller runs a weak model and may miscount. The master sees the original reviewer JSON, not just the controller's summary.

**Safe by default.** Privileged execution and auto-merge stay off unless `--unattended` / `--auto-merge` are passed. pi has no permission prompts, so the confirmation must happen in the script *before* the loop starts, or the run must be containerized. An extension cannot ask under `pi -p` — `ctx.hasUI` is false there. Never rely on a runtime dialog in an unattended run.

**Missing configuration degrades, never breaks.** Governance without a `models:` block runs every role on the default model. Absent budget fields fall back to documented defaults. Verify this rather than assuming it.

## Model routing

The mapping lives in `AGENTS.md` under `models:`; the field reference is in `references/contract.md`.

Two constraints the generated script must enforce:

- **No self-review.** A model that implemented a diff must not review it. On collision, drop that reviewer for the run and gate on the rest — but if drops and unparseable output shrink the panel below two reviewers, the gate blocks instead of approving. One opinion is not a review panel (`MIN_REVIEWERS`, default 2).
- **Provider diversity.** Reviewers should span at least two providers. Three prompts against one model share its blind spots, which defeats the purpose of reviewing three times.

Invoke a role like this, reading `MODEL` from the mapping:

```bash
pi -p --model "$MODEL" "$(build_prompt review security "$ISSUE" "$DIFF")"
```

`$MODEL` is `provider/id`, or `provider/id:thinking` when the role sets `thinking` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). That is pi's `--model` shorthand; the separate `--thinking <level>` flag does the same job and wins when both are given, so pass one or the other, never both. pi clamps a level the model does not expose to the nearest one it does, and says nothing — the level is an instruction, not a guarantee. The same model may be mapped to two roles with different thinking. Identity for `no_self_review` and for `implement` vs `implement_master` still ignores thinking — a different effort level is not a different model.

Verify the exact flag names against `pi --help` for the installed version before generating the script, and use the JSON event stream mode when the caller needs to parse structured output rather than prose.

## Escalation and abort

When the master implements a fix itself, it starts **fresh from the issue** with prior findings as an exclusion list — not from the failed diff. Inheriting the broken diff inherits the reasoning that already failed three times; a different model is only useful if it gets to think differently.

An abort is never silent: mark the issue blocked, write the blocker to `MEMORY.md`, notify a human. `MEMORY.md` feeds back into issue creation, so the next run knows this issue has a history instead of picking it up naively.
