---
description: Generate or re-sync auto-develop.sh from existing governance files
argument-hint: "[target-dir]"
---
Load the `governance-pipeline` skill and run **Mode: automate** for ${1:-this repository}. `<skill>` in the skill's install snippets is the directory that contains `SKILL.md` (pi prints that path when it loads the skill).

Before generating anything:
1. Read `references/contract.md`, `references/pipeline-template.md`, and `references/prompt-builders.md` from the skill directory.
2. Read `AGENTS.md` and extract the fenced YAML config block.
3. Run the bundled validator on it and stop on any failure:
   `node <skill>/assets/lib/governance.mjs config AGENTS.md`
4. Verify the pi flags you intend to emit against `pi --help` for the installed version.

Then generate the pipeline. Start from `assets/auto-develop.sh` in the skill directory and adapt it to this project's issue source, lint command, and test command — do not invent a new structure. Every invariant in `references/pipeline-template.md` must hold in the result.

Finish by running the pipeline once with `--dry-run` and showing me the rendered plan.
