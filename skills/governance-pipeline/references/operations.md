# Operations

Flags, variables, layout, logging and the threat model of the pipeline as it ships in the package. What the loop guarantees is in `invariants.md`; what governance must contain is in `contract.md`.

## Contents

- [Commands](#commands)
- [Run flags](#run-flags)
- [Environment](#environment)
- [Harness selection](#harness-selection)
- [Layout](#layout)
- [State file](#state-file)
- [Logging](#logging)
- [Safety](#safety)
- [Trust and project resources](#trust-and-project-resources)

## Commands

`bin/pipeline.mjs` is the entry; the project's `auto-develop.sh` execs `run` through it.

| Command | Effect |
|---|---|
| `run [flags]` | Run every open issue of the issue source |
| `init [--harness <spec>] [--local] [--force]` | Validate options and contract first, write the wrapper (pinned to the package version, executable bit recorded in the index, line endings pinned to LF in `.gitattributes`), add `.pipeline/` to `.gitignore`, create a missing issue file and its parent directories |
| `doctor [--harness <spec>]` | PASS / WARN / FAIL per project check; exit 1 on FAIL |
| `status` | Counters, tree budget, per-issue state |

Two 1.0.x facades stay callable for operators and the parity suite: `lib/governance.mjs` (`config`, `model`, `models`, `state …`) and `lib/gate.mjs`.

## Run flags

| Flag | Default | Effect |
|---|---|---|
| `--dry-run` | off | Renders prompts and prints the routing without calling a model; writes no state, consumes no budget |
| `--issue <id>` | — | Runs a single issue; an id that is not open is an error |
| `--unattended` | off | Privileged steps allowed in child processes; confirmed once before the loop |
| `--auto-merge` | off | Adaptation point: parsed and confirmed, not implemented |
| `--yes`, `-y` | off | Answers every startup gate yes; required on a non-interactive stdin |
| `--max-runs <n>` | off | Invocation cap across issues. Not a PRD field; `max_runs_per_tree` remains per tree |
| `--harness <spec>` | `pi` | Harness per provider, see below |

## Environment

Run-time knobs. The contract carries routing, budgets, gates and the issue source; these override or tune a single run.

| Variable | Default | Effect |
|---|---|---|
| `AGENTS_FILE`, `SOUL_FILE`, `MEMORY_FILE` | root files | Relocate a governance file |
| `ISSUE_SOURCE` | contract, else `tasks.md` | A file, or `!command` whose stdout lists `id: title` lines; overrides the contract for the run |
| `LINT_CMD`, `TEST_CMD` | — | When either is set, they replace the contract's `gates` list for the run |
| `COMMIT_APPROVED` | `1` | `0` leaves approved work uncommitted and stops the run after the first approval |
| `DIFF_MAX_BYTES` | `65536` | Cap on the review diff; truncation is per file, omitted paths are named |
| `REVIEWERS_MAX_BYTES` | `65536` | Cap on concatenated reviewer JSON in the controller and master prompts |
| `EXCLUSIONS_MAX_LINES` | `200` | Cap on tool output re-entering the implement prompt; gate findings are never displaced |
| `MIN_REVIEWERS` | `2` | Panel floor; two consecutive attempts below it abort as a configuration error. A value that is not an integer ≥ 1 is fatal |
| `ROLE_TIMEOUT_SECONDS` | `0` | Cap around each role; a timeout ends the whole process tree, empties the answer and logs status 124 |
| `GATE_TIMEOUT_SECONDS` | `ROLE_TIMEOUT_SECONDS` | Cap around each gate and around a `!command` issue source; a timeout counts as a failed gate and feeds the output so far back |
| `PROMPT_KEEP_RUNS` | `3` | Distinct run ids kept under `.pipeline/prompts/` |
| `BLOCKER_HISTORY_MAX`, `BLOCKER_HISTORY_MAX_BYTES` | `5`, `16384` | MEMORY.md blocker entries fed into research and implement prompts, and their byte cap |
| `PIPELINE_PI_BIN`, `PIPELINE_CLAUDE_BIN` | PATH lookup | Explicit harness binaries (a `.mjs` runs under node) |
| `PIPELINE_SHELL` | bash, else sh | Shell for gates and `!command` sources |
| `PIPELINE_WRAPPER` | `auto-develop.sh` | Set by the wrapper; the file stays out of the review diff and the stash |
| `PIPELINE_BIN` | — | Path to `bin/pipeline.mjs`; the wrapper runs it instead of `npx` |
| `PIPELINE_UNATTENDED` | — | Exported to child processes once the startup gate has passed; the guard reads it. An inherited value is dropped by the engine with a warning: trust comes from `--unattended`, never from the caller's environment |
| `PIPELINE_ALLOW_DESTRUCTIVE` | — | `1` unlocks `sudo`, recursive `rm` and force-push in the guard even when unattended |
| `PIPELINE_ALLOW_GOVERNANCE_WRITE` | — | `1` lets a non-interactive govern step write governance through the guard |
| `PIPELINE_ALLOW_DEEP_SPLIT` | — | `1` accepts `max_split_depth > 1` |
| `PIPELINE_GUARD` | on | `off` disables the extension's gating |
| `GOVERNANCE_AGENTS` | `AGENTS.md` | Contract file for the `governance.mjs state` facade |

## Harness selection

The harness is chosen per invocation from the model's provider, never from governance: the same `AGENTS.md` runs on pi alone and on pi plus Claude Code. `--harness pi` (default) sends every role through pi. `--harness anthropic=claude-code` sends roles whose provider is `anthropic` through Claude Code and the rest through pi. Claude Code can only execute Anthropic models, so it can never carry a whole panel that spans two providers; a role routed to it with another provider is refused at start and in `doctor`, with the role named. `init --harness …` bakes the spec into the wrapper.

Isolation per role class:

| Class | Roles | pi | Claude Code |
|---|---|---|---|
| reviewer | `review.*` | `-nc -t read,grep,find,ls --no-approve -ne -ns -np` | `--safe-mode --permission-mode dontAsk --tools Read Grep Glob` |
| research | `research` | `-t read,grep,find,ls --no-approve -ne -ns -np` | `--permission-mode dontAsk --tools Read Grep Glob` |
| judge | `controller`, `master_review` | `--no-tools --no-approve -ne -ns -np` | `--safe-mode --tools ""` |
| implementer | `implement`, `implement_master` | all tools, `--approve` only after the startup gate | `--permission-mode acceptEdits`, `bypassPermissions` after the startup gate |

Every pi role gets `-p --no-session`; every Claude Code role `-p --output-format json`. The prompt goes in on stdin. Pi reviewers, research and judges additionally receive `--system-prompt "" --append-system-prompt ""`, which selects the built-in base prompt without discovering global or project system-prompt files. This preserves authentication and model configuration. Research and judges still load context files; reviewers disable those with `-nc`. The implementer is the only class that can receive `--approve`. A role whose process exits non-zero is reported with the first line of its stderr, and the full text is kept as `<answer>.stderr` under the issue's work directory; two implementation attempts in a row that exit non-zero with an unchanged tree end the issue as a configuration error. The Claude Code adapter is checked against `claude --help` and a stub; it has no live verification in this release.

**Commit integrity.** An approval commits only the reviewed paths and the issue source; unrelated staged entries remain staged. If either implementer changes HEAD, the issue is blocked and the whole run stops before gates or review, including when some edits remain uncommitted. The log records `head-moved`. Inspect the unexpected commits and restore a reviewed baseline before starting another run; the pipeline preserves both the commits and remaining edits for that inspection.

A failed approval commit exits non-zero even for the last issue or a split-parent closing commit. Approval and checkbox changes are retained: inspect git's error and commit the approved paths manually before continuing. No further issue starts. A halt after a split child leaves its parent open; after restoring the baseline, rerun the parent to close it or resume any remaining children. `COMMIT_APPROVED=0` is an intentional stop, not a commit error, and can return success when no further issue was selected.

**Launching the binary.** The harness is found on PATH (`PIPELINE_PI_BIN` / `PIPELINE_CLAUDE_BIN` name it explicitly; a `.mjs` runs under node). On Windows a native `.exe` is preferred, then the extensionless shim npm writes next to its `.cmd` (run under Git Bash, which pi needs anyway), then the `.cmd`, which is launched through an explicit `cmd.exe /d /s /c` with a quoted command line — never `shell: true`, so a path with a space works and Node prints no deprecation warning. A timeout ends the whole process tree (process group on POSIX, `taskkill /T` on Windows), and the result is settled half a second after the process's exit at the latest, so a grandchild that still holds stdout — a hanging test run — does not hold the loop.

## Layout

```
auto-develop.sh              # the wrapper: cd, PIPELINE_WRAPPER, exec npx pi-governance-pipeline@<pin> run
AGENTS.md                    # the contract (routing, budgets, gates, issue source)
tasks.md                     # or the issue source declared in the contract
.pipeline/                   # MUST be gitignored — plaintext diffs and prompts
  state/<root_id>.json       # counters and budget
  logs/<root_id>/<run>.jsonl # per-run event log
  prompts/<root_id>/         # rendered prompts, pruned to PROMPT_KEEP_RUNS run ids
  work/<issue_id>/           # research cache, diff, reviewer output, gate, findings, exclusions, <answer>.stderr
```

`init` writes the wrapper and the `.gitignore` entry; `run` warns when `.pipeline/` is not ignored and prunes the prompt archive at start.

## State file

One per root issue. The single source of truth for counters — no model ever holds them. Written after every mutation, so a crashed run resumes with its counters.

```json
{
  "root_id": "issue-42",
  "runs_used": 7,
  "max_runs_per_tree": 25,
  "depth": 1,
  "issues": {
    "issue-42":   { "attempts_controller": 3, "attempts_master": 0, "status": "split", "children": ["issue-42.1", "issue-42.2"] },
    "issue-42.1": { "attempts_controller": 1, "attempts_master": 0, "status": "open", "parent": "issue-42", "depth": 1 }
  }
}
```

`max_runs_per_tree` is frozen at tree creation; editing the contract later does not change an existing tree. Raise it with `node lib/governance.mjs state budget .pipeline <root_id> --set <n>`. Children of a split live in the parent's file and consume the same budget.

## Logging

One JSONL event per step: `ts`, `issue`, `role`, `model`, `status`, `prompt` (path, never the text), `gates`. Special statuses: `dry-run`, `dropped-self-review`, `independence-unverified`, `governance-modified`, `head-moved`, `124` (timeout). Enough to answer "why did issue-42 take 60 calls" after the fact. What those calls cost is the harness's own accounting and the operator's business, not the pipeline's.

## Safety

pi has no permission dialog and `pi -p` has no UI. The package handles that in three places:

- **The startup gate.** `--unattended` and `--auto-merge` are confirmed before the loop, on a TTY or by `--yes`. An external issue source (a `!command`, or `issues.source.command` without `trust: internal`) is confirmed the same way on a real run: its text feeds every prompt.
- **Governance integrity.** Before every tool-bearing role the protected paths (`SOUL.md`, `AGENTS.md`, `AGENTS.override.md`, `SYSTEM.md`, `.pi/**`, `CLAUDE.md`, `MEMORY.md`, upper-case spellings, plus the issue source and the wrapper) are snapshotted; afterwards they are compared by hash. The same set is copied out and written back around every stash — `take_over`, `split`, and a block, which stashes the rejected tree so the next issue starts from HEAD. A role that changed them loses the attempt, the files come back from the snapshot (kept in memory up to 1 MB per file, otherwise as a copy under `.pipeline/work/<issue>/gov-snapshot/`), the run log records `governance-modified`. This looks at files, not at commands: `eval`, `bash -c` and scripts are covered. A large package checkout under `.pi/` costs I/O per role, not heap.
- **pipeline-guard.** The interactive counterpart: an agent that reaches for `git push --force`, `sudo`, `rm -rf` or a governance write in a session is asked, and blocked without a UI. Its patterns live in `lib/guard/patterns.mjs`; the governance names in `lib/integrity/governance-paths.mjs` — the one list that also feeds the diff filter and the stash protection. The guard is a speed bump, not a sandbox: `rm -rf "$HOME"` behind a variable, runtime-constructed commands and `eval` walk past a regex. Destructive-command gating in unattended child processes remains the guard's job.

**Untrusted input.** Multi-model review covers correlated blind spots, not manipulation. Three processes, at least two providers, no shared verdict and `no_self_review` defend against every reviewer missing the same thing; they do not defend against the object under review talking to the panel. Issue text (from `gh`, Jira) and the diff (written by a model) are framed in every prompt as content to judge, never as instructions. That is a mitigation, not a boundary. Run an unattended loop over foreign-fed issues in a container.

**Gates through a shell.** `gates[].run`, `LINT_CMD`, `TEST_CMD` and `!command` sources run through bash (or `PIPELINE_SHELL`). Whoever writes governance or the run's environment has code execution — governance is guard-protected, committed and reviewable; the environment is the operator's.

## Trust and project resources

`--approve` is passed to child `pi -p` processes only after the startup gate exported `PIPELINE_UNATTENDED=1`, and never to a `review.*` role. pi's trust prompt spells out what it grants: `.pi/settings.json` and `.pi` resources load, missing project packages are installed, project extensions execute. In an unattended run that happens once per role per attempt; on a repository you do not fully trust that is package installation plus code execution — containerize it.

Reviewers, research and judges explicitly use `--no-approve` to override saved trust. `-nc` only drops context files, and `--no-approve` still permits global system-prompt files; the explicit empty system-prompt options close that gap. `-ne -ns -np` drop extension, skill and prompt-template discovery (explicit `-e` paths would still load; the pipeline passes none) — pi lets an extension register a tool under a built-in name and inject context before the agent starts. Without `--approve`, an attended run implements against `AGENTS.md` but not `.pi/APPEND_SYSTEM.md` unless the project was trusted interactively; `doctor` reports a root `SYSTEM.md` whose `.pi/APPEND_SYSTEM.md` copy is missing.

Do not call `pi auth check --model <id>` as a startup gate: ids such as `google/gemini-2.5-flash` are often openrouter models, and `auth check` would treat `google/` as a native provider and abort a healthy run. The binaries are checked; the keys are what the first role call tells you.
