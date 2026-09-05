# MEMORY

Living status for this package. Not packed.

## Decisions

- **2026-09-05: final 1.2.0 release review.** Mixed-schema reviewer JSON now retains the strongest findings. Commit failures return non-zero even on the last issue and halt split-parent closure; a halt after a child leaves its parent open. New regressions first failed, then passed. All 83 tests pass locally with Pi 0.85.1 SDK checks enabled. The opt-in packed-artifact live check also passed: real extension loading and `pipeline_state`, reviewer finding, deterministic blocking gate and tool-free master rejection with `openrouter/openai/gpt-5-mini:low`. This does not establish full-panel independence or govern quality. Details: `docs/review-2026-09-05-1.2.0-final.md`.
- **2026-09-05: follow-up Pi review fixes.** Approval commits exclude unrelated index entries and include both sides of renames; an implementer moving HEAD blocks the issue and halts the run before review. Pi research disables trust and extension discovery; non-implementer roles explicitly suppress global system-prompt files. `/automate` forwards all options, CLI commands reject missing harness values, and `init` validates before writes and creates issue-file parent directories. Regression coverage includes the installed Pi 0.85.1 loader and template parser; no live model calls.
- **2026-09-05, 1.2.0: the pipeline is code in the package, not a script the skill generates.** `bin/pipeline.mjs` + `lib/` replace `assets/auto-develop.sh`; the project keeps a pinned wrapper. Rationale and the staged plan: `refactor.md`.
- **2026-09-05: budget inheritance on split is the account variant.** The tree budget is held at the root and consumed by every child; attempts restart per child. Chosen because the state file was built that way (PRD R10) and because a per-child share cannot be calibrated before anyone has measured a real tree. Revisit once real trees have run.
- **2026-09-05: the harness is not a contract field.** Governance stays harness-neutral (PRD R15); `--harness provider=harness` lives in the wrapper. Claude Code can only carry Anthropic roles.

- **2026-09-05: the same-day review of 1.2.0 (`docs/review-2026-09-05-1.2.0.md`) is closed.** Twelve findings, all fixed with tests: split resume, title injection, process-tree timeouts, the Windows `.cmd` launch, hash-based snapshots, and the small ones.
- **2026-09-05: the pre-release review of 1.2.0 (`docs/review-2026-09-05-1.2.0-pre-release.md`) is closed.** Eighteen findings, all fixed with tests: a block stashes the rejected tree, CRLF issue files are read, trust comes from the flag and never from the environment, the integrity snapshot covers the issue source and the wrapper, harness stderr is reported and two failing implementer processes are a configuration error, gates have a timeout, judges run untrusted, routing to Claude Code is checked at start, and the small ones.
- **2026-09-05: no metering in the skill.** The token/usage/cost recording and the `report` command were removed on the author's decision: the skill is about doing the work; what it costs is the coder's own business and the harness's accounting. The parity suite refuses if metering comes back into the shipped files.

## Drift notes

- **PRD AK6 is met with a stub, not live.** The Claude Code adapter runs the scenario table against a stub `claude` and its flags are checked against `claude --help`. No live run against Claude Code has been made in this release.
- **`govern` has no eval.** Nothing is generated any more except governance itself; whether an agent following `SKILL.md` writes a sound contract from a PRD is still unmeasured. `init`/`doctor` refuse a bad one, which is the safety net, not a measurement.
- **The parity suite is bash.** `tests/smoke.sh` needs bash (Git Bash on Windows); unit tests that run shell commands also need bash on PATH or `PIPELINE_SHELL`. Porting the scenarios to `node --test` was deferred on purpose: the bash suite is the proof that 1.2.0 retains the 1.0.17 scenarios. CI covers Ubuntu Node 18/22 and Windows Node 22; the release process waits for that matrix before pushing the tag, then reruns both suites before OIDC publishing.
