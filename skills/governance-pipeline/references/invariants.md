# Invariants

The rules the pipeline enforces, in one place. Each entry names why it exists and the test that pins it: `smoke:` is a scenario label in `tests/smoke.sh` (the parity suite, 1.0.x behaviour and 1.2.0 additions), `unit:` a file under `tests/unit/`. `tests/unit/traceability.test.mjs` checks that every invariant names a test that exists and that every unit test names an invariant. A change that breaks one of these is wrong even if it runs.

### INV-01 Routing comes from governance
Every model invocation reads its model from the `models:` block in `AGENTS.md`; the engine holds no model name. Changing the mapping changes the routing; nothing else is touched. A role that is written down without a `model` is a contract error, not a silent default.
**Why:** cost differentiation per role (PRD §4.1, AK1) only works if the mapping is the single lever.
**Test:** smoke: P3.2 role toolset flags | unit: contract.test.mjs

### INV-02 Reviewers are separate processes with no sibling verdicts
Each reviewer is its own harness process with a fresh context. No reviewer prompt carries another verdict, the panel size, or the implementer's model.
**Why:** three opinions are only three if none of them read the others (PRD R4).
**Test:** smoke: 1.0.14 R1: no governance/pipeline path in a reviewer prompt | unit: prompts.test.mjs

### INV-03 Counters live in the state file
Attempt counters and the tree budget are read from and written to `.pipeline/state/<root_id>.json` only. A model is told at most "N attempts left".
**Why:** a model forgets or invents counters (PRD R10).
**Test:** smoke: e2e: resume from existing state file | smoke: state store

### INV-04 The budget check precedes every attempt
Before any implementation attempt the tree budget is checked; exhaustion blocks the issue and writes the blocker. `runs_used` counts every implementation attempt, whoever implemented, including attempts that then fail a gate.
**Why:** a resource limit checked after the spend is not a limit (PRD R11).
**Test:** smoke: P1.1 config abort ~17 calls, not 55 | smoke: e2e: exclusions cap

### INV-05 Deterministic gates run before any review, and they come from governance
After every implementation the contract's `gates` run in order; a failure feeds its output back and costs the attempt without a review cycle. `LINT_CMD` / `TEST_CMD` replace the list for one run. No gate at all is a loud warning at start and `"gates":"none"` in every log event; in a v2 contract it has to be written down as `gates: []`. Every gate, and a `!command` issue source, is capped by `GATE_TIMEOUT_SECONDS` (default: the role cap); a timeout counts as a failed gate, and the head and the tail of its output are fed back.
**Why:** a lint failure must not consume six model calls, a gate that lives in the environment is a gate that ships empty (PRD §3), and a test run stuck in watch mode must not hold an unattended loop.
**Test:** smoke: 1.2.0 contract v2: gates from AGENTS.md | smoke: 1.0.14 R3: an unadapted script says it has no gate | smoke: e2e: lint feedback | smoke: 1.2.0 gate timeout | unit: text.test.mjs

### INV-06 The master decides on every attempt, fail-closed, strictest-wins, never over a blocking gate
The master review runs on every attempt and sees the original reviewer JSON, not only the controller's summary. Its output is parsed fail-closed (unparseable is reject; the decision word is trimmed and case-folded like a reviewer verdict); among several parseable decisions the strictest wins (`take_over` > `reject` > `approve`); the schema echo is never a candidate; `split` is accepted only as the sole, well-formed decision. `approve` over a blocking gate is not an approval.
**Why:** the controller is a weak model and may miscount; the diff sits inside the master's prompt, so a fragment appended after the real object must never upgrade the verdict (PRD R7, R8).
**Test:** smoke: 1.0.14 R4: master verdict takes the strictest, not the last | smoke: e2e: reviewer floor | unit: master-decision.test.mjs

### INV-07 An abort is never silent
When the master budget is exhausted, the panel is broken, or the tree budget is gone, the issue is marked `blocked` under its **tree root**, the blocker is appended to `MEMORY.md` with the unresolved findings as prose (no line numbers) and the tail of the tool log, and the run exits non-zero naming the issue. A harness process that exits non-zero with nothing on stdout is reported with the first line of its stderr, the text is kept next to its answer (`<answer>.stderr`), and two such implementation attempts in a row are a configuration error, not six empty-diff retries. Lines of a blocker that start with `#` are escaped so the entry stays one entry for the history.
**Why:** PRD R14; a blocked child must not open a state file with a budget of its own; a missing API key must read as a missing API key, not as an implementer that wrote nothing.
**Test:** smoke: F6: the blocker carries the findings, and history is byte-capped | smoke: e2e: MEMORY.md must not unstick a later empty issue | smoke: 1.2.0 harness failure is named | unit: blocker.test.mjs

### INV-08 The startup gate is the only place a human intervenes
`--unattended` and `--auto-merge` are confirmed before the loop, on a TTY or by `--yes`, never mid-run. Only implementers receive `--approve` (pi) or `bypassPermissions` (Claude Code), and only after that gate; reviewers, research and judges never. Trust is derived from the confirmed flag, not from the environment: an inherited `PIPELINE_UNATTENDED=1` is dropped from the child environment with a warning.
**Why:** pi has no permission dialog and `pi -p` has no UI (PRD R12, R13); a variable exported to quiet the guard in a session must not turn a plain run into a trusted one.
**Test:** smoke: 1.0.14 R2: reviewers never receive --approve | smoke: 1.2.0 trust comes from the gate, not the environment | unit: harness.test.mjs

### INV-09 Escalation changes the model, and reviewers span two providers
`implement_master` must differ from `implement` (compared without thinking). Mapped reviewers span at least two providers, and a single mapped reviewer is refused as a panel of one. An explicit `no_self_review: true` with fewer than two mapped reviewers is a contract error.
**Why:** a different blind spot is the point of escalating, and three prompts against one model share its blind spots (PRD R2, R3).
**Test:** smoke: contract: refused | smoke: F13: one mapped reviewer names the real problem | unit: contract.test.mjs

### INV-10 A resumed run restores its counters
Per-issue attempt counters and `runs_used` come back from the state file; a crashed run never restarts at zero. `max_runs_per_tree` is frozen at tree creation; `state budget --set` is the only way to move it.
**Why:** a budget that resets on a crash or on a file edit is not a budget.
**Test:** smoke: e2e: resume from existing state file | smoke: state store

### INV-11 Dry-run spends nothing
`--dry-run` renders prompts and prints the routing, writes no state, consumes no budget, and launches no model; a missing harness binary is a note, not an error.
**Why:** routing and prompt assembly must be verifiable at zero cost.
**Test:** smoke: auto-develop.sh | smoke: no git: fail at start, do not burn the budget

### INV-12 An empty diff is a rejected attempt
When the working tree does not differ from HEAD after an implementation, the attempt is rejected with the reason fed back; nothing is reviewed and nothing is marked done. If an implementer moves HEAD, the issue is blocked and the entire run stops before gates or review, even when uncommitted changes remain. Commits and remaining work are preserved for inspection; the operator must restore a reviewed baseline before resuming.
**Why:** "nothing to find" is not "no findings".
**Test:** smoke: e2e: empty diff is fail-closed | unit: head-integrity.test.mjs

### INV-13 reject repairs in place; take_over starts fresh
A reject keeps the working tree. A take_over stashes it (`git stash -u`) after copying governance, `.pi/`, the issue source and the wrapper out and writing them back, deletes the cached research, and forces the master path; a refused stash is reported on stderr. A block stashes the rejected tree the same way (`pipeline: blocked <id>-<run>`), so the next issue starts from HEAD instead of reviewing, and committing, code the master rejected.
**Why:** inheriting the broken diff inherits the reasoning that failed; inheriting a missing SOUL.md would review without standards (PRD R9); a blocked issue's tree must not become the next issue's diff.
**Test:** smoke: e2e: take_over stashes the rejected tree | smoke: take_over must not stash the governance away | smoke: P3.4 take_over regenerates research | smoke: F7: no initial commit refuses a real run, notes on dry-run | smoke: 1.2.0 blocked issue leaves a clean tree

### INV-14 Governance and harness never enter the review diff
The review diff excludes governance files (including `AGENTS.override.md` and the upper-case spellings), `.pipeline/`, `.pi/`, the issue source and the wrapper, on both paths: the untracked filter and the git pathspecs. One list (`lib/integrity/governance-paths.mjs`) feeds the diff filter, the stash protection, the integrity snapshot and the guard.
**Why:** a blocker note in MEMORY.md must not look like an implementation, and a fourth copy of the list is how `AGENTS.override.md` went missing from three of them.
**Test:** smoke: 1.0.14 R1: no governance/pipeline path in a reviewer prompt | smoke: F5: AGENTS.override.md and the harness stay out of the review diff | unit: snapshot.test.mjs

### INV-15 Diff truncation is per file, with a manifest
Untracked files come first (TDD writes new tests), every file gets a share of `DIFF_MAX_BYTES`, truncated and omitted paths are named in a manifest at the end of the diff, non-ASCII paths reach the reviewers verbatim, and a manifest without diff bytes is an empty diff.
**Why:** the reviewer prompt must say what was not judged; silence reads as "reviewed and clean".
**Test:** smoke: capture_diff cap | smoke: P3.1 omitted paths named in the reviewer prompt | smoke: non-ASCII paths must reach the reviewers

### INV-16 A panel below the floor blocks, and two short panels are a configuration error
The gate blocks when fewer than `MIN_REVIEWERS` reviewers produced usable output; two consecutive attempts below the floor abort the issue as a configuration error before the controller and master of the second attempt run.
**Why:** one opinion is not a review panel, and a broken panel is not a quality signal worth a tree budget.
**Test:** smoke: e2e: reviewer floor | smoke: P1.1 config abort ~17 calls, not 55 | unit: gate.test.mjs

### INV-17 Approved work is committed before the next issue
An approval commits exactly the reviewed paths plus the issue source, using literal pathspecs and `git commit --only`. Unrelated staged entries stay in the index and are not committed. When the commit is disabled (`COMMIT_APPROVED=0`) or fails, the run stops and names the issues it did not start. A failed commit always exits non-zero, including on the last issue and when closing a split parent; approval and checkbox changes are preserved for a manual commit. A halt after a child leaves the split parent open. A fresh issue starting on a tree that already differs from HEAD is warned about, with the paths.
**Why:** an uncommitted approval would be reviewed as the next issue's diff and stashed away by its take_over.
**Test:** smoke: F2: approved work is committed; the next issue reviews only its own diff | unit: commit.test.mjs | unit: completion.test.mjs

### INV-18 Severity decides, and every severity is accounted for
`blocking_severities` and `followup_severities` together cover all four severities (contract error otherwise). Severity words are trimmed and case-folded; a known severity listed in neither blocks, as does an unknown one. Duplicates keep the higher severity. Across reviewer JSON candidates, the most severe usable findings win even when their verdict word is off-schema; a valid empty approval cannot erase a critical. There is no vote count and no percentage.
**Why:** percentages over three reviewers collapse into unanimity, and "not written down" must not mean "does not block" (PRD R6).
**Test:** smoke: F3: severity lists must partition; an unlisted known severity blocks | smoke: gate.mjs | unit: gate.test.mjs

### INV-19 A reviewer retry can only add severity
A reviewer whose output has no usable verdict gets one retry. The retry replaces the original only if it parses at least as well **and** its worst finding is at least as severe.
**Why:** the retry is a fresh process with no memory of the first pass; a cleaner parse that lost a critical is a lost finding.
**Test:** smoke: F1: a retry that parses better but carries less keeps the original | smoke: e2e: unparseable reviewer JSON, one retry | unit: gate.test.mjs

### INV-20 Governance is byte-identical after a tool-bearing role
Before research, implement and implement_master the protected paths — governance, `.pi/`, the issue source and the wrapper — are snapshotted; afterwards they are compared. Any change is restored from the snapshot, the attempt is rejected with the paths named, and the log records `governance-modified`.
**Why:** the guard matches command strings and `eval` walks past it; the property that matters is the files, and it is checkable. The issue source is protected because a model-written issue line would otherwise pass the reviewers (the diff filter hides it), land in the approve commit, and become the next run's work.
**Test:** smoke: 1.2.0 governance integrity | unit: snapshot.test.mjs

### INV-21 A split is bounded by depth, by the source, and by the root budget, and it resumes at its children
The master may split only when the issue's depth is below `max_split_depth` and the issue source can create children; otherwise the split is a reject with a note. Two to five sub-issues, titles one line and bounded, texts bounded. Children are registered in the parent's tree (same budget, attempts of their own), run immediately, and close the parent when the state file shows every one of them done. A run interrupted after the split resumes at the open children and never implements the parent again; `--issue <child>` runs one child under its parent's tree.
**Why:** PRD §4.4: attempts are a quality signal per issue, the budget a resource limit per tree, and depth caps the exponential growth. A parent the master called too big for one diff must not be re-implemented by the next run; a model-authored title must not be able to write issue lines.
**Test:** smoke: 1.2.0 split | smoke: 1.2.0 split resume | unit: issues.test.mjs | unit: master-decision.test.mjs

### INV-22 The harness is chosen per provider, never by governance
`--harness` (or the wrapper) maps providers to harnesses; pi is the default for every provider. Claude Code takes only the roles of its provider. The same `AGENTS.md` runs with pi alone and with pi plus Claude Code. A role routed to a harness that cannot run its provider is refused at start and in `doctor`, with the role and its provider named.
**Why:** governance is harness-neutral (PRD R15, AK6), and a harness that runs one provider cannot carry a panel that spans two; found at start, not six attempts later as "empty diff".
**Test:** smoke: 1.2.0 claude-code adapter (stub) | smoke: 1.2.0 harness routing | unit: harness.test.mjs

### INV-23 Isolation per role class
pi: reviewers `-nc -t read,grep,find,ls --no-approve -ne -ns -np`, research `-t read,grep,find,ls --no-approve -ne -ns -np`, judges `--no-tools --no-approve -ne -ns -np`, implementers alone get `--approve` and only after the gate, every role `-p --no-session`, the prompt on stdin. Reviewers, research and judges also pass `--system-prompt "" --append-system-prompt ""`: Pi uses its built-in base prompt and discovers no global or project system-prompt files. Research and judges retain context files; reviewers do not. Claude Code: reviewers and judges `--safe-mode`, read-only tools or none, every role `-p --output-format json`. A `.cmd` harness on Windows is launched through an explicit `cmd.exe /d /s /c` with a quoted command line, never `shell: true`.
**Why:** `-nc` alone leaves the trust-gated `.pi/APPEND_SYSTEM.md` in reach, while `--no-approve` alone still permits global system-prompt files. An extension may replace `read` or inject context; research must disable discovery explicitly even when a trust decision was previously saved. The judges' verdict must not be influenced by those extensions or custom system-prompt files either.
**Test:** smoke: P3.2 role toolset flags | smoke: 1.0.14 R2: reviewers never receive --approve | smoke: 1.2.0 windows .cmd harness | unit: harness.test.mjs | unit: exec.test.mjs | unit: pi-sdk.test.mjs

### INV-24 An external issue source is acknowledged before a real run
A `!command` source, or a contract command source without `trust: internal`, is confirmed at the startup gate (TTY, or `--yes`) before any model sees its text. A dry-run needs no acknowledgement.
**Why:** foreign-authored issue text feeds every prompt; the framing as untrusted input is a mitigation, not a boundary.
**Test:** smoke: 1.2.0 external issue source needs an acknowledgement

### INV-25 A real run needs a HEAD, and an unknown --issue is an error
Without an initial commit a real run refuses to start (a dry-run notes it). `--issue <id>` naming an id that is not open exits non-zero with a message, also when nothing is open at all. The issue file is read with either line ending and written back with the one it had, so a CRLF checkout is not "no open issues". Two raw ids that sanitise to the same directory name are refused before anything runs.
**Why:** take_over stashes against HEAD and approvals commit on it; a silent no-op is the cron-job lie, and on Windows CRLF is the normal state of a checkout.
**Test:** smoke: F7: no initial commit refuses a real run, notes on dry-run | smoke: F9: --issue naming a closed or unknown id is an error | smoke: 1.2.0 CRLF issue file | unit: issues.test.mjs

### INV-26 One prompt file per attempt, pruned, out of git
Every role's prompt is written under `.pipeline/prompts/<root>/` with the attempt tag and the run id, the archive is pruned to `PROMPT_KEEP_RUNS` run ids at start, and a run warns when `.pipeline/` is not gitignored. Prompts go to the harness on stdin, never on argv.
**Why:** the earlier prompts are what you need when debugging a retry loop; they hold plaintext diffs, so they must not ship; ARG_MAX is real on macOS.
**Test:** smoke: e2e: exclusions cap | smoke: AGENTS.override.md warning + prompt retention + gitignore | smoke: e2e: happy path + @file + tasks.md checkbox

### INV-27 Findings are never displaced by tool output, and blocker history is capped
Gate findings live in their own file and enter the implement prompt as prose, untruncated; lint, test, empty-diff and integrity notes are capped at `EXCLUSIONS_MAX_LINES` newest lines. A gate log enters as head and tail (20 + 60 lines), so a test runner's summary survives. The MEMORY.md blocker history fed back is capped in entries and in bytes, newest text kept.
**Why:** a chatty linter must not push a critical out of the window, a test runner prints its failures last, and a blocker that carried a tool log must not re-enter every later prompt whole.
**Test:** smoke: P2.2 blocking findings survive a 300-line lint | smoke: P2.1 MEMORY.md feeds implement + research | smoke: F6: the blocker carries the findings, and history is byte-capped | unit: prompts.test.mjs | unit: text.test.mjs | unit: blocker.test.mjs

### INV-28 The pipeline never writes governance, and the project keeps no loop logic
Only govern writes governance; `init` validates the options and contract before writing the wrapper (executable bit recorded in the index, line endings pinned to LF in `.gitattributes`), the `.gitignore` entry and an empty issue file with any missing parent directories. Without a contract, `init` fails and points at govern without changing setup files. `/automate` forwards all supplied arguments; a missing `--harness` value is an error. The wrapper carries a version pin and no logic; the engine ships in the package and shells out to no inline programs. A contract field that still carries a decision marker refuses the run.
**Why:** a pipeline that edits the contract it runs on makes every later run wrong; a copied loop drifts and cannot be tested once.
**Test:** smoke: 1.2.0 init and doctor | unit: traceability.test.mjs | unit: yaml.test.mjs | unit: init.test.mjs | unit: pi-sdk.test.mjs

### INV-29 A role timeout ends the process tree and returns within the grace period
`ROLE_TIMEOUT_SECONDS` ends the harness process and everything it started (process group on POSIX, `taskkill /T` on Windows), empties the answer, logs status 124, and the loop continues at most half a second after the process's exit — it never waits on a grandchild that still holds stdout. The engine's own interruption ends every running role the same way.
**Why:** the typical hang is an implementer whose test run never returns; a timeout that waits for that test run is not a timeout.
**Test:** smoke: P1.2 role timeout | unit: exec.test.mjs
