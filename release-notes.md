Closes fail-open unknown severities, validates the contract on the state path, and stops passing `--approve` without the startup gate.

### Fixed
- The review gate no longer drops an unrecognised or untrimmed severity. `"blocker"` and `"CRITICAL "` block (exit 4) and are listed under `unknown_severity`.
- `state init` / `state budget` run the same contract validator as `config`, so `max_runs_per_tree: twenty` exits 2 instead of freezing a string into the tree and reporting budget exhausted at attempt 0.
- Child `pi -p` processes receive `--approve` only after `--unattended` / `--auto-merge` have passed the startup gate. A plain `./auto-develop.sh` no longer trusts the whole `.pi/` directory.
- `REVIEWERS_MAX_BYTES` above ~64 KiB now takes effect: truncation reads from a file, matching `capture_diff`. `dd count=1` on a pipe was short-reading at the pipe buffer.
- `pipeline-guard` applies the same destructive, privileged, and governance-write checks to the `powershell` tool as to `bash`.
- `block_issue` takes the tree root id separately from the issue id, so a generator that splits cannot create a new budget by blocking a child.
- Thinking-level docs match pi 0.84.3: an unsupported level clamps **up** to the next higher supported level, not to the nearest.

### Added
- Prefer a fenced block marked `yaml pipeline-contract` when more than one YAML block in `AGENTS.md` contains contract keys.
- `state` commands now emit contract warnings on stderr the same way `config` does.

### Changed
- README Safety: `--exclude-tools bash,powershell` (excluding `bash` alone does not close the PowerShell path). `--approve` is documented as trusting every project-local resource, not only the guard.

**Full Changelog**: https://github.com/Karlderkarl/pi-governance-pipeline/compare/v1.0.10...v1.0.11
