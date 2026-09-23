# Operations

Flags, variables, layout, logging and the threat model of the pipeline as it ships in the package. What governance must contain is in `contract.md`; the invariants the loop enforces are summarised in `audit.md` and pinned by the engine's test suite.

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
| `init [--harness <spec>] [--local] [--force]` | Validate options and contract first; an existing `auto-develop.sh` that is foreign, pinned to another version or configured differently from the request makes `init` exit 1 before any write (`--force` replaces it). Write the wrapper (pinned to the package version, executable bit recorded in the index, an LF rule in project `.gitattributes` that git resolves to LF when that file is evaluated on its own, plus the effective `text` and `eol` from `git check-attr`), add `.pipeline/` to `.gitignore`, create a missing issue file and its parent directories |
| `doctor [--harness <spec>]` | PASS / WARN / FAIL per project check, including a decision marker in any governance file; exit 1 on FAIL |
| `status` | Counters, tree budget, per-issue state |

Two 1.0.x facades stay callable for operators and the parity suite: `lib/governance.mjs` (`config`, `model`, `models`, `state …`) and `lib/gate.mjs`.

## Run flags

| Flag | Default | Effect |
|---|---|---|
| `--dry-run` | off | Renders prompts and prints the routing of every role without calling a model (controller, master and the escalation implementer by routing only: their prompts need verdicts); writes no state, consumes no budget |
| `--issue <id>` | — | Runs a single issue; an id that is not open is an error |
| `--unattended` | off | Privileged steps allowed in child processes; confirmed once before the loop |
| `--auto-merge` | off | Confirmed at startup, and nothing else: it declares intent for an adapted merge step and grants no privileges. Branch merging is not implemented; trust is `--unattended` |
| `--yes`, `-y` | off | Answers every startup gate yes; required on a non-interactive stdin |
| `--max-runs <n>` | off | Invocation cap across issues; a planned stop, so a split parent keeps `split` and the next run resumes at its open children. Not a PRD field; `max_runs_per_tree` remains per tree |
| `--harness <spec>` | `pi` | Harness per provider, see below |

## Environment

Run-time knobs. The contract carries routing, budgets, gates and the issue source; these override or tune a single run.

| Variable | Default | Effect |
|---|---|---|
| `AGENTS_FILE`, `SOUL_FILE`, `MEMORY_FILE` | root files | Relocate a governance file |
| `ISSUE_SOURCE` | contract, else `tasks.md` | A file, or `!command` whose stdout lists `id: title` lines; overrides the contract for the run |
| `LINT_CMD`, `TEST_CMD` | — | When either is set, they replace the contract's `gates` list for the run |
| `COMMIT_APPROVED` | `1` | `0` leaves approved work uncommitted and stops the run after the first approval |
| `DIFF_MAX_BYTES` | `524288` | Per-file shares bound the text diff. Incomplete coverage pauses the issue; unchanged restarts spend no additional implementation budget. Reduce the change or raise this cap before resuming. Dry-run renders the preview |
| `BINARY_REVIEW_FILE` | — | Operator-owned JSON receipt outside the working tree, loaded before model work. Human approval binds repository-relative binary paths to SHA-256 hashes of their Git blob contents; see Binary review |
| `REVIEWERS_MAX_BYTES` | `65536` | Cap on concatenated reviewer JSON in the controller and master prompts |
| `EXCLUSIONS_MAX_LINES` | `200` | Cap on tool output re-entering the implement prompt; gate findings are never displaced |
| `MIN_REVIEWERS` | `2` | Panel floor, integer 1–3; other values refuse before model work. Two consecutive attempts below it abort as a configuration error |
| `ROLE_TIMEOUT_SECONDS` | `0` | Cap around each role; a timeout ends the whole process tree, empties the answer and logs status 124 |
| `GATE_TIMEOUT_SECONDS` | `ROLE_TIMEOUT_SECONDS` | Cap around each gate and around a `!command` issue source; a timeout counts as a failed gate and feeds the output so far back |
| `PROMPT_KEEP_RUNS` | `3` | Distinct run ids kept under `.pipeline/prompts/` |
| `BLOCKER_HISTORY_MAX`, `BLOCKER_HISTORY_MAX_BYTES` | `5`, `16384` | MEMORY.md blocker entries fed into research and implement prompts, and their byte cap |
| `PIPELINE_PI_BIN`, `PIPELINE_CLAUDE_BIN` | PATH lookup | Explicit harness binaries (a `.mjs` runs under node) |
| `PIPELINE_SHELL` | bash, else sh | Shell for gates and `!command` sources |
| `PIPELINE_WRAPPER` | `auto-develop.sh` | Set by the wrapper; the file stays out of the review diff and the stash |
| `PIPELINE_BIN` | — | Path to `bin/pipeline.mjs`; the wrapper runs it instead of `npx` |
| `PIPELINE_UNATTENDED` | — | Exported to child processes once the startup gate has passed; the guard reads it. An inherited value is dropped by the engine with a warning: trust comes from confirmed `--unattended`, never from `--auto-merge` and never from the caller's environment |
| `PIPELINE_ALLOW_DESTRUCTIVE` | — | `1` unlocks `sudo`, recursive `rm` and force-push in the guard even when unattended |
| `PIPELINE_ALLOW_GOVERNANCE_WRITE` | — | `1` lets a non-interactive govern step write governance through the guard |
| `PIPELINE_ALLOW_DEEP_SPLIT` | — | `1` accepts `max_split_depth > 1` |
| `PIPELINE_GUARD` | on | `off` disables the extension's gating, in interactive sessions and in every implementer a run starts. `doctor` and every run warn while it is set |
| `GOVERNANCE_AGENTS` | `AGENTS.md` | Contract file for the `governance.mjs state` facade |

Unset or empty numeric tuning variables silently use their default. Non-empty values accept decimal digits representing a safe integer at or above their minimum. Invalid values such as `1e6`, `512k`, whitespace or an unsafe integer emit a warning naming the value and fallback, then use the default. `MIN_REVIEWERS` and `--max-runs` have strict validation and refuse invalid values.

## Harness selection

The harness is chosen per invocation from the model's provider, never from governance: the same `AGENTS.md` runs on pi alone and on pi plus Claude Code. `--harness pi` (default) sends every role through pi. `--harness anthropic=claude-code` sends roles whose provider is `anthropic` through Claude Code and the rest through pi. Claude Code can only execute Anthropic models, so it can never carry a whole panel that spans two providers; a role routed to it with another provider is refused at start and in `doctor`, with the role named. `init --harness …` bakes the spec into the wrapper.

Isolation per role class:

| Class | Roles | pi | Claude Code |
|---|---|---|---|
| reviewer | `review.*` | `-nc -t read,grep,find,ls --no-approve -ne -ns -np` | `--safe-mode --permission-mode dontAsk --tools Read Grep Glob` |
| research | `research` | `-t read,grep,find,ls --no-approve -ne -ns -np` | `--permission-mode dontAsk --tools Read Grep Glob` |
| judge | `controller`, `master_review` | `--no-tools --no-approve -ne -ns -np` | `--safe-mode --tools ""` |
| implementer | `implement`, `implement_master` | all tools, `--approve` only after the startup gate | `--permission-mode acceptEdits`, `bypassPermissions` after the startup gate |

Every pi role gets `-p --no-session`; every Claude Code role `-p --output-format json`. The prompt goes in on stdin. Pi reviewers, research and judges additionally receive `--system-prompt "" --append-system-prompt ""`, which selects the built-in base prompt without discovering global or project system-prompt files. This preserves authentication and model configuration. Pi research and judges still load context files; reviewers disable those with `-nc`. Claude Code reviewers and judges use safe mode, which also suppresses CLAUDE.md. Claude Code research has no safe mode: its read-only tool list does not suppress CLAUDE.md, plugins, hooks or MCP discovery. The implementer is the only class that can receive `--approve`. A role whose process exits non-zero is reported with the first line of its stderr, and the full text is kept as `<answer>.stderr` under the issue's work directory; two implementation attempts in a row that exit non-zero with an unchanged tree end the issue as a configuration error. The Claude Code adapter is checked against `claude --help` and a stub; it has no live verification in this release.

**Commit integrity.** An approval commits the exact Git-normalized blobs captured for review, plus the issue source; unrelated staged entries remain staged. A scratch index applies clean filters during capture, and its blob IDs are retained in parent memory for approval. Commit uses those IDs without restaging implementation from disk; external diffs and textconv are disabled in the review patch. If either implementer changes HEAD, the issue is blocked and the whole run stops before gates or review, including when some edits remain uncommitted. The log records `head-moved`. Inspect the unexpected commits and restore a reviewed baseline before starting another run; the pipeline preserves both the commits and remaining edits for that inspection.

Diff capture, including pre-existing work and paused-run preflight, checks protected governance, issue-source and control files plus HEAD around Git filter execution. Changed protected files are restored and the run stops. Approval requires a regular issue-source file (linked sources need a manual commit), stores it as LF text without clean filters while preserving its tracked executable bit, builds the commit with `commit-tree` (respecting signing configuration), and updates HEAD only after the integrity check. All approval hooks are disabled.

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

One per root issue. The single source of truth for counters — no model ever holds them. Each attempt is reserved before launching the implementer. Writes use a flushed temporary file and atomic rename. Invalid JSON or state schema makes `doctor`, `status` (including `--json`) and a real run fail; repair from known state instead of resetting the budget.

```json
{
  "root_id": "issue-42",
  "runs_used": 7,
  "max_runs_per_tree": 25,
  "depth": 1,
  "issues": {
    "issue-42":   { "attempts_controller": 3, "attempts_master": 0, "status": "split", "children": ["issue-42.1", "issue-42.2"] },
    "issue-42.1": { "attempts_controller": 1, "attempts_master": 0, "status": "open", "parent": "issue-42", "depth": 1 },
    "issue-42.2": { "attempts_controller": 3, "attempts_master": 0, "status": "open", "parent": "issue-42", "depth": 1 }
  }
}
```

`max_runs_per_tree` is frozen at tree creation; editing the contract later does not change an existing tree. Raise it from the project root with `node <package>/lib/governance.mjs state budget .pipeline <root_id> --set <n>`; the project holds only the wrapper, the library lives in the installed package. Children of a split live in the parent's file and consume the same budget.

Only one pipeline may own a physical working tree. A competing run or state CLI mutation fails with the `pipeline-run.lock` path in the resolved per-worktree Git directory, independent of caller TEMP/TMPDIR. `doctor` reports an existing lock. A crashed process leaves its lock in place: stop its surviving model processes and inspect the tree before manually removing that named lock. It is deliberately not auto-reclaimed. Outside a Git working tree, the fallback is `~/.pi-pipeline-locks/<sha256-of-canonical-root>.lock`; it also does not depend on TEMP/TMPDIR. All descendants, including a grandchild selected by `--issue`, retain the original tree budget; invocation caps propagate a pause through every split ancestor.

Each issue also persists the mapped models that contributed to its current diff. `no_self_review` excludes all those contributors across escalation and resume, ignoring thinking-level suffixes. A successful `take_over` stash clears that history; a failed stash keeps it. For pre-existing state without this history, the engine conservatively uses the current routing for roles with recorded attempts; historical model names cannot be reconstructed after routing changes.

`init` refuses an explicit harness/local configuration change that would leave the existing wrapper unchanged. Apply the requested replacement with `--force`. Issue IDs must be unique after normalization, including closed entries; completion and child creation compare the entire ID before the colon.

## Binary review

Binary files do not receive an automatic content approval from the text reviewers.
A run pauses with the paths needing human review and writes two artifacts under
`.pipeline/work/<issue>/`:

- `diff.patch.entries.json` maps each path to its exact Git blob ID and mode.
- `diff.patch.binary.json` is a receipt template with `approved: false` and SHA-256 hashes.

Inspect the exact binary content before approving it. Extract a listed blob with
`git cat-file blob <oid> > /outside/review/asset.bin` in Bash, and open it with the
appropriate image/PDF/font/fixture viewer or validation tool. On Windows use Git
Bash for this binary redirection. A hash identifies bytes; it does not perform
their review. Inspect deletions and mode changes in the accompanying patch too.

After reviewing the files, copy the receipt template to an operator-owned path
**outside the working tree**. Set `approved` to `true` and retain only paths whose
contents you approved. For example:

```json
{"version":1,"approved":true,"files":{"assets/logo.png":"<64 lowercase SHA-256 hex characters from the template>"}}
```

Resume with `BINARY_REVIEW_FILE=/outside/review/approved.json ./auto-develop.sh --issue <id>`.
The engine loads this receipt before model work and requires an exact hash match.
Changed binary bytes need another human review; `--yes` and `--unattended` do not
grant binary approval. The file is also included in the control-integrity check.
For a deleted binary the receipt hash describes the empty resulting content;
review the old blob and deletion before acknowledging it.

A coverage pause is stored as `paused`, with a reason shown by `status` and appended
to MEMORY.md. Repeated starts check the retained diff before any model invocation.
They spend no further implementation budget while coverage remains incomplete.
Once the cap or receipt resolves the pause, normal implementation/gates/review
resume; that new implementation counts as another attempt. Already started
attempts are never refunded. The run exits 1 on a coverage pause and does not
start the next issue.

## Submodule review

A changed Git submodule pointer pauses the issue with its paths and a separate-review requirement. It is a commit reference, so neither a text-cap increase nor a binary receipt can approve it. Review the submodule commits separately and commit the approved pointer change manually in the parent repository; then resume the issue from that reviewed baseline. An unchanged restart stays paused without spending more budget.

## Logging

One JSONL event per step: `ts`, `issue`, `role`, `model`, `status`, `prompt` (path, never the text), `gates`. Special statuses: `dry-run`, `dropped-self-review`, `independence-unverified`, `governance-modified`, `head-moved`, `124` (timeout). Enough to answer "why did issue-42 take 60 calls" after the fact. What those calls cost is the harness's own accounting and the operator's business, not the pipeline's.

## Safety

pi has no permission dialog and `pi -p` has no UI. The package uses these checks:

- **The startup gate.** `--unattended` and `--auto-merge` are confirmed before the loop, on a TTY or by `--yes`; only `--unattended` grants the implementer `--approve` / `bypassPermissions`. An external issue source (a `!command`, or `issues.source.command` without `trust: internal`) is confirmed the same way on a real run: its text feeds every prompt. During preflight, before model work, a decision marker in any governance file (`SOUL.md`, `AGENTS.md`, `MEMORY.md`, `SYSTEM.md`, `CLAUDE.md`, `.pi/APPEND_SYSTEM.md`, relocated files included) refuses a real run with file and line; a dry-run notes it.
- **Decision markers.** The phrases `USER DECISION REQUIRED`, `NEEDS PRD CLARIFICATION` and legacy `NEEDS CLARIFICATION` are detected even without brackets. Engine-written blocker and pause history escapes spaces in quoted marker phrases as `&#32;`, keeping the rendered text readable without creating a new decision. In older history, escape only quoted evidence; resolve genuine open decisions through govern.
- **Governance integrity.** Before every tool-bearing role the protected paths (`SOUL.md`, `AGENTS.md`, `AGENTS.override.md`, `SYSTEM.md`, `.pi/**`, `CLAUDE.md`, `MEMORY.md`, upper-case spellings, plus the issue source and the wrapper) are snapshotted; afterwards they are compared by hash. The same set is copied out and written back around every stash — `take_over`, `split`, and a block, which stashes the rejected tree so the next issue starts from HEAD. `git stash` runs the project's clean and smudge filters, so the whole stash, copy-out and write-back included, sits inside the same Git-operation guard as diff capture and approval: state, Git configuration and HEAD are verified around it. A role that changed them loses the attempt, the files come back from the snapshot (kept in memory up to 1 MB per file, otherwise as a copy under `.pipeline/work/<issue>/gov-snapshot/`), the run log records `governance-modified`. This looks at files, not at commands: `eval`, `bash -c` and scripts are covered. Tool-bearing-role snapshots use disk copies for large files. Git-operation snapshots also spill files above 1 MiB per file to a temporary recovery directory outside the working tree and protected paths. Hashes remain in parent memory; hashing large files uses bounded buffers, and recovery copies must match their saved hash before restoration. The temporary directory is removed after the operation. Small-file snapshots still consume memory in proportion to their combined size.
- **pipeline-guard.** The interactive counterpart: an agent that reaches for `git push --force`, `sudo`, `rm -rf` or a governance write in a session is asked, and blocked without a UI. Its patterns live in `lib/guard/patterns.mjs`; the governance names in `lib/integrity/governance-paths.mjs` — the one list that also feeds the diff filter and the stash protection. The guard is a speed bump, not a sandbox: `rm -rf "$HOME"` behind a variable, runtime-constructed commands and `eval` walk past a regex. Destructive-command gating in unattended child processes remains the guard's job.
- **Link-safe recovery.** Snapshots record directory links and symlinks themselves without descending into their targets. Restoration removes newly introduced links, preserves their target data, restores original object types, and verifies the resulting snapshot. It never recursively deletes a new target tree.
- **Engine control integrity.** State, Git configuration, default and configured hooks, and linked-worktree metadata are snapshotted in parent memory around roles, gates and command issue-source reads, including split resumption. A modification or deletion restores the saved bytes and stops the run before approval. The guard refuses ordinary write/edit calls into `.git` and `.pipeline/state`. Approval staging and commits disable all Git hooks, including pre-existing ones; deterministic checks belong in contract gates. Relocated governance is excluded from both review and commit.

These checks run at process boundaries. They do not isolate a hostile process with the same OS permissions, undo external side effects, or recover state if that process destroys the state and kills the parent before its integrity check. Use OS isolation for that threat model. A successful test proves the enforced paths, not that a model understood every reviewed line.

**Untrusted input.** Multi-model review covers correlated blind spots, not manipulation. Three processes, at least two providers, no shared verdict and `no_self_review` defend against every reviewer missing the same thing; they do not defend against the object under review talking to the panel. Issue text (from `gh`, Jira) and the diff (written by a model) are framed in every prompt as content to judge, never as instructions. That is a mitigation, not a boundary. Run an unattended loop over foreign-fed issues in a container.

**Gates through a shell.** `gates[].run`, `LINT_CMD`, `TEST_CMD` and `!command` sources run through bash (or `PIPELINE_SHELL`). Whoever writes governance or the run's environment has code execution — governance is guard-protected, committed and reviewable; the environment is the operator's. The implementer, however, writes the scripts a gate command calls (`npm test` runs whatever `package.json` names), so a gate runs model-written code with the operator's rights and no guard. The engine therefore repeats the governance snapshot and the HEAD check after the gates: a gate that edits governance costs the attempt and is reverted, a gate that commits blocks the issue and stops the run. What a gate does outside the repository is not checked; that is the case for a container.

**Reading a role's answer.** JSON is recovered from every fenced block and from every object the scanner reaches by starting fresh at each `{`, so a verdict or finding written as free text counts even when prose around it carries an unmatched brace or quote. Only keys actually consumed as findings or decisions count as processed. Complete findings recovered from a broken review remain evidence without filling a panel seat. An unconsumed severity key or exhausted JSON scan produces a blocking `unprocessed_review` finding, which survives a clean retry and blocks even if other reviewers meet the panel minimum. It never enters the implement prompt — it asks the reviewer for well-formed JSON, which no implementation can supply — and two attempts in a row carrying it end the issue as a configuration error instead of spending the tree budget on a formatting problem. An unconsumed decision or exhausted scan prevents the master from approving or splitting. Setup keeps the wrapper LF rule in the project itself, judged by evaluating the project's `.gitattributes` alone in a scratch repository: a later pattern that matches the wrapper invalidates the pin, an unrelated one does not, and a private `.git/info/attributes` can neither supply the rule nor hide a conflicting project one.

**Failed processes.** A reviewer or master whose process exits non-zero or times out has not completed its review, whatever it printed. Its approval is discarded; a blocking finding it wrote is kept — including on a timeout, where the reviewer's partial output is retained as evidence and only its seat in the panel is refused. A judge or research role that times out keeps nothing: a truncated verdict is not evidence, and a truncated research note would be cached for the rest of the issue. A refused `git stash` after a block or before a split halts the run with exit 1, because the next issue would otherwise review and commit the rejected tree; the tree stays in place for inspection.

## Trust and project resources

`--approve` is passed to child `pi -p` processes only after the startup gate exported `PIPELINE_UNATTENDED=1`, and never to a `review.*` role. pi's trust prompt spells out what it grants: `.pi/settings.json` and `.pi` resources load, missing project packages are installed, project extensions execute. In an unattended run that happens once per role per attempt; on a repository you do not fully trust that is package installation plus code execution — containerize it.

Reviewers, research and judges explicitly use `--no-approve` to override saved trust. `-nc` only drops context files, and `--no-approve` still permits global system-prompt files; the explicit empty system-prompt options close that gap. `-ne -ns -np` drop extension, skill and prompt-template discovery (explicit `-e` paths would still load; the pipeline passes none) — pi lets an extension register a tool under a built-in name and inject context before the agent starts. Without `--approve`, an attended run implements against `AGENTS.md` but not `.pi/APPEND_SYSTEM.md` unless the project was trusted interactively; `doctor` reports a root `SYSTEM.md` whose `.pi/APPEND_SYSTEM.md` copy is missing.

Do not call `pi auth check --model <id>` as a startup gate: ids such as `google/gemini-2.5-flash` are often openrouter models, and `auth check` would treat `google/` as a native provider and abort a healthy run. The binaries are checked; the keys are what the first role call tells you.
