# pi-governance-pipeline

A pi package that turns a PRD into project governance, and that governance into an
issue-driven auto-develop pipeline: one deliberately chosen model per step,
independent multi-model review, severity-based gating, and a hard run budget.

```
PRD ──▶ govern ──▶ SOUL.md · AGENTS.md · SYSTEM.md · MEMORY.md
                              │
                              ▼
                        automate ──▶ auto-develop.sh
```

## Why

A single model implementing and reviewing its own code shares its own blind spots,
runs research and final approval on the same expensive model, and retries a hard
ticket without a ceiling. This package separates the three concerns:

- **Routing** — every step is its own `pi -p` process, and the script picks the model
  from the mapping in `AGENTS.md`. Changing the mapping changes the routing; the
  script is never touched.
- **Review** — three reviewers in three processes, spanning at least two providers,
  none of them seeing another's verdict. A model that implemented a diff never
  reviews it. Gating is by severity, not by vote count.
- **Budget** — counters and budget live in `.pipeline/state/<root_id>.json`, never in
  a model context. Attempts are a quality signal per issue; the tree budget is a
  resource limit that never resets.

## Install

```bash
pi install npm:pi-governance-pipeline@1.0.1
# or, pinned to the git tag
pi install git:github.com/Karlderkarl/pi-governance-pipeline@v1.0.1
# try it for one run, without installing
pi -e npm:pi-governance-pipeline@1.0.1
```

Both specs are pinned on purpose. `pi update --extensions` and `pi update --all` do not move a
pinned version or tag; they only reconcile the checkout to the ref you asked for. Move deliberately:

```bash
pi install npm:pi-governance-pipeline@1.1.0
pi install git:github.com/Karlderkarl/pi-governance-pipeline@v1.1.0
```

Drop the `@version` if you would rather track the latest release.

The contract in `AGENTS.md` carries its own version (`contract v1`), independent of the package
version. A package release that changes what a contract field means bumps both.

## Use

| Command | Effect |
|---|---|
| `/govern [path-to-PRD]` | Generate or audit `SOUL.md`, `AGENTS.md`, `SYSTEM.md`, `MEMORY.md` |
| `/automate` | Generate or re-sync `auto-develop.sh` from that governance |
| `/pipeline-audit` | Check an existing pipeline against the contract and the invariants |
| `/pipeline-status` | Show counters, tree budget, and per-issue state |
| `/skill:governance-pipeline` | Load the skill directly |

The agent also loads the skill on its own when you mention a PRD, governance files,
`AGENTS.md`, multi-model review, or an auto-develop pipeline.

Typical first run:

```bash
pi
> /govern docs/PRD.md      # writes governance, asks about anything unresolved
> /automate                # generates the pipeline, validates the contract
> !./auto-develop.sh --dry-run
```

## What is in the package

```
skills/governance-pipeline/
  SKILL.md                     two modes: govern and automate
  references/contract.md       versioned interface between the modes
  references/governance-files.md
  references/pipeline-template.md
  references/prompt-builders.md  per-role prompts and the reviewer JSON schema
  assets/auto-develop.sh       reference pipeline (adapt 3 variables)
  assets/lib/governance.mjs    contract parser, validator, state store
  assets/lib/gate.mjs          severity gate over reviewer JSON
extensions/pipeline-guard.ts   privileged-command gate, pipeline_state tool
prompts/                       /govern, /automate, /pipeline-audit
docs/PRD-harness.md            the PRD this package was generated from
```

## The contract

`AGENTS.md` carries one fenced YAML block. Every field is optional; absence is a
documented state, and governance without any of these blocks runs every role on the
default model.

```yaml
models:
  research:          { provider: openai,    model: gpt-5-mini }
  implement:         { provider: anthropic, model: sonnet-4.5 }
  implement_master:  { provider: google,    model: gemini-3-pro }
  controller:        { provider: openai,    model: gpt-5-nano }
  master_review:     { provider: google,    model: gemini-3-pro }
  review:
    security:        { provider: google,    model: gemini-3-flash }
    quality:         { provider: openai,    model: gpt-5 }
    correctness:     { provider: anthropic, model: haiku-4.5 }
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
```

Validation runs at generation time, not at run time, and refuses:
`implement_master` equal to `implement`, reviewers on a single provider, a tree budget
below the attempt sum, and a split depth above 1 without a deliberate override.
See `references/contract.md`.

## Safety

pi has no permission dialog, and `pi -p` has no UI to ask with. The package handles
that in two places, not one:

- The generated script confirms `--unattended` and `--auto-merge` **before** the loop
  starts, and refuses a non-interactive stdin unless `--yes` is passed.
- `pipeline-guard` blocks privileged bash commands and governance rewrites in a
  session. Without a UI it blocks rather than asks — a privileged step must not
  proceed just because nobody could answer.

| Variable | Effect |
|---|---|
| `PIPELINE_GUARD=off` | Disables the extension's gating |
| `PIPELINE_UNATTENDED=1` | Allows privileged commands without a prompt |
| `PIPELINE_ALLOW_GOVERNANCE_WRITE=1` | Allows the govern step to write governance non-interactively |
| `PIPELINE_ALLOW_DEEP_SPLIT=1` | Accepts `max_split_depth > 1` |

## License

MIT
