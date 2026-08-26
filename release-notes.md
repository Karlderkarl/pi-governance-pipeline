Closes fail-open unknown severities, validates the contract on the state path, stops passing `--approve` without the startup gate, and stops the skill from teaching generators the bugs the script already fixed.

### Fixed
- The review gate no longer drops an unrecognised or untrimmed severity. `"blocker"` and `"CRITICAL "` block (exit 4) and are listed under `unknown_severity`.
- `state init` / `state budget` run the same contract validator as `config`, so `max_runs_per_tree: twenty` exits 2 instead of freezing a string into the tree and reporting budget exhausted at attempt 0.
- Child `pi -p` processes receive `--approve` only after `--unattended` / `--auto-merge` have passed the startup gate. A plain `./auto-develop.sh` no longer trusts the whole `.pi/` directory.
- `REVIEWERS_MAX_BYTES` above ~64 KiB now takes effect: truncation reads from a file, matching `capture_diff`. `dd count=1` on a pipe was short-reading at the pipe buffer.
- `pipeline-guard` applies the same destructive, privileged, and governance-write checks to the `powershell` tool as to `bash`.
- `block_issue` takes the tree root id separately from the issue id, so a generator that splits cannot create a new budget by blocking a child.
- Thinking-level docs match pi 0.84.3: an unsupported level clamps **up** to the next higher supported level, not to the nearest.
- The skill's invoke example no longer puts the prompt on argv (the ARG_MAX path the reference script already left). Prompts go in on stdin; `--approve` only after the startup gate.
- The skill no longer claims pi has no sub-agents. Reviewers stay separate `pi -p` processes on purpose — sharing a session would undo independent review.
- The skill no longer promises that `medium`/`low` become tickets. The bundled script records them as gate follow-ups and feeds them back on retry; opening tickets is a generator adaptation point.
- `/pipeline-audit` checks the invariants the 1.0.10–1.0.11 fixes actually added (stdin prompts, empty diff, `take_over` stash, unknown severity, `--approve` gating, `block_issue` root id).
- Lint/test retries are documented as consuming an implementation attempt and tree budget, even though they skip the review cycle.
- Unattended `/govern` is told to set `PIPELINE_ALLOW_GOVERNANCE_WRITE=1`; `pipeline-guard` otherwise blocks the `SYSTEM.md` / `.pi/APPEND_SYSTEM.md` writes the skill requires.

### Added
- Prefer a fenced block marked `yaml pipeline-contract` when more than one YAML block in `AGENTS.md` contains contract keys.
- `state` commands now emit contract warnings on stderr the same way `config` does.

### Changed
- README Safety: `--exclude-tools bash,powershell` (excluding `bash` alone does not close the PowerShell path). `--approve` is documented as trusting every project-local resource, not only the guard.
- Skill description no longer auto-loads on a bare mention of `AGENTS.md`. Copy-and-adapt points (`ISSUE_SOURCE`, `LINT_CMD`, `TEST_CMD`) are named; the loop is not a free rewrite.
- Research notes are documented as cached per issue until the work file is deleted.

**Full Changelog**: https://github.com/Karlderkarl/pi-governance-pipeline/compare/v1.0.10...v1.0.11
