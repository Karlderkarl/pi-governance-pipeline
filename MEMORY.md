# MEMORY

Living status for this package. Not packed.

## Drift notes

- **PRD AK6 unmet.** Acceptance criterion 6 asks for working pipelines on at least two harnesses. This repository ships one pi script. The adapter layer from R15 exists only as description.
- **`max_split_depth` is a dead contract.** The field is validated strictly, including the `PIPELINE_ALLOW_DEEP_SPLIT=1` override, but `assets/auto-develop.sh` never splits. PRD §4.4 and the open decision on budget inheritance stay unresolved until a generator implements splitting.
- **No generation eval.** `tests/smoke.sh` covers the bundled assets and documentation greps. It does not ask whether an agent following `SKILL.md` produces a conformant pipeline. `/pipeline-audit` exists because of that gap.

