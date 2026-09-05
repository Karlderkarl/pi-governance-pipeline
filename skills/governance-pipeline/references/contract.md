# Governance Contract v2

The versioned interface between governance and the pipeline. `govern` writes these fields; the pipeline reads them and never writes. Version 2 adds `contract_version`, `issues` and `gates`, so that everything the loop needs is in governance rather than in the caller's environment. A file without `contract_version` is v1 and keeps every v1 default.

## Contents

- [Reading rules](#reading-rules)
- [Example](#example)
- [models](#models)
- [budgets](#budgets)
- [review](#review)
- [issues](#issues)
- [gates](#gates)
- [Absent-field behaviour](#absent-field-behaviour)
- [Validation](#validation)

## Reading rules

- All fields live in `AGENTS.md`, in a fenced YAML block (` ```yaml ` or ` ```yml `), marked `yaml pipeline-contract`. If several YAML fences contain contract keys, the marked one is used; otherwise the first is used and a warning names how many were found. A `~~~` fence or an unclosed backtick fence does not parse.
- If the file contains `pipeline-contract` or a line matching `models:` / `budgets:` / `review:` / `contract_version:`, **but no fenced YAML block parsed**, that is a contract error (exit 2) — not silent defaults. A file with neither still takes the documented default path.
- The YAML subset: block maps, block sequences, inline maps `{ a: b }`, inline lists `[a, b]`, quoted and plain scalars, booleans, integers, null, `#` comments. Quotes protect commas, colons and `#`, so `run: "eslint --ext .js,.ts src"` survives intact. Block scalars (`|`, `>`), anchors, aliases, tags, nested sequences (`- - x`) and duplicate keys are contract errors that name the construct — a second `implement:` never silently wins.
- Every field is optional in v1. Absence is a documented state, never an error. In v2, `issues.source` and `gates` are required (see below).
- Unknown fields are ignored, not rejected — forward compatibility. They still produce a **warning** that names the key (`models.implement_msater`, `budgets.max_atempts_controller`, …) so a typo cannot vanish into the merged config.
- A value carrying a decision marker (`[USER DECISION REQUIRED]`, `[NEEDS PRD CLARIFICATION]`, quoted or not) is not a value: the field counts as undecided and validation refuses with the field named. That is how `govern` hands an open decision to the human without the pipeline running on a placeholder.

## Example

```yaml pipeline-contract
contract_version: 2

models:
  research:          { provider: openai,    model: gpt-5-mini,   thinking: low }
  implement:         { provider: anthropic, model: sonnet-4.5,   thinking: high }
  implement_master:  { provider: google,    model: gemini-3-pro, thinking: high }
  controller:        { provider: openai,    model: gpt-5-nano }
  master_review:     { provider: anthropic, model: opus-4.5,     thinking: high }
  review:
    security:        { provider: google,    model: gemini-3-flash, thinking: medium }
    quality:         { provider: openai,    model: gpt-5 }
    correctness:     { provider: anthropic, model: haiku-4.5,   thinking: low }
  constraints:
    no_self_review: true

budgets:
  max_attempts_controller: 3
  max_attempts_master: 3
  max_runs_per_tree: 25
  max_split_depth: 1

review:
  blocking_severities: [critical, high]
  followup_severities: [medium, low]

issues:
  source: tasks.md                     # a checkbox file, or:
  # source: { command: "gh issue list --label ready --json number,title --jq '.[] | \"\\(.number): \\(.title)\"'", trust: external }

gates:                                 # ordered; every gate must pass before any review
  - { name: lint, run: "npm run lint" }
  - { name: test, run: "npm test" }
  # - { name: complexity, run: "npx eslint --max-complexity 10 src" }
```

The harness (pi, Claude Code) is **not** a contract field: governance is harness-neutral, and the same file must run on either. See `operations.md`, "Harness selection".

## models

| Role | Purpose | Notes |
|---|---|---|
| `research` | Gathers context before implementation | Runs once per issue, not per attempt; read-only tools |
| `implement` | Writes the code | The main cost driver |
| `implement_master` | Escalated implementation | Must differ from `implement` — a different blind spot is the point |
| `controller` | Aggregates reviewer JSON, proposes a verdict | Weak model is fine; it does not decide |
| `master_review` | Final decision | Runs on every attempt; should differ from `implement_master` |
| `review.*` | Independent reviewers | Span ≥2 providers |
| `constraints.no_self_review` | Drops a reviewer whose model implemented the diff | Default `true`. Enforced over `provider/model` refs at run time; two unmapped roles carry no ref to compare, so map at least two `review.*` roles |

`provider` and `model` are opaque strings passed through to the harness. `thinking` is optional per role (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) and launches as pi's `--model provider/model:thinking`. Identity for `no_self_review` and for `implement` vs `implement_master` is `provider/model` only; a different thinking level is not a different model. pi clamps a level the model does not expose to the next higher supported level, silently; the log records the level requested. Claude Code ignores the level.

## budgets

`max_attempts_*` are per issue and start at zero for every child of a split. `max_runs_per_tree` is held at the root and consumed across every descendant; it never resets. `max_split_depth` caps how deep a split may go (default 1; above 1 needs `PIPELINE_ALLOW_DEEP_SPLIT=1`). Every budget field must be an integer: `max_attempts_*` and `max_runs_per_tree` ≥ 1; `max_split_depth` ≥ 0.

`state init` freezes `max_runs_per_tree` into the state file at tree creation. Later edits to `budgets` do not change an existing tree. To raise the ceiling for a running tree: `node lib/governance.mjs state budget .pipeline <root_id> --set <n>`.

Sizing note: at split degree 4 and depth 1 the loop reaches `3 + 4 × 6 = 27` implementation runs at roughly six model calls each. The default of 25 is deliberately below that, so a pathological issue is stopped rather than fully explored.

## review

Any finding at a blocking severity rejects the attempt. Findings at follow-up severities are recorded in the gate JSON and fed back on retry. Severity is normalised with trim + lower-case. A finding whose severity is not `critical`, `high`, `medium`, `low` is **blocking** (`unknown_severity`); a known severity that appears in neither list also blocks (`unlisted_severity`), and the validator refuses such a pair of lists up front. Both lists may be written inline (`[critical, high]`) or as a block sequence.

## issues

Where open issues come from. Required in v2.

| Form | Meaning |
|---|---|
| `source: tasks.md` | A checkbox file: `- [ ] <id>: <title>` per open issue, `- [x]` when done. Children of a split are indented under their parent (`  - [ ] <id>.1: …`). The pipeline marks issues done and creates children here |
| `source: { command: "…", trust: external }` | A command whose stdout lists `id: title` lines. It cannot create children, so a split becomes a reject. `trust: external` (the default for commands) makes a real run ask for confirmation, because the issue text is foreign input to every prompt; `trust: internal` skips that |

`ISSUE_SOURCE` in the environment (a file, or `!command`) overrides the contract for one run.

## gates

The deterministic checks that run after every implementation and before any model-based review, in order. Required in v2: list them, or write `gates: []` to run without one on purpose (a warning at every start). A gate is `{ name, run }`; `name` is a short identifier that labels the log and the feedback block, `run` a shell command. A failing gate feeds its output back into the next implement prompt and costs the attempt without spending a review cycle. Fold clean-code checks (complexity, duplication) in as further gates; there is no separate slot. `LINT_CMD` / `TEST_CMD` in the environment replace the list for one run.

## Absent-field behaviour

| Absent | Behaviour |
|---|---|
| `contract_version` | The file is v1 |
| whole `models:` block | Every role runs the default model; warning once at start |
| a single role under `models:` | That role falls back to the default model |
| `thinking` on a role | The harness resolves the level from its own settings |
| `review:` sub-map under `models:` | All reviewers run the default model; `no_self_review` cannot fire — warning, error if `no_self_review: true` is written explicitly |
| `constraints.no_self_review` | Treated as `true` |
| whole `budgets:` block, or a field | Defaults above |
| `review:` gating block | Defaults above |
| `issues` | v1: `tasks.md`, or `ISSUE_SOURCE`. v2: contract error |
| `gates` | v1: `LINT_CMD` / `TEST_CMD`, or no gate with a warning. v2: contract error |

A v1 file with none of these blocks runs exactly as before: absence degrades loudly instead of refusing. The one thing absence cannot do is buy a guarantee — `no_self_review` written into the file is a promise, and a configuration that cannot honour it is a contract error.

## Validation

Validation runs in `init`, `doctor`, at the start of every run, and in the `governance.mjs config` facade (exit 2). It refuses:

- `contract_version` other than 1 or 2
- a decision marker in any field
- a mapped role without `model` (`implement: { provider: a }` would otherwise run the default model in silence)
- `implement_master` identical to `implement` (compared without `thinking`)
- exactly one provider across mapped `review.*` roles; exactly one mapped `review.*` role ("only one models.review.* role is mapped"); a mapped `review.*` role without `provider`
- severity lists that do not together cover `critical`, `high`, `medium`, `low`; an unknown severity; a list that is not a list
- `max_runs_per_tree` below `max_attempts_controller + max_attempts_master`; a budget field that is not an integer in range; `max_split_depth` above 1 without `PIPELINE_ALLOW_DEEP_SPLIT=1`
- a `thinking` value that is not one of pi's levels
- an explicit `constraints.no_self_review: true` with fewer than two mapped `review.*` roles
- v2 without `issues.source` or without `gates`; `gates` entries without a valid `name` or `run`, or with a duplicate `name`; an `issues.source` that is neither a path nor a `{ command }` map, or a `trust` other than `external` / `internal`
- a file that looks like a contract when no fenced YAML block parsed

It warns (never refuses) on unknown keys at every map, on `master_review` equal to `implement_master`, on a `review.*` model equal to an implementer under `no_self_review`, on a panel that would shrink below two reviewers on the escalated path, on overlapping severity lists (blocking wins), on a `models:` block that maps no role, on an `issues.source` path outside the repository (it would not be committed with approved work), and on `gates: []`.
