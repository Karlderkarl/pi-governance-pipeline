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
  reviews it. Gating is by severity, not by vote count — and if self-review drops
  and lost outputs shrink the panel below two reviewers, the gate blocks instead
  of approving.
- **Budget** — counters and budget live in `.pipeline/state/<root_id>.json`, never in
  a model context. Attempts are a quality signal per issue; the tree budget is a
  resource limit that never resets. One attempt is six model invocations
  (implement, three reviewers, controller, master; research is cached per issue),
  so the default `max_runs_per_tree: 25` is a ceiling of ~150 calls, not a
  spending cap.

## Install

```bash
pi install npm:pi-governance-pipeline@1.0.10
# or, pinned to the git tag
pi install git:github.com/Karlderkarl/pi-governance-pipeline@v1.0.10
# try it for one run, without installing
pi -e npm:pi-governance-pipeline@1.0.10
```

Both specs are pinned on purpose. `pi update --extensions` and `pi update --all` do not move a
pinned version or tag; they only reconcile the checkout to the ref you asked for. Move deliberately:

```bash
pi install npm:pi-governance-pipeline@<version>          # e.g. @1.0.10
pi install git:github.com/Karlderkarl/pi-governance-pipeline@v<version>
```

Drop the `@version` if you would rather track the latest release.

Install **user-scoped** (the default). A project-local install (`-l`) loads `pipeline-guard` in
the pipeline's child `pi -p` processes only after a saved trust decision (`/trust`) or `--approve`.
Without either, `defaultProjectTrust` (default `ask`) ignores project extensions in non-interactive
modes, and nothing in the output says the guard is absent. The reference script passes `--approve`
to those children so a project-local guard still loads once you have started the pipeline.

The contract in `AGENTS.md` carries its own version (`contract v1`), independent of the package
version. A package release that changes what a contract field means bumps both.

## Use

| Command | Effect |
|---|---|
| `/govern [path-to-PRD]` | Generate or audit `SOUL.md`, `AGENTS.md`, `SYSTEM.md`, `MEMORY.md` (and copy `SYSTEM.md` to `.pi/APPEND_SYSTEM.md`) |
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
  assets/auto-develop.sh       reference pipeline (ISSUE_SOURCE, LINT_CMD, TEST_CMD)
  assets/lib/governance.mjs    contract parser, validator, state store
  assets/lib/gate.mjs          severity gate over reviewer JSON
extensions/pipeline-guard.ts   privileged-command gate, pipeline_state tool
prompts/                       /govern, /automate, /pipeline-audit
docs/PRD-harness.md            (repository only, not packed) — the PRD this package was generated from
```

## The contract

`AGENTS.md` carries one fenced YAML block. Every field is optional; absence is a
documented state, and governance without any of these blocks runs every role on the
default model.

```yaml
models:
  research:          { provider: openai,    model: gpt-5-mini, thinking: low }
  implement:         { provider: anthropic, model: sonnet-4.5, thinking: high }
  implement_master:  { provider: google,    model: gemini-3-pro, thinking: high }
  controller:        { provider: openai,    model: gpt-5-nano }
  master_review:     { provider: anthropic, model: opus-4.5, thinking: high }
  review:
    security:        { provider: google,    model: gemini-3-flash, thinking: medium }
    quality:         { provider: openai,    model: gpt-5 }
    correctness:     { provider: anthropic, model: haiku-4.5, thinking: low }
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

`thinking` is optional per role (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`,
`max`) and launches as pi's `--model provider/id:thinking` shorthand. The same model
may appear on two roles with different thinking; identity for `no_self_review` and
for `implement` vs `implement_master` still ignores the level. The level is checked
for spelling, not for support: pi clamps a level a model does not expose to the
nearest one it does, silently, and omitting it leaves the choice to pi's own
settings.

Validation runs at generation time, and the reference script also runs it at
startup (`governance.mjs config`, exit 2), so an invalid contract cannot reach
the loop. It refuses:
`implement_master` equal to `implement`, reviewers on a single provider, a tree budget
below the attempt sum, a split depth above 1 without a deliberate override, and an
unknown `thinking` value. See `references/contract.md`.

## Safety

pi has no permission dialog, and `pi -p` has no UI to ask with. The package handles
that in two places, not one:

- The generated script confirms `--unattended` and `--auto-merge` **before** the loop
  starts, and refuses a non-interactive stdin unless `--yes` is passed.
  `--auto-merge` is a stub in the reference script: the flag is parsed and the
  gate asks, but nothing is merged — adapt that step in a generated pipeline.
- `pipeline-guard` is a speed bump against an agent reaching for a destructive
  command by accident in an interactive session, **not a sandbox**. It pattern-
  matches the command string; `rm -rf "$HOME"`, `eval`, `bash -c`, and runtime-
  constructed commands are not a boundary. The governance-write gate covers the
  `write` and `edit` tools plus obvious bash write paths (`sed -i`, `tee`,
  redirections, `mv`/`cp`/`rm`) that name a governance file — not every way to
  rewrite `AGENTS.md`. `--exclude-tools bash` or a container is the only real
  boundary. Run the pipeline in a container or VM when you need isolation.
  Without a UI it blocks rather than asks.
- Once the startup gate has passed, the script exports `PIPELINE_UNATTENDED=1`, so
  the child `pi -p` processes are not re-blocked by `pipeline-guard` for what a
  human already approved — except `sudo`, recursive `rm`, and force-push, which
  stay armed unless `PIPELINE_ALLOW_DESTRUCTIVE=1`. Governance writes stay gated
  even in an unattended run, under their own switch.

| Variable | Effect |
|---|---|
| `PIPELINE_GUARD=off` | Disables the extension's gating |
| `PIPELINE_UNATTENDED=1` | Allows privileged commands without a prompt (not sudo / recursive delete / force-push) |
| `PIPELINE_ALLOW_DESTRUCTIVE=1` | Allows sudo, recursive delete, and force-push in non-interactive runs |
| `PIPELINE_ALLOW_GOVERNANCE_WRITE=1` | Allows the govern step to write governance non-interactively |
| `PIPELINE_ALLOW_DEEP_SPLIT=1` | Accepts `max_split_depth > 1` |

The generated script reads its own tuning variables; the defaults are safe and
rarely need changing:

| Variable | Default | Effect |
|---|---|---|
| `DIFF_MAX_BYTES` | `65536` | Cap on the working-tree diff that enters reviewer prompts; larger diffs are truncated and say so |
| `REVIEWERS_MAX_BYTES` | `65536` | Cap on concatenated reviewer JSON entering the controller and master prompts; larger input is truncated and say so |
| `EXCLUSIONS_MAX_LINES` | `200` | Cap on prior findings re-entering the implement prompt; the newest blocks survive, the oldest are omitted |
| `MIN_REVIEWERS` | `2` | Below this many parseable reviewers the gate blocks instead of approving |

## Releasing (maintainers)

Publish happens only from a pushed tag — never from a local machine. The release
workflow runs `tests/smoke.sh` first and then publishes via npm Trusted Publishing
(OIDC), which attaches a provenance attestation. Once the tarball is on the
registry, the same workflow creates the GitHub Release for the tag — from
`release-notes.md` at the repo root when you pre-seed curated notes there
(`### Fixed` / `### Added` / `### Changed` plus a compare link). The file must
name the tag being released — on the right side of the compare link or as a
heading — otherwise the workflow treats it as a leftover from the previous
release and generates notes from the commits instead. A local `npm publish`
bypasses both and puts a tarball on the registry that the chain never verified.

```bash
# bump version in package.json, update the install examples above,
# seed release-notes.md for the tag, commit, then:
git tag vX.Y.Z && git push origin vX.Y.Z
```

## License

MIT
