// INV-28: setup validates before writes, accepts options, and creates nested issue sources.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { initCommand } from "../../lib/cli/init.mjs";
import { parseRunFlags } from "../../lib/cli/run.mjs";
import { doctorCommand } from "../../lib/cli/doctor.mjs";
import { CONTRACT, checkedGit, createProject } from "../fixtures/project.mjs";

test("init creates a nested issue source and forwards harness plus local options", async () => {
	const root = createProject();
	const contract = CONTRACT.replace("source: tasks.md", "source: backlog/planned/tasks.md");
	writeFileSync(join(root, "AGENTS.md"), contract);
	assert.equal(await initCommand(["--harness", "anthropic=claude-code", "--local"], { root }), 0);
	assert.match(readFileSync(join(root, "backlog", "planned", "tasks.md"), "utf8"), /# Tasks/);
	assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), contract);
	const wrapper = readFileSync(join(root, "auto-develop.sh"), "utf8");
	assert.match(wrapper, /exec node/);
	assert.match(wrapper, /--harness anthropic=claude-code/);
});

test("an invalid contract leaves setup files and the index untouched", async () => {
	const root = createProject();
	writeFileSync(join(root, "AGENTS.md"), CONTRACT.replace("gates: []", "gates: [broken]"));
	const before = checkedGit(root, ["ls-files", "--stage"]);
	assert.equal(await initCommand([], { root }), 1);
	assert.equal(existsSync(join(root, "auto-develop.sh")), false);
	assert.equal(existsSync(join(root, ".gitattributes")), false);
	assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), ".pipeline/\n");
	assert.equal(checkedGit(root, ["ls-files", "--stage"]), before);
});

test("missing harness values are rejected consistently before setup mutation", async () => {
	const root = createProject();
	const before = readdirSync(root);
	for (const args of [["--harness"], ["--harness", "--local"], ["--harness", ""]]) {
		assert.equal(await initCommand(args, { root }), 1);
		assert.equal(await doctorCommand(args, { root }), 1);
		assert.throws(() => parseRunFlags(args), /--harness needs a spec/);
	}
	assert.equal(await initCommand(["--harness", "anthropic=unknown"], { root }), 1);
	assert.deepEqual(readdirSync(root), before);
});
