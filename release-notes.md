Keeps internal notes out of model prompts, unglues the exclusion-cap marker, archives one prompt per attempt, and teaches the release workflow to read curated notes from `release-notes.md`.

### Fixed
- A script comment (`# tail, not head …`) sat inside the implement-prompt heredoc and leaked into every retry prompt; it now lives outside the heredoc like all other comments.
- The `[older blocks omitted]` marker glued itself to the first kept line (`…kept]lint-line-46`) because command substitution strips the trailing newline; the block is now printed line by line.
- The GitHub Release step now actually honors a pre-seeded `release-notes.md` (`--notes-file`), as the README already claimed — the claim outran the implementation in f91f3d4.

### Changed
- Prompt archive keeps **one file per role and attempt** (`<issue>-<role>-a<N>[-retry]-<run>.txt`) instead of overwriting per role, so retry loops stay debuggable — including which exclusion block survived the cap on attempts 1..N-1.
- The unreachable all-reviewers-dropped `gate.json` branch now carries `min_reviewers`, matching the `gate.mjs` output shape.
- README documents the script tuning variables (`DIFF_MAX_BYTES`, `EXCLUSIONS_MAX_LINES`, `MIN_REVIEWERS`) with their defaults.

**Full Changelog**: https://github.com/Karlderkarl/pi-governance-pipeline/compare/v1.0.5...v1.0.6
