---
name: governance-pipeline
description: Generate or audit project governance (SOUL.md, AGENTS.md, SYSTEM.md, MEMORY.md, the pipeline contract) from a PRD, or set up, dry-run, run and audit the issue-driven auto-develop pipeline shipped in this package (auto-develop.sh, /govern, /automate, /pipeline-audit). Use for these workflows, not merely because a repository contains AGENTS.md.
---

# Governance Pipeline

Governance is the source of truth; the versioned engine reads it. Never write or copy the loop, or add loop logic to the project's pinned `auto-develop.sh` wrapper.

Requires pi, bash, git and credentials for the configured providers. The engine supports Node >=18; also satisfy the installed Pi package's `engines.node` requirement.

Run commands in the project root. `<package>` is two levels above the directory containing this `SKILL.md`; `pi list` can locate the installed package. Load only the references required by the selected mode.

## Mode: govern

Generate governance, or audit it after PRD/repository changes. Read [governance-files.md](references/governance-files.md) and [contract.md](references/contract.md) before writing.

1. Read the PRD and inspect the actual repository: stack, architecture, security/compliance needs, dependencies and lint/test/type-check commands. Report conflicts rather than choosing silently.
2. Resolve roles, models, git conventions, budgets, gates and issue source with the human. Present the proposed changes before writing; for existing files, audit first and ask per file: overwrite, merge or skip.
3. Write the four governance files and harness copies as specified in the references. New contracts use exactly one `yaml pipeline-contract` block with `contract_version: 2`, `issues.source` and `gates`. Mark unresolved decisions with `[USER DECISION REQUIRED]` or `[NEEDS PRD CLARIFICATION]`; the legacy `[NEEDS CLARIFICATION]` also blocks startup. Never invent answers or quote these marker phrases elsewhere in governance, even without brackets. A marker fails `doctor` and refuses a real run; a dry-run only notes prose markers (contract markers still fail validation).
4. Validate before handing over: `node <package>/bin/pipeline.mjs doctor`. Typical pre-automate setup findings are a missing wrapper (WARN), `.pipeline/` not gitignored (FAIL), or a missing file issue source (FAIL); `init` resolves them. A missing HEAD is a separate prerequisite for a real run, not for generating governance or running `init`. Report intentional decision-marker FAILs and these setup prerequisites explicitly; fix other FAILs within the requested scope. Contract errors require correcting the block.

Under `pi -p`, do not ask questions: an existing-governance audit stays read-only; authorized generation leaves markers for unresolved decisions. Governance writes require interactive confirmation or, for unattended govern, `PIPELINE_ALLOW_GOVERNANCE_WRITE=1`. Model roles never write governance; only the engine may append blocker, review-pause and approval follow-up history to `MEMORY.md`.

## Mode: automate

Use only after governance is current. Run:

```bash
node <package>/bin/pipeline.mjs init      # forward all requested init options unchanged
./auto-develop.sh --dry-run              # routing and prompts, zero model calls
```

Show both outputs. If `init` fails, stop and explain; contract changes go through govern. Read [operations.md](references/operations.md) for option questions and before a real run. Start a real run only when requested; it needs a HEAD commit and the applicable startup confirmations.

## Mode: audit

Follow [audit.md](references/audit.md): run `doctor` and `status`, inspect project-controlled setup, report readiness without changing anything. The checklist summarises the invariants it cites; the engine's test suite owns their verification.

## Boundaries

- Never let a prompt choose its model; routing comes from `AGENTS.md`.
- Never bypass the startup gate: `--unattended`, `--auto-merge` and an external issue source are confirmed before the loop or by `--yes`, never mid-run.
- Never edit `.pipeline/state` by hand; `node <package>/lib/governance.mjs state budget .pipeline <root_id> --set <n>` is the way to raise a ceiling.
