---
name: governance-pipeline
description: Generate or audit project governance from a PRD, or set up, run and audit the issue-driven auto-develop pipeline shipped in this package. Use for these workflows, not merely because a repository contains AGENTS.md.
compatibility: Requires pi, bash, git and credentials for the configured providers. The engine supports Node >=18; Pi 0.85 requires Node >=22.19.
---

# Governance Pipeline

Governance is the source of truth; the versioned engine reads it. Never write or copy the loop, or add loop logic to the project's pinned `auto-develop.sh` wrapper.

Run commands in the project root. `<package>` is two levels above the directory containing this `SKILL.md`; `pi list` can locate the installed package. Load only the references required by the selected mode.

## Mode: govern

Generate governance, or audit it after PRD/repository changes. Read [governance-files.md](references/governance-files.md) and [contract.md](references/contract.md) before writing.

1. Read the PRD and inspect the actual repository: stack, architecture, security/compliance needs, dependencies and lint/test/type-check commands. Report conflicts rather than choosing silently.
2. Resolve roles, models, git conventions, budgets, gates and issue source with the human. Present the proposed changes before writing; for existing files, audit first and ask per file: overwrite, merge or skip.
3. Write the four governance files and harness copies as specified in the references. New contracts use `yaml pipeline-contract` with `contract_version: 2`, `issues.source` and `gates`. Mark unresolved decisions with `[USER DECISION REQUIRED]` or `[NEEDS PRD CLARIFICATION]`; never invent answers. Markers intentionally prevent startup.

Under `pi -p`, do not ask questions: an existing-governance audit stays read-only; authorized generation leaves markers for unresolved decisions. Governance writes require interactive confirmation or, for unattended govern, `PIPELINE_ALLOW_GOVERNANCE_WRITE=1`. The pipeline itself must never write governance.

## Mode: automate

Use only after governance is current. Run:

```bash
node <package>/bin/pipeline.mjs init      # forward all requested init options unchanged
./auto-develop.sh --dry-run              # routing and prompts, zero model calls
```

Show both outputs. If `init` fails, stop and explain; contract changes go through govern. Read [operations.md](references/operations.md) for option questions and before a real run. Start a real run only when requested; it needs a HEAD commit and the applicable startup confirmations.

## Mode: audit

Follow [audit.md](references/audit.md): run `doctor` and `status`, inspect project-controlled setup, report readiness without changing anything. Consult individual invariants only for unresolved behavior questions; the engine's test suite owns their verification.

## Boundaries

- Never let a prompt choose its model; routing comes from `AGENTS.md`.
- Never bypass the startup gate: `--unattended`, `--auto-merge` and an external issue source are confirmed before the loop or by `--yes`, never mid-run.
- Never edit `.pipeline/state` by hand; `governance.mjs state budget --set` is the way to raise a ceiling.
