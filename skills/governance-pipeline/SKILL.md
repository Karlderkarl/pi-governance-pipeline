---
name: governance-pipeline
description: Generate or audit project governance (SOUL.md, AGENTS.md, SYSTEM.md, MEMORY.md, the pipeline contract) from a PRD, or set up, dry-run, run and audit the issue-driven auto-develop pipeline shipped in this package (auto-develop.sh, /govern, /automate, /pipeline-audit). Use for these workflows, not merely because a repository contains AGENTS.md.
---

# Governance Pipeline

Governance is the source of truth; the versioned engine reads it. Never write or copy the loop, or add loop logic to the project's pinned `auto-develop.sh` wrapper.

Requires pi, bash, git and credentials for the configured providers. The engine supports Node >=18; also satisfy the installed Pi package's `engines.node` requirement.

Run commands in the project root. `<package>` is the path of this `SKILL.md` without its last three segments: for `…/pi-governance-pipeline/skills/governance-pipeline/SKILL.md` it is `…/pi-governance-pipeline`, and the CLI is `<package>/bin/pipeline.mjs`. It is not the pi installation; `pi list` shows the installed package path. Load only the references required by the selected mode.

## Mode: govern

Generate governance, or audit it after PRD/repository changes. Read [governance-files.md](references/governance-files.md) and [contract.md](references/contract.md) before writing anything: they define every file and every contract field you may write. Never invent a field or a value format that contract.md does not list.

First decide whether a human can answer: run `echo "${PIPELINE_ALLOW_GOVERNANCE_WRITE:-unset}"`. `1` means the operator authorized unattended generation and nobody will reply — do not ask; write the files, leave a marker for every unresolved decision, and report the markers. Any other value means ask in step 2 and write only after the answers; if you cannot get answers, write nothing and report what is needed.

1. Read the PRD and inspect the actual repository: stack, architecture, security/compliance needs, dependencies and lint/test/type-check commands. Report conflicts rather than choosing silently.
2. Resolve roles, models, git conventions, budgets, gates and issue source with the human. Present the proposed changes before writing; for existing files, audit first and ask per file: overwrite, merge or skip.
3. Write the four governance files and harness copies as specified in the references. These are not negotiable, whatever else is dropped:
   - The contract lives in `AGENTS.md`, in exactly one fence tagged `yaml pipeline-contract`, never in `SOUL.md` or any other file. Its shape is fixed; replace the values, add nothing else (`contract.md` explains every field):

     ```yaml
     contract_version: 2
     models:
       research:         { provider: openai,    model: gpt-5-mini }
       implement:        { provider: anthropic, model: claude-sonnet-4-5, thinking: high }
       implement_master: { provider: google,    model: gemini-2.5-pro }     # a different model than implement
       controller:       { provider: openai,    model: gpt-5-nano }
       master_review:    { provider: anthropic, model: claude-opus-4-5 }
       review:                                                               # at least two vendors
         security:       { provider: google,    model: gemini-2.5-flash }
         quality:        { provider: openai,    model: gpt-5 }
         correctness:    { provider: anthropic, model: claude-haiku-4-5 }
       constraints: { no_self_review: true }
     budgets: { max_attempts_controller: 3, max_attempts_master: 3, max_runs_per_tree: 25, max_split_depth: 1 }
     review: { blocking_severities: [critical, high], followup_severities: [medium, low] }
     issues: { source: tasks.md }                  # a path, or { command: "…", trust: external }
     gates:                                        # the repository's real commands, or gates: []
       - { name: test, run: "npm test" }
     ```

   - `.pi/APPEND_SYSTEM.md` is a byte copy of the root `SYSTEM.md`: write the root file, then `cp SYSTEM.md .pi/APPEND_SYSTEM.md`. Never paraphrase it.
   - Model ids are ids the configured providers offer (`pi --list-models`), never ones copied from this skeleton or the contract example. With only an OpenRouter key, route explicitly: `{ provider: openrouter, model: <vendor>/<model> }`; reviewers then need two different vendors.

   Mark unresolved decisions with `[USER DECISION REQUIRED]` or `[NEEDS PRD CLARIFICATION]`; the legacy `[NEEDS CLARIFICATION]` also blocks startup. Never invent answers or quote these marker phrases elsewhere in governance, even without brackets. A marker fails `doctor` and refuses a real run; a dry-run only notes prose markers (contract markers still fail validation).
4. Validate before handing over: run `node <package>/bin/pipeline.mjs doctor` and show its output; never report governance as done without it. Typical pre-automate setup findings are a missing wrapper (WARN), `.pipeline/` not gitignored (FAIL), or a missing file issue source (FAIL); `init` resolves them. A missing HEAD is a separate prerequisite for a real run, not for generating governance or running `init`. Report intentional decision-marker FAILs and these setup prerequisites explicitly; fix other FAILs within the requested scope. Contract errors require correcting the block.

Without `PIPELINE_ALLOW_GOVERNANCE_WRITE=1` an unattended session writes nothing: an existing-governance audit stays read-only. The pipeline-guard extension enforces the same variable for governance writes without a UI. Commit messages of approved work are fixed by the engine (`pipeline: <id>: <title>`); do not promise a commit convention for them in governance. Model roles never write governance; only the engine may append blocker, review-pause and approval follow-up history to `MEMORY.md`.

## Mode: automate

Use only after governance is current. Run:

```bash
node <package>/bin/pipeline.mjs init      # forward all requested init options unchanged
./auto-develop.sh --dry-run              # routing and prompts, zero model calls
```

Show both outputs. If `init` fails, stop and explain; never run an existing `auto-develop.sh` that `init` refused — it is not this package's wrapper, and replacing it needs the human's `--force`. Contract changes go through govern. Read [operations.md](references/operations.md) for option questions and before a real run. Start a real run only when requested; it needs a HEAD commit and the applicable startup confirmations.

## Mode: audit

Read [audit.md](references/audit.md) before the first command and work through every check it lists: run `doctor` and `status`, inspect the governance and harness files themselves, and report each check as PASS / WARN / FAIL / N-A with evidence. Change nothing. `doctor` passing is not readiness on its own. The checklist summarises the invariants it cites; the engine's test suite owns their verification.

## Boundaries

- Never let a prompt choose its model; routing comes from `AGENTS.md`.
- Never bypass the startup gate: `--unattended`, `--auto-merge` and an external issue source are confirmed before the loop or by `--yes`, never mid-run.
- Never edit `.pipeline/state` by hand; `node <package>/lib/governance.mjs state budget .pipeline <root_id> --set <n>` is the way to raise a ceiling.
