#!/usr/bin/env bash
# auto-develop.sh — reference implementation of the governance-driven pipeline.
#
# Adapt three things per project: ISSUE_SOURCE, LINT_CMD, TEST_CMD. Everything
# else is read from governance. Do not hardcode a model here — the mapping in
# AGENTS.md is what makes routing changeable without touching this file.
#
#   ./auto-develop.sh --dry-run
#   ./auto-develop.sh --issue issue-42
#   ./auto-develop.sh --unattended --yes

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="${PIPELINE_LIB:-$ROOT/.pipeline/lib}"
PIPELINE_DIR="$ROOT/.pipeline"
AGENTS_FILE="${AGENTS_FILE:-$ROOT/AGENTS.md}"
SOUL_FILE="${SOUL_FILE:-$ROOT/SOUL.md}"
MEMORY_FILE="${MEMORY_FILE:-$ROOT/MEMORY.md}"

ISSUE_SOURCE="${ISSUE_SOURCE:-$ROOT/tasks.md}"   # adapt: gh issue list, jira, ...
LINT_CMD="${LINT_CMD:-}"                          # adapt: npm run lint, ruff, ...
TEST_CMD="${TEST_CMD:-}"                          # adapt: npm test, pytest, ...

UNATTENDED=0; AUTO_MERGE=0; DRY_RUN=0; ASSUME_YES=0; ONLY_ISSUE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --unattended) UNATTENDED=1 ;;
    --auto-merge) AUTO_MERGE=1 ;;
    --dry-run)    DRY_RUN=1 ;;
    --yes|-y)     ASSUME_YES=1 ;;
    --issue)      ONLY_ISSUE="${2:?--issue needs an id}"; shift ;;
    -h|--help)    sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
  shift
done

die() { echo "error: $*" >&2; exit 1; }

# ---------------------------------------------------------------- safety gate
# pi has no permission dialog and `pi -p` has no UI. This startup gate is the
# only place a human can intervene, so it runs before the loop, never inside it.
if (( UNATTENDED || AUTO_MERGE )); then
  if (( ! ASSUME_YES )); then
    [[ -t 0 ]] || die "--unattended/--auto-merge on a non-interactive stdin requires --yes"
    read -r -p "Run unattended (privileged steps, auto-merge=$AUTO_MERGE)? [y/N] " reply
    [[ "$reply" == [yY]* ]] || die "aborted at the safety gate"
  fi
fi

# ------------------------------------------------------------------ contract
command -v node >/dev/null || die "node is required (contract parser and review gate)"
[[ -f "$LIB/governance.mjs" ]] || die "missing $LIB/governance.mjs"

CONFIG="$(node "$LIB/governance.mjs" config "$AGENTS_FILE")" || exit 2
BLOCKING="$(node -e 'const c=JSON.parse(process.argv[1]);console.log(c.review.blocking_severities.join(","))' "$CONFIG")"
FOLLOWUP="$(node -e 'const c=JSON.parse(process.argv[1]);console.log(c.review.followup_severities.join(","))' "$CONFIG")"
MAX_CTRL="$(node -e 'console.log(JSON.parse(process.argv[1]).budgets.max_attempts_controller)' "$CONFIG")"
MAX_MASTER="$(node -e 'console.log(JSON.parse(process.argv[1]).budgets.max_attempts_master)' "$CONFIG")"

model_for() { node "$LIB/governance.mjs" model "$AGENTS_FILE" "$1" 2>/dev/null; }

# ------------------------------------------------------------------- logging
RUN_ID="$(date +%Y%m%dT%H%M%S)"
log_event() { # log_event <root> <issue> <role> <model> <status> <prompt_path>
  local dir="$PIPELINE_DIR/logs/$1"; mkdir -p "$dir"
  # node appends, not the shell: the three reviewers run concurrently and a
  # `>>` redirect from parallel processes loses lines.
  node -e '
    const [file,ts,issue,role,model,status,prompt]=process.argv.slice(1);
    require("node:fs").appendFileSync(file, JSON.stringify({ts,issue,role,model,status,prompt})+"\n");
  ' "$dir/$RUN_ID.jsonl" "$(date -Is)" "$2" "$3" "$4" "$5" "$6"
}

# ------------------------------------------------------------------- runners
# One role, one process, one fresh context. Reviewers stay independent because
# they are separate processes, not because we asked them to be.
run_role() { # run_role <root> <issue> <role.path> <prompt> <outfile>
  local root="$1" issue="$2" role="$3" prompt="$4" out="$5"
  local model; model="$(model_for "$role")"
  local pdir="$PIPELINE_DIR/prompts/$root"; mkdir -p "$pdir" "$(dirname "$out")"
  local ppath="$pdir/${issue}-${role//./_}-$RUN_ID.txt"
  printf '%s\n' "$prompt" > "$ppath"

  if (( DRY_RUN )); then
    echo "[dry-run] $role -> ${model} (prompt: $ppath)"
    log_event "$root" "$issue" "$role" "$model" "dry-run" "$ppath"
    return 0
  fi

  local status=0
  if [[ "$model" == "default" ]]; then
    pi -p "$(cat "$ppath")" > "$out" || status=$?
  else
    pi -p --model "$model" "$(cat "$ppath")" > "$out" || status=$?
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
  cat <<EOF
Implement this issue test-first: write the failing test, watch it fail, make it pass.

Issue:
$1

Research notes:
$(excerpt "$2" 200)

Project coding standards:
$(excerpt "$SOUL_FILE" 120)

$( [[ -s "$3" ]] && printf 'Previous attempts were rejected for these findings. Repeating any of them fails again:\n%s\n' "$(cat "$3")" )

You have $4 attempts left. Change the code only; do not edit governance files.
EOF
}

# --------------------------------------------------------------------- issues
next_issues() {
  [[ -f "$ISSUE_SOURCE" ]] || die "issue source not found: $ISSUE_SOURCE"
  grep -E '^- \[ \] ' "$ISSUE_SOURCE" | sed -E 's/^- \[ \] //'
}

block_issue() { # <issue_id> <reason>
  {
    echo ""
    echo "## Blocker — $1 ($(date -I))"
    echo ""
    echo "$2"
  } >> "$MEMORY_FILE"
  echo "blocked: $1 — written to $MEMORY_FILE" >&2
}

# ----------------------------------------------------------------------- loop
process_issue() {
  local issue_line="$1"
  local issue_id="${issue_line%%:*}"
  local root="$issue_id"
  local work="$PIPELINE_DIR/work/$issue_id"; mkdir -p "$work"

  node "$LIB/governance.mjs" state init "$PIPELINE_DIR" "$root" >/dev/null
  GOVERNANCE_AGENTS="$AGENTS_FILE" node "$LIB/governance.mjs" state issue "$PIPELINE_DIR" "$root" "$issue_id" open >/dev/null

  # Research runs once per issue, not per attempt, and is cached.
  if [[ ! -s "$work/research.md" ]]; then
    run_role "$root" "$issue_id" research \
      "Gather context for this issue. Name the relevant files, the existing patterns to follow, and the pitfalls. Do not write code.

Issue:
$issue_line

Stack and architecture:
$(excerpt "$SOUL_FILE" 120)" "$work/research.md" || true
  fi

  : > "$work/exclusions.md"
  local ctrl_attempts=0 master_attempts=0

  while :; do
    # Budget is checked before the attempt, never after.
    if ! node "$LIB/governance.mjs" state budget "$PIPELINE_DIR" "$root" >/dev/null; then
      block_issue "$issue_id" "Tree budget exhausted after $ctrl_attempts controller and $master_attempts master attempts."
      return 0
    fi

    local role="implement" left=$(( MAX_CTRL - ctrl_attempts ))
    if (( ctrl_attempts >= MAX_CTRL )); then
      role="implement_master"; left=$(( MAX_MASTER - master_attempts ))
      (( master_attempts >= MAX_MASTER )) && {
        block_issue "$issue_id" "Rejected at master review $master_attempts times. Unresolved findings:
$(cat "$work/exclusions.md")"
        return 0
      }
    fi

    run_role "$root" "$issue_id" "$role" \
      "$(build_implement_prompt "$issue_line" "$work/research.md" "$work/exclusions.md" "$left")" \
      "$work/implement.log" || true

    if [[ "$role" == "implement" ]]; then ctrl_attempts=$((ctrl_attempts+1)); else master_attempts=$((master_attempts+1)); fi
    GOVERNANCE_AGENTS="$AGENTS_FILE" node "$LIB/governance.mjs" state attempt "$PIPELINE_DIR" "$root" "$issue_id" \
      "$([[ "$role" == "implement" ]] && echo controller || echo master)" >/dev/null

    # Deterministic gates first. A lint failure must not consume a review cycle.
    if (( ! DRY_RUN )); then
      [[ -n "$LINT_CMD" ]] && { eval "$LINT_CMD" || { echo "lint failed; retrying implementation" >&2; continue; }; }
      [[ -n "$TEST_CMD" ]] && { eval "$TEST_CMD" || { echo "tests failed; retrying implementation" >&2; continue; }; }
    fi

    git -C "$ROOT" diff > "$work/diff.patch" || true

    # Three reviewers, three processes, in parallel, no shared verdicts.
    local pids=()
    for focus in security quality correctness; do
      run_role "$root" "$issue_id" "review.$focus" \
        "$(build_review_prompt "$focus" "$issue_line" "$work/diff.patch")" \
        "$work/review-$focus.json" &
      pids+=($!)
    done
    for pid in "${pids[@]}"; do wait "$pid" || true; done

    (( DRY_RUN )) && { echo "[dry-run] stopping after one pass for $issue_id"; return 0; }

    local gate_status=0
    node "$LIB/gate.mjs" --blocking "$BLOCKING" --followup "$FOLLOWUP" \
      "$work"/review-*.json > "$work/gate.json" || gate_status=$?

    # The controller proposes on a weak model; the master decides and sees the
    # original reviewer JSON, so an aggregation error is catchable.
    run_role "$root" "$issue_id" controller \
      "Merge these reviewer JSON objects. Deduplicate findings naming the same file and line, apply the severity rule (blocking: $BLOCKING), and propose a verdict. You do not decide; the master sees the originals regardless. Emit only JSON.

$(cat "$work"/review-*.json)" "$work/controller.json" || true

    run_role "$root" "$issue_id" master_review \
      "Decide: approve, reject with reasons, or take over the implementation. Check the controller's arithmetic rather than trust it.

Issue:
$issue_line

Diff:
$(cat "$work/diff.patch")

Original reviewer output:
$(cat "$work"/review-*.json)

Controller proposal:
$(cat "$work/controller.json")

Deterministic gate: $(cat "$work/gate.json")
Attempt $((ctrl_attempts + master_attempts)).

Answer with one line: APPROVE or REJECT, then the reasons." "$work/master.txt" || true

    if grep -qi '^APPROVE' "$work/master.txt" && (( gate_status == 0 )); then
      echo "approved: $issue_id"
      (( AUTO_MERGE )) && echo "auto-merge enabled — merge step goes here"
      return 0
    fi

    { echo "--- attempt $((ctrl_attempts + master_attempts)) ---"; cat "$work/gate.json"; } >> "$work/exclusions.md"
  done
}

main() {
  mkdir -p "$PIPELINE_DIR"/{state,logs,prompts,work}
  local issues; issues="$(next_issues)"
  [[ -n "$issues" ]] || { echo "no open issues in $ISSUE_SOURCE"; return 0; }
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    [[ -n "$ONLY_ISSUE" && "${line%%:*}" != "$ONLY_ISSUE" ]] && continue
    echo "=== ${line%%:*} ==="
    process_issue "$line"
  done <<< "$issues"
}

main
