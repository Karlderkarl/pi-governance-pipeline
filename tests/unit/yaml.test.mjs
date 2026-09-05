// yaml.test.mjs — the contract subset parser. INV-05 (gates come from the
// contract, commas and all), INV-29 (a marker is not a value).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseYamlSubset, splitTopLevel, stripComment } from "../../lib/contract/yaml.mjs";

test("v1 contract shape parses unchanged", () => {
	const v = parseYamlSubset(`models:
  implement: { provider: X, model: strong, thinking: high }
  review:
    security: { provider: Y, model: mid }
  constraints:
    no_self_review: true
budgets:
  max_attempts_controller: 3
review:
  blocking_severities: [critical, high]
`);
	assert.deepEqual(v.models.implement, { provider: "X", model: "strong", thinking: "high" });
	assert.equal(v.models.constraints.no_self_review, true);
	assert.equal(v.budgets.max_attempts_controller, 3);
	assert.deepEqual(v.review.blocking_severities, ["critical", "high"]);
});

test("block sequences of inline maps and of maps", () => {
	const v = parseYamlSubset(`gates:
  - { name: lint, run: "npm run lint" }
  - name: test
    run: "npm test -- --runInBand"
`);
	assert.deepEqual(v.gates, [
		{ name: "lint", run: "npm run lint" },
		{ name: "test", run: "npm test -- --runInBand" },
	]);
});

test("a sequence may sit at the key's own indent", () => {
	const v = parseYamlSubset("gates:\n- name: a\n  run: x\n- { name: b, run: y }\n");
	assert.deepEqual(v.gates, [
		{ name: "a", run: "x" },
		{ name: "b", run: "y" },
	]);
});

test("quotes protect commas, colons and hashes", () => {
	const v = parseYamlSubset(`gates:
  - { name: lint, run: "eslint --ext .js,.ts src # keep" }
issues:
  source: "gh issue list --label ready: yes"
`);
	assert.equal(v.gates[0].run, "eslint --ext .js,.ts src # keep");
	assert.equal(v.issues.source, "gh issue list --label ready: yes");
	assert.deepEqual(splitTopLevel('a: "x,y", b: [1,2]'), ['a: "x,y"', " b: [1,2]"]);
	assert.equal(stripComment('run: "echo # no" # yes'), 'run: "echo # no" ');
});

test("scalars: booleans, numbers, null, plain strings with colons", () => {
	const v = parseYamlSubset("a: true\nb: 12\nc: ~\nd: http://x/y\ne: 'it''s'\nf: \"a\\nb\"\n");
	assert.equal(v.a, true);
	assert.equal(v.b, 12);
	assert.equal(v.c, null);
	assert.equal(v.d, "http://x/y");
	assert.equal(v.e, "it's");
	assert.equal(v.f, "a\nb");
});

test("a decision marker in list syntax parses to a list, which the reader then rejects", () => {
	const v = parseYamlSubset("issues:\n  source: [USER DECISION REQUIRED]\n");
	assert.deepEqual(v.issues.source, ["USER DECISION REQUIRED"]);
});

test("unsupported constructs are contract errors that name themselves", () => {
	for (const [text, word] of [
		["a: |\n  x\n", "block scalar"],
		["a: &anchor b\n", "anchor"],
		["a: *alias\n", "alias"],
		["a: !!str b\n", "tag"],
	]) {
		assert.throws(() => parseYamlSubset(text), (e) => e.code === "CONTRACT" && e.message.includes(word));
	}
	assert.throws(() => parseYamlSubset("a:\n   b: 1\n  c: 2\n"), /unexpected indentation/);
});

test("empty input is an empty map", () => {
	assert.deepEqual(parseYamlSubset(""), {});
	assert.deepEqual(parseYamlSubset("# only a comment\n"), {});
});

test("duplicate keys and nested sequences are contract errors, never last-wins or a stray scalar", () => {
	assert.throws(() => parseYamlSubset("models:\n  implement: { provider: a, model: m }\n  implement: { provider: b, model: n }\n"), (e) => e.code === "CONTRACT" && /duplicate key `models\.implement`/.test(e.message));
	assert.throws(() => parseYamlSubset("a: { x: 1, x: 2 }\n"), (e) => e.code === "CONTRACT" && /duplicate key `x` in inline map/.test(e.message));
	assert.throws(() => parseYamlSubset("gates:\n  - name: a\n    run: x\n    name: b\n"), (e) => e.code === "CONTRACT" && /duplicate key/.test(e.message));
	assert.throws(() => parseYamlSubset("a:\n  - - x\n"), (e) => e.code === "CONTRACT" && /nested sequence/.test(e.message));
});
