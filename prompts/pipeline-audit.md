---
description: Audit an existing auto-develop pipeline against the governance contract and invariants
---
Load the `governance-pipeline` skill and audit the existing pipeline in this repository without changing it.

Check, and report one line per item as PASS / FAIL / N-A with the evidence (file and line):

1. Every model invocation reads its model from the `AGENTS.md` mapping — no literal model string in the script body.
2. Reviewers run as separate `pi -p` processes and receive no sibling verdicts.
3. Counters and budget are read from and written to `.pipeline/state/<root_id>.json` only, never held in a model context.
4. The budget check precedes every implementation attempt.
5. Deterministic gates (lint, tests — a clean-code check folds into the lint command, there is no separate slot) run before any model-based review.
6. The master review runs on every attempt, sees the original reviewer JSON, and cannot approve when the deterministic gate blocked.
7. Abort writes the blocker to `MEMORY.md` before exiting. `block_issue` / `state issue` is called with the **tree root id**, not only the sub-issue id.
8. Without `--unattended`, no privileged step proceeds unconfirmed; the confirmation happens before the loop starts. Child `pi -p` processes receive `--approve` only after that gate (`PIPELINE_UNATTENDED=1`).
9. `implement_master` differs from `implement`, and reviewers span at least two providers.
10. A resumed run restores per-issue attempt counters from the state file instead of restarting at zero.
11. `--dry-run` performs no state writes and consumes no budget.
12. With `no_self_review` on, a reviewer dropped for the current attempt contributes nothing to that attempt: gate, controller, and master read only the verdicts of reviewers that actually ran, and the unparseable-output retry never restarts a dropped reviewer.
13. Prompts are fed to `pi -p` on stdin, not interpolated onto argv.
14. An empty working-tree diff is a rejected attempt, not a clean review.
15. `take_over` stashes the rejected tree; `MEMORY.md` is copied out and written back.
16. Reviewer JSON whose severity is missing, untrimmed, or not `critical|high|medium|low` blocks rather than disappearing.
17. Reviewers are separate `pi -p` processes, not sub-agents of the implementer.
18. Credential preflight is warn-only. The script must not call `pi auth check --model <id>` (openrouter ids such as `google/gemini-*` would abort a healthy run).
19. Role toolset: every role passes `--no-session`; `review.*` passes `-nc` and `-t read,grep,find,ls`; `controller` and `master_review` pass `--no-tools` once the diff is truncated per file with an omitted-path manifest.
20. An optional `--max-runs <n>` caps the invocation across issues. Default off. `max_runs_per_tree` remains per issue.
21. `MEMORY.md` blocker entries for the current issue are fed back into the research and implement prompts. Blocking gate findings are stored separately from lint/test output and are never displaced by the exclusions line cap; they are rewritten as prose without line numbers.
22. Unknown contract keys warn (never refuse). A `pipeline-contract` / `models:` / `budgets:` / `review:` intent with no parsed fence is a contract error. `state` warnings are deduplicated per `.pipeline/` directory; errors stay loud. Every `state` call sets `GOVERNANCE_AGENTS`.
23. `.pipeline/` is gitignored (or the script warns). Prompt archives are pruned. `AGENTS.override.md`, if present, is warned about at start.

End with a verdict: CONFORMANT or the shortest list of changes that would make it conformant.
