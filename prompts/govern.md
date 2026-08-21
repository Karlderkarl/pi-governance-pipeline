---
description: Generate or audit governance files (SOUL.md, AGENTS.md, SYSTEM.md, MEMORY.md) from a PRD
argument-hint: "[path-to-PRD]"
---
Load the `governance-pipeline` skill (read its SKILL.md and `references/governance-files.md`) and run **Mode: govern**.

PRD: ${1:-find the PRD in this repository (look for PRD*.md, docs/PRD*.md, or ask me)}

Rules for this run:
- Inspect the actual repository for stack, versions, and structure. Do not trust the PRD where the repo disagrees — report both.
- If governance files already exist, audit first and ask per file: overwrite, merge, or skip.
- Write concrete values. Unresolved decisions get `[USER DECISION REQUIRED]` or `[NEEDS PRD CLARIFICATION]` markers, never invented answers.
- Show me a summary of what you intend to write before writing it.
