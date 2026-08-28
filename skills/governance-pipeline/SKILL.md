---
name: governance-pipeline
description: Turns a PRD into project governance (SOUL.md, AGENTS.md, SYSTEM.md, MEMORY.md) and turns that governance into an issue-driven auto-develop pipeline with per-role model routing, independent multi-model review, and hard run budgets. Use when the user wants to generate or audit governance from a PRD, or to generate, re-sync, or audit an auto-develop pipeline with multi-model review. Do not load merely because a repository contains AGENTS.md.
compatibility: Requires pi with bash, read, write, edit, grep, find, ls. Model routing requires API keys for every provider referenced in AGENTS.md. Child `pi -p` processes load project-trusted resources (SYSTEM.md via `.pi/APPEND_SYSTEM.md`) only with a saved trust decision or `--approve` (the latter only after `--unattended`).
---

# Governance Pipeline

Two modes, one skill. Governance is the source of truth. Copy the bundled pipeline and adapt only the documented points (`ISSUE_SOURCE`, `LINT_CMD`, `TEST_CMD`, and the stubs in `references/pipeline-template.md`) — do not rewrite the loop.

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
| `assets/auto-develop.sh` | Reference pipeline. Adapt `ISSUE_SOURCE` (a tasks.md file, or `!command`), `LINT_CMD`, `TEST_CMD`; keep the structure. |
| `assets/lib/governance.mjs` | Reads and validates the contract block in `AGENTS.md`, resolves a role to a model, owns the state file. Node built-ins only. |
| `assets/lib/gate.mjs` | Severity-based review gate over the reviewer JSON files. Exit 0 clear, 4 blocked. |
| `references/*.md` | The contract, file structure, pipeline blueprint, and prompt builders. |

Install the libraries next to the generated script. `<skill>` is the directory that contains this `SKILL.md` — pi prints that path when it loads the skill; otherwise locate `SKILL.md` under the installed package.

```bash
mkdir -p .pipeline/lib && cp <skill>/assets/lib/*.mjs .pipeline/lib/
cp <skill>/assets/auto-develop.sh . && chmod +x auto-develop.sh
node .pipeline/lib/governance.mjs config AGENTS.md   # validate before the first run
printf -- '- [ ] issue-1: first task\n' > tasks.md     # dry-run reads this; without it it dies
./auto-develop.sh --dry-run                          # routing and prompts, zero model calls; notes if pi is missing
```

**Reference scope.** The bundled script implements the full loop except issue splitting (it blocks instead), the clean-code gate (fold it into `LINT_CMD` — e.g. a complexity or duplication linter; there is no separate slot), and the commit/PR/governance-update step (a marked stub, including `--auto-merge`). Those are deliberate adaptation points — `references/pipeline-template.md` says what a generator must add. `/pipeline-audit` checks a *generated* pipeline against the invariants.

The package also ships `pipeline-guard`, an extension that blocks privileged bash commands and unconfirmed governance writes, exposes the `pipeline_state` tool, and adds `/pipeline-status`. It is a speed bump, not a sandbox — see the package README. It is the interactive counterpart to the script's startup gate.

## Safety

`pipeline-guard` does not see the script's own environment. Whoever sets that environment has code execution, and attended runs can miss governance the operator thinks is loaded.

| Variable | Why it exists |
|---|---|
| `PIPELINE_ALLOW_DESTRUCTIVE=1` | Unlocks `sudo`, recursive `rm`, and force-push that stay blocked even after `--unattended` |
| `PIPELINE_LIB` | Override the copied `gate.mjs` / `governance.mjs` directory |
| `MIN_REVIEWERS` | Floor of parseable reviewers; below it the gate blocks. Two consecutive attempts below the floor abort as a configuration error. Not a performance cap |
| `PIPELINE_ALLOW_DEEP_SPLIT` | Accepts `max_split_depth > 1`; without it that budget is a contract error |
| `GOVERNANCE_AGENTS` / `AGENTS_FILE` | Contract file for `state` commands vs the script. Every `state` invocation in the reference script sets `GOVERNANCE_AGENTS` |
| `REVIEWERS_MAX_BYTES` | Cap on concatenated reviewer JSON in controller/master prompts |
| `ROLE_TIMEOUT_SECONDS` | Cap around each `pi -p` (GNU `timeout`, else `gtimeout`, else unprotected). `0` disables. A timeout empties the outfile so the role is unavailable |
| `PROMPT_KEEP_RUNS` | Distinct run-ids to keep under `.pipeline/prompts/`; older prompt files are deleted |
| `BLOCKER_HISTORY_MAX` | Last N `MEMORY.md` blocker entries for the current issue, fed into research and implement prompts |

**`eval` is the issue source.** `ISSUE_SOURCE=!command`, `LINT_CMD`, and `TEST_CMD` run through `eval` and are all env-overridable. That is deliberate (one-line adaptation to `gh` or Jira) — it also means the run's environment is a shell, with or without `pipeline-guard`.

**Project trust.** `--approve` is passed to child `pi -p` processes only after `--unattended` / `--auto-merge` export `PIPELINE_UNATTENDED=1`. Without it, pi loads trust-gated project resources only if the operator already trusted the project interactively. `AGENTS.md` still loads (context files are trust-independent); `SYSTEM.md` via `.pi/APPEND_SYSTEM.md` does not. An attended run can therefore implement against `AGENTS.md` while silently missing the rest of governance.

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
5. Write concrete values, never vague placeholders. Anything unresolved gets an explicit marker: `[NEEDS PRD CLARIFICATION]`, `[USER DECISION REQUIRED]`. Write `SYSTEM.md` at the repository root (source of truth) and copy it to `.pi/APPEND_SYSTEM.md` so pi actually loads it — a root `SYSTEM.md` is inert. Prefer append over `.pi/SYSTEM.md`, which replaces pi's default prompt. `pipeline-guard` blocks those writes unless the user confirms or `PIPELINE_ALLOW_GOVERNANCE_WRITE=1` is set for an unattended govern step.
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
        ├─ approved   ─▶ governance update ─▶ next issue
        ├─ rejected   ─▶ back to implement; after max_attempts_controller the
        │                 next attempt is implement_master (not a block).
        │                 Splitting is a generator adaptation point; the bundled
        │                 reference never splits.
        ├─ take_over  ─▶ stash the tree, drop cached research, implement_master
        │                 starts fresh from the issue with findings as exclusions
        └─ max_attempts_master exhausted ─▶ abort: mark blocked, write blocker
                                            to MEMORY.md, notify human
```

Two consecutive attempts with fewer parseable reviewers than `MIN_REVIEWERS` abort as a **configuration error** before controller and master of the second attempt — that is a broken panel, not a quality signal.

## Non-negotiable invariants

These hold in every generated pipeline. If a requested change would break one, stop and say so.

**Each step is a separate `pi -p` process.** If an extension provides sub-agents, do not use them for this pipeline. Reviewers must not share a session or see each other's verdicts — that is why each role is its own process, not a child of the implementer.

**The script picks the model, not the agent.** Read the mapping from `AGENTS.md`; never let a prompt choose its own model.

**Counters and budgets live in the harness.** `.pipeline/state/<root_id>.json`, never in a model context. A model may be told "you have N attempts left" and nothing more. Two distinct quantities:
- *attempts* — a quality signal, per issue, reset when an issue is split
- *budget* — a resource limit, held at the tree root, consumed across the whole tree, never reset

**Review gating is severity-based**, not a percentage. Any `critical` or `high` blocks; `medium` and `low` are recorded as follow-ups in the gate JSON and fed back on retry. The bundled script does not open tickets for them — that is a generator adaptation point. Percentage thresholds over three reviewers collapse into unanimity and hide that fact.

**The controller proposes; the master decides.** The controller runs a weak model and may miscount. The master sees the original reviewer JSON, not just the controller's summary. The master cannot approve over a blocking gate: a deterministic severity fail outranks the model verdict.

**Safe by default.** Privileged execution and auto-merge stay off unless `--unattended` / `--auto-merge` are passed. pi has no permission prompts, so the confirmation must happen in the script *before* the loop starts, or the run must be containerized. An extension cannot ask under `pi -p` — `ctx.hasUI` is false there. Never rely on a runtime dialog in an unattended run.

**Missing configuration degrades, never breaks.** Governance without a `models:` block runs every role on the default model. Absent budget fields fall back to documented defaults. Verify this rather than assuming it.

## Model routing

The mapping lives in `AGENTS.md` under `models:`; the field reference is in `references/contract.md`.

Two constraints the generated script must enforce:

- **No self-review.** A model that implemented a diff must not review it. This is enforced over `provider/model` refs, so it only holds for roles that are actually mapped: two unmapped roles both run pi's default model, and neither carries a ref to compare. Map at least two `review.*` roles — with fewer, the panel may be the implementer reviewing its own diff and the gate would approve it. `governance.mjs` warns about that at generation time and errors when `no_self_review` is written into `AGENTS.md` explicitly. On collision, drop that reviewer for the run and gate on the rest — but if drops and unparseable output shrink the panel below two reviewers, the gate blocks instead of approving. One opinion is not a review panel. The bundled script passes `MIN_REVIEWERS` (default 2). `gate.mjs` itself defaults `--min-reviewers` to 1 so a direct caller is unchanged.
- **Provider diversity.** Reviewers should span at least two providers. Three prompts against one model share its blind spots, which defeats the purpose of reviewing three times.

Invoke a role like this, reading `MODEL` from the mapping. Feed the prompt on stdin — interpolating it onto argv exceeds macOS `ARG_MAX` once the master sees the diff plus every reviewer JSON. Pass `--approve` only after the startup gate has set `PIPELINE_UNATTENDED=1`; it trusts every project-local resource, not only the guard.

```bash
pi_args=(-p --no-session)
[[ "${PIPELINE_UNATTENDED:-}" == 1 ]] && pi_args+=(--approve)
# review.*: -nc -t read,grep,find,ls   (AGENTS.md must not leak panel size)
# controller / master_review: --no-tools  (the diff is inline after per-file truncation)
if [[ "$MODEL" == "default" ]]; then
  pi "${pi_args[@]}" < "$ppath"
else
  pi "${pi_args[@]}" --model "$MODEL" < "$ppath"
fi
```

`$MODEL` is `provider/id`, or `provider/id:thinking` when the role sets `thinking` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). That is pi's `--model` shorthand; the separate `--thinking <level>` flag does the same job and wins when both are given, so pass one or the other, never both. pi clamps a level the model does not expose to the next higher supported level (and only falls back to a lower one when none exists above), and says nothing — the level is an instruction, not a guarantee. A cheap `thinking: low` can therefore run at `high` or `max`. The same model may be mapped to two roles with different thinking. Identity for `no_self_review` and for `implement` vs `implement_master` still ignores thinking — a different effort level is not a different model.

Verify the exact flag names against `pi --help` for the installed version before generating the script, and use the JSON event stream mode when the caller needs to parse structured output rather than prose.

## Escalation and abort

Research notes are cached per issue in the work directory. A bad first research pass sticks for later *repair* attempts; `take_over` deletes `research.md` so the escalated model gathers context again instead of inheriting the failed approach.

When the master implements a fix itself, it starts **fresh from the issue** with prior findings as an exclusion list — not from the failed diff. Inheriting the broken diff inherits the reasoning that already failed three times; a different model is only useful if it gets to think differently. Blocking findings are stored separately from lint/test output and are never displaced by a chatty linter; they are rewritten as prose (file + title/rationale, no line numbers) because `implement_master` does not receive the diff.

An abort is never silent: mark the issue blocked, write the blocker to `MEMORY.md`, notify a human. The next research and implement prompts for that issue receive the last N blocker entries from `MEMORY.md`. The state file already skips `blocked` issues; the MEMORY excerpt is the *content* of the history, not the skip itself.

`.pipeline/` holds plaintext diffs and prompts and **must be gitignored**. The script warns at start if it is not, and prunes `.pipeline/prompts/` down to `PROMPT_KEEP_RUNS` distinct run ids.

`--max-runs <n>` is an optional **invocation** cap across issues (not a PRD field; `max_runs_per_tree` remains per issue). Default off.

Do not call `pi auth check --model <id>` as a startup gate: ids such as `google/gemini-2.5-flash` are often openrouter models, and `auth check` would treat `google/` as a native provider and abort a healthy run. Credential preflight is warn-only.
