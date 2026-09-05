# pi-governance-pipeline

A pi package that turns a PRD into project governance, and runs an issue-driven
auto-develop pipeline from that governance: one deliberately chosen model per step,
independent multi-model review, severity-based gating, and a hard run budget.
The pipeline ships in the package. The skill configures it; nothing is copied.

```
PRD ──▶ govern ──▶ SOUL.md · AGENTS.md · SYSTEM.md · MEMORY.md
                              │
                              ▼
                      automate ──▶ pipeline init ──▶ auto-develop.sh ──▶ pipeline run
```

## Why

A single model implementing and reviewing its own code shares its own blind spots,
runs research and final approval on the same expensive model, and retries a hard
ticket without a ceiling. This package separates the three concerns:

- **Routing** — every step is its own harness process, and the engine picks the model
  from the mapping in `AGENTS.md`. Changing the mapping changes the routing; the
  engine is never touched. The harness (pi, or Claude Code for Anthropic roles) is
  chosen per provider, never by governance.
- **Review** — three reviewers in three processes, spanning at least two providers,
  none of them seeing another's verdict. A model that implemented a diff never
  reviews it. Gating is by severity, not by vote count — and if self-review drops
  and lost outputs shrink the panel below two reviewers, the gate blocks instead
  of approving.
- **Budget** — counters and budget live in `.pipeline/state/<root_id>.json`, never in
  a model context. Attempts are a quality signal per issue; the tree budget is a
  resource limit that never resets. One attempt is six model invocations
  (implement, three reviewers, controller, master; research is cached per issue),
  so 25 ordinary attempts already mean ~150 calls, plus research and reviewer
  retries. `max_runs_per_tree` caps implementation attempts, not spending.

## Install

```bash
pi install npm:pi-governance-pipeline@1.2.1
# or, pinned to the git tag
pi install git:github.com/Karlderkarl/pi-governance-pipeline@v1.2.1
# try it for one run, without installing
pi -e npm:pi-governance-pipeline@1.2.1
```

Both specs are pinned on purpose. `pi update --extensions` and `pi update --all` do not move a
pinned version or tag; they only reconcile the checkout to the ref you asked for. Move deliberately:

```bash
pi install npm:pi-governance-pipeline@<version>          # e.g. @1.2.1
pi install git:github.com/Karlderkarl/pi-governance-pipeline@v<version>
```

Install **user-scoped** (the default). A project-local install (`-l`) loads `pipeline-guard` in
implementer `pi -p` processes only after a saved trust decision (`/trust`) or `--approve`.
Research, reviewers and judges explicitly disable extensions and project trust;
see `skills/governance-pipeline/references/operations.md`, "Trust and project resources".

The project itself keeps a small wrapper, `auto-develop.sh`, that runs
`npx pi-governance-pipeline@<pin> run`. The pin is the package version `init` wrote;
`init --force` moves it, `init --local` points it at a checkout instead of npm.
The engine supports Node >=18; Pi has its own runtime requirement (Node >=22.19
for the tested Pi 0.85.1). Bash and git are required; use Git Bash on Windows.

## Use

| Command | Effect |
|---|---|
| `/govern [path-to-PRD]` | Generate or audit `SOUL.md`, `AGENTS.md`, `SYSTEM.md`, `MEMORY.md` (and `.pi/APPEND_SYSTEM.md`; `CLAUDE.md` when Claude Code runs a role) |
| `/automate [--harness <spec>] [--local] [--force]` | Validate first, then set up wrapper, `.gitignore` and issue file; dry-run the pipeline |
| `/pipeline-audit` | `pipeline doctor` and `status`, plus a read-only project-readiness checklist |
| `/pipeline-status` | Counters, tree budget, per-issue state (extension command) |
| `/skill:governance-pipeline` | Load the skill directly |

The skill can also be selected when you ask to generate or audit governance from a PRD,
or to set up, run or audit the pipeline. A repository containing `AGENTS.md` alone is
not a reason to load it. Slash prompts select a mode and pass arguments; the skill
holds the workflow rules. It loads only the references needed for that mode.
Routine audits use a short checklist; the full engine invariants are a lookup
reference for unresolved behavior questions.

Typical first run:

```bash
pi
> /govern docs/PRD.md      # writes governance, asks about anything unresolved
> /automate                # init + dry-run: routing and prompts, no model calls
> !git add -A && git commit -qm "governance + pipeline"   # a real run needs a HEAD
> !./auto-develop.sh --issue issue-1
```

Options can be combined: `/automate --harness anthropic=claude-code --local` forwards
both options and the harness value to `init`. Use `--force` to replace an existing
wrapper. Missing `--harness` values are errors. `init` validates the options and
contract before changing setup files, and creates parent directories for an issue
source such as `backlog/tasks.md`.

The engine's own commands (`node <package>/bin/pipeline.mjs …`):

| Command | Effect |
|---|---|
| `run [--dry-run] [--issue id] [--unattended] [--yes] [--max-runs n] [--harness spec]` | The loop |
| `init [--harness spec] [--local] [--force]` | Validate options and contract; create wrapper, `.gitignore` entry and issue file with parent directories |
| `doctor` | PASS / WARN / FAIL per project check |
| `status [--json]` | Counters, tree budget, per-issue state |

## What is in the package

```
bin/pipeline.mjs               the CLI: run · init · doctor · status
lib/
  contract/                    YAML subset parser, contract v2 reader and validator
  state/                       counters and budget (the state file)
  issues/                      tasks.md and command sources, with split children
  harness/                     pi and Claude Code adapters, chosen per provider
  review/                      reviewer-output recovery, severity gate, master decision, findings prose
  diff/                        per-file review diff with manifest
  prompts/                     one template per role, assembled per attempt
  loop/                        the loop, commit, stash, blocker
  log/                         JSONL events, prompt pruning
  integrity/                   the one governance path list, snapshot check
  guard/                       the interactive guard's patterns
  governance.mjs, gate.mjs     1.0.x-compatible command-line facades
extensions/pipeline-guard.ts   interactive guard, /pipeline-status, pipeline_state tool
skills/governance-pipeline/
  SKILL.md                     three modes: govern, automate, audit
  references/audit.md          short, read-only project-readiness checklist
  references/contract.md       contract v2
  references/governance-files.md
  references/operations.md     flags, variables, layout, threat model
  references/invariants.md     INV-01 … INV-29, each with the test that pins it
prompts/                       /govern, /automate, /pipeline-audit
docs/                         repository only, not packed
  PRD-harness.md               the PRD this package answers
  prompt-builders.md           engine prompt design for maintainers
```

Maintainer reference: [engine prompt design](https://github.com/Karlderkarl/pi-governance-pipeline/blob/v1.2.1/docs/prompt-builders.md).
This repository-only document is not required to use the installed skill.

## The contract

`AGENTS.md` carries one fenced YAML block. Contract v2 puts everything the loop needs into
governance; a v1 file (no `contract_version`) keeps every v1 default and its environment
adaptation points. Full reference: `skills/governance-pipeline/references/contract.md`.

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
  source: tasks.md
gates:
  - { name: lint, run: "npm run lint" }
  - { name: test, run: "npm test" }
```

Validation runs in `init`, `doctor` and at the start of every run. Invalid contracts
exit 2 from `run`, or 1 from `init` and `doctor`. Validation refuses
an implementer that escalates to itself, reviewers on a single provider, severity lists
that do not cover all four severities, a tree budget below the attempt sum, a v2 contract
without `issues.source` or `gates`, and any field that still carries a decision marker
(`[USER DECISION REQUIRED]`) — that is how govern hands an open decision to a human
instead of running on a placeholder.

## Safety

**Only reviewed work is committed.** Approval commits the reviewed paths and the
issue source. Unrelated staged entries remain staged. Renames include both the old
and new paths, and filenames are handled literally. If an implementer moves HEAD,
the issue is blocked and the whole run stops before gates or review, even if some
edits remain uncommitted. The log records `head-moved`; commits and remaining edits
are preserved for inspection. Restore a reviewed baseline before starting another run.
If an approval commit fails, the run exits non-zero even on the last issue or
when closing a split parent. Approved work and checkbox changes remain available
for a manual commit; no further issue starts. A halt after a child leaves its
split parent open until the baseline is restored.

**Severity survives JSON recovery.** Across multiple reviewer JSON blocks, the
most severe usable findings win even if their verdict word is off-schema. A later
well-formed `approve` cannot erase a critical finding.

**Pi role isolation.** Research, reviewers and judges use `--no-approve -ne -ns -np`;
saved project trust cannot enable extensions for those roles. Explicit empty
`--system-prompt` and `--append-system-prompt` options select Pi's built-in base
prompt without global or project system-prompt files. Authentication and model
configuration remain available. Research and judges retain context files such as
`AGENTS.md`; reviewers disable context-file discovery as well.

pi has no permission dialog and `pi -p` has no UI. The package handles that in three places:

- **The startup gate.** `--unattended` and `--auto-merge` are confirmed before the loop
  (TTY, or `--yes`). An external issue source (`!command`, or a contract command without
  `trust: internal`) is confirmed the same way: its text feeds every prompt.
- **Governance integrity.** Governance files, `.pi/`, the issue source and the wrapper
  are snapshotted before every tool-bearing role and compared afterwards. A role that
  changed them loses the attempt, the files come back, the log says
  `governance-modified`. That looks at files, not at commands, so `eval` and `bash -c`
  are covered. The same set survives every stash: `take_over`, `split`, and a block,
  which stashes the rejected tree so the next issue starts from HEAD.
- **`pipeline-guard`.** The interactive counterpart: destructive and privileged commands
  and governance writes are confirmed in a session and blocked without a UI. A speed
  bump, not a sandbox — run an unattended loop over a repository you do not fully trust
  in a container.

Multi-model review covers correlated blind spots, not manipulation: issue text and the
diff are untrusted input to the whole loop, framed as such in every prompt. The full
threat model, the trust mechanics of `--approve`, and every variable
(`COMMIT_APPROVED`, `MIN_REVIEWERS`, `ROLE_TIMEOUT_SECONDS`, `GATE_TIMEOUT_SECONDS`, `BLOCKER_HISTORY_MAX_BYTES`, …) are in `skills/governance-pipeline/references/operations.md`.

## Tests

```bash
npm test              # unit tests, including commit scope, HEAD changes and init regressions
bash tests/smoke.sh    # parity suite: every 1.0.x scenario plus the 1.2.0 additions, against a stub pi and a stub claude
```

To exercise an already installed Pi SDK without model calls:

```bash
PI_TEST_SDK_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" node --test tests/unit/pi-sdk.test.mjs
```

These integration tests use Pi's actual skill loader, template parser and resource
loader, including conflicting global system prompts and executable extensions.
They require Node >=22.19 for Pi 0.85; without `PI_TEST_SDK_DIR`, the unit command
reports them as skipped. The smoke suite runs them against its temporary SDK install
on supported Node versions. On Windows, expose Git Bash on PATH or set `PIPELINE_SHELL`
to its `bash.exe` for tests that exercise shell commands.
`npm test` uses `node --test` without a directory argument so discovery works
across Node 18, 22 and newer versions.

For an opt-in live check with a configured Pi model (three billable calls):

```bash
PI_LIVE_MODEL="provider/model:low" node tests/pi-live.mjs
# PowerShell: $env:PI_LIVE_MODEL = 'provider/model:low'; node tests/pi-live.mjs
```

This packs and installs the artifact in a temporary project, loads its extension
through real Pi, calls `pipeline_state`, and checks a deliberately unsafe fixture
through a real reviewer, the severity gate and a tool-free master. It never edits
your Pi settings or installs the package globally. The 1.2.1 check passed on Pi
0.85.1 with `openrouter/openai/gpt-5-mini:low`. It verifies live wiring and provider
authentication, not the quality or independence of a full multi-provider panel.

For 1.2.1, a separate read-only Pi review approved the corrected candidate with no
findings. Local validation passed 87 tests (including the real Pi SDK checks),
the full smoke suite and ShellCheck. See the [release review](https://github.com/Karlderkarl/pi-governance-pipeline/blob/v1.2.1/docs/review-2026-09-05-1.2.1.md)
for findings, their disposition and the limits of these checks.

CI is configured to run both on Ubuntu (node 18 and 22) and Windows (node 22). The Claude Code
adapter is verified against a stub and `claude --help`; it has no live verification in this release.

## Releasing (maintainers)

Publish happens only from a pushed tag — never from a local machine. Both suites
run on every push to `main` and every pull request (`.github/workflows/ci.yml`),
so a broken engine is caught before the tag. The release workflow runs them again
and then publishes via npm Trusted Publishing (OIDC), which attaches a provenance
attestation. Once the tarball is on the registry, the same workflow creates the
GitHub Release for the tag — from `release-notes.md` at the repo root when you
pre-seed curated notes there (`### Fixed` / `### Added` / `### Changed` plus a
compare link). The file must name the tag being released — on the right side of
the compare link or as a heading — otherwise the workflow treats it as a leftover
from the previous release and generates notes from the commits instead. A local
`npm publish` bypasses both and puts a tarball on the registry that the chain
never verified.

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
