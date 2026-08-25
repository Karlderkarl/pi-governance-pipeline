Adds an optional per-role `thinking` level to the model contract, so effort can be routed like models are — a cheap level for the mechanical roles, a high one where the reasoning has to hold.

### Added
- `models.<role>.thinking` accepts pi's levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) and launches the role as `--model provider/id:thinking`, pi's documented shorthand. Absent, the level stays pi's own decision, so a pre-contract mapping behaves exactly as before.
- Validation refuses an unknown level at generation time. pi's CLI does not fall back on an invalid `:suffix` — it fails to resolve the model — so the error belongs where the mapping is written, not where it launches.

### Changed
- `no_self_review` compares `provider/model` and ignores the level, in the validator and at run time: the same model at two effort levels is still the same model reviewing its own diff. `implement_master` vs `implement` is compared the same way.
- Contract, skill, and README now state what the level does not promise: pi clamps a level a model does not expose to the nearest one it does, silently, and the run log records the level that was requested. Omitted, pi resolves it from `modelThinkingLevels` for that model first, `defaultThinkingLevel` second, and its own built-in default (`medium`) last — an unmapped role is not an unthinking one.
- The example mapping puts `master_review` at `high` rather than below the implementers it adjudicates.

**Full Changelog**: https://github.com/Karlderkarl/pi-governance-pipeline/compare/v1.0.8...v1.0.9
