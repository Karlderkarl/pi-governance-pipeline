# Pipeline Template

Structural blueprint for the generated `auto-develop.sh`. Stack-agnostic: the gates are read from governance, never hardcoded.

> **Scope of the bundled reference** (`assets/auto-develop.sh`): it implements this blueprint except the split branch (it blocks instead) and the commit/PR/governance-update step (a marked stub). Both are deliberate adaptation points. A generator that implements splitting must honor `max_split_depth`.

## Contents

- [Layout](#layout)
- [State file](#state-file)
- [Main loop](#main-loop)
- [Flags](#flags)
- [Logging](#logging)
- [Invariants](#invariants)

## Layout

```
auto-develop.sh              # entry point, the loop
.pipeline/
  state/<root_id>.json       # counters and budget
  logs/<root_id>/<run>.jsonl # per-run event log
  prompts/                   # rendered prompts, one per role and attempt, for debugging
tasks.md                     # or the issue source declared in governance
```

## State file

One per root issue. The single source of truth for counters — no model ever holds them.

```json
{
  "root_id": "issue-42",
  "runs_used": 7,
  "max_runs_per_tree": 25,
  "depth": 0,
  "issues": {
    "issue-42": { "attempts_controller": 3, "attempts_master": 0, "status": "split" },
    "issue-42a": { "attempts_controller": 1, "attempts_master": 0, "status": "open" }
  }
}
```

Written after every step, not at the end. A crashed run must be resumable, and a lost counter means a budget that silently resets.

`state init` is a no-op when the file already exists, so `max_runs_per_tree` is captured once at tree creation. Editing `budgets` in `AGENTS.md` afterwards does not change that tree. Raise the ceiling with `governance.mjs state budget <dir> <root_id> --set <n>` — n must be an integer ≥ 1 and not below `runs_used`.

## Main loop

```
load governance ─▶ validate contract ─▶ pick next issue
  │
  ├─ budget exhausted? ─▶ block tree, write MEMORY.md, exit
  │
  ├─ research (once per issue, cached)
  │
  └─ attempt:
       implement ─▶ deterministic gates (lint, tests)
         │  (no model — a failure here retries without consuming
         │   a review cycle; fold clean-code checks into the lint
         │   command, there is no separate slot)
         ▼
       3 reviewers in parallel, separate processes
         ▼
       controller ─▶ master review
         ├─ approve ─▶ commit ─▶ PR ─▶ update governance ─▶ next issue
         ├─ reject  ─▶ attempts_controller++ ─▶ retry in place (dirty tree kept), or split at max
         └─ master takes over ─▶ stash the rejected tree ─▶ attempts_master++ ─▶ retry fresh, or abort at max
```

Increment `runs_used` once per implementation attempt, regardless of which role implemented. Check the budget before starting an attempt, not after.

## Flags

| Flag | Default | Effect |
|---|---|---|
| `--unattended` | off | Skips per-step confirmation; requires the pre-loop confirmation to have passed |
| `--auto-merge` | off | **Stub in the reference script.** Parsed and confirmed at the safety gate so an adapted pipeline can merge an approved PR; the bundled script prints a notice and does not merge. |
| `--dry-run` | off | Renders prompts and prints the plan without calling a model |
| `--issue <id>` | — | Runs a single issue |

`--unattended` and `--auto-merge` both prompt once at startup, before the loop, and refuse to proceed on a non-interactive stdin unless an explicit `--yes` accompanies them. pi has no permission dialog and `pi -p` has no UI, so this startup gate is the only place a human can intervene.

`--dry-run` is worth building early: it is the cheapest way to verify routing and prompt assembly without spending a single call.

## Logging

One JSONL event per step: timestamp, issue, role, model, exit status, token usage where available, and the path to the rendered prompt. Enough to answer "why did issue-42 cost 60 calls" after the fact.

Never log secrets or full file contents. Log the prompt path, not the prompt.

## Invariants

Verify these when generating or re-syncing. A pipeline that violates one is wrong even if it runs.

1. Every model invocation reads its model from the governance mapping. No literal model string in the script body.
2. Reviewers run in separate processes and receive no sibling verdicts.
3. Counters are read from and written to the state file only.
4. The budget check precedes every attempt.
5. Deterministic gates run before any model-based review.
6. The master review runs on every attempt.
7. Abort writes to `MEMORY.md` before exiting.
8. Without `--unattended`, no privileged step proceeds unconfirmed.
9. A resumed run restores per-issue attempt counters from the state file; counters never restart at zero after a crash.
10. `--dry-run` writes no state and consumes no budget.
11. An empty working-tree diff is a rejected attempt, not a clean review.
12. `reject` keeps the working tree (incremental repair). `take_over` stashes it so `implement_master` starts from the issue, not from the rejected approach. `MEMORY.md` is copied out and written back — stash `-u` would otherwise swallow the blocker history.
13. The review diff excludes governance files (`MEMORY.md`, `SOUL.md`, `AGENTS.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `CLAUDE.md`) and the `.pipeline/` and `.pi/` directories. An issue whose only intended change is a governance file cannot complete in this pipeline; that work belongs to `/govern`.
