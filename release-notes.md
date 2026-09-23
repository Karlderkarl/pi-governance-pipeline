# v1.2.5

Closes what two independent reviews and a full live run found on 2026-09-23: `/govern`, `/automate`, `/pipeline-audit` and a real run of one issue on a throwaway project, through OpenRouter with three reviewer vendors. The run implemented, reviewed, approved and committed the issue on the first attempt; the findings below are what the path there exposed.

### Fixed

- **`init` reported success next to a wrapper it had not written.** A foreign `auto-develop.sh`, or one pinned to another version, produced a note and exit 0 with `next: ./auto-develop.sh --dry-run` — and the automate mode runs exactly that script next, so an arbitrary existing script ran as the "dry-run". Without `--force`, `init` now exits 1 before writing any setup file whenever the existing wrapper is not the one it would generate: foreign, another pin, or a configuration other than the one requested. The skill never runs a wrapper `init` refused.
- **A review panel reached only through OpenRouter was refused as a single provider.** `openrouter/google/…`, `openrouter/openai/…` and `openrouter/anthropic/…` are three vendors' models behind one API; provider diversity now counts the vendor behind an aggregator route. The same model through two routes (`openrouter/google/x`, `google/x`) is one model for `no_self_review`, escalation and every overlap warning. pi still receives the ref exactly as written. Three reviewers of one vendor behind OpenRouter are still refused.
- **The smoke suite broke against the current Pi (0.87.1).** `loadPromptTemplates` returns `{ templates, diagnostics }` since Pi 0.86; the SDK tests assumed a list. They accept both shapes and require empty `diagnostics` where Pi reports them. The skill, the prompts and the extension were unaffected; CI and the release workflow were blocked.
- **The opt-in live check could not pass.** `tests/pi-live.mjs` wrote a hand-built state without `depth` or a root issue, which the validator has refused since the schema tightened; `pipeline_state` answered `invalid state`. The state now comes from the engine's own `initState` and `recordAttempt`.

### Changed

- **The govern mode states its non-negotiable outputs in `SKILL.md` itself**: the contract in `AGENTS.md` in one `yaml pipeline-contract` fence with the v2 fields as `contract.md` defines them, `.pi/APPEND_SYSTEM.md` as a byte copy of `SYSTEM.md` (`cp`), model ids the configured providers offer, and `doctor` run and shown before governance counts as done. In a live run a model that skipped the references wrote the contract into `SOUL.md`, invented `issues.source` and gate formats, and never ran `doctor`; another paraphrased the `.pi` copy.
- **Unattended govern has an explicit signal.** The skill told the model not to ask "under `pi -p`", which a model cannot observe: in a live run it asked its questions, wrote nothing and exited 0. It now checks `PIPELINE_ALLOW_GOVERNANCE_WRITE` — the variable the guard already requires for unattended governance writes. `1` means write, with markers for open decisions; anything else means ask, and write nothing without answers.
- The audit mode reads `audit.md` before its first command and reports every check with evidence; a passing `doctor` is not readiness on its own.
- `doctor` and every run warn while `PIPELINE_GUARD=off` is set. It is often set user-wide for interactive sessions and then silently disables the guard in every implementer a run starts. It stays the operator's choice and is not dropped.
- `doctor` warns when `.pi/APPEND_SYSTEM.md` differs from `SYSTEM.md` (line endings aside): pi loads only the `.pi` copy, and a paraphrase drifts with the next edit.
- The dry-run prints the routing of `controller`, `master_review` and `implement_master`, whose prompts it cannot render because they need the panel's verdicts.
- The contract example uses Pi catalog ids (`claude-sonnet-4-5`, `gemini-2.5-pro`, …) instead of invented ones that generated governance copied, and `contract.md` documents OpenRouter routing. Governance no longer promises a commit convention for pipeline commits, which the engine writes as `pipeline: <id>: <title>`.
- `peerDependencies` for the Pi SDK is `>=0.85.1` instead of `^0.85.0`, which excluded every current Pi. 1.2.4 bounded the range to make SDK breakage visible; that job moves to the smoke suite, which now runs the SDK tests against both the newest Pi and the `peerDependencies` floor.

### Validation

- 181 unit tests on Windows (Node 26.8.2, Git Bash): 177 pass, 4 skip without `PI_TEST_SDK_DIR` and pass with the installed Pi 0.85.1.
- The full smoke suite passed (`smoke OK`), including `tsc --noEmit` against the newest SDK and the SDK tests against Pi 0.87.1 and the floor 0.85.1 (5/5 each). `npm pack --dry-run`: 59 files; `git diff --check` clean.
- `PI_LIVE_MODEL=openrouter/openai/gpt-5-mini:low node tests/pi-live.mjs` passed: packed extension and `pipeline_state`, a reviewer finding the seeded authorization regression, the blocking gate and a rejecting master.
- End to end with 1.2.4 on a throwaway project before the fixes: `/govern`, `/automate`, `/pipeline-audit` and a real run of one issue (research, implementation, three reviewers on Google, DeepSeek and Anthropic models, controller, master, commit) through OpenRouter, under two cents.
- The changed govern mode, live with `openrouter/openai/gpt-5-mini:low` and `PIPELINE_ALLOW_GOVERNANCE_WRITE=1` — the model that failed before: it checked the signal and wrote without asking, put a v2 contract that validates into `AGENTS.md` with OpenRouter routes, made `.pi/APPEND_SYSTEM.md` with `cp`, located the package and ran `doctor`, and left markers for its open decisions. It still skipped the references; the skeleton in `SKILL.md` carried the shape.
- Every code finding has a regression that fails without its fix: `tests/unit/init.test.mjs`, `tests/unit/contract.test.mjs`, `tests/unit/release-125.test.mjs`.
- No live Claude Code run and no macOS or Linux execution is claimed for this release; CI covers Ubuntu 18/22 and Windows 22.

# v1.2.4

### Fixed

- **A reviewer or master could report `critical` and the pipeline approved and committed anyway.** JSON was recovered only from fenced blocks and from the whole answer, and the whole answer is cut from the first `{` to the last `}` — across two objects that never parses. An object written as plain text next to a fenced one was therefore no candidate at all. Reproduced end to end: three reviewers reporting `critical`, a master writing `reject`, exit 0 and a commit. Every `{` is now its own starting point with fresh brace and quote state, so prose carrying an unmatched `{` or `"` cannot hide the object either.
- A `severity` or `decision` key that no parsed object holds is now unaccounted-for evidence: the reviewer loses its panel seat and the master's `approve` or `split` becomes `reject`. What the scanner cannot reach must not release work.
- A reviewer that hit `ROLE_TIMEOUT_SECONDS` lost the findings it had already written — the answer was emptied before the rule "a finding is evidence whatever the exit code" could see it. Reviewers keep their partial output and only lose the panel seat; judges and research still lose theirs, because a truncated verdict is not evidence.
- `git stash` was the one filter-running Git operation outside the integrity guard that already wraps diff capture and approval, so a project clean filter could reset `runs_used` unobserved. The stash, including the copy-out and write-back of governance, now runs inside that guard.
- `models.*.model` and `.provider` were only checked for presence. A nested map routed to `provider/[object Object]` through validation and `doctor`, and failed two attempts later at the first model call. Both must now be non-empty strings on every mapped role, not only on the reviewers.
- An `AGENTS.md` with a prose line `review:` — the section `governance-files.md` asks for — was read as a contract that failed to parse and refused the whole run. Only the `pipeline-contract` marker, or a contract key inside a fence that did not parse, counts as intent now.
- The wrapper's LF pin is verified as git resolves it, for `text` and `eol`, from the project's own `.gitattributes` evaluated alone. `linguist-generated=true` pinned nothing, `text eol=crlf` and `-text` pinned the opposite, `-text eol=lf` normalises nothing, and a rule supplied only by `core.attributesFile` or `.git/info/attributes` does not survive a clone — all four reported success before.
- Truncation of the review diff and the reviewer JSON cuts on a UTF-8 character boundary instead of mid-sequence.
- On a case-insensitive filesystem the stash restored both spellings of a context file (`AGENTS.md` and `AGENTS.MD`), renaming it on disk. The preserved set is deduplicated by real path.

### Changed

- **`--auto-merge` no longer grants implementer trust.** Granting `--approve` / `bypassPermissions` was the flag's only actual effect, which contradicted its own help text ("parsed and confirmed, not implemented") and made a flag named after merging the shortest route to a fully trusted implementer. It is still confirmed at the startup gate as the adaptation point for a real merge step. INV-08 changed with it.
- Reviewer output that cannot be fully processed carries an `unprocessed_review` finding that blocks the attempt and survives a clean retry, because a retry is a different answer and proves nothing about the first. It never enters the implement prompt — it asks the reviewer for well-formed JSON, which no implementation can supply — and two attempts in a row carrying it end the issue as a configuration error instead of spending the tree budget on a formatting problem. The reviewer prompt asks explicitly not to quote JSON out of the diff.
- `peerDependencies` are bounded (`^0.85.0` for the Pi SDK, `^1.3.0` for typebox) instead of `*`, so an SDK change that breaks the guard extension is visible.
- `--tools` is appended last in the Claude Code adapter; it is variadic and previously worked only because it happened to be written last in each branch.
- The finished 1.2.0 refactor plan and the archived review reports are no longer kept. The reproductions two of them carried are live regressions and moved to `tests/fixtures/review-2026-09-08*.repro.mjs`.

### Validation

- 176 tests passed locally on Windows (Node 26.8.1, Git Bash); 4 skip without `PI_TEST_SDK_DIR` and pass with the installed Pi SDK.
- The full smoke suite passed (`smoke OK`), as did `tsc --noEmit` against the real SDK, the guard behaviour test and `git diff --check`.
- Every finding above has a regression that fails without its fix: `tests/unit/review-2026-09-09.test.mjs` and `tests/unit/review-safety.test.mjs`, with `tests/fixtures/mixed-json-stub.mjs`, `prose-hidden-json-stub.mjs`, `quoting-reviewer-stub.mjs` and `unprocessed-review-stub.mjs`. The review-parsing regressions run to the commit decision, not only over the parser — the consequence of losing a finding was a commit, and a parser assertion does not show that.
- `P1.1 never-json run: 17 model calls` is unchanged across every round of this release, so no change moved the abort path for a broken reviewer setup.
- No live evaluation of PRD-to-governance generation, no live Claude Code run, and no macOS or Linux execution is claimed for this release; CI covers Ubuntu 18/22 and Windows 22.

# v1.2.3

### Fixed

- Reviewer findings survive retry selection even when the retry is malformed or discarded. Original and retry evidence reaches the gate and judges without adding a panel seat or inventing a reviewer verdict.
- Git clean filters cannot silently change protected governance, issue data or engine control files during diff capture, including initial and paused-run preflight. Changes are restored and the run stops; an unexpected HEAD change also stops the run.
- Approval stores the regular issue-source file without clean filters, normalizes it to LF and preserves its tracked executable bit. Commits use captured blobs and are published only after the integrity check, with hooks disabled and signing configuration respected. Linked issue sources require a manual commit.
- Changed submodule pointers produce an explicit review pause instead of a blob-reading error. Review and commit the pointer separately before resuming; unchanged restarts spend no additional implementation budget. A binary receipt or larger text cap cannot approve a submodule.
- Multiple marked pipeline-contract blocks are rejected, including empty marked examples. A lone marked block without recognized top-level contract fields also refuses; it cannot hide an unmarked real contract. `doctor` and `init` now pass their supplied environment to contract validation.
- Decision-marker phrases quoted in engine-written blocker and pause history are escaped, preserving readable text without blocking unrelated issues. Genuine open decisions still prevent a real run.
- Unset and empty numeric tuning values retain their silent defaults. Invalid non-empty values emit a warning naming the supplied value and fallback. Unsafe integers are rejected as tuning values too.
- Git-operation snapshots spill protected files above 1 MiB to temporary recovery copies outside the working tree. Large files are hashed in bounded chunks, and corrupted recovery copies are refused.

### Changed

- Approving an issue records its accepted `medium`/`low` findings in `MEMORY.md` as `## Follow-ups — <id> (<date>)`, with decision-marker phrases escaped like every other engine-written history. `gate.json` lives under the gitignored `.pipeline/`, so it was not a place a follow-up survived. The pipeline still creates no tickets and never reads these entries back into a prompt; PRD R6 describes this explicitly.

- Documentation clarifies all three decision markers, setup and HEAD prerequisites, map-form gates, command-source shorthand, run-lock locations and the engine's MEMORY.md exception. The audit checklist now covers review pauses, binary receipts and submodules.
- The existing implementer trust granted by `--auto-merge` alone and Claude Code's differing role isolation are explicit. Branch merging remains unimplemented.
- Skill runtime requirements refer to the installed Pi package's `engines.node` instead of a fixed Pi version. README consistently documents the 512 KiB text-diff default.
- The smoke timeout check measures a hanging role directly; the integration scenario separately checks twelve reviewer timeouts and fail-closed panel handling, without treating total Git and filesystem time as role execution time. A separate 60-second ceiling bounds the complete timeout scenario, allowing margin above the previously observed 36-second Windows run.

### Validation

- 154 tests passed locally on Windows (Node 26.8.1, Git Bash) with the real Pi SDK and no skips, including the lone marked-contract regression, large-file recovery, corrupted recovery-copy rejection and the follow-up recording.
- The full smoke suite passed (`smoke OK`) with a real SDK bootstrap, as did ShellCheck, the Bash syntax check and `git diff --check`. The process-tree probe returned status 124 in about 1.9 seconds with a one-second role limit and a child sleeping for 20 seconds; the complete timeout scenario finished in 23 seconds against its separate 60-second ceiling.
- `npm pack --dry-run`: 59 files, 109.7 kB packed, 334.8 kB unpacked, version 1.2.3.
- The counterexamples of both 1.2.2 reviews run as regressions: `tests/unit/review-fixes.test.mjs` with `tests/fixtures/review-counterexamples.mjs`.
- No live evaluation of PRD-to-governance generation, no live Claude Code run, and no macOS or Linux execution is claimed for this release; CI covers Ubuntu 18/22 and Windows 22.

# v1.2.2

### Fixed

- Failed reviewer/master processes cannot release work. Malformed reviewer arrays never fill a panel seat, and findings from every JSON candidate survive recovery. Deduplication preserves configured blocking membership even for unusual severity partitions.
- Attempts are reserved before model startup, state writes are atomic, and invalid state/schema fails doctor, status and real runs. A per-worktree Git-directory lock excludes competing API/CLI runs and state mutations independently of TEMP/TMPDIR; doctor reports existing locks.
- Split descendants retain their original tree budget at every supported depth. Invocation caps preserve split resumption, and contributor history excludes previous implementers from reviewing retained code across escalation and restart.
- Explicit null and other wrong contract types refuse. Relocated governance stays out of review and approval. Issue operations compare entire IDs and reject ambiguous duplicates. Init reports requested harness/local changes that require --force.
- Governance and control snapshots cover model processes, gates and command issue-source reads, including split resumption. Link-aware restoration preserves existing target data and stops on incomplete recovery. State, Git config, hooks and run locks are protected; approval Git commands disable hooks.
- Approval commits the exact Git-normalized blobs captured for review through an isolated index. Later worktree changes or clean-filter transformations cannot add implementation content to the commit. Unrelated staged entries remain staged; failed commits and refused block/split stashes stop subsequent work.
- Decision markers anywhere in governance prevent a real run; dry-run reports them without model work. Pi non-implementer isolation explicitly suppresses discovered executable resources and custom system-prompt files.

### Added

- Persistent review pauses: truncated or omitted content records a reason in state and MEMORY.md, exits 1 and retains the work. Unchanged restarts check coverage before starting a model. Started implementation attempts remain counted.
- A documented binary-review workflow: a human inspects exact Git blobs and supplies an approved SHA-256 receipt outside the working tree through BINARY_REVIEW_FILE. Hashes identify approved bytes; neither --yes nor --unattended grants binary approval.
- Regression coverage for the original F01–F13 findings and the later F14–F18/G01–G02 counterexamples, using isolated repositories, real Git operations and separate processes.

### Changed

- DIFF_MAX_BYTES defaults to 524288 (512 KiB), up from 65536. Text and binary pause messages name different recovery steps.
- Skill instructions, README, operating instructions and invariant documentation describe the enforced behavior and the boundary between text review and human binary review.
- Release notes are included in the npm package. Installation examples pin 1.2.2.

### Validation

Release validation and the finding-to-test mapping are recorded in
[the 1.2.2 validation report](https://github.com/Karlderkarl/pi-governance-pipeline/blob/v1.2.2/docs/release-1.2.2-validation.md).
The GitHub release workflow runs unit and smoke tests before publishing through
npm Trusted Publishing. Local validation uses Windows, Node 26.8.1 and the real Pi
SDK. No live model run is claimed for this release.

**Full Changelog**: https://github.com/Karlderkarl/pi-governance-pipeline/compare/v1.2.1...v1.2.2

# v1.2.1

A smaller skill context, with the same pipeline engine and safeguards as 1.2.0.

### Changed

- **Lean skill instructions.** Shared workflow rules live in `SKILL.md`; slash prompts select a mode and pass its arguments instead of repeating the rules. The entrypoint shrinks from 68 to 42 lines.
- **Focused project audits.** `/pipeline-audit` uses a short, read-only checklist with `doctor` and `status`. The full invariants remain available for unresolved behavior questions instead of being required reading for every audit.
- **Maintainer documentation stays out of the skill context.** Engine prompt design moves from the skill references to `docs/prompt-builders.md`, which is not included in the npm package. README and install examples reflect the new layout and version.

### Fixed

- The audit checklist distinguishes supported legacy v1 contracts from invalid configuration. A zero exit code from `doctor` is not, by itself, a readiness verdict.
- Prompt-design documentation now matches the implementation: severity values are trimmed and case-folded, retries need a strictly better parse-quality rank without losing severity, and controller/master inputs are distinguished from independent reviewer inputs.
- Pi SDK integration tests skip unsupported Node 22 minors below 22.19 instead of checking the major version alone; a regression pins the supported runtime boundary.

### Added

- Real Pi SDK coverage for discovering all three slash prompts, selecting existing skill modes and preserving explicit, quoted and omitted PRD arguments. The `/automate` regression now loads templates through Pi's own loader.
- Regression coverage for skill-reference links remaining inside the published package and for referenced invariant identifiers existing.

No changes to engine code, guard behavior, model routing, budget accounting, commit scope or role isolation.

### Validation

- Read-only release review with Pi 0.85.1 and `openrouter/openai/gpt-5-mini:high`; the second pass approved the corrected candidate with no findings.
- 87 tests passed locally on Windows, including the real Pi SDK loader/parser checks; no skipped tests. The full smoke suite and ShellCheck passed.
- The packed 1.2.1 artifact passed the live Pi check with `openrouter/openai/gpt-5-mini:low`: extension loading, `pipeline_state`, seeded reviewer finding, deterministic blocking gate and master rejection.
- Package inspection confirmed all three prompts and the audit checklist are included, while maintainer docs stay repository-only.

The Pi release review is static; the live fixture verifies integration, not a complete multi-provider development run. Claude Code remains stub-verified only.

**Full Changelog**: https://github.com/Karlderkarl/pi-governance-pipeline/compare/v1.2.0...v1.2.1
