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
- The contract validates without decision markers. New governance uses v2 with `issues.source` and `gates`; a supported legacy v1 contract is not invalid solely for being v1. (INV-01, INV-05)
- The configured gates match the repository's real lint/test commands; `gates: []` is an intentional choice, not a silently omitted check. Verify a file issue source exists; inspect command-source configuration without executing it. (INV-05, INV-24)
- `AGENTS.override.md` is absent or intentional. Harness configuration (`SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, and `CLAUDE.md` when used) is present as required and contains no pipeline internals such as panel size or model routing. See [governance-files.md](governance-files.md) only if the expected files or their ownership are unclear.
- Required harness binaries are available. Real runs need the applicable startup confirmations; external input must be acknowledged, and unattended runs over untrusted repositories or issue text need a container. See [operations.md](operations.md) for trust, isolation or flag questions. (INV-08, INV-23, INV-24)
- Blocked issues in `status` have a blocker entry in `MEMORY.md`; resumed runs retain their counters and tree budget. Do not edit state to clear a warning. (INV-07, INV-10)

End with READY only when applicable checks are verified and no blocking gaps remain; include any non-blocking warnings. Otherwise give the shortest list of missing evidence or changes needed. An audit is not authorization to make those changes or start the loop.

The full [invariants.md](invariants.md) maps INV identifiers to engine tests. Consult only the relevant section when a behavior question remains unresolved; do not load the whole reference for a routine project audit.
