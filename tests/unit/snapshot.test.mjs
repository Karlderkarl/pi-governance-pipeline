// snapshot.test.mjs — INV-20 (governance integrity by snapshot) and INV-14
// (one governance path list).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GUARD_PATHS, GOVERNANCE_FILES, diffPathspecExcludes, guardMatches, isGovernanceTreePath, preservePaths } from "../../lib/integrity/governance-paths.mjs";
import { compareSnapshots, describeDiff, restoreSnapshot, takeSnapshot } from "../../lib/integrity/snapshot.mjs";

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
