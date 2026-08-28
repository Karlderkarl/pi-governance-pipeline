Closes the verified 1.0.12 findings: unknown contract keys warn, an unparsed contract fence is an error, state warnings print once, a short review panel aborts as a configuration error after two attempts (~17 calls instead of 55), and MEMORY.md / gate findings actually re-enter the next prompt.

### Fixed
- Unknown contract keys (`implement_msater`, `review.securty`, `max_atempts_controller`) warn and stay ignored — never refused — so v2 fields remain forward-compatible.
- A `pipeline-contract` marker or a `models:` / `budgets:` / `review:` line with no parsed fenced YAML block is a contract error (exit 2), not silent defaults. Absence of both is still the documented default path.
- `state` still validates on every call; identical warnings are printed once per `.pipeline/` directory. Errors stay loud.
- `state attempts` and `state budget` set `GOVERNANCE_AGENTS`, so `AGENTS_FILE` cannot silently fall back to a different `AGENTS.md`.
- Two consecutive attempts with `reviewers_used < MIN_REVIEWERS` abort as a configuration error before controller and master of the second attempt. A stub run where reviewers never emit JSON costs 17 model calls instead of 55.
- Each `pi -p` can be wrapped in GNU `timeout` / `gtimeout` (`ROLE_TIMEOUT_SECONDS`, default 0). Exit 124 empties the outfile so the role is unavailable.
- Credential preflight does not call `pi auth check` with an AGENTS.md model id (openrouter ids such as `google/gemini-*` would abort a healthy run).
- `MEMORY.md` blocker entries for the current issue are fed into research and implement prompts (`BLOCKER_HISTORY_MAX`).
- Gate findings live in `findings.md` and are never displaced by a chatty linter. Lint/test output stays under `EXCLUSIONS_MAX_LINES`.
- Diff truncation is per file, not a byte prefix. Omitted and truncated paths are named in a manifest; untracked TDD files are considered first.
- `take_over` deletes cached `research.md` so the escalated model gathers context again.
- Findings re-enter the implement prompt as prose (file + title/rationale), not `file:line`.

### Added
- `--no-session` on every role; `review.*` gets `-nc` and `-t read,grep,find,ls`; `controller` / `master_review` get `--no-tools`.
- `--max-runs <n>` is an optional invocation cap across issues (not a PRD field). Default off.
- `PROMPT_KEEP_RUNS` prunes `.pipeline/prompts/`. The script warns if `.pipeline/` is not gitignored and if `AGENTS.override.md` exists.
- Drift notes in `MEMORY.md` for unmet PRD AK6, dead `max_split_depth`, and the missing generation eval.

### Changed
- SKILL.md diagram: `reject` escalates to `implement_master` after `max_attempts_controller`; it does not block at 3.
- `pipeline-template.md` no longer claims token usage in the JSONL log (`log_event` does not parse `pi --mode json`).
- `/pipeline-audit` covers preflight, role toolset, `--max-runs`, and MEMORY.md feedback.
- README install pins, tuning table, and the release section track 1.0.13.

**Full Changelog**: https://github.com/Karlderkarl/pi-governance-pipeline/compare/v1.0.12...v1.0.13
