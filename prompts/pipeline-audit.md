---
description: Audit an existing auto-develop pipeline against the governance contract and invariants
---
Load the `governance-pipeline` skill and audit the existing pipeline in this repository without changing it.

Check, and report one line per item as PASS / FAIL / N-A with the evidence (file and line):

1. Every model invocation reads its model from the `AGENTS.md` mapping — no literal model string in the script body.
2. Reviewers run as separate `pi -p` processes and receive no sibling verdicts.
3. Counters and budget are read from and written to `.pipeline/state/<root_id>.json` only, never held in a model context.
4. The budget check precedes every implementation attempt.
5. Deterministic gates (lint, tests, clean-code) run before any model-based review.
6. The master review runs on every attempt, and sees the original reviewer JSON.
7. Abort writes the blocker to `MEMORY.md` before exiting.
8. Without `--unattended`, no privileged step proceeds unconfirmed; the confirmation happens before the loop starts.
9. `implement_master` differs from `implement`, and reviewers span at least two providers.

End with a verdict: CONFORMANT or the shortest list of changes that would make it conformant.
