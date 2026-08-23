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

echo "smoke OK"
