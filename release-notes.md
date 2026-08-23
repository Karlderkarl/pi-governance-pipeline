Anchors the release-notes freshness guard to the tag's own side of the compare link, and finishes the blank-line discipline around the exclusion block in both directions.

### Fixed
- The freshness guard matched the tag anywhere in `release-notes.md` — including the *left* side of the compare link, so re-tagging vN while notes for vN+1 were already seeded would have published notes describing the wrong range. The guard now anchors: the tag must appear on the right side of the compare link (`…v1.0.7...v1.0.8`) or as a markdown heading, verified against a five-case matrix including `v1.0.80` collisions.
- The README described the guard's condition but not its requirement; it now states plainly that the file must name the tag being released, otherwise the fallback generates notes instead.
- Blank lines around the exclusion block are now correct in both directions: exactly one before the closing instruction when prior findings exist, and exactly one when they don't (previously three in the first attempt). The block is built before the heredoc and inserted via `${excl:+…}`, because trailing newlines inside heredoc command substitutions are stripped.

### Changed
- README install examples track the release (`@1.0.8`).
- Smoke pins the empty-exclusion case too: the first-attempt prompt must show exactly one blank line before the closing instruction (the test project now carries a SOUL.md so the assertion measures spacing, not a missing excerpt).

**Full Changelog**: https://github.com/Karlderkarl/pi-governance-pipeline/compare/v1.0.7...v1.0.8
