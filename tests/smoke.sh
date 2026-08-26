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

git_init() {
  # Commit the seeded tree so capture_diff does not treat auto-develop.sh as
  # the implementation. The script contains "Gather context" / "concern only"
  # strings that would otherwise match every stub arm.
  git -C "$1" init -q
  printf '.pipeline/\n' > "$1/.gitignore"
  git -C "$1" add -A
  git -C "$1" -c user.email=t@t -c user.name=t commit -qm init
}

# ---------------------------------------------------------------- syntax
bash -n "$SH" || fail "auto-develop.sh has a syntax error"
node --check "$LIB/governance.mjs" || fail "governance.mjs has a syntax error"
node --check "$LIB/gate.mjs" || fail "gate.mjs has a syntax error"

# The extension ships as raw TypeScript. Catch a type error before the registry.
npx --yes --package typescript@5.8.3 tsc --noEmit -p "$ROOT/tests/tsconfig.guard.json" \
  || fail "pipeline-guard.ts failed tsc --noEmit"

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

# thinking: optional per role, launched as provider/model:level
cat > "$TMP/think.md" <<'MD'
# A
```yaml
models:
  implement:         { provider: anthropic, model: impl, thinking: high }
  implement_master:  { provider: google,    model: master-impl, thinking: medium }
  review:
    security:        { provider: google,    model: r1, thinking: low }
    quality:         { provider: openai,    model: r2 }
    correctness:     { provider: anthropic, model: r3, thinking: off }
```
MD
[[ "$(node "$LIB/governance.mjs" model "$TMP/think.md" implement)" == "anthropic/impl:high" ]] \
  || fail "thinking not appended to invoke ref"
[[ "$(node "$LIB/governance.mjs" model "$TMP/think.md" review.quality)" == "openai/r2" ]] \
  || fail "role without thinking must stay provider/model"
node "$LIB/governance.mjs" models "$TMP/think.md" | grep -q '"review.security":"google/r1:low"' \
  || fail "models map missing thinking suffix"

# same model, two roles, different thinking — legal, but identity still collides
cat > "$TMP/think-same.md" <<'MD'
# A
```yaml
models:
  implement:         { provider: anthropic, model: sonnet, thinking: high }
  implement_master:  { provider: google,    model: gemini }
  review:
    security:        { provider: google,    model: r1 }
    quality:         { provider: openai,    model: r2 }
    correctness:     { provider: anthropic, model: sonnet, thinking: low }
```
MD
node "$LIB/governance.mjs" config "$TMP/think-same.md" >/dev/null \
  || fail "same model with different thinking on two roles was refused"
node "$LIB/governance.mjs" config "$TMP/think-same.md" 2>&1 >/dev/null \
  | grep -q "equals models.implement" \
  || fail "same model different thinking must still warn no_self_review"

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
bad 'models:
  implement: { provider: a, model: m, thinking: ultra }
  implement_master: { provider: b, model: n }'
# same model, different thinking is still the same implementer
bad 'models:
  implement:        { provider: a, model: m, thinking: high }
  implement_master: { provider: a, model: m, thinking: low }'
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
git_init "$proj"
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
git_init "$proj2"
out="$(cd "$proj2" && bash auto-develop.sh --dry-run 2>&1)" || fail "dry-run (drop case) failed: $out"
echo "$out" | grep -q "dropped" || fail "no_self_review did not drop the colliding reviewer: $out"
echo "$out" | grep -q "review.quality" || fail "non-colliding reviewers must still run: $out"

# thinking is a launch parameter: same model at different levels still drops
proj_think="$TMP/run-think"; mkdir -p "$proj_think/.pipeline/lib"
cp "$SH" "$proj_think/auto-develop.sh"; cp "$LIB"/*.mjs "$proj_think/.pipeline/lib/"
cat > "$proj_think/AGENTS.md" <<'MD'
# A
```yaml
models:
  implement: { provider: a, model: same, thinking: high }
  review:
    security:    { provider: a, model: same, thinking: low }
    quality:     { provider: b, model: q, thinking: medium }
    correctness: { provider: c, model: r }
```
MD
printf -- "- [ ] issue-8: thinking identity\n" > "$proj_think/tasks.md"
git_init "$proj_think"
out="$(cd "$proj_think" && bash auto-develop.sh --dry-run 2>&1)" || fail "dry-run (thinking) failed: $out"
echo "$out" | grep -q "dropped" || fail "different thinking must not bypass no_self_review: $out"
echo "$out" | grep -q "review.quality -> b/q:medium" || fail "dry-run must show thinking suffix: $out"
echo "$out" | grep -q "implement -> a/same:high" || fail "implement thinking missing from dry-run: $out"

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
git_init "$proj3"

# A stub pi whose answer depends on the prompt it receives; logs every call.
stub="$TMP/stub-bin"; mkdir -p "$stub"
cat > "$stub/pi" <<'EOF'
#!/usr/bin/env bash
# Emulate pi: piped (non-TTY) stdin is drained and becomes the message.
last=""
[ -t 0 ] || last="$(cat)"
if [[ -z "$last" ]]; then for a in "$@"; do last="$a"; done; fi
case "$last" in
  "Gather context"*)       echo research >> "${PI_CALLS_LOG:?}"; echo "research notes" ;;
  "Implement this issue"*) echo implement >> "${PI_CALLS_LOG:?}"
    printf 'implemented\n' >> ./impl.txt ;;
  "You review a diff for one concern only: security"*)
    echo review-security >> "${PI_CALLS_LOG:?}"
    echo '{"role":"security","verdict":"reject","findings":[{"severity":"high","file":"f","line":1,"title":"stale-marker","rationale":"r","suggestion":"s"}]}' ;;
  "You review a diff for one concern only: quality"*)
    echo review-quality >> "${PI_CALLS_LOG:?}"
    echo '{"role":"quality","verdict":"approve","findings":[]}' ;;
  "You review a diff for one concern only: correctness"*)
    echo review-correctness >> "${PI_CALLS_LOG:?}"
    echo '{"role":"correctness","verdict":"approve","findings":[]}' ;;
  "Merge these reviewer"*) echo controller >> "${PI_CALLS_LOG:?}"; echo '{}' ;;
  "Decide this attempt"*)  echo master >> "${PI_CALLS_LOG:?}"
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
git_init "$proj4"
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
git_init "$proj6"
stub2="$TMP/stub2-bin"; mkdir -p "$stub2"
cat > "$stub2/pi" <<'EOF'
#!/usr/bin/env bash
# Emulate pi: piped (non-TTY) stdin is drained and becomes the message.
last=""
[ -t 0 ] || last="$(cat)"
if [[ -z "$last" ]]; then for a in "$@"; do last="$a"; done; fi
case "$last" in
  "Gather context"*)       echo "research notes" ;;
  "Implement this issue"*) printf 'implemented\n' >> ./impl.txt ;;
  "You review a diff for one concern only: quality"*)
    echo '{"role":"quality","verdict":"approve","findings":[]}' ;;
  "You review a diff for one concern only:"*) echo 'not json at all' ;;
  "Merge these reviewer"*) echo '{}' ;;
  "Decide this attempt"*)  echo '{"decision":"approve","reasons":["ok"]}' ;;
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
printf 'write clean code\n' > "$proj7/SOUL.md"
git_init "$proj7"
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
# The empty exclusion case (first attempt) must have exactly one blank line
# before the closing instruction — the separation is printed inside the same
# substitution, so an empty block must not stack newlines.
first_prompt="$(ls "$proj7"/.pipeline/prompts/issue-7/issue-7-implement-a01-* | head -1)"
[[ -z "$(grep -B1 'You have' "$first_prompt" | head -1)" ]] \
  || fail "first prompt: closing instruction glued to the standards excerpt"
[[ -n "$(grep -B2 'You have' "$first_prompt" | head -1)" ]] \
  || fail "first prompt: stacked blank lines before the closing instruction"
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

# ---------------------------------------------------------------- e2e: happy path + @file + tasks.md checkbox
proj_ok="$TMP/run-happy"; mkdir -p "$proj_ok/.pipeline/lib"
cp "$SH" "$proj_ok/auto-develop.sh"; cp "$LIB"/*.mjs "$proj_ok/.pipeline/lib/"
cp "$TMP/AGENTS.md" "$proj_ok/AGENTS.md"
printf -- "- [ ] issue-9: happy path\n" > "$proj_ok/tasks.md"
git_init "$proj_ok"
stub_ok="$TMP/stub-ok"; mkdir -p "$stub_ok"
cp "$ROOT/tests/fixtures/bin/pi" "$stub_ok/pi"; chmod +x "$stub_ok/pi"
rc=0
out="$(cd "$proj_ok" && PATH="$stub_ok:$PATH" PI_CALLS_LOG="$TMP/calls-ok.log" bash auto-develop.sh 2>&1)" || rc=$?
[[ "$rc" -eq 0 ]] || fail "happy path failed (rc=$rc): $out"
echo "$out" | grep -q "^approved: issue-9" || fail "happy path did not approve: $out"
grep -q '^- \[x\] issue-9' "$proj_ok/tasks.md" || fail "approved issue not marked done in tasks.md"
[[ -s "$proj_ok/.pipeline/work/issue-9/diff.patch" ]] || fail "happy path left an empty diff"
# The stub drains stdin like pi does. If the prompt were not redirected in,
# it would see main()'s issue-list here-string and log "unknown" instead of roles.
grep -q '^master$' "$TMP/calls-ok.log" || fail "master prompt was not delivered on stdin: $(cat "$TMP/calls-ok.log")"

# ---------------------------------------------------------------- e2e: empty diff is fail-closed
proj_empty="$TMP/run-empty"; mkdir -p "$proj_empty/.pipeline/lib"
cp "$SH" "$proj_empty/auto-develop.sh"; cp "$LIB"/*.mjs "$proj_empty/.pipeline/lib/"
cp "$TMP/AGENTS.md" "$proj_empty/AGENTS.md"
printf -- "- [ ] issue-empty: write nothing\n" > "$proj_empty/tasks.md"
git_init "$proj_empty"
rc=0
out="$(cd "$proj_empty" && PATH="$stub_ok:$PATH" PI_IMPLEMENT=empty PI_CALLS_LOG="$TMP/calls-empty.log" bash auto-develop.sh 2>&1)" || rc=$?
[[ "$rc" -ne 0 ]] || fail "empty diff should not approve"
if echo "$out" | grep -q "^approved: issue-empty"; then fail "empty diff approved the issue"; fi
grep -q "empty diff" "$proj_empty/.pipeline/work/issue-empty/exclusions.md" \
  || fail "empty diff was not recorded in exclusions.md"
if grep -q '^- \[x\] issue-empty' "$proj_empty/tasks.md"; then fail "empty-diff issue was marked done"; fi

# ---------------------------------------------------------------- e2e: unparseable reviewer JSON, one retry
proj_retry="$TMP/run-retry"; mkdir -p "$proj_retry/.pipeline/lib"
cp "$SH" "$proj_retry/auto-develop.sh"; cp "$LIB"/*.mjs "$proj_retry/.pipeline/lib/"
cp "$TMP/AGENTS.md" "$proj_retry/AGENTS.md"
printf -- "- [ ] issue-retry: unparseable then ok\n" > "$proj_retry/tasks.md"
git_init "$proj_retry"
stub_retry="$TMP/stub-retry"; mkdir -p "$stub_retry"
cat > "$stub_retry/pi" <<'EOF'
#!/usr/bin/env bash
# Emulate pi: piped (non-TTY) stdin is drained and becomes the message.
last=""
[ -t 0 ] || last="$(cat)"
if [[ -z "$last" ]]; then for a in "$@"; do last="$a"; done; fi
case "$last" in
  "Gather context"*) echo "research notes" ;;
  "Implement this issue"*) printf 'implemented\n' >> ./impl.txt ;;
  *"REMINDER"*)
    echo retry >> "${PI_CALLS_LOG:?}"
    echo '{"role":"security","verdict":"approve","findings":[]}' ;;
  "You review a diff for one concern only: security"*)
    echo review-security >> "${PI_CALLS_LOG:?}"
    echo 'not json at all' ;;
  "You review a diff for one concern only: quality"*) echo '{"role":"quality","verdict":"approve","findings":[]}' ;;
  "You review a diff for one concern only: correctness"*) echo '{"role":"correctness","verdict":"approve","findings":[]}' ;;
  "Merge these reviewer"*) echo '{}' ;;
  "Decide this attempt"*) echo '{"decision":"approve","reasons":["ok"]}' ;;
  *) echo '{}' ;;
esac
EOF
chmod +x "$stub_retry/pi"
rc=0
out="$(cd "$proj_retry" && PATH="$stub_retry:$PATH" PI_CALLS_LOG="$TMP/calls-retry.log" bash auto-develop.sh 2>&1)" || rc=$?
[[ "$rc" -eq 0 ]] || fail "retry-after-garbage should approve once JSON is valid (rc=$rc): $out"
[[ "$(grep -c review-security "$TMP/calls-retry.log")" -eq 1 ]] || fail "security reviewer should run once before retry"
[[ "$(grep -c retry "$TMP/calls-retry.log")" -eq 1 ]] || fail "unparseable reviewer was not retried: $(cat "$TMP/calls-retry.log")"

# ---------------------------------------------------------------- e2e: resume from existing state file
proj_res="$TMP/run-resume"; mkdir -p "$proj_res/.pipeline/lib"
cp "$SH" "$proj_res/auto-develop.sh"; cp "$LIB"/*.mjs "$proj_res/.pipeline/lib/"
cat > "$proj_res/AGENTS.md" <<'MD'
# A
```yaml
models:
  implement:         { provider: a, model: impl }
  implement_master:  { provider: google,    model: master-impl }
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
printf -- "- [ ] issue-resume: continue counters\n" > "$proj_res/tasks.md"
git_init "$proj_res"
GOVERNANCE_AGENTS="$proj_res/AGENTS.md" node "$LIB/governance.mjs" state init "$proj_res/.pipeline" issue-resume >/dev/null
GOVERNANCE_AGENTS="$proj_res/AGENTS.md" node "$LIB/governance.mjs" state issue "$proj_res/.pipeline" issue-resume issue-resume >/dev/null
GOVERNANCE_AGENTS="$proj_res/AGENTS.md" node "$LIB/governance.mjs" state attempt "$proj_res/.pipeline" issue-resume issue-resume controller >/dev/null
GOVERNANCE_AGENTS="$proj_res/AGENTS.md" node "$LIB/governance.mjs" state attempt "$proj_res/.pipeline" issue-resume issue-resume controller >/dev/null
rc=0
out="$(cd "$proj_res" && PATH="$stub_ok:$PATH" PI_CALLS_LOG="$TMP/calls-resume.log" bash auto-develop.sh 2>&1)" || rc=$?
[[ "$rc" -eq 0 ]] || fail "resume run failed (rc=$rc): $out"
att="$(node "$LIB/governance.mjs" state attempts "$proj_res/.pipeline" issue-resume issue-resume)"
# Two attempts already on disk; one more controller attempt should finish the issue.
echo "$att" | grep -q '"controller": 3' || echo "$att" | grep -q '"controller":3' \
  || fail "resume did not continue from stored counters: $att"
echo "$out" | grep -q "^approved: issue-resume" || fail "resume did not approve: $out"

# ---------------------------------------------------------------- e2e: take_over stashes the rejected tree
proj_to="$TMP/run-takeover"; mkdir -p "$proj_to/.pipeline/lib"
cp "$SH" "$proj_to/auto-develop.sh"; cp "$LIB"/*.mjs "$proj_to/.pipeline/lib/"
cp "$TMP/AGENTS.md" "$proj_to/AGENTS.md"
printf -- "- [ ] issue-to: take over\n" > "$proj_to/tasks.md"
git_init "$proj_to"
# Untracked on purpose: stash -u would swallow it without the restore.
printf '## existing blocker\nkeep me\n' > "$proj_to/MEMORY.md"
stub_to="$TMP/stub-to"; mkdir -p "$stub_to"
cat > "$stub_to/pi" <<'EOF'
#!/usr/bin/env bash
# Emulate pi: piped (non-TTY) stdin is drained and becomes the message.
last=""
[ -t 0 ] || last="$(cat)"
if [[ -z "$last" ]]; then for a in "$@"; do last="$a"; done; fi
case "$last" in
  "Gather context"*) echo "research notes" ;;
  "Implement this issue"*) printf 'from-controller\n' >> ./impl.txt ;;
  "You review a diff for one concern only:"*) echo '{"role":"x","verdict":"approve","findings":[]}' ;;
  "Merge these reviewer"*) echo '{}' ;;
  "Decide this attempt"*)
    if [[ -f .pipeline/work/issue-to/.took-over ]]; then
      echo '{"decision":"approve","reasons":["fresh"]}'
    else
      mkdir -p .pipeline/work/issue-to
      touch .pipeline/work/issue-to/.took-over
      echo '{"decision":"take_over","reasons":["wrong approach"]}'
    fi ;;
  *) echo '{}' ;;
esac
EOF
chmod +x "$stub_to/pi"
rc=0
out="$(cd "$proj_to" && PATH="$stub_to:$PATH" PI_CALLS_LOG="$TMP/calls-to.log" bash auto-develop.sh 2>&1)" || rc=$?
[[ "$rc" -eq 0 ]] || fail "take_over run failed (rc=$rc): $out"
echo "$out" | grep -q "stashed working tree" || fail "take_over did not stash: $out"
git -C "$proj_to" stash list | grep -q "pipeline: pre-take_over issue-to-" \
  || fail "stash missing: $(git -C "$proj_to" stash list)"
echo "$out" | grep -q "^approved: issue-to" || fail "take_over path did not approve: $out"
[[ -f "$proj_to/MEMORY.md" ]] || fail "take_over stash swallowed MEMORY.md"
grep -q "keep me" "$proj_to/MEMORY.md" || fail "MEMORY.md content lost after take_over stash"

# ---------------------------------------------------------------- ISSUE_SOURCE=!command and --auto-merge notice
proj_cmd="$TMP/run-cmd"; mkdir -p "$proj_cmd/.pipeline/lib"
cp "$SH" "$proj_cmd/auto-develop.sh"; cp "$LIB"/*.mjs "$proj_cmd/.pipeline/lib/"
cp "$TMP/AGENTS.md" "$proj_cmd/AGENTS.md"
git_init "$proj_cmd"
out="$(cd "$proj_cmd" && ISSUE_SOURCE='!printf "%s\n" "issue-cmd: from command"' bash auto-develop.sh --dry-run --auto-merge --yes 2>&1)" \
  || fail "!command ISSUE_SOURCE dry-run failed: $out"
echo "$out" | grep -q "issue-cmd" || fail "!command source not picked up: $out"
echo "$out" | grep -q "auto-merge: not implemented" || fail "--auto-merge stub notice missing: $out"

# A failing !command is an error, not "no open issues" with exit 0.
rc=0
out="$(cd "$proj_cmd" && ISSUE_SOURCE='!sh -c "exit 17"' bash auto-develop.sh --dry-run 2>&1)" || rc=$?
[[ "$rc" -ne 0 ]] || fail "failed !command source exited 0: $out"
echo "$out" | grep -q "issue source failed (exit 17)" || fail "failed !command did not report its exit: $out"
if echo "$out" | grep -q "no open issues"; then fail "failed !command was reported as no open issues: $out"; fi

# ------------------------------------- e2e: two issues in one run (stdin leak)
# main() drives the loop with `done <<< "$issues"`, so every child inherits the
# issue-list here-string as stdin. pi drains piped stdin and prepends it to the
# prompt, so an unredirected launch would swallow issue two and corrupt issue
# one's prompt. Both issues must be approved, and no role may see the list.
proj_two="$TMP/run-two"; mkdir -p "$proj_two/.pipeline/lib"
cp "$SH" "$proj_two/auto-develop.sh"; cp "$LIB"/*.mjs "$proj_two/.pipeline/lib/"
cp "$TMP/AGENTS.md" "$proj_two/AGENTS.md"
printf -- "- [ ] issue-a: first\n- [ ] issue-b: second\n" > "$proj_two/tasks.md"
git_init "$proj_two"
rc=0
out="$(cd "$proj_two" && PATH="$stub_ok:$PATH" PI_CALLS_LOG="$TMP/calls-two.log" bash auto-develop.sh 2>&1)" || rc=$?
[[ "$rc" -eq 0 ]] || fail "two-issue run failed (rc=$rc): $out"
echo "$out" | grep -q "^approved: issue-a" || fail "issue-a not approved: $out"
echo "$out" | grep -q "^approved: issue-b" || fail "issue-b was swallowed by pi's stdin: $out"
if grep -q '^unknown$' "$TMP/calls-two.log"; then
  fail "a role received the issue list instead of its prompt: $(cat "$TMP/calls-two.log")"
fi
grep -q '^- \[x\] issue-a' "$proj_two/tasks.md" || fail "issue-a not marked done"
grep -q '^- \[x\] issue-b' "$proj_two/tasks.md" || fail "issue-b not marked done"

# ------------------------------------- e2e: MEMORY.md must not unstick a later empty issue
# block_issue appends to MEMORY.md. If capture_diff treats that as the next
# issue's implementation, reviewers rubber-stamp the blocker note and the
# second issue is marked done without a line of code.
proj_mem="$TMP/run-mem"; mkdir -p "$proj_mem/.pipeline/lib"
cp "$SH" "$proj_mem/auto-develop.sh"; cp "$LIB"/*.mjs "$proj_mem/.pipeline/lib/"
cat > "$proj_mem/AGENTS.md" <<'MD'
# A
```yaml
models:
  implement:         { provider: a, model: impl }
  implement_master:  { provider: google,    model: master-impl }
  review:
    security:        { provider: google,    model: r1 }
    quality:         { provider: openai,    model: r2 }
    correctness:     { provider: anthropic, model: r3 }
budgets:
  max_attempts_controller: 1
  max_attempts_master: 1
  max_runs_per_tree: 25
```
MD
printf -- "- [ ] issue-A: write nothing\n- [ ] issue-B: also write nothing\n" > "$proj_mem/tasks.md"
git_init "$proj_mem"
rc=0
out="$(cd "$proj_mem" && PATH="$stub_ok:$PATH" PI_IMPLEMENT=empty PI_CALLS_LOG="$TMP/calls-mem.log" bash auto-develop.sh 2>&1)" || rc=$?
[[ "$rc" -ne 0 ]] || fail "two empty issues should not exit 0: $out"
if echo "$out" | grep -q "^approved:"; then fail "an empty issue was approved via MEMORY.md: $out"; fi
echo "$out" | grep -q "blocked: issue-A" || fail "issue-A was not blocked: $out"
echo "$out" | grep -q "blocked: issue-B" || fail "issue-B was not blocked: $out"
[[ -f "$proj_mem/MEMORY.md" ]] || fail "block_issue did not write MEMORY.md"
if grep -q 'MEMORY.md' "$proj_mem/.pipeline/work/issue-B/diff.patch" 2>/dev/null; then
  fail "issue-B review diff included MEMORY.md"
fi
if grep -q '^- \[x\]' "$proj_mem/tasks.md"; then fail "an empty issue was marked done"; fi

# ------------------------------------- e2e: raw issue id survives sanitising
proj_slash="$TMP/run-slash"; mkdir -p "$proj_slash/.pipeline/lib"
cp "$SH" "$proj_slash/auto-develop.sh"; cp "$LIB"/*.mjs "$proj_slash/.pipeline/lib/"
cp "$TMP/AGENTS.md" "$proj_slash/AGENTS.md"
printf -- "- [ ] feat/login-page: slash in the id\n" > "$proj_slash/tasks.md"
git_init "$proj_slash"
rc=0
out="$(cd "$proj_slash" && PATH="$stub_ok:$PATH" PI_CALLS_LOG="$TMP/calls-slash.log" bash auto-develop.sh 2>&1)" || rc=$?
[[ "$rc" -eq 0 ]] || fail "slash-id run failed (rc=$rc): $out"
echo "$out" | grep -q "^approved: feat-login-page" || fail "slash-id issue not approved: $out"
grep -q '^- \[x\] feat/login-page' "$proj_slash/tasks.md" || fail "raw slash id was not marked done"

# ------------------------------------- no git: fail at start, do not burn the budget
proj_nogit="$TMP/run-nogit"; mkdir -p "$proj_nogit/.pipeline/lib"
cp "$SH" "$proj_nogit/auto-develop.sh"; cp "$LIB"/*.mjs "$proj_nogit/.pipeline/lib/"
cp "$TMP/AGENTS.md" "$proj_nogit/AGENTS.md"
printf -- "- [ ] issue-nogit: no repo\n" > "$proj_nogit/tasks.md"
rc=0
out="$(cd "$proj_nogit" && PATH="$stub_ok:$PATH" PI_CALLS_LOG="$TMP/calls-nogit.log" bash auto-develop.sh 2>&1)" || rc=$?
[[ "$rc" -ne 0 ]] || fail "missing git repo exited 0: $out"
echo "$out" | grep -q "requires a git repository" || fail "missing git repo did not fail at start: $out"
if [[ -f "$TMP/calls-nogit.log" ]]; then fail "missing git repo still invoked pi"; fi

echo "smoke OK"
