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
