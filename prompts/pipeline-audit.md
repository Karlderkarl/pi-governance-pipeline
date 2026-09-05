---
description: Audit the pipeline setup of this repository against the governance contract and the invariants
---
Load the `governance-pipeline` skill and run **Mode: audit** without changing anything.

1. Run `node <package>/bin/pipeline.mjs doctor` (add `--harness <spec>` if the wrapper pins one) and `node <package>/bin/pipeline.mjs status`. Report every FAIL and WARN line with what it means for the next run.
2. Read `references/invariants.md`. The loop's invariants (INV-01 … INV-29) are pinned by the package's test suite; do not re-derive them from the code. Report only what the *project* controls, one line each, PASS / FAIL / N-A with the evidence:
   - `auto-develop.sh` is the generated wrapper, pinned to the installed package version, with no loop logic added
   - `.pipeline/` is gitignored and a HEAD exists
   - the contract validates, is v2, names `issues.source` and `gates`, and carries no decision marker
   - the gates named are the project's real lint and test commands
   - `AGENTS.override.md` is absent, or its presence is intended
   - `SYSTEM.md` / `.pi/APPEND_SYSTEM.md` / `CLAUDE.md` carry no pipeline internals (panel size, role-to-model mapping)
   - the issue source is internal, or an external one is acknowledged and the run is containerized
   - blocked issues in `status` have a blocker entry in `MEMORY.md`
3. End with a verdict: READY, or the shortest list of changes that would make it ready.
