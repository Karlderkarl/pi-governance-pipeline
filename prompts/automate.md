---
description: Set up or re-pin the auto-develop pipeline from existing governance (init + dry-run)
argument-hint: "[--harness <spec>] [--local] [--force]"
---
Load the `governance-pipeline` skill and run **Mode: automate** for this repository. The loop ships in the package; you configure it, you do not write it.

1. Locate the installed package (`pi list`, or the directory that contains this skill's `SKILL.md`; `bin/pipeline.mjs` sits two levels above it).
2. Run `node <package>/bin/pipeline.mjs init ${ARGUMENTS:-}` in the repository root and show me its output. It validates the contract in `AGENTS.md`, writes `auto-develop.sh` pinned to the package version, adds `.pipeline/` to `.gitignore`, and creates the issue file and its parent directories if missing.
3. On a contract error, explain it and propose the change to `AGENTS.md`; make it through `/govern`, not by hand — only govern writes governance.
4. Run `./auto-develop.sh --dry-run` and show me the routing and the prompt paths. A real run needs a commit first (`take_over` stashes against HEAD); say so if there is none.
5. Read `references/operations.md` for the startup gates (`--unattended`, external issue sources) before suggesting a real run.
