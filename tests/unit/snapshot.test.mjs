// snapshot.test.mjs — INV-20 (governance integrity by snapshot) and INV-14
// (one governance path list).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GUARD_PATHS, GOVERNANCE_FILES, diffPathspecExcludes, guardMatches, isGovernanceTreePath, preservePaths } from "../../lib/integrity/governance-paths.mjs";
import { compareSnapshots, describeDiff, restoreSnapshot, takeSnapshot, uncoveredLinks } from "../../lib/integrity/snapshot.mjs";

test("snapshot detects modified, created and deleted governance and restores it", () => {
	const root = mkdtempSync(join(tmpdir(), "snap-"));
	writeFileSync(join(root, "AGENTS.md"), "a");
	writeFileSync(join(root, "SOUL.md"), "s");
	mkdirSync(join(root, ".pi"));
	writeFileSync(join(root, ".pi", "settings.json"), "{}");
	const paths = preservePaths(root);
	const before = takeSnapshot(paths);
	writeFileSync(join(root, "AGENTS.md"), "a-changed");
	rmSync(join(root, "SOUL.md"));
	writeFileSync(join(root, ".pi", "planted.md"), "x");
	writeFileSync(join(root, "src.ts"), "not governance");
	const diff = compareSnapshots(before, takeSnapshot(paths));
	assert.equal(diff.clean, false);
	assert.equal(diff.changed.length, 1);
	assert.equal(diff.removed.length, 1);
	assert.equal(diff.added.length, 1);
	assert.match(describeDiff(root, diff), /modified: AGENTS.md; created: .pi\/planted.md; deleted: SOUL.md/);
	restoreSnapshot(before, diff);
	assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), "a");
	assert.equal(readFileSync(join(root, "SOUL.md"), "utf8"), "s");
	assert.equal(existsSync(join(root, ".pi", "planted.md")), false);
	assert.equal(existsSync(join(root, "src.ts")), true);
	assert.equal(compareSnapshots(before, takeSnapshot(paths)).clean, true);
});

test("snapshot compares by hash, keeps big files on disk, and the after-snapshot is hash-only", () => {
	const root = mkdtempSync(join(tmpdir(), "snap-big-"));
	mkdirSync(join(root, ".pi"));
	const big = Buffer.alloc(3 * 1024 * 1024, 7);
	writeFileSync(join(root, ".pi", "big.bin"), big);
	writeFileSync(join(root, "AGENTS.md"), "a");
	const paths = preservePaths(root);
	const spill = join(root, "spill");
	const before = takeSnapshot(paths, { spillDir: spill, keepBytes: 1024 * 1024 });
	const bigEntry = [...before.values()].find((e) => e.size === big.length);
	assert.equal(bigEntry.content, null, "big file is not held in memory");
	assert.ok(bigEntry.spill && existsSync(bigEntry.spill), "big file is spilled to disk");
	assert.ok([...before.values()].find((e) => e.size === 1).content, "small file stays in memory");
	writeFileSync(join(root, ".pi", "big.bin"), Buffer.alloc(3 * 1024 * 1024, 9));
	const after = takeSnapshot(paths, { hashOnly: true });
	assert.equal([...after.values()].every((e) => e.content === null && e.spill === null), true, "hash-only keeps nothing");
	const diff = compareSnapshots(before, after);
	assert.equal(diff.changed.length, 1);
	assert.deepEqual(restoreSnapshot(before, diff), []);
	assert.ok(readFileSync(join(root, ".pi", "big.bin")).equals(big), "restored from the spill copy");
	// A hash-only "before" cannot restore and says so.
	const hashOnlyBefore = takeSnapshot(paths, { hashOnly: true });
	writeFileSync(join(root, "AGENTS.md"), "changed");
	const d2 = compareSnapshots(hashOnlyBefore, takeSnapshot(paths, { hashOnly: true }));
	assert.equal(restoreSnapshot(hashOnlyBefore, d2).length, 1);
});

test("snapshot diagnostics stay project-relative through a directory alias", () => {
	const work = mkdtempSync(join(tmpdir(), "snap-alias-"));
	const target = join(work, "actual");
	const alias = join(work, "alias");
	mkdirSync(target);
	symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
	const path = join(alias, "AGENTS.md");
	writeFileSync(path, "before");
	const before = takeSnapshot([path]);
	writeFileSync(path, "after");
	const diff = compareSnapshots(before, takeSnapshot([path]));
	assert.equal(describeDiff(alias, diff), "modified: AGENTS.md");
	assert.deepEqual(restoreSnapshot(before, diff), []);
	assert.equal(readFileSync(path, "utf8"), "before");
});

test("a changed disk recovery copy is refused instead of restored into governance", () => {
	const root = mkdtempSync(join(tmpdir(), "snap-corrupt-"));
	const path = join(root, "AGENTS.md");
	writeFileSync(path, Buffer.alloc(2 * 1024 * 1024, 7));
	const before = takeSnapshot([path], { spillDir: join(root, "spill") });
	const entry = [...before.values()][0];
	assert.equal(entry.content, null);
	writeFileSync(entry.spill, "tampered recovery data");
	writeFileSync(path, "changed governance");
	const diff = compareSnapshots(before, takeSnapshot([path], { hashOnly: true }));
	assert.ok(restoreSnapshot(before, diff).includes([...before.keys()][0]));
	if (existsSync(path)) assert.notEqual(readFileSync(path, "utf8"), "tampered recovery data");
});

test("governance paths: one list feeds the diff filter, the pathspecs and the guard", () => {
	for (const f of GOVERNANCE_FILES) {
		assert.equal(isGovernanceTreePath(f), true, f);
		assert.ok(diffPathspecExcludes().includes(`:(exclude)${f}`), f);
		assert.equal(guardMatches(`docs/${f}`), f);
	}
	assert.equal(isGovernanceTreePath(".pipeline/logs/x.jsonl"), true);
	assert.equal(isGovernanceTreePath(".pi/APPEND_SYSTEM.md"), true);
	assert.equal(isGovernanceTreePath("src/AGENTS.md"), false, "nested copies are implementation for the diff");
	assert.equal(isGovernanceTreePath("MYAGENTS.md"), false);
	assert.equal(guardMatches("C:\\proj\\.pi\\settings.json"), ".pi/settings.json");
	assert.equal(guardMatches("MYAGENTS.md"), undefined);
	assert.ok(GUARD_PATHS.includes("AGENTS.override.md"));
});

// A link records its target, not its contents: a role that writes through one
// changes governance without a byte of the snapshot moving.
test("a governance link is safe only where its target is itself protected", () => {
	const root = mkdtempSync(join(tmpdir(), "snap-links-"));
	const kind = process.platform === "win32" ? "junction" : "dir";
	writeFileSync(join(root, "AGENTS.md"), "a");
	// The shared-config case: .pi is a junction to a directory nobody protects.
	const shared = join(root, "shared-pi");
	mkdirSync(shared);
	writeFileSync(join(shared, "APPEND_SYSTEM.md"), "rules");
	symlinkSync(shared, join(root, ".pi"), kind);
	const linked = uncoveredLinks(takeSnapshot([join(root, "AGENTS.md"), join(root, ".pi")]));
	assert.deepEqual(linked.map((l) => l.path), [join(root, ".pi")]);
	// A link into a protected directory is covered by the walk of that directory.
	const inside = mkdtempSync(join(tmpdir(), "snap-links-"));
	mkdirSync(join(inside, ".pi"));
	writeFileSync(join(inside, ".pi", "APPEND_SYSTEM.md"), "rules");
	symlinkSync(join(inside, ".pi"), join(inside, "alias"), kind);
	assert.deepEqual(uncoveredLinks(takeSnapshot([join(inside, ".pi"), join(inside, "alias")])), []);
	// A dangling link points at something a role could create.
	const dangling = mkdtempSync(join(tmpdir(), "snap-links-"));
	symlinkSync(join(dangling, "missing"), join(dangling, ".pi"), kind);
	assert.equal(uncoveredLinks(takeSnapshot([join(dangling, ".pi")])).length, 1);
	// No link, no finding.
	assert.deepEqual(uncoveredLinks(takeSnapshot([join(root, "AGENTS.md")])), []);
});
