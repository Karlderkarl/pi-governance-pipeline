#!/usr/bin/env bash
# smoke.sh — pre-publish sanity for the pipeline assets. Runs in release.yml.
# Not packed into the tarball (package.json `files` whitelist).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SH="$ROOT/skills/governance-pipeline/assets/auto-develop.sh"
LIB="$ROOT/skills/governance-pipeline/assets/lib"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "smoke FAIL: $*" >&2; exit 1; }

# ---------------------------------------------------------------- syntax
bash -n "$SH" || fail "auto-develop.sh has a syntax error"
node --check "$LIB/governance.mjs" || fail "governance.mjs has a syntax error"
node --check "$LIB/gate.mjs" || fail "gate.mjs has a syntax error"

# ---------------------------------------------------------------- contract: valid
cat > "$TMP/AGENTS.md" <<'MD'
# AGENTS

```yaml
models:
  implement:         { provider: anthropic, model: impl }
  implement_master:  { provider: google,    model: master-impl }
  master_review:     { provider: openai,    model: decider }
  review:
    security:        { provider: google,    model: r1 }
    quality:         { provider: openai,    model: r2 }
    correctness:     { provider: anthropic, model: r3 }
budgets:
  max_attempts_controller: 3
  max_attempts_master: 3
  max_runs_per_tree: 25
```
MD

node "$LIB/governance.mjs" config "$TMP/AGENTS.md" >/dev/null || fail "valid contract rejected"
[[ "$(node "$LIB/governance.mjs" model "$TMP/AGENTS.md" review.quality)" == "openai/r2" ]] \
  || fail "model resolution wrong"
node "$LIB/governance.mjs" models "$TMP/AGENTS.md" | grep -q '"review.security":"google/r1"' \
  || fail "models map wrong"

# ---------------------------------------------------------------- contract: refused
bad() { # <yaml body> — expect exit 2
  printf '# A\n```yaml\n%s\n```\n' "$1" > "$TMP/bad.md"
  local rc=0
  node "$LIB/governance.mjs" config "$TMP/bad.md" >/dev/null 2>&1 || rc=$?
  [[ "$rc" -eq 2 ]] || fail "invalid contract not refused with exit 2 (got $rc): $1"
}
bad 'models:
  implement:        { provider: a, model: m }
  implement_master: { provider: a, model: m }'
bad 'models:
  review:
    security:    { provider: a, model: r1 }
    quality:     { provider: a, model: r2 }
    correctness: { provider: a, model: r3 }'
bad 'budgets:
  max_runs_per_tree: 2'
bad 'budgets:
  max_split_depth: 3'

printf '# A\n```yaml\nbudgets:\n  max_split_depth: 3\n```\n' > "$TMP/deep.md"
PIPELINE_ALLOW_DEEP_SPLIT=1 node "$LIB/governance.mjs" config "$TMP/deep.md" >/dev/null 2>&1 \
  || fail "deep-split override refused"

# ---------------------------------------------------------------- contract: warnings
cat > "$TMP/warn.md" <<'MD'
# A
```yaml
models:
  implement:        { provider: a, model: m1 }
  implement_master: { provider: b, model: m2 }
  master_review:    { provider: b, model: m2 }
```
MD
node "$LIB/governance.mjs" config "$TMP/warn.md" 2>&1 >/dev/null | grep -q "contract warning" \
  || fail "master_review == implement_master produced no warning"

# ---------------------------------------------------------------- gate.mjs
echo '{"role":"security","verdict":"reject","findings":[{"severity":"high","file":"f","line":1,"title":"t","rationale":"r","suggestion":"s"}]}' > "$TMP/r-high.json"
echo '{"role":"quality","verdict":"approve","findings":[]}' > "$TMP/r-ok.json"
echo 'garbage, not json' > "$TMP/r-bad.json"

rc=0; node "$LIB/gate.mjs" "$TMP/r-high.json" "$TMP/r-ok.json" >/dev/null || rc=$?
[[ $rc -eq 4 ]] || fail "gate did not block a high finding"
node "$LIB/gate.mjs" "$TMP/r-ok.json" >/dev/null || fail "gate blocked a clean review"
rc=0; node "$LIB/gate.mjs" "$TMP/r-bad.json" > "$TMP/gate-out.json" || rc=$?
[[ $rc -eq 4 ]] || fail "gate did not fail closed on unparseable reviewers"
grep -q '"verdict": "blocked"' "$TMP/gate-out.json" || fail "gate verdict must be blocked when all reviewers are unreadable"
node "$LIB/gate.mjs" --check "$TMP/r-ok.json" >/dev/null || fail "--check rejected valid reviewer json"
if node "$LIB/gate.mjs" --check "$TMP/r-bad.json" >/dev/null; then fail "--check accepted garbage"; fi

# ---------------------------------------------------------------- state store
GOVERNANCE_AGENTS="$TMP/AGENTS.md" node "$LIB/governance.mjs" state init "$TMP/proj" issue-1 >/dev/null
GOVERNANCE_AGENTS="$TMP/AGENTS.md" node "$LIB/governance.mjs" state attempt "$TMP/proj" issue-1 issue-1 controller >/dev/null
GOVERNANCE_AGENTS="$TMP/AGENTS.md" node "$LIB/governance.mjs" state attempt "$TMP/proj" issue-1 issue-1 controller >/dev/null
att="$(node "$LIB/governance.mjs" state attempts "$TMP/proj" issue-1 issue-1)"
[[ "$att" == *'"controller": 2'* || "$att" == *'"controller":2'* ]] || fail "state attempts wrong: $att"
node "$LIB/governance.mjs" state budget "$TMP/proj" issue-1 >/dev/null || fail "budget check failed with budget left"
GOVERNANCE_AGENTS="$TMP/AGENTS.md" node "$LIB/governance.mjs" state escalate "$TMP/proj" issue-1 issue-1 >/dev/null
att="$(node "$LIB/governance.mjs" state attempts "$TMP/proj" issue-1 issue-1)"
[[ "$att" == *'"controller": 3'* || "$att" == *'"controller":3'* ]] || fail "escalate did not exhaust the controller path: $att"

# init must honor the configured budget when GOVERNANCE_AGENTS is set
printf '# A\n```yaml\nbudgets:\n  max_runs_per_tree: 7\n```\n' > "$TMP/custom.md"
GOVERNANCE_AGENTS="$TMP/custom.md" node "$LIB/governance.mjs" state init "$TMP/proj2" issue-9 \
  | grep -q '"max_runs_per_tree": 7' || fail "configured budget not honored by state init"

# ---------------------------------------------------------------- auto-develop.sh
proj="$TMP/run"; mkdir -p "$proj/.pipeline/lib"
cp "$SH" "$proj/auto-develop.sh"; cp "$LIB"/*.mjs "$proj/.pipeline/lib/"

# no open issues: friendly message, exit 0 (regression: pipefail killed this path)
printf -- "- [x] closed-1: done already\n" > "$proj/tasks.md"
out="$(cd "$proj" && bash auto-develop.sh --dry-run 2>&1)" || fail "dry-run with no open issues failed: $out"
echo "$out" | grep -q "no open issues" || fail "missing no-open-issues message: $out"

# one open issue: reviewers planned, no state mutated, no budget consumed
printf -- "- [ ] issue-1: try the pipeline\n" > "$proj/tasks.md"
out="$(cd "$proj" && bash auto-develop.sh --dry-run 2>&1)" || fail "dry-run failed: $out"
echo "$out" | grep -q "review.security" || fail "reviewers not planned: $out"
if ls "$proj"/.pipeline/state/*.json >/dev/null 2>&1; then fail "dry-run mutated pipeline state"; fi

# no_self_review: the colliding reviewer is dropped, the others still run
proj2="$TMP/run-drop"; mkdir -p "$proj2/.pipeline/lib"
cp "$SH" "$proj2/auto-develop.sh"; cp "$LIB"/*.mjs "$proj2/.pipeline/lib/"
cat > "$proj2/AGENTS.md" <<'MD'
# A
```yaml
models:
  implement: { provider: a, model: same }
  review:
    security:    { provider: a, model: same }
    quality:     { provider: b, model: q }
    correctness: { provider: c, model: r }
```
MD
printf -- "- [ ] issue-7: self review check\n" > "$proj2/tasks.md"
out="$(cd "$proj2" && bash auto-develop.sh --dry-run 2>&1)" || fail "dry-run (drop case) failed: $out"
echo "$out" | grep -q "dropped" || fail "no_self_review did not drop the colliding reviewer: $out"
echo "$out" | grep -q "review.quality" || fail "non-colliding reviewers must still run: $out"

# validator: review.* == implement_master must warn — the dangerous direction,
# where the drop lands exactly when the master path starts
cat > "$TMP/warn-master.md" <<'MD'
# A
```yaml
models:
  implement:        { provider: a, model: m1 }
  implement_master: { provider: b, model: m2 }
  review:
    security:    { provider: b, model: m2 }
    quality:     { provider: c, model: m3 }
    correctness: { provider: d, model: m4 }
```
MD
node "$LIB/governance.mjs" config "$TMP/warn-master.md" 2>&1 >/dev/null \
  | grep -q "equals models.implement_master" \
  || fail "review.* == implement_master produced no warning"

# ---------------------------------------------------------------- e2e: escalated no_self_review
# review.security == implement_master: the reviewer runs while the controller
# implements and is dropped once the master path starts. Regression guard: its
# stale verdict must not gate the master attempts (permanent deadlock), and the
# unparseable-output retry must never resurrect the dropped reviewer.
proj3="$TMP/run-master-drop"; mkdir -p "$proj3/.pipeline/lib"
cp "$SH" "$proj3/auto-develop.sh"; cp "$LIB"/*.mjs "$proj3/.pipeline/lib/"
cat > "$proj3/AGENTS.md" <<'MD'
# A
```yaml
models:
  implement:        { provider: a, model: impl }
  implement_master: { provider: b, model: master-impl }
  review:
    security:    { provider: b, model: master-impl }
    quality:     { provider: c, model: q }
    correctness: { provider: d, model: r }
budgets:
  max_attempts_controller: 1
  max_attempts_master: 2
  max_runs_per_tree: 50
```
MD
printf -- "- [ ] issue-3: escalated self review\n" > "$proj3/tasks.md"

# A stub pi whose answer depends on the prompt it receives; logs every call.
stub="$TMP/stub-bin"; mkdir -p "$stub"
cat > "$stub/pi" <<'EOF'
#!/usr/bin/env bash
for last; do :; done   # the prompt is the final argument
case "$last" in
  *"Gather context"*)       echo research >> "${PI_CALLS_LOG:?}"; echo "research notes" ;;
  *"Implement this issue"*) echo implement >> "${PI_CALLS_LOG:?}" ;;
  *"concern only: security"*)
    echo review-security >> "${PI_CALLS_LOG:?}"
    echo '{"role":"security","verdict":"reject","findings":[{"severity":"high","file":"f","line":1,"title":"stale-marker","rationale":"r","suggestion":"s"}]}' ;;
  *"concern only: quality"*)
    echo review-quality >> "${PI_CALLS_LOG:?}"
    echo '{"role":"quality","verdict":"approve","findings":[]}' ;;
  *"concern only: correctness"*)
    echo review-correctness >> "${PI_CALLS_LOG:?}"
    echo '{"role":"correctness","verdict":"approve","findings":[]}' ;;
  *"Merge these reviewer"*) echo controller >> "${PI_CALLS_LOG:?}"; echo '{}' ;;
  *"Decide this attempt"*)  echo master >> "${PI_CALLS_LOG:?}"
    echo '{"decision":"approve","reasons":["ok"]}' ;;
  *) echo unknown >> "${PI_CALLS_LOG:?}"; echo '{}' ;;
esac
EOF
chmod +x "$stub/pi"

rc=0
out="$(cd "$proj3" && PATH="$stub:$PATH" PI_CALLS_LOG="$TMP/calls3.log" bash auto-develop.sh 2>&1)" || rc=$?
[[ "$rc" -eq 0 ]] || fail "escalated no_self_review deadlocked — a stale verdict gated the master attempts (rc=$rc): $out"
grep -q '"reviewers_used": 2' "$proj3/.pipeline/work/issue-3/gate.json" \
  || fail "gate must count only this attempt's reviewers: $(cat "$proj3/.pipeline/work/issue-3/gate.json")"
if grep -q "stale-marker" "$proj3/.pipeline/work/issue-3/gate.json"; then
  fail "stale finding from the dropped reviewer reached the gate"
fi
[[ "$(grep -c review-security "$TMP/calls3.log")" -eq 1 ]] \
  || fail "dropped reviewer ran beyond its pre-drop attempt (retry resurrection?): $(cat "$TMP/calls3.log")"
echo "$out" | grep -q "dropped" || fail "drop not logged: $out"

# ---------------------------------------------------------------- e2e: lint feedback
# A failing LINT_CMD must feed its output back into exclusions.md — otherwise
# the retry re-runs the identical prompt and learns nothing.
proj4="$TMP/run-lint"; mkdir -p "$proj4/.pipeline/lib"
cp "$SH" "$proj4/auto-develop.sh"; cp "$LIB"/*.mjs "$proj4/.pipeline/lib/"
cp "$TMP/AGENTS.md" "$proj4/AGENTS.md"
printf -- "- [ ] issue-4: lint feedback\n" > "$proj4/tasks.md"
rc=0
out="$(cd "$proj4" && PATH="$stub:$PATH" PI_CALLS_LOG="$TMP/calls4.log" \
  LINT_CMD='echo "lint-broke: missing semicolon"; false' bash auto-develop.sh 2>&1)" || rc=$?
[[ "$rc" -ne 0 ]] || fail "persistent lint failure should exhaust the budget and block, not pass"
grep -q "lint-broke: missing semicolon" "$proj4/.pipeline/work/issue-4/exclusions.md" \
  || fail "lint output never reached exclusions.md: $(cat "$proj4/.pipeline/work/issue-4/exclusions.md")"

# ---------------------------------------------------------------- capture_diff cap
# An oversized diff must be truncated at DIFF_MAX_BYTES — and portably so
# (dd, not GNU-only head -c). Runs a dry-run: capture_diff executes before the
# dry-run stop, no model calls needed.
proj5="$TMP/run-cap"; mkdir -p "$proj5/.pipeline/lib"
cp "$SH" "$proj5/auto-develop.sh"; cp "$LIB"/*.mjs "$proj5/.pipeline/lib/"
printf -- "- [ ] issue-5: big diff\n" > "$proj5/tasks.md"
git -C "$proj5" init -q
git -C "$proj5" -c user.email=t@t -c user.name=t commit -qm init --allow-empty
dd if=/dev/zero bs=100000 count=1 2>/dev/null | tr '\0' 'x' > "$proj5/big.txt"
out="$(cd "$proj5" && DIFF_MAX_BYTES=1024 bash auto-develop.sh --dry-run 2>&1)" || fail "dry-run (cap case) failed: $out"
grep -q "diff truncated at 1024 bytes" "$proj5/.pipeline/work/issue-5/diff.patch" \
  || fail "oversized diff not truncated: $(wc -c < "$proj5/.pipeline/work/issue-5/diff.patch") bytes"
[[ "$(wc -c < "$proj5/.pipeline/work/issue-5/diff.patch")" -lt 2048 ]] \
  || fail "truncated diff still too large"

# ---------------------------------------------------------------- gate floor
# One surviving reviewer is not a panel: below --min-reviewers the gate blocks
# instead of approving. Default stays 1, so existing callers are unaffected.
rc=0; node "$LIB/gate.mjs" --min-reviewers 2 "$TMP/r-ok.json" > "$TMP/gate-floor.json" || rc=$?
[[ $rc -eq 4 ]] || fail "gate approved a one-reviewer panel despite --min-reviewers 2"
grep -q '"verdict": "blocked"' "$TMP/gate-floor.json" || fail "shrunk panel must report blocked"
node "$LIB/gate.mjs" --min-reviewers 2 "$TMP/r-ok.json" "$TMP/r-ok.json" >/dev/null \
  || fail "gate blocked a panel at the floor"

# validator: two reviewers equal to implement_master leave a one-reviewer panel
# on the escalated path — warn at generation time, not mid-run
cat > "$TMP/warn-floor.md" <<'MD'
# A
```yaml
models:
  implement:        { provider: a, model: m1 }
  implement_master: { provider: b, model: m2 }
  review:
    security:    { provider: b, model: m2 }
    quality:     { provider: b, model: m2 }
    correctness: { provider: c, model: m3 }
```
MD
node "$LIB/governance.mjs" config "$TMP/warn-floor.md" 2>&1 >/dev/null \
  | grep -q "fewer than two reviewers" \
  || fail "panel below the floor produced no generation-time warning"

# ---------------------------------------------------------------- e2e: reviewer floor
# Two of three reviewers return garbage, persistently (retry included). One
# readable reviewer remains — below the script's default floor of two. The
# master approving must not matter: the gate blocks, the issue is blocked.
proj6="$TMP/run-floor"; mkdir -p "$proj6/.pipeline/lib"
cp "$SH" "$proj6/auto-develop.sh"; cp "$LIB"/*.mjs "$proj6/.pipeline/lib/"
cp "$TMP/AGENTS.md" "$proj6/AGENTS.md"
printf -- "- [ ] issue-6: shrunk panel\n" > "$proj6/tasks.md"
stub2="$TMP/stub2-bin"; mkdir -p "$stub2"
cat > "$stub2/pi" <<'EOF'
#!/usr/bin/env bash
for last; do :; done   # the prompt is the final argument
case "$last" in
  *"Gather context"*)       echo "research notes" ;;
  *"Implement this issue"*) : ;;
  *"concern only: quality"*)
    echo '{"role":"quality","verdict":"approve","findings":[]}' ;;
  *"concern only:"*)        echo 'not json at all' ;;
  *"Merge these reviewer"*) echo '{}' ;;
  *"Decide this attempt"*)  echo '{"decision":"approve","reasons":["ok"]}' ;;
  *) echo '{}' ;;
esac
EOF
chmod +x "$stub2/pi"
rc=0
out="$(cd "$proj6" && PATH="$stub2:$PATH" PI_CALLS_LOG="$TMP/calls6.log" bash auto-develop.sh 2>&1)" || rc=$?
[[ "$rc" -ne 0 ]] || fail "a one-reviewer panel approved its issue"
if echo "$out" | grep -q "^approved: issue-6"; then fail "shrunk panel approved issue-6"; fi
grep -q '"reviewers_used": 1' "$proj6/.pipeline/work/issue-6/gate.json" \
  || fail "gate must count only parseable reviewers: $(cat "$proj6/.pipeline/work/issue-6/gate.json")"
grep -q '"verdict": "blocked"' "$proj6/.pipeline/work/issue-6/gate.json" \
  || fail "shrunk panel must be blocked at the gate"

# ---------------------------------------------------------------- e2e: exclusions cap
# A chatty linter (300 lines per failure) must not inflate the implement prompt
# unboundedly: newest blocks survive, oldest are omitted, the prompt is capped.
proj7="$TMP/run-exclcap"; mkdir -p "$proj7/.pipeline/lib"
cp "$SH" "$proj7/auto-develop.sh"; cp "$LIB"/*.mjs "$proj7/.pipeline/lib/"
cp "$TMP/AGENTS.md" "$proj7/AGENTS.md"
printf -- "- [ ] issue-7: exclusions cap\n" > "$proj7/tasks.md"
rc=0
out="$(cd "$proj7" && PATH="$stub:$PATH" PI_CALLS_LOG="$TMP/calls7.log" \
  LINT_CMD='i=0; while [ $i -lt 300 ]; do i=$((i+1)); echo "lint-line-$i"; done; false' \
  bash auto-develop.sh 2>&1)" || rc=$?
[[ "$rc" -ne 0 ]] || fail "persistent lint failure should block, not pass"
last_prompt="$(ls -t "$proj7"/.pipeline/prompts/issue-7/issue-7-implement*.txt | head -1)"
grep -q "older blocks omitted" "$last_prompt" \
  || fail "exclusion cap marker missing in the implement prompt"
if grep -q "kept]lint-line" "$last_prompt"; then fail "cap marker glued to the first kept line"; fi
if grep -q "tail, not head" "$last_prompt"; then fail "script comment leaked into the prompt"; fi
# The closing instruction must not glue to the last lint line, and the
# singular must be spelled correctly (the last master attempt has left=1).
[[ -z "$(grep -B1 'You have' "$last_prompt" | head -1)" ]] \
  || fail "missing blank line before the closing instruction"
grep -q 'You have 1 attempt left' "$last_prompt" \
  || fail "singular attempt count broken"
[[ "$(wc -l < "$last_prompt")" -lt 320 ]] \
  || fail "implement prompt not bounded: $(wc -l < "$last_prompt") lines"
# The newest prompt was rendered before the newest lint run, so the latest
# block it can contain is attempt 5.
grep -q "(attempt 5)" "$last_prompt" || fail "newest lint block must survive the cap"
if grep -q "(attempt 1)" "$last_prompt"; then fail "oldest lint block should have been capped away"; fi
# One archived prompt per attempt, not one per role: 3 controller + 3 master
# attempts must each keep the prompt that produced them.
[[ "$(ls "$proj7"/.pipeline/prompts/issue-7/ | grep -c '^issue-7-implement-a')" -eq 3 ]] \
  || fail "controller attempts must each keep their prompt"
[[ "$(ls "$proj7"/.pipeline/prompts/issue-7/ | grep -c '^issue-7-implement_master-a')" -eq 3 ]] \
  || fail "master attempts must each keep their prompt"

echo "smoke OK"
