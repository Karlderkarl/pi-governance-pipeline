# Governance Contract v1

The versioned interface between the two modes. `govern` writes these fields; `automate` reads them. Change the version when a field's meaning changes.

## Contents

- [Reading rules](#reading-rules)
- [models](#models)
- [budgets](#budgets)
- [review](#review)
- [Absent-field behaviour](#absent-field-behaviour)
- [Validation](#validation)

## Reading rules

- All fields live in `AGENTS.md`, in a fenced YAML block.
- Every field is optional. Absence is a documented state, never an error.
- `automate` reads; it must never write to governance. Only `govern` writes.
- Unknown fields are ignored, not rejected — forward compatibility for v2.

## models

```yaml
models:
  research:          { provider: X, model: mid, thinking: low }
  implement:         { provider: X, model: strong, thinking: high }
  implement_master:  { provider: Y, model: frontier, thinking: high }
  controller:        { provider: X, model: small }
  master_review:     { provider: Z, model: frontier, thinking: high }
  review:
    security:        { provider: Y, model: mid, thinking: medium }
    quality:         { provider: Z, model: mid }
    correctness:     { provider: X, model: mid, thinking: low }
  constraints:
    no_self_review: true
```

| Role | Purpose | Notes |
|---|---|---|
| `research` | Gathers context before implementation | Runs once per issue, not per attempt |
| `implement` | Writes the code | The main cost driver |
| `implement_master` | Escalated implementation | Must differ from `implement` — a different blind spot is the point |
| `controller` | Aggregates reviewer JSON, proposes a verdict | Weak model is fine; it does not decide |
| `master_review` | Final decision | Runs on every attempt; should differ from `implement_master` — the escalated model must not review its own work |
| `review.*` | Independent reviewers | Span ≥2 providers |
| `constraints.no_self_review` | Drops a reviewer whose model implemented the diff | Default `true`. Enforced at run time. A collision where both sides resolve to `default` cannot be detected — map at least the implement roles |

`provider` and `model` are opaque strings passed through to the model flag. This skill does not validate them against a catalogue; an unknown model surfaces as a launch failure with the offending role named.

`thinking` is optional per role. Allowed values are pi's thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. When set, the pipeline launches that role as `--model provider/model:thinking` (pi's documented shorthand). When omitted, pi resolves the level itself: `modelThinkingLevels["provider/id"]` from settings first, then `defaultThinkingLevel`, then pi's own built-in default, which is `medium` — a per-model entry in a user's settings therefore outranks the process default, and governance never sees it. Omitting `thinking` is not the same as writing `off`: with empty settings the role runs at `medium` on any model that supports it, so a mapped role without a level is a thinking role, not a cheap one. The same `provider`/`model` pair may appear on two roles with different `thinking` — YAML role keys stay unique, so you cannot list one role twice. Identity for `no_self_review` and for `implement` vs `implement_master` is `provider/model` only. Thinking is a launch parameter, not a different model: `sonnet-4.5` at `high` and `sonnet-4.5` at `low` still collide.

Validation checks the spelling of the level, not whether the model offers it. pi clamps a level a model does not expose to the nearest one it does — a model without reasoning support runs everything at `off`, and `xhigh`/`max` exist only where the model's own level map declares them. The clamp is silent, and the run log records the level that was *requested*. Treat a level as an instruction to pi, not as a guarantee about the model.

## budgets

```yaml
budgets:
  max_attempts_controller: 3
  max_attempts_master: 3
  max_runs_per_tree: 25
  max_split_depth: 1
```

`max_attempts_*` are per issue and reset on split. `max_runs_per_tree` is held at the root and consumed across every descendant; it never resets. `max_split_depth: 1` caps the branching — without it, budget alone loses to exponential growth. The bundled reference script blocks instead of splitting; the field still constrains generators that implement splitting.

Sizing note: at split degree 4 and depth 1 the loop reaches `3 + 4 × 6 = 27` implementation runs at roughly six model calls each. The default of 25 is deliberately below that, so a pathological issue is stopped rather than fully explored.

## review

```yaml
review:
  blocking_severities: [critical, high]
  followup_severities: [medium, low]
```

Any finding at a blocking severity rejects the attempt. Findings at follow-up severities become tickets and do not block. There is no vote count and no percentage — see the reviewer schema in `prompt-builders.md`.

## Absent-field behaviour

| Absent | Behaviour |
|---|---|
| whole `models:` block | Every role runs the default model; log a warning once at pipeline start |
| a single role under `models:` | That role falls back to the default model |
| `thinking` on a role | pi resolves the level: per-model setting, then `defaultThinkingLevel`, then its built-in default (`medium`) |
| `thinking` without `model` | Warning; thinking is ignored — the role runs the default model at pi's own level |
| a level the model does not expose | pi clamps to the nearest supported level, silently; the log still shows the requested one |
| `review:` sub-map under `models:` | All three reviewers use the default model; `no_self_review` still applies |
| `constraints.no_self_review` | Treated as `true` |
| whole `budgets:` block | Defaults above apply |
| a single budget field | That field's default applies |
| `review:` gating block | Defaults above apply |

A pipeline generated from governance with none of these blocks must be functionally identical to a pre-contract pipeline. This is the backward-compatibility test.

## Validation

`automate` validates at generation time and fails loudly on:

- `implement_master` identical to `implement` — escalation would be pointless (compared without `thinking`)
- fewer than two distinct providers across `review.*` — correlated reviewers
- `max_runs_per_tree` lower than `max_attempts_controller + max_attempts_master` — no issue could ever finish
- `max_split_depth` above 1 without an explicit override in the PRD
- a `thinking` value that is not one of pi's levels

Each failure names the offending field and the governance file it came from. The reference script also runs this validator at startup (`governance.mjs config`, exit 2), so an invalid contract cannot reach the loop even if generation was skipped. `max_split_depth` is validated even though the bundled script never splits — generators that implement splitting must still honor the field.

Validation also emits **warnings** (non-blocking) for configurations that are legal but defeat the design: `master_review` equal to `implement_master` (the escalated model would review its own work), a `review.*` model equal to `implement` under `no_self_review` (it is dropped at run time, leaving fewer reviewers), and any configuration where two or more `review.*` models equal the same implementation model — `no_self_review` would leave fewer than two reviewers on that path, and the runtime gate blocks below that floor instead of approving.
