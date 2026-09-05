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

- All fields live in `AGENTS.md`, in a fenced YAML block (` ```yaml ` or ` ```yml `, optionally marked `pipeline-contract`). A `~~~` fence or an unclosed backtick fence does not parse.
- Mark the real block `yaml pipeline-contract`. If several YAML fences contain contract keys, the marked one is used; otherwise the first is used and a warning names how many were found.
- If the file contains `pipeline-contract` or a line matching `models:` / `budgets:` / `review:`, **but no fenced YAML block parsed**, that is a contract error (exit 2) — not silent defaults that would drop the configured budgets and models. A file with neither still takes the documented default path.
- Every field is optional. Absence is a documented state, never an error.
- `automate` reads; it must never write to governance. Only `govern` writes.
- Unknown fields are ignored, not rejected — forward compatibility for v2. They still produce a **warning** that names the key (`models.implement_msater`, `budgets.max_atempts_controller`, …) so a typo cannot vanish into the merged config unnoticed.

## models

```yaml pipeline-contract
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
| `constraints.no_self_review` | Drops a reviewer whose model implemented the diff | Default `true`. Enforced at run time, over `provider/model` refs. Two roles that are both unmapped resolve to the same default model, but neither carries a ref to compare, so the drop cannot fire on that pair — map at least two `review.*` roles, not just the implement roles |

`provider` and `model` are opaque strings passed through to the model flag. This skill does not validate them against a catalogue; an unknown model surfaces as a launch failure with the offending role named.

`thinking` is optional per role. Allowed values are pi's thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. When set, the pipeline launches that role as `--model provider/model:thinking` (pi's documented shorthand). When omitted, pi resolves the level from its own settings (`defaultThinkingLevel`, and any per-model pinning such as `--models` / `enabledModels` with a `provider/id:level` suffix); governance never sees it. Omitting `thinking` is not the same as writing `off`. The same `provider`/`model` pair may appear on two roles with different `thinking` — YAML role keys stay unique, so you cannot list one role twice. Identity for `no_self_review` and for `implement` vs `implement_master` is `provider/model` only. Thinking is a launch parameter, not a different model: `sonnet-4.5` at `high` and `sonnet-4.5` at `low` still collide.

Validation checks the spelling of the level, not whether the model offers it. pi clamps a level a model does not expose to the next **higher** supported level, and only falls back to a lower one when none exists above — so `thinking: low` on a model that only exposes `off` and `high` runs at `high`, not `off`. A model without reasoning support runs everything at `off`. `xhigh`/`max` exist only where the model's own level map declares them. The clamp is silent, and the run log records the level that was *requested*. Treat a level as an instruction to pi, not as a guarantee about the model.

## budgets

```yaml
budgets:
  max_attempts_controller: 3
  max_attempts_master: 3
  max_runs_per_tree: 25
  max_split_depth: 1
```

`max_attempts_*` are per issue and reset on split. `max_runs_per_tree` is held at the root and consumed across every descendant; it never resets. `max_split_depth: 1` caps the branching — without it, budget alone loses to exponential growth. The bundled reference script blocks instead of splitting; the field still constrains generators that implement splitting.

Every budget field must be an integer: `max_attempts_controller`, `max_attempts_master`, and `max_runs_per_tree` ≥ 1; `max_split_depth` ≥ 0. A typo such as `twenty` is a contract error, not "budget exhausted" at attempt 0.

`state init` freezes `max_runs_per_tree` into the state file at tree creation. Later edits to `budgets` in `AGENTS.md` do not change an existing tree, in either direction — a resource limit that resets when someone edits a file is not a limit. To raise the ceiling for a running tree, use `governance.mjs state budget <dir> <root_id> --set <n>` (n must be an integer ≥ 1 and ≥ `runs_used`). Do not hand-edit the JSON.

Sizing note: at split degree 4 and depth 1 the loop reaches `3 + 4 × 6 = 27` implementation runs at roughly six model calls each. The default of 25 is deliberately below that, so a pathological issue is stopped rather than fully explored.

## review

```yaml
review:
  blocking_severities: [critical, high]
  followup_severities: [medium, low]
```

Any finding at a blocking severity rejects the attempt. Findings at follow-up severities become tickets and do not block. There is no vote count and no percentage — see the reviewer schema in `prompt-builders.md`.

Severity is normalised with trim + lower-case before comparison. A finding whose normalised severity is not `critical`, `high`, `medium`, or `low` is treated as **blocking** (fail-closed) and listed under `unknown_severity` in the gate JSON — reviewers are language models, and a trailing space or a synonym like `blocker` must not clear the gate. A known severity that appears in neither list also blocks and is listed under `unlisted_severity`; the validator refuses such a pair of lists up front.

Both lists must be flow-style arrays of known severities (`critical`, `high`, `medium`, `low`), e.g. `[critical, high]`. A YAML block sequence (`- critical`) is a contract error: the subset parser would otherwise treat it as an empty map and crash later.

## Absent-field behaviour

| Absent | Behaviour |
|---|---|
| whole `models:` block | Every role runs the default model; log a warning once at pipeline start |
| a single role under `models:` | That role falls back to the default model |
| `thinking` on a role | pi resolves the level from its own settings; governance never sees it |
| `thinking` without `model` | Warning; thinking is ignored — the role runs the default model at pi's own level |
| a level the model does not expose | pi clamps to the next higher supported level (falling back downward only when none exists above), silently; the log still shows the requested one |
| `review:` sub-map under `models:` | All three reviewers use the default model. `no_self_review` cannot fire against an unmapped `implement` (no refs to compare) and does not fire against a mapped one (`default` never equals `provider/model`), so the panel may be the implementer reviewing itself. Warning at generation time; error if `no_self_review` is written down explicitly |
| `constraints.no_self_review` | Treated as `true` |
| whole `budgets:` block | Defaults above apply |
| a single budget field | That field's default applies |
| `review:` gating block | Defaults above apply |

A pipeline generated from governance with none of these blocks must be functionally identical to a pre-contract pipeline. This is the backward-compatibility test, and it is why an absent `models.review` is a warning rather than an error: absence is a documented state (see [Reading rules](#reading-rules)), so it degrades loudly instead of refusing to run.

The one thing absence cannot do is buy a guarantee. `no_self_review` written into the file *is* a guarantee, and a configuration that cannot honour it is a contract error — not because the field is present, but because what it promises is not deliverable there. Absence keeps the default and gets a warning naming the consequence; presence gets an error. Both paths refuse to claim independence the panel does not have.

## Validation

`automate` validates at generation time and fails loudly on:

- `implement_master` identical to `implement` — escalation would be pointless (compared without `thinking`)
- exactly one provider across mapped `review.*` roles — correlated reviewers. Exactly one mapped `review.*` role is its own error ("only one models.review.* role is mapped"): the fix is a second reviewer, not a different provider. A mapped `review.*` role without `provider:` is also an error (the role is named): diversity and `no_self_review` cannot compare a model that has no provider. Zero mapped reviewers stay a warning, not this error
- `review.blocking_severities` and `review.followup_severities` that do not together cover `critical`, `high`, `medium`, `low` — a finding at an unlisted severity would be neither blocking nor a follow-up. Overlap between the two lists is a warning; blocking wins at the gate
- `max_runs_per_tree` lower than `max_attempts_controller + max_attempts_master` — no issue could ever finish
- a budget field that is not an integer in range (`max_attempts_*` and `max_runs_per_tree` ≥ 1, `max_split_depth` ≥ 0)
- `max_split_depth` above 1 without `PIPELINE_ALLOW_DEEP_SPLIT=1` (an env override, not a PRD field — generators that only read this contract would otherwise have no way to honour it)
- a `thinking` value that is not one of pi's levels
- `review.blocking_severities` or `review.followup_severities` that is not an array of known severities, or a YAML block sequence
- an explicit `constraints.no_self_review` with fewer than two mapped `review.*` roles — the field promises independence the panel cannot deliver
- a file that looks like a contract (`pipeline-contract`, or a `models:` / `budgets:` / `review:` line) when no fenced YAML block parsed

Each failure names the offending field and the governance file it came from. The reference script also runs this validator at startup (`governance.mjs config`, exit 2) **and** on every `state` command, so an invalid contract cannot reach the loop or freeze a garbage budget into a state file. `max_split_depth` is validated even though the bundled script never splits — generators that implement splitting must still honor the field. Warnings from those `state` calls are printed once per pipeline directory (fingerprint under `.pipeline/.contract-warning-fingerprint`); errors stay loud every time.

Validation also warns (never refuses) on **unknown contract keys** at every map (`models.*`, `models.review.*`, `models.constraints.*`, `budgets.*`, `review.*`, top-level). Unknown keys stay ignored so a v2 field remains forward-compatible; the warning is what stops `implement_msater` from shipping as a junk field.

Validation also emits **warnings** (non-blocking) for configurations that are legal but defeat the design: `master_review` equal to `implement_master` (the escalated model would review its own work), a `review.*` model equal to `implement` under `no_self_review` (it is dropped at run time, leaving fewer reviewers), and any configuration where two or more `review.*` models equal the same implementation model. That last case is recoverable only by escalating: `no_self_review` leaves fewer than two reviewers on that path, so the runtime gate blocks **every** attempt on it and the matching attempt budget is spent with no chance of approval.

Fewer than two mapped `review.*` roles under a defaulted `no_self_review` is the remaining warning. The generated script also reports it per issue — on stderr once, and in the run log as `independence-unverified` — and states it in the master's prompt, so the deciding role never reads three reviewer files as three independent opinions when they may be one.
