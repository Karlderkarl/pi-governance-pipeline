# v1.2.2

### Fixed

- Failed reviewer/master processes cannot release work. Malformed reviewer arrays never fill a panel seat, and findings from every JSON candidate survive recovery. Deduplication preserves configured blocking membership even for unusual severity partitions.
- Attempts are reserved before model startup, state writes are atomic, and invalid state/schema fails doctor, status and real runs. A per-worktree Git-directory lock excludes competing API/CLI runs and state mutations independently of TEMP/TMPDIR; doctor reports existing locks.
- Split descendants retain their original tree budget at every supported depth. Invocation caps preserve split resumption, and contributor history excludes previous implementers from reviewing retained code across escalation and restart.
- Explicit null and other wrong contract types refuse. Relocated governance stays out of review and approval. Issue operations compare entire IDs and reject ambiguous duplicates. Init reports requested harness/local changes that require --force.
- Governance and control snapshots cover model processes, gates and command issue-source reads, including split resumption. Link-aware restoration preserves existing target data and stops on incomplete recovery. State, Git config, hooks and run locks are protected; approval Git commands disable hooks.
- Approval commits the exact Git-normalized blobs captured for review through an isolated index. Later worktree changes or clean-filter transformations cannot add implementation content to the commit. Unrelated staged entries remain staged; failed commits and refused block/split stashes stop subsequent work.
- Decision markers anywhere in governance prevent a real run; dry-run reports them without model work. Pi non-implementer isolation explicitly suppresses discovered executable resources and custom system-prompt files.

### Added

- Persistent review pauses: truncated or omitted content records a reason in state and MEMORY.md, exits 1 and retains the work. Unchanged restarts check coverage before starting a model. Started implementation attempts remain counted.
- A documented binary-review workflow: a human inspects exact Git blobs and supplies an approved SHA-256 receipt outside the working tree through BINARY_REVIEW_FILE. Hashes identify approved bytes; neither --yes nor --unattended grants binary approval.
- Regression coverage for the original F01–F13 findings and the later F14–F18/G01–G02 counterexamples, using isolated repositories, real Git operations and separate processes.

### Changed

- DIFF_MAX_BYTES defaults to 524288 (512 KiB), up from 65536. Text and binary pause messages name different recovery steps.
- Skill instructions, README, operating instructions and invariant documentation describe the enforced behavior and the boundary between text review and human binary review.
- Release notes are included in the npm package. Installation examples pin 1.2.2.

### Validation

Release validation and the finding-to-test mapping are recorded in
[the 1.2.2 validation report](https://github.com/Karlderkarl/pi-governance-pipeline/blob/v1.2.2/docs/release-1.2.2-validation.md).
The GitHub release workflow runs unit and smoke tests before publishing through
npm Trusted Publishing. Local validation uses Windows, Node 26.8.1 and the real Pi
SDK. No live model run is claimed for this release.

**Full Changelog**: https://github.com/Karlderkarl/pi-governance-pipeline/compare/v1.2.1...v1.2.2

# v1.2.1

A smaller skill context, with the same pipeline engine and safeguards as 1.2.0.

### Changed

- **Lean skill instructions.** Shared workflow rules live in `SKILL.md`; slash prompts select a mode and pass its arguments instead of repeating the rules. The entrypoint shrinks from 68 to 42 lines.
- **Focused project audits.** `/pipeline-audit` uses a short, read-only checklist with `doctor` and `status`. The full invariants remain available for unresolved behavior questions instead of being required reading for every audit.
- **Maintainer documentation stays out of the skill context.** Engine prompt design moves from the skill references to `docs/prompt-builders.md`, which is not included in the npm package. README and install examples reflect the new layout and version.

### Fixed

- The audit checklist distinguishes supported legacy v1 contracts from invalid configuration. A zero exit code from `doctor` is not, by itself, a readiness verdict.
- Prompt-design documentation now matches the implementation: severity values are trimmed and case-folded, retries need a strictly better parse-quality rank without losing severity, and controller/master inputs are distinguished from independent reviewer inputs.
- Pi SDK integration tests skip unsupported Node 22 minors below 22.19 instead of checking the major version alone; a regression pins the supported runtime boundary.

### Added

- Real Pi SDK coverage for discovering all three slash prompts, selecting existing skill modes and preserving explicit, quoted and omitted PRD arguments. The `/automate` regression now loads templates through Pi's own loader.
- Regression coverage for skill-reference links remaining inside the published package and for referenced invariant identifiers existing.

No changes to engine code, guard behavior, model routing, budget accounting, commit scope or role isolation.

### Validation

- Read-only release review with Pi 0.85.1 and `openrouter/openai/gpt-5-mini:high`; the second pass approved the corrected candidate with no findings.
- 87 tests passed locally on Windows, including the real Pi SDK loader/parser checks; no skipped tests. The full smoke suite and ShellCheck passed.
- The packed 1.2.1 artifact passed the live Pi check with `openrouter/openai/gpt-5-mini:low`: extension loading, `pipeline_state`, seeded reviewer finding, deterministic blocking gate and master rejection.
- Package inspection confirmed all three prompts and the audit checklist are included, while maintainer docs stay repository-only.

The Pi release review is static; the live fixture verifies integration, not a complete multi-provider development run. Claude Code remains stub-verified only.

**Full Changelog**: https://github.com/Karlderkarl/pi-governance-pipeline/compare/v1.2.0...v1.2.1
