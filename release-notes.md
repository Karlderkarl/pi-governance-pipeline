Closes the fail-open empty-diff path, feeds prompts on stdin so macOS ARG_MAX cannot kill a paid-for master step, and makes `take_over` the fresh start the prompt already promised.

### Fixed
- An empty working-tree diff is now a rejected attempt, not a clean review. Reviewers never see a 0-byte patch, and an implementer that commits (against the prompt) gets an actionable exclusion instead of a silent `approved`.
- `capture_diff` excludes `.pipeline/` and the governance files (`MEMORY.md`, `SOUL.md`, `AGENTS.md`, `SYSTEM.md`, `CLAUDE.md`). `block_issue` writes `MEMORY.md`; leaving that file in the review diff let a later empty issue look implemented and get `approved`.
- `ISSUE_SOURCE=!command` no longer swallows a failed source as "no open issues" with exit 0. A non-zero command exits the run with `issue source failed (exit N)`.
- `mark_issue_done` matches the raw id from `tasks.md` (`feat/login-page`), not the sanitised directory token (`feat-login-page`).
- The script refuses to start outside a git repository, instead of burning the tree budget on empty diffs and then blocking a correct implementation.
- Isolated `tsc --noEmit` on `pipeline-guard.ts` no longer depends on a global `@types/node` (the release runner has none).
- Prompts are fed to `pi -p` on stdin instead of interpolating the body onto argv, so a master prompt that concatenates the diff plus every reviewer JSON no longer dies with `argument list too long` on macOS.
- The same redirect keeps the issue-list here-string that drives the main loop out of `pi`'s stdin. Unredirected, `pi` drained it, prepended the remaining issues to the running prompt, and the loop never saw them: a multi-issue run silently processed only the first.
- `take_over` stashes the rejected working tree (`pipeline: pre-take_over …`) before `implement_master` runs. Controller retries still repair in place; only escalation resets.
- Highest-consequence bash patterns (`sudo`, recursive `rm`, force-push) stay armed during unattended runs unless `PIPELINE_ALLOW_DESTRUCTIVE=1`. The `rm` pattern requires a recursive flag, so a routine `rm -f somefile` is not blocked. An unattended `rm -rf node_modules` is therefore a blocked tool call in the model context, not a pipeline-level error.

### Added
- `ISSUE_SOURCE=!command` prints one open issue per line (`id: title`). A tasks.md file is still the default; adapting to `gh` or Jira no longer requires rewriting `next_issues()`.
- Approved issues are marked `- [x]` in a file-backed `ISSUE_SOURCE`, so the source and the state file stop drifting.
- Pre-publish smoke covers a stub-`pi` happy path, empty diff, unparseable-reviewer retry, resume from an existing state file, a two-issue run, a blocked issue followed by a second empty issue (must also block), a slash id in `tasks.md`, a failing `ISSUE_SOURCE=!command`, a missing git repository, and `tsc --noEmit` on `pipeline-guard.ts`. The stub drains stdin the way `pi` does, so the launch shape is tested, not assumed.

### Changed
- `--auto-merge` prints that it is not implemented in the reference script, at flag parse and at approve. The README, skill, and pipeline template say the same.
- README Safety states that `pipeline-guard` is a speed bump, not a sandbox, and that the default tree budget of 25 is ~150 model invocations, not a spending cap.
- Contract docs match the code: `governance.mjs config` also validates at pipeline startup (exit 2). `max_split_depth` is validated even though the bundled script never splits.

**Full Changelog**: https://github.com/Karlderkarl/pi-governance-pipeline/compare/v1.0.9...v1.0.10
