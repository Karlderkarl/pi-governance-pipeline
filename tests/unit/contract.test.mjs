// contract.test.mjs — reading and validating AGENTS.md. INV-01 (routing from
// governance), INV-05 (gates from the contract), INV-09 (escalation and
// provider diversity), INV-18 (severity partition), INV-29 (markers refuse).
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	effectiveGates,
	effectiveIssueSource,
	modelIdentity,
	readConfig,
	resolveAllModels,
	validate,
} from "../../lib/contract/index.mjs";

const dir = mkdtempSync(join(tmpdir(), "contract-"));
function agents(body, name = "AGENTS.md") {
	const p = join(dir, name);
	writeFileSync(p, `# A\n\`\`\`yaml pipeline-contract\n${body}\n\`\`\`\n`);
	return p;
}
const PANEL = `models:
  implement:        { provider: anthropic, model: impl, thinking: high }
  implement_master: { provider: google,    model: master }
  review:
    security:    { provider: google,    model: r1 }
    quality:     { provider: openai,    model: r2 }
    correctness: { provider: anthropic, model: r3, thinking: low }`;

test("v1 file: defaults, routing map, thinking suffix, identity without thinking", () => {
	const src = readConfig(agents(PANEL));
	assert.equal(src.config.contract_version, 1);
	assert.equal(src.config.budgets.max_runs_per_tree, 25);
	assert.equal(src.config.gates, null);
	const models = resolveAllModels(src.config);
	assert.equal(models.implement, "anthropic/impl:high");
	assert.equal(models["review.correctness"], "anthropic/r3:low");
	assert.equal(models.research, "default");
	assert.equal(modelIdentity("anthropic/impl:high"), "anthropic/impl");
	assert.equal(modelIdentity("anthropic/impl"), "anthropic/impl");
	assert.deepEqual(validate(src.config, src).errors, []);
});

test("v2 file requires issues.source and gates; gates: [] is a warning", () => {
	const missing = readConfig(agents(`contract_version: 2\n${PANEL}`));
	const e1 = validate(missing.config, missing).errors;
	assert.ok(e1.some((e) => e.includes("issues.source is required")));
	assert.ok(e1.some((e) => e.includes("gates is required")));
	const empty = readConfig(agents(`contract_version: 2\n${PANEL}\nissues:\n  source: tasks.md\ngates: []`));
	const r = validate(empty.config, empty);
	assert.deepEqual(r.errors, []);
	assert.ok(r.warnings.some((w) => w.includes("empty on purpose")));
});

test("gates: shape errors name the entry; a map form is normalised to a list", () => {
	const bad = readConfig(agents(`contract_version: 2\n${PANEL}\nissues:\n  source: tasks.md\ngates:\n  - { name: "bad name", run: x }\n  - { name: dup, run: a }\n  - { name: dup, run: "" }`));
	const errors = validate(bad.config, bad).errors;
	assert.ok(errors.some((e) => e.includes("gates[0].name")));
	assert.ok(errors.some((e) => e.includes("gates[2].name (dup) is used twice")));
	assert.ok(errors.some((e) => e.includes("gates[2].run")));
	const map = readConfig(agents(`${PANEL}\ngates: { lint: "npm run lint", test: "npm test" }`));
	assert.deepEqual(map.config.gates, [
		{ name: "lint", run: "npm run lint" },
		{ name: "test", run: "npm test" },
	]);
});

test("decision markers refuse with the field named, whatever syntax carried them", () => {
	for (const value of ['"[USER DECISION REQUIRED]"', "[USER DECISION REQUIRED]", "[NEEDS PRD CLARIFICATION]"]) {
		const src = readConfig(agents(`${PANEL}\nissues:\n  source: ${value}\ngates: []`));
		assert.equal(src.decisions.length, 1);
		assert.equal(src.decisions[0].path, "issues.source");
		const errors = validate(src.config, src).errors;
		assert.ok(errors.some((e) => e.includes("issues.source") && e.includes("marker")), errors.join("\n"));
	}
});

test("effectiveGates: LINT_CMD/TEST_CMD replace the contract list for a run", () => {
	const src = readConfig(agents(`${PANEL}\ngates:\n  - { name: lint, run: "c-lint" }`));
	assert.deepEqual(effectiveGates(src.config, {}), { gates: [{ name: "lint", run: "c-lint" }], origin: "contract" });
	const env = effectiveGates(src.config, { LINT_CMD: "e-lint", TEST_CMD: "e-test" });
	assert.equal(env.origin, "env");
	assert.deepEqual(
		env.gates.map((g) => g.run),
		["e-lint", "e-test"],
	);
	assert.equal(effectiveGates(readConfig(agents(PANEL)).config, {}).origin, "none");
});

test("effectiveIssueSource: env overrides contract; command sources are external unless said otherwise", () => {
	const src = readConfig(agents(`${PANEL}\nissues:\n  source: { command: "gh issue list", trust: internal }`));
	const fromContract = effectiveIssueSource(src.config, {});
	assert.equal(fromContract.kind, "command");
	assert.equal(fromContract.trust, "internal");
	const fromEnv = effectiveIssueSource(src.config, { ISSUE_SOURCE: "!jira list" });
	assert.equal(fromEnv.command, "jira list");
	assert.equal(fromEnv.trust, "external");
	assert.equal(effectiveIssueSource(readConfig(agents(PANEL)).config, {}).path, "tasks.md");
});

test("v1 refusals stay: same implementer twice, single provider, severity lists that do not partition", () => {
	const same = readConfig(agents("models:\n  implement: { provider: a, model: m, thinking: high }\n  implement_master: { provider: a, model: m, thinking: low }"));
	assert.ok(validate(same.config, same).errors.some((e) => e.includes("equals models.implement")));
	const one = readConfig(agents("models:\n  review:\n    security: { provider: a, model: r1 }\n    quality: { provider: a, model: r2 }"));
	assert.ok(validate(one.config, one).errors.some((e) => e.includes("single provider")));
	const part = readConfig(agents("review:\n  blocking_severities: [critical]\n  followup_severities: [low]"));
	assert.ok(validate(part.config, part).errors.some((e) => e.includes("missing: high, medium")));
	const seq = readConfig(agents("review:\n  blocking_severities:\n    - critical\n    - high\n  followup_severities: [medium, low]"));
	assert.deepEqual(validate(seq.config, seq).errors, []);
});

test("unknown keys warn and never refuse; unparsed intent refuses", () => {
	const src = readConfig(agents(`${PANEL}\nbudgets:\n  max_atempts_controller: 9`));
	assert.ok(src.warnings.some((w) => w.includes("max_atempts_controller")));
	assert.deepEqual(validate(src.config, src).errors, []);
	const p = join(dir, "tilde.md");
	writeFileSync(p, "# A\n~~~yaml pipeline-contract\nmodels:\n  implement: { provider: a, model: m }\n~~~\n");
	assert.throws(() => readConfig(p), (e) => e.code === "CONTRACT");
});

test("a mapped role without a model is a contract error, not a silent default", () => {
	const src = readConfig(agents(`models:\n  implement: { provider: a }\n  implement_master: { provider: b, model: n }\n  review:\n    security: { provider: a, model: r1 }\n    quality: { provider: b, model: r2 }`));
	const errors = validate(src.config, src).errors;
	assert.ok(errors.some((e) => e.includes("models.implement is mapped but has no model")), errors.join("\n"));
	const empty = readConfig(agents(`models:\n  research: {}\n  review:\n    security: { provider: a, model: r1 }\n    quality: { provider: b, model: r2 }`));
	assert.ok(validate(empty.config, empty).errors.some((e) => e.includes("models.research is mapped but has no model")));
	// Absent stays the documented default path.
	assert.deepEqual(validate(readConfig(agents(PANEL)).config, readConfig(agents(PANEL))).errors, []);
});

test("an issue source outside the repository is a warning", () => {
	for (const src of ["../other/tasks.md", "/tmp/tasks.md", "C:\\\\work\\\\tasks.md"]) {
		const s = readConfig(agents(`contract_version: 2\n${PANEL}\nissues:\n  source: "${src}"\ngates: []`));
		const r = validate(s.config, s);
		assert.deepEqual(r.errors, [], src);
		assert.ok(r.warnings.some((w) => w.includes("points outside the repository")), `${src}: ${r.warnings.join("\n")}`);
	}
	const inside = readConfig(agents(`contract_version: 2\n${PANEL}\nissues:\n  source: docs/tasks.md\ngates: []`));
	assert.ok(!validate(inside.config, inside).warnings.some((w) => w.includes("outside the repository")));
});

// INV-01, INV-09: a known field with the wrong type is an error, never a
// silent default or a constraint that the validator counts as on and the
// loop as off.
test("wrong types in known fields are contract errors, not silent defaults", () => {
	const cases = [
		["models:\n  implement: wrong-scalar\n  implement_master: { provider: b, model: y }", /models\.implement must be a map/],
		[`${PANEL}\n  constraints: { no_self_review: "true" }`, /no_self_review must be true or false, unquoted; got "true"/],
		["models:\n  review: nope", /models\.review must be a map of reviewer roles/],
		["models:\n  review:\n    security: gemini", /models\.review\.security must be a map/],
		["models: just-a-string", /models must be a map of roles/],
		["budgets: 3", /budgets must be a map/],
	];
	for (const [body, expected] of cases) {
		const source = readConfig(agents(body));
		const { errors } = validate(source.config, source);
		assert.ok(errors.some((e) => expected.test(e)), `${body}\n-> ${errors.join("\n")}`);
	}
	const ok = readConfig(agents(`${PANEL}\n  constraints: { no_self_review: true }`));
	assert.ok(!validate(ok.config, ok).errors.some((e) => /must be/.test(e)));
});

test("an OpenRouter panel counts the vendor behind each model, and identity ignores the route", () => {
	// All three reviewers through one aggregator, three vendors behind it: a
	// diverse panel. Before 1.2.5 this was refused as "single provider".
	const routed = `models:
  implement:        { provider: openrouter, model: z-ai/glm-5.3-flash, thinking: high }
  implement_master: { provider: openrouter, model: deepseek/deepseek-v4-flash }
  review:
    security:    { provider: openrouter, model: google/gemini-2.5-flash-lite }
    quality:     { provider: openrouter, model: openai/gpt-5-mini }
    correctness: { provider: openrouter, model: anthropic/claude-haiku-4.5 }`;
	const ok = readConfig(agents(routed));
	const verdict = validate(ok.config, ok);
	assert.deepEqual(verdict.errors, []);
	// Still the route pi receives: identity is for comparison only.
	assert.equal(resolveAllModels(ok.config)["review.security"], "openrouter/google/gemini-2.5-flash-lite");

	// One vendor behind the aggregator is still one provider.
	const single = readConfig(agents(routed.replace("openai/gpt-5-mini", "google/gemini-2.5-flash").replace("anthropic/claude-haiku-4.5", "google/gemini-2.5-pro")));
	assert.match(validate(single.config, single).errors.join("\n"), /single provider \(google\)/);

	// The same model through two routes is one model: escalation, self-review.
	const mixed = readConfig(agents(routed.replace("{ provider: openrouter, model: deepseek/deepseek-v4-flash }", "{ provider: z-ai, model: glm-5.3-flash }")));
	assert.match(validate(mixed.config, mixed).errors.join("\n"), /implement_master .* equals models\.implement/);
	assert.equal(modelIdentity("openrouter/google/gemini-2.5-flash:high"), "google/gemini-2.5-flash");
	assert.equal(modelIdentity("google/gemini-2.5-flash"), "google/gemini-2.5-flash");
	assert.equal(modelIdentity("openrouter/auto"), "openrouter/auto");
	assert.equal(modelIdentity("openrouter/google/gemini-2.5-flash:free"), "google/gemini-2.5-flash:free");
});
