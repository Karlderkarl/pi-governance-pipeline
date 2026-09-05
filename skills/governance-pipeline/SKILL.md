---
name: governance-pipeline
description: Turns a PRD into project governance (SOUL.md, AGENTS.md, SYSTEM.md, MEMORY.md) and runs an issue-driven auto-develop pipeline from that governance, with per-role model routing, independent multi-model review, severity-based gating and hard run budgets. The pipeline ships in this package; the skill configures it. Use when the user wants to generate or audit governance from a PRD, or set up, run or audit the pipeline. Do not load merely because a repository contains AGENTS.md.
compatibility: Requires pi, bash and git. The engine supports Node >=18; Pi 0.85 requires Node >=22.19. Model routing needs credentials for every configured provider. Only implementers load trust-gated project resources; research, reviewers and judges disable project trust and executable resource discovery.
---

# Governance Pipeline

Governance is the source of truth. The PRD becomes four files; the pipeline reads them. The loop itself is code in this package (`bin/pipeline.mjs`, `lib/`), tested once, versioned, pinned by the project's `auto-develop.sh`. You never write or copy the loop. You write governance, run the deterministic commands, and read their diagnosis.

```
PRD ──▶ govern ──▶ SOUL.md · AGENTS.md · SYSTEM.md · MEMORY.md
                              │
                              ▼
                      automate ──▶ pipeline init ──▶ auto-develop.sh (wrapper) ──▶ pipeline run
```

Read `references/governance-files.md` before writing governance, `references/contract.md` for the fields the pipeline reads, `references/operations.md` for flags, variables and the threat model, `references/invariants.md` for the rules the loop enforces and the tests that pin them.

## Choosing a mode

| Situation | Mode |
|---|---|
| PRD exists, no governance files yet | govern (generate) |
| Governance exists, PRD or repo changed | govern (audit) |
| Governance is current, no wrapper yet, or the package version moved | automate |
| Something looks wrong, or before an unattended run | audit |

Run govern to completion before automate: the pipeline reads governance, and an incomplete contract is refused at `init`, not silently defaulted.

## Mode: govern

1. Determine the project root from the PRD. `read` the PRD; extract stack, architecture, security, compliance.
2. Inspect the repository with `find` and `grep`: build config, dependencies, structure, **dev commands** (lint, test, type-check). Where PRD and repo disagree, report the conflict.
3. Resolve open decisions with the human: roles, model routing, git conventions, budgets, which gates run, where issues come from.
4. Write the four files with concrete values. Write the contract block in `AGENTS.md` as `yaml pipeline-contract` with `contract_version: 2`, including `issues.source` and `gates` (`references/contract.md`). Anything unresolved gets a marker (`[USER DECISION REQUIRED]`, `[NEEDS PRD CLARIFICATION]`); the pipeline refuses to start on a marker, which is the point.
5. Render the harness configuration: root `SYSTEM.md` and a copy at `.pi/APPEND_SYSTEM.md` (pi ignores a root `SYSTEM.md`); `CLAUDE.md` when Claude Code runs any role. Never put pipeline internals (panel size, role-to-model mapping) in those files.
6. Present a summary before writing. If files exist, audit first and ask per file: overwrite, merge, skip.

Under `pi -p` there is no UI: do not ask, do not invent — write the marker and continue. `pipeline-guard` blocks governance writes unless the user confirms or `PIPELINE_ALLOW_GOVERNANCE_WRITE=1` is set for an unattended govern step.

## Mode: automate

Deterministic. Run, in the project root:

```bash
node <package>/bin/pipeline.mjs init      # validate first; wrapper with version pin, .gitignore, issue file and parents
./auto-develop.sh --dry-run               # routing and prompts, zero model calls
```

`<package>` is the installed pi package (`pi list` shows it); the wrapper itself uses `npx pi-governance-pipeline@<version>`. `init --local` pins a checkout instead, `init --harness anthropic=claude-code` routes Anthropic roles through Claude Code. On a contract error, explain it and propose the governance change; the change goes through govern, because only govern writes governance. A first real run needs a commit (`take_over` stashes against HEAD) and, with `--unattended` or an external issue source, the startup gate answered.

## Mode: audit

```bash
node <package>/bin/pipeline.mjs doctor    # contract, gates, issue source, HEAD, .gitignore, wrapper pin, binaries
node <package>/bin/pipeline.mjs status    # counters, tree budget, per-issue state
```

Read the output and explain it against `references/invariants.md`. The loop's invariants are pinned by the package's test suite, not re-derived by you.

## Never

- Never write or copy the loop, and never add loop logic to `auto-develop.sh`.
- Never let a prompt choose its model; routing comes from `AGENTS.md`.
- Never write governance under `pi -p` without `PIPELINE_ALLOW_GOVERNANCE_WRITE=1`, and never from the pipeline itself.
- Never bypass the startup gate: `--unattended`, `--auto-merge` and an external issue source are confirmed before the loop or by `--yes`, never mid-run.
- Never edit `.pipeline/state` by hand; `governance.mjs state budget --set` is the way to raise a ceiling.
