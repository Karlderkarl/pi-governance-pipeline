Guards the release workflow against stale curated notes, pulls the README examples up to the version they describe, and finishes the prompt-hygiene pass around the exclusion block.

### Fixed
- `release-notes.md` had no freshness guard: tagging without touching the file would have silently published the previous release's notes, including a compare link for the wrong range. The workflow now only uses the file when it names the tag being released, and otherwise falls back to generated notes — generic, but never wrong.
- The README install examples pinned `@1.0.5` while the registry already served 1.0.6; they now track the release, and the example tag command uses a `vX.Y.Z` placeholder instead of an already-taken tag.
- The blank line between the exclusion block and the closing instruction was lost in the glue fix: after a long lint block the prompt's only imperative line stuck to the last finding. Separated again; smoke pins it.
- `You have 1 attempts left` — singular now spells correctly.

### Changed
- Attempt tags in the prompt archive are zero-padded (`a01`…`a20`), so plain `ls` sorts them chronologically past attempt 9.
- The release checklist explicitly calls for seeding `release-notes.md` alongside the version bump.

**Full Changelog**: https://github.com/Karlderkarl/pi-governance-pipeline/compare/v1.0.6...v1.0.7
