Closes fail-open review-gate flags and unmapped self-review, keeps a written finding through a worse retry, and runs the smoke suite on every PR.

### Fixed
- `gate.mjs --min-reviewers zwei` (or `0`) is a usage error (exit 1) that names the value. It no longer clamps the floor to 1.
- `gate.mjs --blocking` / `--followup` refuse unknown severities instead of dropping them from the lists.
- Unknown `gate.mjs` flags (`--min-reviewrs`) are a usage error, not phantom reviewer files that leave `--min-reviewers` at 1.
- `extractJson` tries every fenced block, then the raw text. A schema echo (`"verdict":"approve|reject"`) is recognised by the pipe in that word, not by failing `approve|reject`. The last real object wins. Severity decides the gate: a schemakonform `critical` with verdict `"blocked"` still blocks. `--check` is 0 (usable verdict), 2 (findings, wrong word), or 1 (nothing) so the pipeline retry still fires on a wrong word.
- A reviewer retry writes a sidecar and is taken only when `--check` ranks it better (0 > 2 > 1). A prose retry can no longer erase a `critical` that was already on disk.
- The master-decision parser uses the same last-valid-candidate rule (`approve|reject|take_over`). An example fence before `approve` no longer burns the attempt as a silent `reject`.
- `MIN_REVIEWERS` that is not an integer ≥ 1 is fatal rather than reset. The check runs after flag parsing so `--help` still prints.
- Explicit `constraints.no_self_review: true` with fewer than two mapped `review.*` roles is a contract error. The defaulted-true path still parses, but warns whenever fewer than two reviewers are mapped — including when `implement` itself is mapped (`"default"` never equals `provider/model`).
- An unmapped review panel is reported at run time (stderr once per issue, `independence-unverified` in the log, a `Panel independence:` line in the master prompt). `no_self_review: false` no longer claims every reviewer ran on a mapped model. A constraints-only `models:` block warns that no role is mapped.
- A mapped `review.*` role without `provider:` is a contract error. Exactly one provider across mapped reviewers is still an error; zero mapped reviewers stay a warning.
- A real run without `pi` dies at start instead of burning the tree budget. `--dry-run` without `pi` notes the gap and still exits 0.
- `contract.md` no longer claims `no_self_review` still applies when the `review:` sub-map is absent. The split-depth override is named `PIPELINE_ALLOW_DEEP_SPLIT=1`.
- The skill documents `PIPELINE_ALLOW_DESTRUCTIVE`, `MIN_REVIEWERS`, `PIPELINE_ALLOW_DEEP_SPLIT`, that `ISSUE_SOURCE=!command` / `LINT_CMD` / `TEST_CMD` are `eval`, and that attended child `pi -p` processes load `SYSTEM.md` via `.pi/APPEND_SYSTEM.md` only with a saved project-trust decision. It no longer claims pi has built-in sub-agents. The quickstart creates `tasks.md` and says dry-run does not confirm a real run.

### Added
- `.github/workflows/ci.yml` runs `bash tests/smoke.sh` on push to `main` and on pull requests (Node 22, `contents: read`). Publish stays on the tag workflow.

### Changed
- README install pins, validation list, Safety, `MIN_REVIEWERS`, and the release section track 1.0.12.

**Full Changelog**: https://github.com/Karlderkarl/pi-governance-pipeline/compare/v1.0.11...v1.0.12
