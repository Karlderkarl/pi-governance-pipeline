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
pi install npm:pi-governance-pipeline@1.0.17
# or, pinned to the git tag
pi install git:github.com/Karlderkarl/pi-governance-pipeline@v1.0.17
# try it for one run, without installing
pi -e npm:pi-governance-pipeline@1.0.17
```

Both specs are pinned on purpose. `pi update --extensions` and `pi update --all` do not move a
pinned version or tag; they only reconcile the checkout to the ref you asked for. Move deliberately:

```bash
pi install npm:pi-governance-pipeline@<version>          # e.g. @1.0.17
pi install git:github.com/Karlderkarl/pi-governance-pipeline@v<version>
```

Drop the `@version` if you would rather track the latest release.

Install **user-scoped** (the default). A project-local install (`-l`) loads `pipeline-guard` in
the pipeline's child `pi -p` processes only after a saved trust decision (`/trust`) or `--approve`.
Without either, `defaultProjectTrust` (default `ask`) ignores project extensions in non-interactive
modes, and nothing in the output says the guard is absent. The reference script passes `--approve`
to those children **only after** the startup safety gate (`--unattended` / `--auto-merge`). That
flag trusts *all* project-local resources (`.pi/settings.json`, extensions, skills, prompts,
`SYSTEM.md` / `APPEND_SYSTEM.md`), not only the guard. A plain `./auto-develop.sh` does not pass it.

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
> !grep -qxF '.pipeline/' .gitignore 2>/dev/null || echo '.pipeline/' >> .gitignore
> !git add -A && git commit -qm "governance + pipeline"   # a real run needs a HEAD
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
next higher supported level (falling back downward only when none exists above),
silently, and omitting it leaves the choice to pi's own settings. `thinking: low`
on a model that only exposes `off` and `high` therefore runs at `high`.

Validation runs at generation time, and the reference script also runs it at
startup (`governance.mjs config`, exit 2), so an invalid contract cannot reach
the loop. It refuses:
`implement_master` equal to `implement`, reviewers on a single provider or only one
mapped reviewer, severity lists that do not together cover all four severities, a tree budget
below the attempt sum, a split depth above 1 without a deliberate override, an
unknown `thinking` value, and `constraints.no_self_review: true` written explicitly
while fewer than two `review.*` roles are mapped (a `default`/`default` collision
cannot be proven, so the panel would be one model reviewing itself). The defaulted
`true` path — no `models:` block — still runs, and warns that `no_self_review` cannot
fire. See `references/contract.md`.

## Safety

pi has no permission dialog, and `pi -p` has no UI to ask with. The package handles
that in two places, not one:

- The generated script confirms `--unattended` and `--auto-merge` **before** the loop
  starts, and refuses a non-interactive stdin unless `--yes` is passed.
  `--auto-merge` is a stub in the reference script: the flag is parsed and the
  gate asks, but nothing is merged — adapt that step in a generated pipeline.
  Approved work is committed (the reviewed paths plus the issue source) before
  the next issue starts, so no issue reviews another's diff and a later
  `take_over` cannot stash approved work away. `COMMIT_APPROVED=0` disables the
  commit; the run then stops after the first approval instead.
- `pipeline-guard` is a speed bump against an agent reaching for a destructive
  command by accident in an interactive session, **not a sandbox**. It pattern-
  matches the command string; `rm -rf "$HOME"`, `eval`, `bash -c`, and runtime-
  constructed commands are not a boundary. The script's own `ISSUE_SOURCE=!command`,
  `LINT_CMD`, and `TEST_CMD` run through `eval` and are env-overridable — whoever
  sets the run's environment has code execution, with or without the guard.
  `LINT_CMD` and `TEST_CMD` also ship **empty**: an unadapted script runs no
  deterministic gate at all and model review is the only check. The script warns
  once at start and records `gates` in every JSONL log event, but adapting them
  is the operator's job. The governance-write gate covers the
  `write` and `edit` tools plus obvious bash and PowerShell write paths (`sed -i`,
  `tee`, `Set-Content`, redirections, `mv`/`cp`/`rm`) that name a governance file —
  not every way to rewrite `AGENTS.md`. `--exclude-tools bash,powershell` or a
  container is the only real boundary. Run the pipeline in a container or VM when
  you need isolation.
  Without a UI it blocks rather than asks.
- `--approve` on a child `pi -p` is much broader than the guard. pi's own trust
  prompt states what project trust grants: `.pi` settings and resources load,
  **missing project packages are installed, and project extensions execute**. An
  unattended loop against a repository you do not fully trust is therefore package
  installation plus code execution out of that repository, once per role per
  attempt. `review.*` roles are excluded and run with `--no-approve`: it keeps the
  trust-gated `.pi/APPEND_SYSTEM.md` from carrying panel size or the role-to-model
  mapping into a review, and it keeps a project extension from replacing the
  `read` / `grep` / `find` / `ls` tools the reviewers are limited to (pi lets an
  extension register a tool under a built-in name). The remaining roles need the
  project's own tooling and keep the flag. Containerize the run when the
  repository is not yours.
- Once the startup gate has passed, the script exports `PIPELINE_UNATTENDED=1`, so
  the child `pi -p` processes are not re-blocked by `pipeline-guard` for what a
  human already approved — except `sudo`, recursive `rm`, and force-push, which
  stay armed unless `PIPELINE_ALLOW_DESTRUCTIVE=1`. Governance writes stay gated
  even in an unattended run, under their own switch.

Multi-model review is a defence against correlated blind spots — three processes,
at least two providers, no shared verdict. It is not a defence against the object
under review. Issue text (`ISSUE_SOURCE=!gh issue list`, Jira) and the diff itself
are untrusted input: a diff that instructs the panel to return an empty findings
list passes three independent reviewers, clears the gate honestly, and the master
approves over a real pass. The prompts frame both explicitly as content to judge
rather than instructions, which is a mitigation, not a boundary.

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
| `DIFF_MAX_BYTES` | `65536` | Cap on the working-tree diff that enters reviewer prompts; truncation is per file, omitted paths are named in a manifest |
| `REVIEWERS_MAX_BYTES` | `65536` | Cap on concatenated reviewer JSON entering the controller and master prompts; larger input is truncated and says so |
| `EXCLUSIONS_MAX_LINES` | `200` | Cap on lint/test output re-entering the implement prompt; gate findings live separately and are never displaced |
| `MIN_REVIEWERS` | `2` | Below this many parseable reviewers the gate blocks instead of approving. Two consecutive attempts below the floor abort as a configuration error. A value that is not an integer ≥ 1 is fatal (`die`), not reset — unlike the byte caps above. `--help` still prints because the check runs after flag parsing. `gate.mjs --min-reviewers` likewise refuses anything that is not an integer ≥ 1 |
| `ROLE_TIMEOUT_SECONDS` | `0` | Cap around each `pi -p`. GNU `timeout`, else `gtimeout`, else unprotected. `0` disables. Exit 124 empties the outfile |
| `PROMPT_KEEP_RUNS` | `3` | Distinct run ids kept under `.pipeline/prompts/`; older files are deleted |
| `BLOCKER_HISTORY_MAX` | `5` | Last N `MEMORY.md` blocker entries fed into research and implement prompts |
| `BLOCKER_HISTORY_MAX_BYTES` | `16384` | Byte cap on that history; the newest text is kept |
| `COMMIT_APPROVED` | `1` | Commit the reviewed paths plus the issue source after an approval. `0` leaves the tree untouched and stops the run after the first approval, so the next issue never reviews it as its own diff |

## Releasing (maintainers)

Publish happens only from a pushed tag — never from a local machine. `tests/smoke.sh`
also runs on every push to `main` and every pull request (`.github/workflows/ci.yml`),
so a broken asset is caught before the tag. The release
workflow runs the same suite first and then publishes via npm Trusted Publishing
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
# if the tag push does not start the job (check Actions), publish that tag by hand:
gh workflow run release.yml -f tag=vX.Y.Z
```

A manual run must pass `tag`. The job checks that tag out and still refuses to
publish when it does not match `package.json`. Dispatching against `main` without
`tag` is rejected.

## License

MIT
