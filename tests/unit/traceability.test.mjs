// traceability.test.mjs — INV-28: the invariants live in one file, every
// invariant names a test that exists, every unit test names an invariant, and
// the wrapper a project keeps carries no loop logic.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const invariants = readFileSync(join(root, "skills", "governance-pipeline", "references", "invariants.md"), "utf8");
const smoke = readFileSync(join(root, "tests", "smoke.sh"), "utf8");

const entries = invariants
	.split(/^### /m)
	.slice(1)
	.map((chunk) => ({ id: chunk.match(/^(INV-\d\d)/)?.[1], body: chunk }));

test("every invariant has an id, a reason, and at least one test that exists", () => {
	assert.ok(entries.length >= 25, `only ${entries.length} invariants found`);
	const ids = new Set();
	for (const { id, body } of entries) {
		assert.ok(id, `heading without an INV id: ${body.slice(0, 40)}`);
		assert.ok(!ids.has(id), `${id} listed twice`);
		ids.add(id);
		assert.match(body, /\*\*Why:\*\*/, `${id} has no reason`);
		const tests = body.match(/\*\*Test:\*\*\s*([^\n]+)/);
		assert.ok(tests, `${id} names no test`);
		for (const ref of tests[1].split("|").map((s) => s.trim()).filter(Boolean)) {
			const m = ref.match(/^(smoke|unit):\s*(.+)$/);
			assert.ok(m, `${id}: test reference "${ref}" must be smoke:<scenario label> or unit:<file>, separated by |`);
			if (m[1] === "smoke") assert.ok(smoke.includes(m[2]), `${id}: smoke.sh has no scenario labelled "${m[2]}"`);
			else assert.ok(existsSync(join(root, "tests", "unit", m[2])), `${id}: tests/unit/${m[2]} does not exist`);
		}
	}
});

test("every unit test file names at least one invariant, and every named id exists", () => {
	const ids = new Set(entries.map((e) => e.id));
	for (const file of readdirSync(join(root, "tests", "unit")).filter((f) => f.endsWith(".test.mjs"))) {
		const text = readFileSync(join(root, "tests", "unit", file), "utf8");
		const named = [...text.matchAll(/INV-\d\d/g)].map((m) => m[0]);
		assert.ok(named.length > 0, `${file} names no invariant`);
		for (const id of named) assert.ok(ids.has(id), `${file} names ${id}, which invariants.md does not define`);
	}
});

test("skill reference links resolve inside the published package and name existing invariants", () => {
	const packed = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).files;
	const ids = new Set(entries.map((entry) => entry.id));
	const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith(".md") ? [join(dir, entry.name)] : []);
	for (const file of [...walk(join(root, "skills")), ...walk(join(root, "prompts"))]) {
		const content = readFileSync(file, "utf8");
		for (const [, href] of content.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)) {
			if (/^(?:[a-z]+:|#)/i.test(href)) continue;
			const target = resolve(dirname(file), decodeURIComponent(href.split("#")[0]));
			assert.ok(existsSync(target), `${relative(root, file)} has a broken link: ${href}`);
			const path = relative(root, target).split(sep).join("/");
			assert.ok(packed.some((entry) => path === entry || path.startsWith(`${entry}/`)), `${href} is not shipped with the skill`);
		}
		for (const [id] of content.matchAll(/INV-\d\d/g)) assert.ok(ids.has(id), `${relative(root, file)} refers to unknown ${id}`);
	}
});

test("the wrapper carries no loop logic and the engine has no inline node programs", () => {
	const wrapper = readFileSync(join(root, "tests", "fixtures", "auto-develop.sh"), "utf8").split("\n").filter((l) => l.trim() !== "");
	assert.ok(wrapper.length <= 8, `wrapper has ${wrapper.length} lines`);
	assert.ok(!wrapper.some((l) => /while|for |if .*review|pi -p/.test(l)), "wrapper contains loop logic");
	const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".mjs") ? [join(d, e.name)] : []));
	for (const file of walk(join(root, "lib"))) {
		assert.ok(!/node -e/.test(readFileSync(file, "utf8")), `${file} shells out to node -e`);
	}
	assert.ok(!existsSync(join(root, "skills", "governance-pipeline", "assets")), "the copied-assets model is gone");
	const skill = readFileSync(join(root, "skills", "governance-pipeline", "SKILL.md"), "utf8");
	const body = skill.split(/^---$/m)[2] ?? "";
	assert.ok(body.split("\n").length <= 80, `SKILL.md body has ${body.split("\n").length} lines`);
});
