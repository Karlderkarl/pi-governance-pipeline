# Project readiness audit

Audit project setup, not the engine implementation. Keep this mode read-only: do not repair files, reset counters, run project gates or execute an issue-source command.

## Diagnostics

Run in the project root, using the package location from `SKILL.md`:

```bash
node <package>/bin/pipeline.mjs doctor    # add --harness <spec> if the wrapper pins one
node <package>/bin/pipeline.mjs status
```

Explain every FAIL and WARN and its effect on the next run. A zero exit code alone does not establish readiness: `doctor` also succeeds with warnings and cannot establish whether configured commands match the project.

## Project checks

Report PASS / WARN / FAIL / N-A with evidence; mark anything unverified explicitly.

- The generated `auto-develop.sh` pins the intended package version and harness, with no added loop logic. Report a mismatch with the installed version. (INV-22, INV-28)
- A HEAD exists and `.pipeline/` is gitignored. (INV-25, INV-26)
- The contract validates, and no governance file carries a decision marker; `doctor` reports each one as FAIL with file and line, and a real run refuses on it. New governance uses v2 with `issues.source` and `gates`; a supported legacy v1 contract is not invalid solely for being v1. (INV-01, INV-05, INV-28)
- The configured gates match the repository's real lint/test commands; `gates: []` is an intentional choice, not a silently omitted check. Verify a file issue source exists; inspect command-source configuration without executing it. (INV-05, INV-24)
- `AGENTS.override.md` is absent or intentional. Harness configuration (`SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, and `CLAUDE.md` when used) is present as required, `.pi/APPEND_SYSTEM.md` is a byte copy of `SYSTEM.md` (`doctor` warns on drift), and none contains pipeline internals such as panel size or model routing. See [governance-files.md](governance-files.md) only if the expected files or their ownership are unclear.
- Required harness binaries are available. `doctor` warns when `PIPELINE_GUARD=off` is in the environment: the guard is then off for every implementer too — report whether that is intended. Real runs need the applicable startup confirmations; external input must be acknowledged, and unattended runs over untrusted repositories or issue text need a container. See [operations.md](operations.md) for trust, isolation or flag questions. (INV-08, INV-23, INV-24)
- Blocked issues in `status` have a blocker entry in `MEMORY.md`, and approved issues with accepted `medium`/`low` findings a `## Follow-ups` entry awaiting manual backlog triage; resumed runs retain their counters and tree budget. Do not edit state to clear a warning. (INV-07, INV-10)
- Paused issues have a recorded reason and review-pause history in `MEMORY.md`. Report incomplete text coverage, unsupported submodule changes and outstanding binary reviews as unresolved readiness gaps. Inspect any configured `BINARY_REVIEW_FILE` and its outside-worktree location without granting approval or generating a new diff (Git filters execute project code). The engine must recheck blob hashes on resume. (INV-15)
- No working-tree run lock blocks startup; `doctor` reports an existing `pipeline-run.lock`. Report its named location and whether a running owner is known; never remove it during an audit. (INV-04)

End with READY only when applicable checks are verified and no blocking gaps remain; include any non-blocking warnings. Otherwise give the shortest list of missing evidence or changes needed. An audit is not authorization to make those changes or start the loop.

## Invariants cited above

One line each; the engine's test suite pins them. The full list with reasons and the test that pins each one is maintainer documentation: [docs/invariants.md](https://github.com/Karlderkarl/pi-governance-pipeline/blob/main/docs/invariants.md), not shipped with the skill.

| Id | Rule |
|---|---|
| INV-01 | Every model is read from the `models:` block in `AGENTS.md`; a mapped role without a model is a contract error |
| INV-04 | A run lock prevents concurrent pipeline ownership of the same working tree |
| INV-05 | The contract's `gates` run in order after every implementation and before any review; `gates: []` is explicit |
| INV-07 | An abort is never silent: the issue is `blocked`, the blocker is appended to `MEMORY.md`, the run exits non-zero |
| INV-08 | `--unattended` enables implementer trust after confirmation; `--auto-merge` is confirmed but grants nothing; external input has its own acknowledgement; trust never comes from an inherited environment value |
| INV-10 | A resumed run restores its counters; `max_runs_per_tree` is frozen at tree creation and moved only by `state budget --set` |
| INV-15 | Incomplete review coverage pauses approval; binary content needs a matching human receipt; submodule changes need a separate review and commit |
| INV-22 | The harness is chosen per provider by `--harness` or the wrapper, never by governance |
| INV-23 | Pi reviewers, research and judges disable approval, extensions and custom system prompts; Claude Code research is read-only but lacks safe mode, while its reviewers and judges use safe mode; see the operations matrix |
| INV-24 | An external issue source is acknowledged at the startup gate before any model sees its text |
| INV-25 | A real run needs a HEAD commit; an unknown `--issue` is an error |
| INV-26 | Prompts live under `.pipeline/prompts/`, pruned, and `.pipeline/` must be gitignored |
| INV-28 | Model roles never write governance; only the engine appends MEMORY.md blocker/pause history; the wrapper carries a version pin and no loop logic; decision markers refuse a real run |
