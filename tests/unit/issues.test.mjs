// issues.test.mjs — the tasks.md source: listing, closing, creating children
// for a split (INV-21), and the command source's error path (INV-24 trust).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commandSource, openIssueSource, tasksMdSource } from "../../lib/issues/source.mjs";

const root = mkdtempSync(join(tmpdir(), "issues-"));

test("tasks.md: open items, parents, done markers, raw ids with slashes", async () => {
	const p = join(root, "tasks.md");
	writeFileSync(p, "# header\n- [ ] feat/login: slash id\n- [x] done-1: closed\n- [ ] big: parent\n  - [ ] big.1: child one\n  - [x] big.2: child done\n");
	const src = tasksMdSource(p, root);
	const list = await src.list();
	assert.deepEqual(
		list.map((i) => [i.raw, i.parent]),
		[
			["feat/login", null],
			["big", null],
			["big.1", "big"],
		],
	);
	assert.equal(list[0].line, "feat/login: slash id");
	assert.equal(await src.markDone("feat/login"), true);
	assert.match(readFileSync(p, "utf8"), /^- \[x\] feat\/login: slash id$/m);
	assert.equal(await src.markDone("nope"), false);
});

test("tasks.md: create appends children under the parent with ids parent.n", async () => {
	const p = join(root, "split.md");
	writeFileSync(p, "- [ ] a: first\n- [ ] b: second\n");
	const src = tasksMdSource(p, root);
	assert.equal(await src.create({ parentRaw: "a", title: "one" }), "a.1");
	assert.equal(await src.create({ parentRaw: "a", title: "two" }), "a.2");
	assert.equal(readFileSync(p, "utf8"), "- [ ] a: first\n  - [ ] a.1: one\n  - [ ] a.2: two\n- [ ] b: second\n");
	const list = await src.list();
	assert.deepEqual(
		list.map((i) => i.raw),
		["a", "a.1", "a.2", "b"],
	);
	assert.equal(list[1].parent, "a");
	await assert.rejects(src.create({ parentRaw: "zzz", title: "x" }), /not found/);
});

test("tasks.md: create picks the first unused id and flattens a multi-line title", async () => {
	const p = join(root, "collide.md");
	writeFileSync(p, "- [ ] big: parent\n  - [ ] big.2: hand-written\n");
	const src = tasksMdSource(p, root);
	assert.equal(await src.create({ parentRaw: "big", title: "first" }), "big.1");
	assert.equal(await src.create({ parentRaw: "big", title: "x\n- [ ] evil: injected\n  - [ ] deeper: more" }), "big.3");
	const text = readFileSync(p, "utf8");
	assert.equal(text, "- [ ] big: parent\n  - [ ] big.2: hand-written\n  - [ ] big.1: first\n  - [ ] big.3: x - [ ] evil: injected - [ ] deeper: more\n");
	assert.deepEqual(
		(await src.list()).map((i) => i.raw),
		["big", "big.2", "big.1", "big.3"],
	);
});

test("command source: stdout lines, no create, failure carries the exit code", async () => {
	const ok = commandSource('printf "%s\\n" "x-1: from a command" ""', { root, env: process.env });
	const list = await ok.list();
	assert.deepEqual(list.map((i) => i.raw), ["x-1"]);
	assert.equal(ok.create, null);
	assert.equal(ok.trust, "external");
	const bad = commandSource("exit 17", { root, env: process.env });
	await assert.rejects(bad.list(), (e) => e.code === "SOURCE" && /exit 17/.test(e.message));
	assert.equal(openIssueSource({ kind: "command", command: "true", trust: "internal", spec: "!true" }, { root }).trust, "internal");
	assert.equal(openIssueSource({ kind: "file", path: "tasks.md" }, { root }).relPath, "tasks.md");
});

test("tasks.md with CRLF is read like LF and written back with CRLF (INV-25)", async () => {
	const p = join(root, "crlf.md");
	writeFileSync(p, "- [ ] a: one\r\n  - [ ] a.1: child\r\n- [x] done: closed\r\n");
	const src = tasksMdSource(p, root);
	assert.deepEqual(
		(await src.list()).map((i) => [i.raw, i.parent, i.title]),
		[
			["a", null, "one"],
			["a.1", "a", "child"],
		],
	);
	assert.equal(await src.create({ parentRaw: "a", title: "second" }), "a.2");
	assert.equal(await src.markDone("a.1"), true);
	assert.equal(readFileSync(p, "utf8"), "- [ ] a: one\r\n  - [x] a.1: child\r\n  - [ ] a.2: second\r\n- [x] done: closed\r\n");
});

test("ids that sanitise to the same directory are refused; raw ids are trimmed", async () => {
	const p = join(root, "collide-ids.md");
	writeFileSync(p, "- [ ] feat/a: slash\n- [ ] feat-a: dash\n");
	await assert.rejects(tasksMdSource(p, root).list(), (e) => e.code === "SOURCE" && /"feat\/a" and "feat-a" both become "feat-a"/.test(e.message));
	writeFileSync(p, "- [ ]  spaced : leading space\n- [ ] a: x\n- [ ] a: x again\n");
	const list = await tasksMdSource(p, root).list();
	assert.deepEqual(
		list.map((i) => i.raw),
		["spaced", "a", "a"],
	);
	assert.equal(list[0].line, "spaced : leading space");
	const cmd = commandSource('printf "%s\\n" "x/1: one" "x-1: two"', { root, env: process.env });
	await assert.rejects(cmd.list(), (e) => e.code === "SOURCE" && /both become "x-1"/.test(e.message));
});

test("a command source is capped like a gate", async () => {
	const slow = commandSource("sleep 5; echo x-1: late", { root, env: process.env, timeoutMs: 500 });
	await assert.rejects(slow.list(), (e) => e.code === "SOURCE" && /timed out after 1s/.test(e.message));
});
