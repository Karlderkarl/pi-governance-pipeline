#!/usr/bin/env bash
# auto-develop.sh — reference implementation of the governance-driven pipeline.
#
# Adapt per project: ISSUE_SOURCE (a tasks.md file, or !command), LINT_CMD,
# TEST_CMD. Everything else is read from governance. Do not hardcode a model
# here — the mapping in AGENTS.md is what makes routing changeable without
# touching this file. Keep the script at the repository root: ROOT is the
# script's own directory.
#
#   ./auto-develop.sh --dry-run
#   ./auto-develop.sh --issue issue-42
#   ./auto-develop.sh --unattended --yes
#   ./auto-develop.sh --auto-merge --yes   # stub — does not merge

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$ROOT/$(basename "${BASH_SOURCE[0]}")"   # absolute: $0 may be relative, and we cd below
cd "$ROOT"   # child `pi -p` processes work here, never in the caller's cwd
LIB="${PIPELINE_LIB:-$ROOT/.pipeline/lib}"
PIPELINE_DIR="$ROOT/.pipeline"
AGENTS_FILE="${AGENTS_FILE:-$ROOT/AGENTS.md}"
SOUL_FILE="${SOUL_FILE:-$ROOT/SOUL.md}"
MEMORY_FILE="${MEMORY_FILE:-$ROOT/MEMORY.md}"

ISSUE_SOURCE="${ISSUE_SOURCE:-$ROOT/tasks.md}"   # file of "- [ ] id: ..." lines, or !command printing "id: ..."
LINT_CMD="${LINT_CMD:-}"                          # adapt: npm run lint, ruff, ...
TEST_CMD="${TEST_CMD:-}"                          # adapt: npm test, pytest, ...
# The diff is prompt input — cap it like every other excerpt, or an unignored
# build directory flushes into every reviewer prompt on every attempt.
DIFF_MAX_BYTES="${DIFF_MAX_BYTES:-65536}"
[[ "$DIFF_MAX_BYTES" =~ ^[0-9]+$ ]] || DIFF_MAX_BYTES=65536
# exclusions.md grows by one block per failed gate and per rejected attempt;
# cap what re-enters the implement prompt, or a chatty linter inflates it
# exponentially over the attempt tree.
EXCLUSIONS_MAX_LINES="${EXCLUSIONS_MAX_LINES:-200}"
[[ "$EXCLUSIONS_MAX_LINES" =~ ^[0-9]+$ ]] || EXCLUSIONS_MAX_LINES=200
# The contract promises independent reviewers; no_self_review drops and
# unparseable output can shrink the panel at run time. Below this floor no
# independent check is left, and the gate must block instead of approving.
MIN_REVIEWERS="${MIN_REVIEWERS:-2}"
[[ "$MIN_REVIEWERS" =~ ^[0-9]+$ ]] || MIN_REVIEWERS=2

UNATTENDED=0; AUTO_MERGE=0; DRY_RUN=0; ASSUME_YES=0; ONLY_ISSUE=""
FAILED_ISSUES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --unattended) UNATTENDED=1 ;;
    --auto-merge) AUTO_MERGE=1 ;;
    --dry-run)    DRY_RUN=1 ;;
    --yes|-y)     ASSUME_YES=1 ;;
    --issue)      ONLY_ISSUE="${2:?--issue needs an id}"; shift ;;
    -h|--help)    sed -n '2,13p' "$SELF"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
  shift
done

die() { echo "error: $*" >&2; exit 1; }

# The flag is parsed and confirmed at the safety gate so an adapted script can
# hook a real merge here. The reference implementation does not merge.
(( AUTO_MERGE )) && echo "auto-merge: not implemented in the reference script — adapt this step" >&2

# ---------------------------------------------------------------- safety gate
# pi has no permission dialog and `pi -p` has no UI. This startup gate is the
# only place a human can intervene, so it runs before the loop, never inside it.
if (( UNATTENDED || AUTO_MERGE )); then
  if (( ! ASSUME_YES )); then
    [[ -t 0 ]] || die "--unattended/--auto-merge on a non-interactive stdin requires --yes"
    read -r -p "Run unattended (privileged steps, auto-merge=$AUTO_MERGE)? [y/N] " reply
    [[ "$reply" == [yY]* ]] || die "aborted at the safety gate"
  fi
  # The pipeline-guard extension cannot ask under `pi -p` and would block every
  # privileged step of the child processes. The human confirmed above, once —
  # the two halves of the safety rule meet at this variable.
  export PIPELINE_UNATTENDED=1
fi

# ------------------------------------------------------------------ contract
command -v node >/dev/null || die "node is required (contract parser and review gate)"
[[ -f "$LIB/governance.mjs" ]] || die "missing $LIB/governance.mjs"
# Reviewers read the working-tree diff. Without a repo the empty-diff check
# would burn the whole tree budget and then block a correct implementation.
git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || die "auto-develop.sh requires a git repository"

CONFIG="$(node "$LIB/governance.mjs" config "$AGENTS_FILE")" || exit 2
MODELS_JSON="$(node "$LIB/governance.mjs" models "$AGENTS_FILE")" || exit 2
BLOCKING="$(node -e 'const c=JSON.parse(process.argv[1]);console.log(c.review.blocking_severities.join(","))' "$CONFIG")"
FOLLOWUP="$(node -e 'const c=JSON.parse(process.argv[1]);console.log(c.review.followup_severities.join(","))' "$CONFIG")"
MAX_CTRL="$(node -e 'console.log(JSON.parse(process.argv[1]).budgets.max_attempts_controller)' "$CONFIG")"
MAX_MASTER="$(node -e 'console.log(JSON.parse(process.argv[1]).budgets.max_attempts_master)' "$CONFIG")"
NO_SELF_REVIEW="$(node -e 'console.log(JSON.parse(process.argv[1]).models.constraints.no_self_review)' "$CONFIG")"

# Models are resolved once, up front: warnings surface exactly once, and a
# later unreadable AGENTS.md cannot silently flip routing mid-run.
# Invoke refs may carry pi's :<thinking> suffix (see --model / --thinking).
model_for() { node -e 'const m=JSON.parse(process.argv[1]);console.log(m[process.argv[2]]??"default")' "$MODELS_JSON" "$1"; }
# Identity for no_self_review is provider/model. Thinking is a launch
# parameter, not a different model — sonnet:high and sonnet:low still collide.
model_identity() {
  case "$1" in
    *:off|*:minimal|*:low|*:medium|*:high|*:xhigh|*:max) printf '%s\n' "${1%:*}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# ------------------------------------------------------------------- logging
RUN_ID="$(date +%Y%m%dT%H%M%S)"
log_event() { # log_event <root> <issue> <role> <model> <status> <prompt_path>
  local dir="$PIPELINE_DIR/logs/$1"; mkdir -p "$dir"
  # node does the JSON encoding: no shell-escaping bugs, and one short-lived
  # writer per event when the three reviewers finish at the same time.
  node -e '
    const [file,ts,issue,role,model,status,prompt]=process.argv.slice(1);
    require("node:fs").appendFileSync(file, JSON.stringify({ts,issue,role,model,status,prompt})+"\n");
  ' "$dir/$RUN_ID.jsonl" "$(date +%Y-%m-%dT%H:%M:%S%z)" "$2" "$3" "$4" "$5" "$6"
}

# ------------------------------------------------------------------- runners
# One role, one process, one fresh context. Reviewers stay independent because
# they are separate processes, not because we asked them to be.
run_role() { # run_role <root> <issue> <role.path> <prompt> <outfile> [attempt-tag]
  local root="$1" issue="$2" role="$3" prompt="$4" out="$5" att="${6:-}"
  local model; model="$(model_for "$role")"
  local pdir="$PIPELINE_DIR/prompts/$root"; mkdir -p "$pdir" "$(dirname "$out")"
  # One file per attempt, not one per role: the earlier prompts are exactly
  # what you want when debugging a retry loop.
  local ppath="$pdir/${issue}-${role//./_}${att:+-$att}-$RUN_ID.txt"
  printf '%s\n' "$prompt" > "$ppath"

  if (( DRY_RUN )); then
    echo "[dry-run] $role -> ${model} (prompt: $ppath)"
    log_event "$root" "$issue" "$role" "$model" "dry-run" "$ppath"
    return 0
  fi

  # Prompt-on-argv exceeds macOS ARG_MAX (~256 KB including the environment),
  # so the body goes in on stdin: pi reads piped stdin as the message verbatim.
  # @file would also avoid argv, but pi wraps a file in <file name="..."> and
  # the roles expect their prompt as an instruction, not as an attachment.
  # The redirect is also what keeps main()'s `done <<< "$issues"` here-string
  # out of pi's stdin — unredirected, pi would drain the remaining issue lines
  # into the prompt and the loop would never see them.
  local status=0
  if [[ "$model" == "default" ]]; then
    pi -p < "$ppath" > "$out" || status=$?
  else
    pi -p --model "$model" < "$ppath" > "$out" || status=$?
  fi
  log_event "$root" "$issue" "$role" "$model" "$status" "$ppath"
  return $status
}

excerpt() { [[ -f "$1" ]] && sed -n "1,${2:-200}p" "$1" || true; }

# ------------------------------------------------------------------- prompts
build_review_prompt() { # <focus> <issue> <difffile>
  cat <<EOF
You review a diff for one concern only: $1. Stay in your lane — a comment
outside it dilutes the signal and inflates the finding count.

Severity definitions, use exactly these:
  critical - exploitable now, data loss, or the feature is fundamentally broken
  high     - a real bug or vulnerability under plausible conditions
  medium   - should be fixed, but shipping without it is defensible
  low      - style, polish, nitpick

Issue:
$2

Project standards:
$(excerpt "$SOUL_FILE" 120)

Diff:
$(cat "$3")

Emit ONLY this JSON, no prose and no code fence:
{"role":"$1","verdict":"approve|reject","findings":[{"severity":"high","file":"path","line":42,"title":"","rationale":"","suggestion":""}]}
EOF
}

build_implement_prompt() { # <issue> <researchfile> <exclusionfile> <attempts_left>
  # tail, not head: the retry must fix the newest failure, not re-read the
  # first. Above the cap, the oldest blocks are omitted and the prompt says so.
  # The block is built before the heredoc so its surrounding blank lines can
  # be conditional: ${excl:+...} expands to nothing when there are no prior
  # findings — a trailing printf inside a heredoc $() would be stripped, and
  # an unconditional blank line would stack in the empty case.
  local excl=""
  if [[ -s "$3" ]]; then
    excl="$( printf 'Previous attempts were rejected for these findings. Repeating any of them fails again:\n'
      if (( $(wc -l < "$3") > EXCLUSIONS_MAX_LINES )); then
        printf '[older blocks omitted — newest %s lines kept]\n' "$EXCLUSIONS_MAX_LINES"
      fi
      tail -n "$EXCLUSIONS_MAX_LINES" "$3" )"
  fi
  cat <<EOF
Implement this issue test-first: write the failing test, watch it fail, make it pass.

Issue:
$1

Research notes:
$(excerpt "$2" 200)

Project coding standards:
$(excerpt "$SOUL_FILE" 120)

${excl:+$excl

}You have $4 attempt$( (( $4 == 1 )) || printf 's' ) left. Change the code only; do not edit governance files.
Leave your changes uncommitted in the working tree — the reviewers read the
working-tree diff, and committed work would be invisible to them.
EOF
}

# ---------------------------------------------------------------------- diff
# Reviewers must see what actually changed. `git diff` alone hides untracked
# files — and TDD writes new test files — so new files are appended explicitly.
capture_diff() { # <outfile>
  local out="$1"; : > "$out"
  git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  # Governance files never belong in the review diff: the implement prompt
  # forbids them, pipeline-guard blocks them, and block_issue writes MEMORY.md.
  # Leaving MEMORY.md in would let a prior blocker look like an implementation.
  if git -C "$ROOT" rev-parse --verify HEAD >/dev/null 2>&1; then
    git -C "$ROOT" diff HEAD -- . \
      ':(exclude).pipeline' ':(exclude)MEMORY.md' ':(exclude)SOUL.md' \
      ':(exclude)AGENTS.md' ':(exclude)SYSTEM.md' ':(exclude)CLAUDE.md' \
      >> "$out" 2>/dev/null || true
  else
    git -C "$ROOT" diff -- . \
      ':(exclude).pipeline' ':(exclude)MEMORY.md' ':(exclude)SOUL.md' \
      ':(exclude)AGENTS.md' ':(exclude)SYSTEM.md' ':(exclude)CLAUDE.md' \
      >> "$out" 2>/dev/null || true
  fi
  local f
  git -C "$ROOT" ls-files --others --exclude-standard 2>/dev/null | while IFS= read -r f; do
    case "$f" in
      .pipeline/*|MEMORY.md|SOUL.md|AGENTS.md|SYSTEM.md|CLAUDE.md|"") continue ;;
    esac
    if [[ -s "$ROOT/$f" ]] && ! grep -qI . "$ROOT/$f" 2>/dev/null; then
      printf '\n--- new file (untracked, binary — omitted): %s ---\n' "$f" >> "$out"
      continue
    fi
    printf '\n--- new file (untracked): %s ---\n' "$f" >> "$out"
    cat "$ROOT/$f" >> "$out" 2>/dev/null || true
  done || true
  if (( $(wc -c < "$out") > DIFF_MAX_BYTES )); then
    # dd, not head -c: BSD/macOS head has no -c. One block read = first N bytes.
    dd if="$out" of="$out.trunc" bs="$DIFF_MAX_BYTES" count=1 2>/dev/null
    printf '\n[diff truncated at %s bytes; the rest is in the working tree]\n' "$DIFF_MAX_BYTES" >> "$out.trunc"
    mv "$out.trunc" "$out"
  fi
}

# --------------------------------------------------------------------- issues
next_issues() {
  # A leading ! means "run this command"; its stdout is one open issue per
  # line ("id: title"), the same shape the file form has after stripping the
  # markdown checkbox. Adapting to gh or Jira is then a one-line assignment,
  # not a rewrite of this function. eval is intentional and matches LINT_CMD.
  if [[ "$ISSUE_SOURCE" == !* ]]; then
    local rc=0
    eval "${ISSUE_SOURCE#!}" || rc=$?
    (( rc == 0 )) || die "issue source failed (exit $rc)"
    return 0
  fi
  [[ -f "$ISSUE_SOURCE" ]] || die "issue source not found: $ISSUE_SOURCE"
  # grep exits 1 when nothing is open; that is a normal result, not an error.
  grep -E '^- \[ \] ' "$ISSUE_SOURCE" | sed -E 's/^- \[ \] //' || true
}

# Keep tasks.md in step with the state file so a human reading the source
# does not re-open work the harness already marked done. Command sources
# (!...) own their own done-state — we do not rewrite their stdout.
mark_issue_done() {
  local id="$1"
  [[ "$ISSUE_SOURCE" == !* ]] && return 0
  [[ -f "$ISSUE_SOURCE" ]] || return 0
  node -e '
    const fs = require("node:fs");
    const id = process.argv[1], p = process.argv[2];
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("^(- \\[ \\] )" + esc + "(?=:|\\s|$)");
    const lines = fs.readFileSync(p, "utf8").split("\n");
    let n = 0;
    const out = lines.map((l) => {
      if (!n && re.test(l)) { n = 1; return l.replace("- [ ] ", "- [x] "); }
      return l;
    });
    fs.writeFileSync(p, out.join("\n"));
  ' "$id" "$ISSUE_SOURCE"
}

block_issue() { # <issue_id> <reason> — never silent: MEMORY.md, state, human
  GOVERNANCE_AGENTS="$AGENTS_FILE" node "$LIB/governance.mjs" \
    state issue "$PIPELINE_DIR" "$1" "$1" blocked >/dev/null || true
  {
    echo ""
    echo "## Blocker — $1 ($(date +%Y-%m-%d))"
    echo ""
    echo "$2"
  } >> "$MEMORY_FILE"
  echo "blocked: $1 — written to $MEMORY_FILE" >&2
}

# ----------------------------------------------------------------------- loop
process_issue() {
  local issue_line="$1"
  local issue_raw="${issue_line%%:*}"
  local issue_id="$issue_raw"
  # The id becomes a directory name — keep it path-safe whatever tasks.md holds.
  # mark_issue_done still needs the raw token; sanitising it made slash ids a no-op.
  issue_id="${issue_id//[^A-Za-z0-9._-]/-}"
  [[ -n "$issue_id" ]] || { echo "cannot derive an issue id from: $issue_line" >&2; FAILED_ISSUES+=("$issue_line"); return 0; }
  local root="$issue_id"
  local work="$PIPELINE_DIR/work/$issue_id"; mkdir -p "$work"

  local ctrl_attempts=0 master_attempts=0
  if (( ! DRY_RUN )); then
    # init reads the contract for the tree budget — GOVERNANCE_AGENTS is
    # required here, or the state silently falls back to defaults.
    GOVERNANCE_AGENTS="$AGENTS_FILE" node "$LIB/governance.mjs" state init "$PIPELINE_DIR" "$root" >/dev/null
    GOVERNANCE_AGENTS="$AGENTS_FILE" node "$LIB/governance.mjs" state issue "$PIPELINE_DIR" "$root" "$issue_id" >/dev/null
    # Resume: counters come back from the state file, not from this run.
    local attempts_json issue_status
    attempts_json="$(node "$LIB/governance.mjs" state attempts "$PIPELINE_DIR" "$root" "$issue_id")"
    ctrl_attempts="$(node -e 'console.log(JSON.parse(process.argv[1]).controller)' "$attempts_json")"
    master_attempts="$(node -e 'console.log(JSON.parse(process.argv[1]).master)' "$attempts_json")"
    issue_status="$(node -e 'console.log(JSON.parse(process.argv[1]).status)' "$attempts_json")"
    if [[ "$issue_status" == "blocked" || "$issue_status" == "done" ]]; then
      echo "skip $issue_id (status: $issue_status)"
      return 0
    fi
  fi

  # Research runs once per issue, not per attempt, and is cached.
  if [[ ! -s "$work/research.md" ]]; then
    run_role "$root" "$issue_id" research \
      "Gather context for this issue. Name the relevant files, the existing patterns to follow, and the pitfalls. Do not write code.

Issue:
$issue_line

Stack and architecture:
$(excerpt "$SOUL_FILE" 120)" "$work/research.md" || true
  fi

  touch "$work/exclusions.md"   # resume keeps the findings of earlier attempts

  while :; do
    # Budget is checked before the attempt, never after — and only exit 3
    # means "exhausted"; anything else is a broken state store: fail loudly.
    if (( ! DRY_RUN )); then
      local budget_rc=0
      node "$LIB/governance.mjs" state budget "$PIPELINE_DIR" "$root" >/dev/null || budget_rc=$?
      case "$budget_rc" in
        0) ;;
        3) block_issue "$issue_id" "Tree budget exhausted after $ctrl_attempts controller and $master_attempts master attempts."
           FAILED_ISSUES+=("$issue_id"); return 0 ;;
        *) echo "state store error: budget check exited $budget_rc" >&2
           FAILED_ISSUES+=("$issue_id"); return 0 ;;
      esac
    fi

    local attempt_n=$(( ctrl_attempts + master_attempts + 1 ))
    # Zero-padded so the prompt archive sorts chronologically in plain ls.
    local att; att="$(printf 'a%02d' "$attempt_n")"
    local role="implement" left=$(( MAX_CTRL - ctrl_attempts ))
    if (( ctrl_attempts >= MAX_CTRL )); then
      role="implement_master"; left=$(( MAX_MASTER - master_attempts ))
      if (( master_attempts >= MAX_MASTER )); then
        block_issue "$issue_id" "Rejected at master review $master_attempts times. Unresolved findings:
$(cat "$work/exclusions.md")"
        FAILED_ISSUES+=("$issue_id")
        return 0
      fi
    fi

    # Snapshot HEAD so an implementer that commits (against the prompt) can
    # be distinguished from one that wrote nothing at all.
    local head_before=""
    if git -C "$ROOT" rev-parse --verify HEAD >/dev/null 2>&1; then
      head_before="$(git -C "$ROOT" rev-parse HEAD)"
    fi

    run_role "$root" "$issue_id" "$role" \
      "$(build_implement_prompt "$issue_line" "$work/research.md" "$work/exclusions.md" "$left")" \
      "$work/implement.log" "$att" || true

    if [[ "$role" == "implement" ]]; then ctrl_attempts=$((ctrl_attempts+1)); else master_attempts=$((master_attempts+1)); fi
    if (( ! DRY_RUN )); then
      GOVERNANCE_AGENTS="$AGENTS_FILE" node "$LIB/governance.mjs" state attempt "$PIPELINE_DIR" "$root" "$issue_id" \
        "$([[ "$role" == "implement" ]] && echo controller || echo master)" >/dev/null
    fi

    # Deterministic gates first. A lint failure must not consume a review cycle.
    # The failure output goes into exclusions.md — without it the retry re-runs
    # the identical prompt, learns nothing, and burns the whole tree budget.
    if (( ! DRY_RUN )); then
      [[ -n "$LINT_CMD" ]] && { eval "$LINT_CMD" > "$work/lint.log" 2>&1 || {
        echo "lint failed; feeding the output back and retrying implementation" >&2
        { echo "--- lint failed (attempt $((ctrl_attempts + master_attempts))) ---"
          excerpt "$work/lint.log" 80; echo; } >> "$work/exclusions.md"
        continue
      }; }
      [[ -n "$TEST_CMD" ]] && { eval "$TEST_CMD" > "$work/test.log" 2>&1 || {
        echo "tests failed; feeding the output back and retrying implementation" >&2
        { echo "--- tests failed (attempt $((ctrl_attempts + master_attempts))) ---"
          excerpt "$work/test.log" 80; echo; } >> "$work/exclusions.md"
        continue
      }; }
    fi

    capture_diff "$work/diff.patch"

    # Empty diff is fail-closed: "nothing to find" is not "no findings". An
    # implementer that commits leaves a clean tree, reviewers would rubber-stamp
    # an empty patch, and the issue would be marked done without a review.
    if (( ! DRY_RUN )) && [[ ! -s "$work/diff.patch" ]]; then
      local head_after="" empty_reason
      if git -C "$ROOT" rev-parse --verify HEAD >/dev/null 2>&1; then
        head_after="$(git -C "$ROOT" rev-parse HEAD)"
      fi
      if [[ -n "$head_before" && -n "$head_after" && "$head_before" != "$head_after" ]]; then
        empty_reason="HEAD moved (${head_before:0:7} -> ${head_after:0:7}). The implementer committed; reviewers only see the working-tree diff. Leave the implementation uncommitted."
      else
        empty_reason="The working tree was unchanged. Leave the implementation uncommitted."
      fi
      echo "empty diff; retrying implementation" >&2
      { echo "--- attempt $((ctrl_attempts + master_attempts)) (empty diff) ---"
        echo "$empty_reason"
        echo; } >> "$work/exclusions.md"
      continue
    fi

    # Three reviewers, three processes, in parallel, no shared verdicts.
    # no_self_review: the model that wrote the diff never reviews it. When both
    # sides resolve to "default" a collision cannot be proven, so the drop only
    # applies to explicitly mapped models — map at least the implement roles.
    # `ran`/`ran_focus` record exactly the reviewers started in THIS attempt,
    # in order. Gate, controller, master, and the retry loop consume this list —
    # never a directory glob — so a verdict written before a reviewer was
    # dropped cannot outlive its diff and gate attempts it never reviewed.
    local impl_model; impl_model="$(model_for "$role")"
    local pids=() ran=() ran_focus=() ran_n=0 focus rmodel
    for focus in security quality correctness; do
      rmodel="$(model_for "review.$focus")"
      if [[ "$NO_SELF_REVIEW" == "true" && "$impl_model" != "default" && "$(model_identity "$rmodel")" == "$(model_identity "$impl_model")" ]]; then
        echo "no_self_review: reviewer $focus dropped — $rmodel implemented this diff" >&2
        log_event "$root" "$issue_id" "review.$focus" "$rmodel" "dropped-self-review" "-"
        # A leftover file is a verdict on a different diff by a reviewer that
        # is now disqualified. Remove it so nothing downstream can read it.
        (( DRY_RUN )) || rm -f "$work/review-$focus.json"
        continue
      fi
      run_role "$root" "$issue_id" "review.$focus" \
        "$(build_review_prompt "$focus" "$issue_line" "$work/diff.patch")" \
        "$work/review-$focus.json" "$att" &
      pids+=($!)
      ran+=("$work/review-$focus.json")
      ran_focus+=("$focus")
      ran_n=$((ran_n+1))
    done
    for pid in ${pids[@]+"${pids[@]}"}; do wait "$pid" || true; done

    (( DRY_RUN )) && { echo "[dry-run] stopping after one pass for $issue_id"; return 0; }

    # One retry per reviewer whose output is not parseable JSON, as specified
    # in prompt-builders.md. Still unparseable afterwards: gate.mjs treats the
    # reviewer as unavailable and gates on the rest — down to MIN_REVIEWERS,
    # below which it blocks instead of approving. Only this attempt's
    # reviewers (ran) are eligible — the retry must never resurrect a dropped
    # reviewer to review its own implementation.
    local i rfile
    for (( i = 0; i < ran_n; i++ )); do
      focus="${ran_focus[$i]}"; rfile="${ran[$i]}"
      [[ -f "$rfile" ]] || continue
      if ! node "$LIB/gate.mjs" --check "$rfile" >/dev/null 2>&1; then
        echo "reviewer $focus returned unparseable JSON; one retry with an explicit reminder" >&2
        run_role "$root" "$issue_id" "review.$focus" \
          "$(build_review_prompt "$focus" "$issue_line" "$work/diff.patch")

REMINDER: your previous output was not parseable. Emit ONLY the JSON object — no prose, no code fence." \
          "$rfile" "$att-retry" || true
      fi
    done

    # Gate, controller, and master consume exactly this attempt's reviewers —
    # the explicit ran list, never a glob of whatever files happen to exist.
    local gate_status=0 reviewers_json
    if (( ran_n > 0 )); then
      node "$LIB/gate.mjs" --blocking "$BLOCKING" --followup "$FOLLOWUP" \
        --min-reviewers "$MIN_REVIEWERS" "${ran[@]}" > "$work/gate.json" || gate_status=$?
      # gate.mjs marks a missing reviewer file unavailable and carries on; the
      # prompt assembly must not abort the whole run on that same event.
      reviewers_json="$(cat "${ran[@]}" 2>/dev/null || true)"
    else
      # Every reviewer was dropped this attempt (e.g. all equal
      # implement_master). Gating on nothing is not a gate: fail closed.
      printf '%s\n' '{"verdict":"blocked","reviewers_used":0,"reviewers_unavailable":["all dropped by no_self_review"],"min_reviewers":'"$MIN_REVIEWERS"',"blocking":[],"followups":[]}' \
        > "$work/gate.json"
      gate_status=4
      reviewers_json="(no reviewer output: every reviewer was dropped by no_self_review in this attempt)"
    fi

    # The controller proposes on a weak model; the master decides and sees the
    # original reviewer JSON, so an aggregation error is catchable.
    run_role "$root" "$issue_id" controller \
      "Merge these reviewer JSON objects. Deduplicate findings naming the same file and line, apply the severity rule (blocking: $BLOCKING), and propose a verdict. You do not decide; the master sees the originals regardless. Emit only JSON.

$reviewers_json" "$work/controller.json" "$att" || true

    run_role "$root" "$issue_id" master_review \
      "Decide this attempt. Check the controller's arithmetic against the original reviewer JSON rather than trusting it.

Issue:
$issue_line

Diff:
$(cat "$work/diff.patch")

Original reviewer output:
$reviewers_json

Controller proposal:
$(cat "$work/controller.json")

Deterministic gate: $(cat "$work/gate.json")
Attempt $((ctrl_attempts + master_attempts)).

Outcomes:
- approve: no blocking findings and the diff resolves the issue
- reject: back to implementation; list what must change
- take_over: the approach itself is wrong; a stronger model implements the next attempt fresh from the issue

Emit ONLY this JSON, no prose and no code fence:
{\"decision\":\"approve|reject|take_over\",\"reasons\":[\"...\"]}" "$work/master.txt" "$att" || true

    # The verdict is machine-readable and fail-closed: anything that is not a
    # parseable decision counts as reject. Never grep prose for a verdict.
    local decision
    decision="$(node -e '
      const fs=require("node:fs");
      let text=""; try{ text=fs.readFileSync(process.argv[1],"utf8"); }catch{ console.log("reject"); process.exit(0); }
      const fenced=text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
      const cand=fenced?fenced[1]:text;
      const s=cand.indexOf("{"), e=cand.lastIndexOf("}");
      let d="reject";
      if(s!==-1&&e>s){ try{
        const j=JSON.parse(cand.slice(s,e+1));
        const v=String(j.decision||"").toLowerCase();
        if(["approve","reject","take_over"].includes(v)) d=v;
      }catch{} }
      console.log(d);
    ' "$work/master.txt")"

    if [[ "$decision" == "approve" && "$gate_status" == "0" ]]; then
      GOVERNANCE_AGENTS="$AGENTS_FILE" node "$LIB/governance.mjs" state issue "$PIPELINE_DIR" "$root" "$issue_id" done >/dev/null || true
      echo "approved: $issue_id"
      mark_issue_done "$issue_raw"
      (( AUTO_MERGE )) && echo "auto-merge: not implemented in the reference script — adapt this step"
      return 0
    fi

    if [[ "$decision" == "take_over" ]]; then
      echo "master review takes over: implement_master re-implements from the issue, with the findings so far attached" >&2
      # Controller retries repair in place. take_over promised a fresh start —
      # stash the rejected tree so the stronger model does not inherit it.
      # Empty / clean trees make stash exit 1; that is not an error.
      if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        # stash -u skips ignored files. Pin .pipeline in info/exclude so the
        # harness state survives even when the project has not gitignored it.
        # (Passing ':!.pipeline' as a pathspec makes git exit 1 after saving.)
        local gitdir excl stash_msg
        gitdir="$(git -C "$ROOT" rev-parse --git-dir)"
        excl="$gitdir/info/exclude"
        mkdir -p "$(dirname "$excl")"
        grep -qxF '.pipeline/' "$excl" 2>/dev/null || printf '%s\n' '.pipeline/' >> "$excl"
        stash_msg="pipeline: pre-take_over $issue_id-$RUN_ID"
        # stash -u takes untracked MEMORY.md with it. Do not add MEMORY.md to
        # info/exclude — that would ignore it in the user's repo. Copy out and
        # write back so a later block_issue still appends to the existing history.
        local gov_bak="$work/MEMORY.md.pre-stash"
        [[ -f "$MEMORY_FILE" ]] && cp "$MEMORY_FILE" "$gov_bak"
        git -C "$ROOT" stash push -u -m "$stash_msg" >/dev/null 2>&1 \
          && echo "stashed working tree as $stash_msg" >&2 \
          || true
        [[ -f "$gov_bak" ]] && cp "$gov_bak" "$MEMORY_FILE"
      fi
      ctrl_attempts=$MAX_CTRL
      GOVERNANCE_AGENTS="$AGENTS_FILE" node "$LIB/governance.mjs" state escalate "$PIPELINE_DIR" "$root" "$issue_id" >/dev/null
    fi

    { echo "--- attempt $((ctrl_attempts + master_attempts)) (decision: $decision) ---"
      cat "$work/gate.json"
      echo "--- master ---"
      cat "$work/master.txt"
    } >> "$work/exclusions.md"
  done
}

main() {
  mkdir -p "$PIPELINE_DIR"/{state,logs,prompts,work}
  # next_issues may die (failed !command). A bare $(...) would swallow that
  # exit and report "no open issues" with status 0 — the cron-job lie.
  local issues rc=0
  issues="$(next_issues)" || rc=$?
  (( rc == 0 )) || exit "$rc"
  [[ -n "$issues" ]] || { echo "no open issues in $ISSUE_SOURCE"; return 0; }
  local line
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    [[ -n "$ONLY_ISSUE" && "${line%%:*}" != "$ONLY_ISSUE" ]] && continue
    echo "=== ${line%%:*} ==="
    process_issue "$line"
  done <<< "$issues"
  # A blocked or aborted issue is not "approved": the run exits non-zero.
  # Element-0 test instead of ${#arr[@]}: on bash < 4.4 (macOS ships 3.2) the
  # length expansion of an empty array trips set -u — same class pids guards.
  if [[ ${FAILED_ISSUES[0]+_} ]]; then
    echo "blocked: ${FAILED_ISSUES[*]}" >&2
    return 1
  fi
}

main
