// INV-23, INV-28: exercise actual Pi parsing and resource loading, not SDK shims.
// The smoke suite supplies its installed SDK; local runs can set PI_TEST_SDK_DIR.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { buildArgs } from "../../lib/harness/pi.mjs";
import { initCommand } from "../../lib/cli/init.mjs";
import { createProject } from "../fixtures/project.mjs";

const sdkDir = process.env.PI_TEST_SDK_DIR;
const supportsPiSdk = (version) => {
	const [major, minor] = version.split(".").map(Number);
	return major > 22 || (major === 22 && minor >= 19);
};
const skip = !sdkDir ? "set PI_TEST_SDK_DIR to run against the real Pi SDK" : !supportsPiSdk(process.versions.node) ? "Pi 0.85 requires Node >=22.19" : false;
const sdk = (path) => import(pathToFileURL(join(sdkDir, "dist", path)).href);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

async function loadPackagePrompts() {
	const { loadPromptTemplates } = await sdk("core/prompt-templates.js");
	return loadPromptTemplates({ cwd: packageRoot, agentDir: packageRoot, promptPaths: [join(packageRoot, "prompts")], includeDefaults: false });
}

test("Pi SDK runtime gate respects the Node 22.19 minimum", () => {
	for (const [version, expected] of [["18.20.8", false], ["20.19.0", false], ["22.0.0", false], ["22.18.0", false], ["22.19.0", true], ["22.23.2", true], ["24.0.0", true], ["26.8.1", true]]) {
		assert.equal(supportsPiSdk(version), expected, version);
	}
});

test("Pi discovers the skill without frontmatter diagnostics", { skip }, async () => {
	const { loadSkillsFromDir } = await sdk("core/skills.js");
	const dir = join(dirname(fileURLToPath(import.meta.url)), "../../skills/governance-pipeline");
	const result = loadSkillsFromDir({ dir, source: "test" });
	assert.deepEqual(result.diagnostics, []);
	assert.equal(result.skills.length, 1);
	assert.equal(result.skills[0].name, "governance-pipeline");
});

test("Pi expands every automate argument and init applies the requested configuration", { skip }, async () => {
	const { expandPromptTemplate } = await sdk("core/prompt-templates.js");
	const root = createProject();
	const templates = await loadPackagePrompts();
	for (const input of ["", " --harness anthropic=claude-code --local"]) {
		const expanded = expandPromptTemplate(`/automate${input}`, templates);
		const command = expanded.match(/`node <package>\/bin\/pipeline\.mjs init ([^`]*)`/)[1];
		assert.equal(command, input.trim());
		if (input) {
			assert.equal(await initCommand(command.split(/\s+/), { root }), 0);
			const wrapper = readFileSync(join(root, "auto-develop.sh"), "utf8");
			assert.match(wrapper, /exec node/);
			assert.match(wrapper, /--harness anthropic=claude-code/);
		}
	}
});

test("Pi discovers all mode prompts and preserves explicit and omitted PRD arguments", { skip }, async () => {
	const { expandPromptTemplate } = await sdk("core/prompt-templates.js");
	const templates = await loadPackagePrompts();
	const skill = readFileSync(join(packageRoot, "skills/governance-pipeline/SKILL.md"), "utf8");
	assert.deepEqual(templates.map((template) => template.name).sort(), ["automate", "govern", "pipeline-audit"]);
	for (const [name, mode] of [["automate", "automate"], ["govern", "govern"], ["pipeline-audit", "audit"]]) {
		const template = templates.find((entry) => entry.name === name);
		assert.ok(template.description, `${name} has no discovery description`);
		assert.ok(expandPromptTemplate(`/${name}`, templates).includes(`Mode: ${mode}`), `${name} does not select ${mode}`);
		assert.ok(skill.includes(`## Mode: ${mode}`), `${name} selects a mode absent from the skill`);
	}
	for (const path of ["docs/PRD.md", "docs/My PRD.md"]) {
		const expanded = expandPromptTemplate(`/govern "${path}"`, templates);
		assert.equal(expanded.match(/^PRD: (.+)$/m)[1], path);
	}
	const fallback = expandPromptTemplate("/govern", templates);
	assert.match(fallback, /^PRD: .+$/m);
	assert.doesNotMatch(fallback, /\$\{1:-/);
});

test("Pi excludes custom system prompts and executable extensions for every non-implementer", { skip }, async () => {
	const { parseArgs } = await sdk("cli/args.js");
	const { DefaultResourceLoader } = await sdk("core/resource-loader.js");
	const { SettingsManager } = await sdk("core/settings-manager.js");
	const { buildSystemPrompt } = await sdk("core/system-prompt.js");
	const cwd = createProject();
	const agentDir = mkdtempSync(join(tmpdir(), "pi-sdk-global-"));
	for (const dir of [agentDir, join(cwd, ".pi")]) {
		mkdirSync(join(dir, "extensions"), { recursive: true });
		writeFileSync(join(dir, "SYSTEM.md"), "CUSTOM_SYSTEM_MARKER");
		writeFileSync(join(dir, "APPEND_SYSTEM.md"), "CUSTOM_APPEND_MARKER");
		writeFileSync(join(dir, "extensions", "unexpected.ts"), 'throw new Error("EXTENSION_EXECUTED_MARKER");\nexport default function () {}\n');
	}
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
	// Positive control: the fixture's global prompt files really are discoverable.
	const control = new DefaultResourceLoader({ cwd, agentDir });
	assert.equal(control.discoverSystemPromptFile(), join(cwd, ".pi", "SYSTEM.md"));
	control.settingsManager.setProjectTrusted(false);
	assert.equal(control.discoverAppendSystemPromptFile(), join(agentDir, "APPEND_SYSTEM.md"));
	for (const isolation of ["reviewer", "research", "judge"]) {
		const parsed = parseArgs(buildArgs({ isolation, model: "default", trusted: true }));
		assert.equal(parsed.projectTrustOverride, false, isolation);
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		const loader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager,
			noContextFiles: parsed.noContextFiles, noExtensions: parsed.noExtensions,
			noSkills: parsed.noSkills, noPromptTemplates: parsed.noPromptTemplates,
			systemPrompt: parsed.systemPrompt, appendSystemPrompt: parsed.appendSystemPrompt,
		});
		await loader.reload({ resolveProjectTrust: async ({ extensionsResult }) => {
			assert.deepEqual(extensionsResult.errors, [], isolation);
			assert.equal(extensionsResult.extensions.length, 0, isolation);
			return parsed.projectTrustOverride;
		} });
		assert.deepEqual(loader.getExtensions().errors, [], isolation);
		assert.equal(loader.getExtensions().extensions.length, 0, isolation);
		assert.equal(loader.getSystemPrompt(), undefined, isolation);
		assert.deepEqual(loader.getAppendSystemPrompt(), [], isolation);
		const contextFiles = loader.getAgentsFiles().agentsFiles;
		if (isolation === "reviewer") assert.deepEqual(contextFiles, []);
		else assert.ok(contextFiles.some((file) => file.path === join(cwd, "AGENTS.md")));
		const prompt = buildSystemPrompt({ cwd, selectedTools: parsed.tools ?? [], customPrompt: loader.getSystemPrompt(), appendSystemPrompt: loader.getAppendSystemPrompt().join("\n"), contextFiles });
		assert.match(prompt, /expert coding assistant/);
		assert.doesNotMatch(prompt, /CUSTOM_SYSTEM_MARKER|CUSTOM_APPEND_MARKER/);
	}
});
