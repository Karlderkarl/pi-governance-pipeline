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

- All fields live in `AGENTS.md`, in a fenced YAML block (` ```yaml ` or ` ```yml `). Mark exactly one as `yaml pipeline-contract`: multiple marked fences are a contract error, even if one is an example. A marked block must contain at least one recognized top-level contract field; empty, comment-only or unrelated example blocks refuse instead of selecting defaults. Without a marked fence, the first YAML fence containing contract keys is used and multiple candidates produce a warning. A `~~~` fence or an unclosed backtick fence does not parse.
- If the file contains `pipeline-contract`, or a contract key line **inside** an untagged or YAML-tagged fence, **but no fenced YAML block parsed**, that is a contract error (exit 2) — not silent defaults. That is the `~~~` fence, the fence whose closing backticks never arrived, and the ``` fence missing its language tag. A bare `models:` or `review:` line in the prose is *not* a contract attempt — `AGENTS.md` is expected to have a review-rules section — and a file with no contract at all still takes the documented default path.
- The YAML subset: block maps, block sequences, inline maps `{ a: b }`, inline lists `[a, b]`, quoted and plain scalars, booleans, integers, null, `#` comments. Quotes protect commas, colons and `#`, so `run: "eslint --ext .js,.ts src"` survives intact. Block scalars (`|`, `>`), anchors, aliases, tags, nested sequences (`- - x`) and duplicate keys are contract errors that name the construct — a second `implement:` never silently wins.
- Every field is optional in v1. Absence is a documented state, never an error. In v2, `issues.source` and `gates` are required (see below).
- Unknown fields are ignored, not rejected — forward compatibility. They still produce a **warning** that names the key (`models.implement_msater`, `budgets.max_atempts_controller`, …) so a typo cannot vanish into the merged config.
- A value carrying a decision phrase (`USER DECISION REQUIRED`, `NEEDS PRD CLARIFICATION`, or legacy `NEEDS CLARIFICATION`, with or without brackets/quotes) counts as undecided and validation refuses with the field named. Use markers only for open decisions, not as quoted examples in governance.

## Example

The example below is unmarked to keep it distinguishable from an active contract. When generating `AGENTS.md`, mark its single active block as `yaml pipeline-contract`.

```yaml
contract_version: 2

models:
  research:          { provider: openai,    model: gpt-5-mini,        thinking: low }
  implement:         { provider: anthropic, model: claude-sonnet-4-5, thinking: high }
  implement_master:  { provider: google,    model: gemini-2.5-pro,    thinking: high }
  controller:        { provider: openai,    model: gpt-5-nano }
  master_review:     { provider: anthropic, model: claude-opus-4-5,   thinking: high }
  review:
    security:        { provider: google,    model: gemini-2.5-flash,  thinking: medium }
    quality:         { provider: openai,    model: gpt-5 }
    correctness:     { provider: anthropic, model: claude-haiku-4-5,  thinking: low }
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

The model ids are pi catalog ids; write the ids the project's providers actually offer (`pi --list-models`), never ids copied from this example.

The harness (pi, Claude Code) is **not** a contract field: governance is harness-neutral, and the same file must run on either. See `operations.md`, "Harness selection".

## models

| Role | Purpose | Notes |
|---|---|---|
| `research` | Gathers context before implementation | Runs once per issue, not per attempt; read-only tools |
| `implement` | Writes the code | The main cost driver |
| `implement_master` | Escalated implementation | Must differ from `implement` — a different blind spot is the point |
| `controller` | Aggregates reviewer JSON, proposes a verdict | Weak model is fine; it does not decide |
| `master_review` | Final decision | Runs on every attempt; should differ from `implement_master` |
| `review.*` | Independent reviewers | Span ≥2 vendors (see OpenRouter below) |
| `constraints.no_self_review` | Drops a reviewer whose model implemented the diff | Default `true`. Enforced over `provider/model` refs at run time; two unmapped roles carry no ref to compare, so map at least two `review.*` roles |

`provider` and `model` are opaque strings passed through to the harness. `thinking` is optional per role (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) and launches as pi's `--model provider/model:thinking`. Identity for `no_self_review` and for `implement` vs `implement_master` is `provider/model` only; a different thinking level is not a different model, and neither is an aggregator route (below). pi clamps a level the model does not expose to the next higher supported level, silently; the log records the level requested. Claude Code ignores the level.

### OpenRouter and other routes to the same model

With only an OpenRouter key, write the route explicitly: `{ provider: openrouter, model: google/gemini-2.5-flash }`. pi launches exactly that ref. For comparison the engine reads the vendor behind the route: `openrouter/google/gemini-2.5-flash` is Google's model, so a panel of `openrouter/google/…`, `openrouter/openai/…` and `openrouter/anthropic/…` spans three providers, and `openrouter/google/x` and `google/x` are one model for `no_self_review` and escalation. Three reviewers behind OpenRouter from a single vendor are still refused as a single provider. Prefer the explicit `openrouter` provider over a bare vendor prefix: with no native key pi also resolves `google/gemini-2.5-flash` through OpenRouter, but the same file silently switches to Google directly on a machine that has a Google key.

## budgets

`max_attempts_*` are per issue and start at zero for every child of a split. `max_runs_per_tree` is held at the root and consumed across every descendant; it never resets. `max_split_depth` caps how deep a split may go (default 1; above 1 needs `PIPELINE_ALLOW_DEEP_SPLIT=1`). Every budget field must be an integer: `max_attempts_*` and `max_runs_per_tree` ≥ 1; `max_split_depth` ≥ 0.

`state init` freezes `max_runs_per_tree` into the state file at tree creation. Later edits to `budgets` do not change an existing tree. To raise the ceiling for a running tree: `node <package>/lib/governance.mjs state budget .pipeline <root_id> --set <n>`, from the project root.

Sizing note: at split degree 4 and depth 1 the loop reaches `3 + 4 × 6 = 27` implementation runs at roughly six model calls each. The default of 25 is deliberately below that, so a pathological issue is stopped rather than fully explored.

## review

Any finding at a blocking severity rejects the attempt. Findings at follow-up severities are recorded in the gate JSON, fed back on retry, and appended to `MEMORY.md` when the issue is approved. Severity is normalised with trim + lower-case. A finding whose severity is not `critical`, `high`, `medium`, `low` is **blocking** (`unknown_severity`); a known severity that appears in neither list also blocks (`unlisted_severity`), and the validator refuses such a pair of lists up front. Both lists may be written inline (`[critical, high]`) or as a block sequence.

Approval creates no tickets. It appends the accepted follow-ups to `MEMORY.md` as `## Follow-ups — <id> (<date>)`, because `gate.json` lives under the gitignored `.pipeline/`. Triage them into the project's backlog by hand. This applies to file and command issue sources alike.

## issues

Where open issues come from. Required in v2.

| Form | Meaning |
|---|---|
| `source: tasks.md` | A checkbox file: `- [ ] <id>: <title>` per open issue, `- [x]` when done. Children of a split are indented under their parent (`  - [ ] <id>.1: …`). The pipeline marks issues done and creates children here |
| `source: { command: "…", trust: external }` | A command whose stdout lists `id: title` lines. It cannot create children, so a split becomes a reject. `trust: external` (the default for commands) makes a real run ask for confirmation, because the issue text is foreign input to every prompt; `trust: internal` skips that |
| `source: "!command"` | Command shorthand, also accepted inside the contract. Always external; the same startup confirmation applies. Use the map form to declare internal trust |

`ISSUE_SOURCE` in the environment (a file, or `!command`) overrides the contract for one run.

## gates

The deterministic checks that run after every implementation and before any model-based review, in order. Required in v2: list them, or write `gates: []` to run without one on purpose (a warning at every start). A gate is `{ name, run }`; `name` is a short identifier that labels the log and the feedback block, `run` a shell command. A failing gate feeds its output back into the next implement prompt and costs the attempt without spending a review cycle. Fold clean-code checks (complexity, duplication) in as further gates; there is no separate slot. `LINT_CMD` / `TEST_CMD` in the environment replace the list for one run.

The shorthand `gates: { lint: "npm run lint", test: "npm test" }` is also accepted and normalized to the ordered list of `{ name, run }` entries. Generate the list form for consistency; do not reject an existing valid map during an audit.

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
- a known field with the wrong type: a role that is a scalar instead of `{ provider, model }`, `models`, `models.review`, `budgets` or `review` that is not a map, `no_self_review` that is not an unquoted `true` / `false`. Explicit `null` and empty YAML values in these fields are errors; only a missing key receives the default.
- a mapped role without `model` (`implement: { provider: a }` would otherwise run the default model in silence); a `model` or `provider` that is not a non-empty string (a nested map or an unquoted number would otherwise route to `provider/[object Object]`)
- `implement_master` identical to `implement` (compared without `thinking`)
- exactly one vendor across mapped `review.*` roles (the vendor behind an `openrouter/<vendor>/<model>` route); exactly one mapped `review.*` role ("only one models.review.* role is mapped"); a mapped `review.*` role without `provider`
- severity lists that do not together cover `critical`, `high`, `medium`, `low`; an unknown severity; a list that is not a list
- `max_runs_per_tree` below `max_attempts_controller + max_attempts_master`; a budget field that is not an integer in range; `max_split_depth` above 1 without `PIPELINE_ALLOW_DEEP_SPLIT=1`
- a `thinking` value that is not one of pi's levels
- an explicit `constraints.no_self_review: true` with fewer than two mapped `review.*` roles
- v2 without `issues.source` or without `gates`; `gates` entries without a valid `name` or `run`, or with a duplicate `name`; an `issues.source` that is neither a path nor a `{ command }` map, or a `trust` other than `external` / `internal`
- a file that looks like a contract when no fenced YAML block parsed

Contract validation sees only the YAML block. A marker in the prose of `AGENTS.md`, in `SOUL.md`, `MEMORY.md` or a harness copy is caught separately: `doctor` reports it as FAIL with file and line, a real run refuses to start, a dry-run notes it.

It warns (never refuses) on unknown keys at every map, on `master_review` equal to `implement_master`, on a `review.*` model equal to an implementer under `no_self_review`, on a panel that would shrink below two reviewers on the escalated path, on overlapping severity lists (blocking wins), on a `models:` block that maps no role, on an `issues.source` path outside the repository (it would not be committed with approved work), and on `gates: []`.
