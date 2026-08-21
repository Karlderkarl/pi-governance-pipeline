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
  research:          { provider: X, model: mid }
  implement:         { provider: X, model: strong }
  implement_master:  { provider: Y, model: frontier }
  controller:        { provider: X, model: small }
  master_review:     { provider: Y, model: frontier }
  review:
    security:        { provider: Y, model: mid }
    quality:         { provider: Z, model: mid }
    correctness:     { provider: X, model: mid }
  constraints:
    no_self_review: true
```

| Role | Purpose | Notes |
|---|---|---|
| `research` | Gathers context before implementation | Runs once per issue, not per attempt |
| `implement` | Writes the code | The main cost driver |
| `implement_master` | Escalated implementation | Must differ from `implement` — a different blind spot is the point |
| `controller` | Aggregates reviewer JSON, proposes a verdict | Weak model is fine; it does not decide |
| `master_review` | Final decision | Runs on every attempt |
| `review.*` | Independent reviewers | Span ≥2 providers |
| `constraints.no_self_review` | Drops a reviewer whose model implemented the diff | Default `true` |

`provider` and `model` are opaque strings passed through to the model flag. This skill does not validate them against a catalogue; an unknown model surfaces as a launch failure with the offending role named.

## budgets

```yaml
budgets:
  max_attempts_controller: 3
  max_attempts_master: 3
  max_runs_per_tree: 25
  max_split_depth: 1
```

`max_attempts_*` are per issue and reset on split. `max_runs_per_tree` is held at the root and consumed across every descendant; it never resets. `max_split_depth: 1` caps the branching — without it, budget alone loses to exponential growth.

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
| `review:` sub-map under `models:` | All three reviewers use the default model; `no_self_review` still applies |
| `constraints.no_self_review` | Treated as `true` |
| whole `budgets:` block | Defaults above apply |
| a single budget field | That field's default applies |
| `review:` gating block | Defaults above apply |

A pipeline generated from governance with none of these blocks must be functionally identical to a pre-contract pipeline. This is the backward-compatibility test.

## Validation

`automate` validates at generation time, not at run time, and fails loudly on:

- `implement_master` identical to `implement` — escalation would be pointless
- fewer than two distinct providers across `review.*` — correlated reviewers
- `max_runs_per_tree` lower than `max_attempts_controller + max_attempts_master` — no issue could ever finish
- `max_split_depth` above 1 without an explicit override in the PRD

Each failure names the offending field and the governance file it came from.
