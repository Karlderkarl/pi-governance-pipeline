Closes a fail-open hole in the deterministic gate. `gate.mjs` picked the **last** JSON object a reviewer emitted, so a reviewer that rejected a diff and then quoted a JSON object out of that diff to explain itself lost its own verdict — and with it every finding. The gate reported `clear` and exited 0. This was the last last-wins parser in the package; 1.0.14 had already converted the master verdict.

### Fixed
- `extractJson` in `gate.mjs` took the last parseable object. A reviewer emitting a correct `reject` with a `critical` finding, followed by a fenced quote of a fixture from the diff (`{"verdict":"approve","findings":[]}`), ended as that quote: no findings, `verdict: "clear"`, exit 0. Among several parseable candidates the **strictest** now wins, ranked by the worst finding each carries — the same key the gate scores by further down, so an appended object can only displace the real one by carrying strictly more severe findings, which cannot lower the outcome. Ties keep the first, so a prompt template written *before* the real object stays powerless even where `isEcho` does not catch it.
  - The key is deliberately the worst finding, not the verdict word. A reviewer may write `approve` and still report a `critical`, and that critical must block — `gate.mjs` has always scored severity rather than the word. Ranking candidates by the word would let an appended `{"verdict":"reject","findings":[]}` drop that finding instead, trading one fail-open path for another.
  - The `shaped` fallback tier had the same defect and is converted with it. `verdict ?? shaped` only protects while one candidate carries a valid verdict word; a reviewer whose real object uses an off-schema word (`"blocked"` — a shape `smoke.sh` already tests as supported) has both candidates land in `shaped`, where last-wins applied unchanged.
  - Reachable from this repository's own diffs: `tests/smoke.sh` carries 32 objects of exactly the quoted form, so any diff touching it puts them into every reviewer prompt.

### Added
- `tests/smoke.sh` covers the fix at both levels. Four unit cases on `gate.mjs`: a quoted `approve` after a real `reject`; a quoted `{"findings":[]}` after one (regression guard for the `verdict ?? shaped` tiering, which already held); a quoted empty `reject` after an `approve` that reports a `critical`; and the same against the `shaped` fallback tier. Plus an end-to-end run through `auto-develop.sh` with a reviewer stub that rejects and then quotes a fixture — the gate twin of the 1.0.14 R4 master-verdict test. Against 1.0.14 that run ends in `approved:`.

### Changed
- The master-decision twin test in `smoke.sh` still described and reimplemented last-wins, three releases after `auto-develop.sh` moved to strictest-wins in 1.0.14. It passed only because its single input answers both rules the same way, so a regression would have gone unseen. It now mirrors the shipped parser, adds the discriminating case (a quoted `approve` after a real `reject` must stay `reject`) and a fail-closed case, and greps `auto-develop.sh` for the rank comparison the way it already greps for the raw-text fallback.
- The comment above `extractJson` argued that last-wins was safe here because "an appended object cannot lower the outcome on its own — it would have to also drop every blocking finding". A quoted `{"verdict":"approve","findings":[]}` does exactly that. Replaced with the reasoning for the severity ranking.
- README install pins and the release section track 1.0.15.

`auto-develop.sh` is unchanged: its master-verdict parser has taken the strictest decision since 1.0.14.

**Full Changelog**: https://github.com/Karlderkarl/pi-governance-pipeline/compare/v1.0.14...v1.0.15
