---
description: Generate or audit governance files (SOUL.md, AGENTS.md, SYSTEM.md, MEMORY.md, .pi/APPEND_SYSTEM.md) from a PRD
argument-hint: "[path-to-PRD]"
---
Load the `governance-pipeline` skill (read its SKILL.md, `references/governance-files.md` and `references/contract.md`) and run **Mode: govern**.

PRD: ${1:-find the PRD in this repository (look for PRD*.md, docs/PRD*.md, or ask me)}

Rules for this run:
- Inspect the actual repository for stack, versions, structure and dev commands (lint, test, type-check). Do not trust the PRD where the repo disagrees — report both.
- If governance files already exist, audit first and ask per file: overwrite, merge, or skip.
- Write concrete values. The contract block in `AGENTS.md` is `yaml pipeline-contract` with `contract_version: 2`, including `issues.source` and `gates` from what you found. Unresolved decisions get `[USER DECISION REQUIRED]` or `[NEEDS PRD CLARIFICATION]` markers, never invented answers; the pipeline refuses to start on a marker.
- Write root `SYSTEM.md` and copy it to `.pi/APPEND_SYSTEM.md` (and `CLAUDE.md` when Claude Code runs any role). No pipeline internals in those files. `pipeline-guard` will confirm those writes interactively; an unattended govern step needs `PIPELINE_ALLOW_GOVERNANCE_WRITE=1`.
- Show me a summary of what you intend to write before writing it.
