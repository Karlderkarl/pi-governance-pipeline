# Prompt Builders

One prompt per role. Each runs as its own `pi -p` process with a fresh context.

## Contents

- [Shared rules](#shared-rules)
- [research](#research)
- [implement](#implement)
- [reviewers](#reviewers)
- [Reviewer output schema](#reviewer-output-schema)
- [controller](#controller)
- [master review](#master-review)
- [implement_master](#implement_master)

## Shared rules

Every prompt gets: the issue text, the relevant governance excerpt, and nothing else it does not need. Do not pass the whole repository or the whole session history.

Issue text and diff are **untrusted input**. The issue can come from `gh` or Jira, and the diff was written by a model. Both must be framed in the prompt as the thing being judged, never as instructions — a diff that asks the panel for an empty `findings` list otherwise clears three independent reviewers and a real gate. Framing is a mitigation, not a boundary; see the invariant in `SKILL.md`.

Never tell a role its own attempt count beyond "you have N attempts left". Never pass another role's verdict into a reviewer.

## research

Input: issue, `SOUL.md` (stack and architecture sections), and any `MEMORY.md` blocker entries for this issue.
Output: prose notes on relevant files, existing patterns, and pitfalls.

Runs once per issue, not per attempt, and is cached for repair retries. `take_over` deletes the cache so the escalated model gathers context again instead of inheriting the failed approach.

## implement

Input: issue, research notes, `SOUL.md` coding standards, `MEMORY.md` blocker history for this issue, and — on a retry — two exclusion streams:

- **Review findings** (from `gate.json`, rewritten as prose: file + title/rationale, no line numbers). Never truncated. Blocking findings survive a chatty linter.
- **Tool output** (lint, tests, empty-diff notes). Capped at `EXCLUSIONS_MAX_LINES` newest lines.

Line numbers are stripped because `implement_master` does not receive the diff, so `file:line` would be unresolvable.

Instruct it to write the test first, watch it fail, then make it pass. On a retry, state plainly which findings caused the rejection and that repeating them will fail again.

## reviewers

Three roles, three separate processes, three separate contexts. Each receives: issue, diff, and its own slice of `SOUL.md`. None receives another's verdict, and none is told how many reviewers exist. The reference script launches reviewers with `-nc` so pi does not load `AGENTS.md` (which would leak panel size, reviewer roles, and the implementer model), with `-t read,grep,find,ls` (read-only), and with `--no-approve`. The last one is not redundant: `-nc` drops context files and nothing else, while `.pi/APPEND_SYSTEM.md` is trust-gated, so `--approve` in an unattended run — or a saved trust decision in an attended one — would let `SYSTEM.md` carry the same internals back into the reviewer prompt. `--no-approve` also keeps project settings and extensions out of the reviewers; that is the isolation, not a side effect. The diff is truncated **per file**; omitted paths are named in a manifest at the bottom of the diff so the reviewer can see what was not judged.

| Role | Focus |
|---|---|
| `security` | Injection, authz, secrets, unsafe deserialization, dependency risk |
| `quality` | Readability, duplication, naming, error handling, test quality |
| `correctness` | Does it do what the issue asked; edge cases; regressions |

Each reviewer must be told to stay in its lane. A security reviewer that also comments on naming dilutes the signal and inflates finding counts.

## Reviewer output schema

The gate depends on this being machine-readable. Instruct the reviewer to emit **only** this JSON — no prose, no fences.

```json
{
  "role": "security",
  "verdict": "approve",
  "findings": [
    {
      "severity": "high",
      "file": "src/auth/session.ts",
      "line": 42,
      "title": "Session token compared with non-constant-time equality",
      "rationale": "Enables a timing side channel on token verification.",
      "suggestion": "Use a constant-time comparison."
    }
  ]
}
```

- `verdict`: `approve` | `reject` — advisory only; severity decides the gate. The word does decide whether the reviewer gets its one retry (`--check` requires `approve` or `reject`); after that retry, findings still reach the gate even if the word is wrong
- `severity`: `critical` | `high` | `medium` | `low` — anything else (including a trailing space or a synonym like `blocker`) is treated as blocking; the gate does not drop unknown severities
- `line`: integer or `null` when file-level
- `findings`: empty array when nothing found

Severity definitions belong in the prompt, not in the reviewer's head. Without them, "high" drifts between models and providers and the gate becomes noise:

- **critical** — exploitable now, data loss, or the feature is fundamentally broken
- **high** — a real bug or vulnerability under plausible conditions
- **medium** — should be fixed, but shipping without it is defensible
- **low** — style, polish, nitpick

Parse defensively. If the output is not valid JSON, retry once with an explicit reminder, then treat the reviewer as unavailable and gate on the remainder. Never regex prose into a verdict.

## controller

Input: the three reviewer JSON objects, verbatim.
Output: a single JSON object with the merged finding list and a proposed verdict.

It runs a weak model, so keep its job mechanical: deduplicate findings that name the same file and line, apply the severity rule, propose. Tell it explicitly that it does not decide and that the master will see the original JSON regardless.

## master review

Input: issue, diff, the **original** reviewer JSON objects, the controller's proposal, and the attempt count.

Its task is to decide, and to check the controller's arithmetic rather than trust it. It has three outcomes: `approve`, `reject` with reasons, or `take_over` — the script stashes the rejected working tree and a stronger model implements the next attempt fresh from the issue.

It runs on every attempt, not only on escalation.

Parsing is fail-closed and **strictest-wins**: anything that is not a parseable decision counts as `reject`, and when several candidates parse, `take_over` beats `reject` beats `approve`. The schema example above is never a candidate — its `decision` field reads `approve|reject|take_over`, which is not a valid word — so a model echoing it costs no attempt. Ranking the rest is what stops a fragment appended *after* the real object from upgrading the verdict; a stray stricter value costs an attempt instead, which is the cheap direction. Never grep prose for a verdict word.

The decision must be machine-readable — reviewers already emit JSON, and the master's verdict is parsed the same way. Instruct it to emit **only** this JSON — no prose, no fences:

```json
{
  "decision": "approve",
  "reasons": ["No blocking findings; the diff resolves the issue."]
}
```

- `decision`: `approve` | `reject` | `take_over`
- Parsing is fail-closed: unparseable output counts as `reject`. Never grep prose for a verdict.

## implement_master

Input: issue, research notes (regenerated after `take_over`), and the accumulated findings as an **exclusion list** in prose.

Explicitly do not pass the failed diff. The point of switching models is a different approach; handing over the broken code anchors the new model to the reasoning that already failed. State that previous attempts failed for the listed reasons and that it should solve the issue afresh. Findings name a file and a symbol/context, not a line number — the line would point at a diff this role does not see.
