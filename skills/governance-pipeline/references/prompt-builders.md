# Prompts

One prompt per role, one process per prompt, a fresh context every time. The fixed text of every prompt is a template in the package (`lib/prompts/templates/<role>.md`), reviewable as text; `lib/prompts/build.mjs` fills in the run's data. Projects do not override the templates — project context reaches the roles through `SOUL.md`. What follows is what each role receives and why.

## Contents

- [Shared rules](#shared-rules)
- [research](#research)
- [implement and implement_master](#implement-and-implement_master)
- [reviewers](#reviewers)
- [Reviewer output schema](#reviewer-output-schema)
- [controller](#controller)
- [master review](#master-review)

## Shared rules

Every prompt gets: the issue text, the relevant governance excerpt, and nothing else it does not need. Never the whole repository, never the session history, never another role's verdict.

Issue text and diff are **untrusted input**. The issue can come from `gh` or Jira, and the diff was written by a model. Both are framed as the thing being judged, never as instructions — a diff that asks the panel for an empty `findings` list would otherwise clear three independent reviewers and a real gate. Framing is a mitigation, not a boundary (`operations.md`, Safety).

A role learns its attempt count only as "you have N attempts left". The prompt is fed on stdin, and one rendered prompt per attempt is archived under `.pipeline/prompts/<root>/`.

## research

Input: issue, `SOUL.md` (first 120 lines: stack and architecture), the `MEMORY.md` blocker history for this issue.
Output: prose notes on relevant files, existing patterns, and pitfalls.

Runs once per issue with read-only tools, cached for repair retries. `take_over` deletes the cache so the escalated model gathers context again instead of inheriting the failed approach.

## implement and implement_master

Input: issue, research notes, `SOUL.md` coding standards, the blocker history, and on a retry two exclusion streams:

- **Review findings** (from `gate.json`, as prose: file + title/rationale, no line numbers). Never truncated. Blocking findings survive a chatty linter.
- **Tool output** (gates, empty-diff notes, governance-integrity notes, master excerpts). Capped at `EXCLUSIONS_MAX_LINES` newest lines.

Line numbers are stripped because `implement_master` does not receive the diff; `file:line` would be unresolvable. The instruction is test-first: write the failing test, watch it fail, make it pass; change the code only; leave the work uncommitted, because the reviewers read the working-tree diff. `implement_master` starts fresh from the issue with the findings as an exclusion list — handing over the broken diff would anchor the new model to the reasoning that already failed.

## reviewers

Three roles, three processes, three contexts. Each receives the issue, the diff (truncated per file, omitted paths named in a manifest), its own slice of `SOUL.md`, the severity definitions, and the output schema. None receives another's verdict, and none is told how many reviewers exist or which model implemented. The isolation flags per harness are in `operations.md`.

| Role | Focus |
|---|---|
| `security` | Injection, authz, secrets, unsafe deserialization, dependency risk |
| `quality` | Readability, duplication, naming, error handling, test quality |
| `correctness` | Does it do what the issue asked; edge cases; regressions |

Each reviewer is told to stay in its lane. A security reviewer that also comments on naming dilutes the signal and inflates finding counts.

## Reviewer output schema

The gate depends on this being machine-readable. The reviewer is told to emit **only** this JSON — no prose, no fences.

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

- `verdict`: `approve` | `reject` — advisory; severity decides the gate. The word decides only whether the reviewer gets its one retry. The retry is a fresh process with no memory of the first pass, so it replaces the original only if it parses at least as well **and** its worst finding is at least as severe.
- `severity`: `critical` | `high` | `medium` | `low` — anything else (a trailing space, a synonym like `blocker`) blocks; the gate never drops unknown severities.
- `line`: integer or `null` when file-level. `findings`: empty array when nothing found.

Severity definitions are in the prompt, not in the reviewer's head: **critical** exploitable now, data loss, or fundamentally broken · **high** a real bug or vulnerability under plausible conditions · **medium** should be fixed, shipping without it is defensible · **low** style, polish, nitpick.

Parsing is defensive: every fenced block and the raw text are candidates, the candidate with the worst finding wins (a quoted `{"verdict":"approve","findings":[]}` from the diff cannot displace a real reject), a schema echo (`approve|reject`) is never a candidate, and prose is never regexed into a verdict.

## controller

Input: the reviewer JSON objects of this attempt, verbatim (capped at `REVIEWERS_MAX_BYTES`).
Output: one JSON object with the merged finding list and a proposed verdict.

It runs a weak model, so its job is mechanical: deduplicate findings naming the same file and line, apply the severity rule, propose. It is told that it does not decide and that the master sees the originals regardless.

## master review

Input: issue, diff, the **original** reviewer JSON, the controller's proposal, the deterministic gate JSON, the panel-independence note, and the attempt number.

Outcomes: `approve`, `reject` with reasons, `take_over` (the script stashes the rejected tree and a stronger model implements the next attempt fresh from the issue), and — only when the harness allows it, i.e. depth below `max_split_depth` and an issue source that can create children — `split` with two to five sub-issues, each a title and a text.

```json
{"decision":"approve","reasons":["No blocking findings; the diff resolves the issue."]}
```

Parsing is fail-closed and **strictest-wins**: anything unparseable is `reject`; among several candidates `take_over` beats `reject` beats `approve`, so a fragment appended after the real object can never upgrade the verdict; the schema example is never a candidate. `split` is accepted only when it is the sole parseable decision and well-formed; any ambiguity turns it into `reject` with a note in the run output. The master cannot approve over a blocking gate: a deterministic severity fail outranks the model verdict.
