#!/usr/bin/env node
// governance.mjs — contract v1 reader, validator, and state store for the
// auto-develop pipeline. No dependencies: node built-ins only.
//
//   node governance.mjs config  <AGENTS.md>              -> merged config as JSON
//   node governance.mjs model   <AGENTS.md> <role.path>  -> "provider/model", "provider/model:thinking", or "default"
//   node governance.mjs models  <AGENTS.md>              -> JSON map of every role to its invoke ref
//   node governance.mjs state init     <dir> <root_id>
//   node governance.mjs state show     <dir> <root_id>
//   node governance.mjs state issue    <dir> <root_id> <issue_id> [status]
//   node governance.mjs state attempt  <dir> <root_id> <issue_id> controller|master
//   node governance.mjs state attempts <dir> <root_id> <issue_id> -> counters + status as JSON
//   node governance.mjs state escalate <dir> <root_id> <issue_id> -> force the master path
//   node governance.mjs state budget   <dir> <root_id> -> exit 0 = budget left, 3 = exhausted
//
// Exit codes: 0 ok, 1 usage/IO error, 2 contract validation failed, 3 budget exhausted.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

/* ---------------------------------------------------------------- defaults */

const DEFAULTS = {
	budgets: {
		max_attempts_controller: 3,
		max_attempts_master: 3,
		max_runs_per_tree: 25,
		max_split_depth: 1,
	},
	review: {
		blocking_severities: ["critical", "high"],
		followup_severities: ["medium", "low"],
	},
	models: { constraints: { no_self_review: true } },
};

const ROLES = ["research", "implement", "implement_master", "controller", "master_review"];
const REVIEWERS = ["security", "quality", "correctness"];
// pi --model <pattern> accepts an optional :<thinking> suffix; these are the
// levels from pi's --thinking flag. Identity comparisons strip this suffix.
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/* ------------------------------------------------------------- yaml subset */

// Supports the contract subset: nested maps by indentation, inline maps
// `{ a: b }`, inline lists `[a, b]`, scalars, booleans, integers, # comments.
function parseYamlSubset(text) {
	const root = {};
	const stack = [{ indent: -1, node: root }];
	for (const raw of text.split(/\r?\n/)) {
		const line = stripComment(raw);
		if (!line.trim()) continue;
		const indent = line.length - line.trimStart().length;
		const trimmed = line.trim();
		const sep = trimmed.indexOf(":");
		if (sep === -1) continue; // block sequences are not part of the contract
		const key = trimmed.slice(0, sep).trim();
		const rest = trimmed.slice(sep + 1).trim();
		while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
		const parent = stack[stack.length - 1].node;
		if (rest === "") {
			const child = {};
			parent[key] = child;
			stack.push({ indent, node: child });
		} else {
			parent[key] = parseScalar(rest);
		}
	}
	return root;
}

function stripComment(line) {
	let out = "";
	let quote = null;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (quote) {
			if (c === quote) quote = null;
		} else if (c === '"' || c === "'") {
			quote = c;
		} else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
			break;
		}
		out += c;
	}
	return out;
}

function parseScalar(value) {
	if (value.startsWith("{") && value.endsWith("}")) {
		const map = {};
		for (const part of splitTopLevel(value.slice(1, -1))) {
			const i = part.indexOf(":");
			if (i === -1) continue;
			map[part.slice(0, i).trim()] = parseScalar(part.slice(i + 1).trim());
		}
		return map;
	}
	if (value.startsWith("[") && value.endsWith("]")) {
		return splitTopLevel(value.slice(1, -1))
			.filter((p) => p.trim() !== "")
			.map((p) => parseScalar(p.trim()));
	}
	if (/^".*"$/.test(value) || /^'.*'$/.test(value)) return value.slice(1, -1);
	if (value === "true") return true;
	if (value === "false") return false;
	if (value === "null" || value === "~") return null;
	if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
	return value;
}

function splitTopLevel(text) {
	const parts = [];
	let depth = 0;
	let current = "";
	for (const c of text) {
		if (c === "{" || c === "[") depth++;
		if (c === "}" || c === "]") depth--;
		if (c === "," && depth === 0) {
			parts.push(current);
			current = "";
		} else current += c;
	}
	if (current.trim() !== "") parts.push(current);
	return parts;
}

/* ------------------------------------------------------------ config layer */

// The config block is the first fenced yaml block in AGENTS.md that declares
// any contract top-level key. Prose around it is ignored by construction.
export function readConfig(agentsPath) {
	const warnings = [];
	if (!existsSync(agentsPath)) {
		return { config: withDefaults({}), warnings: [`${agentsPath} not found; every role runs the default model`] };
	}
	const text = readFileSync(agentsPath, "utf8");
	const blocks = [...text.matchAll(/```ya?ml\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
	const block = blocks.find((b) => /^\s*(models|budgets|review)\s*:/m.test(b));
	if (!block) {
		warnings.push("no contract config block in AGENTS.md; defaults apply to every field");
		return { config: withDefaults({}), warnings };
	}
	const parsed = parseYamlSubset(block);
	if (!parsed.models) warnings.push("no `models:` block; every role runs the default model");
	return { config: withDefaults(parsed), warnings };
}

function withDefaults(parsed) {
	const models = parsed.models ?? {};
	return {
		contract_version: 1,
		models: {
			...models,
			review: models.review ?? {},
			constraints: { ...DEFAULTS.models.constraints, ...(models.constraints ?? {}) },
		},
		budgets: { ...DEFAULTS.budgets, ...(parsed.budgets ?? {}) },
		review: { ...DEFAULTS.review, ...(parsed.review ?? {}) },
	};
}

function thinkingRef(entry) {
	if (!entry || typeof entry !== "object") return null;
	if (entry.thinking == null || entry.thinking === "") return null;
	return String(entry.thinking);
}

// Identity: provider/model. Thinking is a launch parameter, not a new model.
function modelRef(entry) {
	if (!entry || typeof entry !== "object") return null;
	if (!entry.model) return null;
	return entry.provider ? `${entry.provider}/${entry.model}` : String(entry.model);
}

// What pi --model accepts: provider/model or provider/model:thinking.
function invokeRef(entry) {
	const id = modelRef(entry);
	if (!id) return null;
	const thinking = thinkingRef(entry);
	return thinking ? `${id}:${thinking}` : id;
}

function roleEntry(config, rolePath) {
	const parts = rolePath.split(".");
	let node = config.models;
	for (const part of parts) {
		if (!node || typeof node !== "object") return null;
		node = node[part];
	}
	return node && typeof node === "object" ? node : null;
}

export function resolveModel(config, rolePath) {
	return invokeRef(roleEntry(config, rolePath)) ?? "default";
}

function eachMappedRole(models, fn) {
	for (const role of ROLES) {
		if (models[role] && typeof models[role] === "object") fn(role, models[role]);
	}
	for (const r of REVIEWERS) {
		const entry = models.review?.[r];
		if (entry && typeof entry === "object") fn(`review.${r}`, entry);
	}
}

// Generation-time validation. Runtime is too late: a correlated reviewer set
// only shows up as bad reviews, never as an error.
export function validate(config) {
	const errors = [];
	const warnings = [];
	const m = config.models ?? {};
	const impl = modelRef(m.implement);
	const master = modelRef(m.implement_master);
	if (impl && master && impl === master) {
		errors.push(`AGENTS.md models.implement_master (${master}) equals models.implement; escalation would change nothing`);
	}
	const providers = new Set(
		REVIEWERS.map((r) => m.review?.[r]?.provider).filter((p) => typeof p === "string" && p !== ""),
	);
	if (providers.size === 1) {
		errors.push(`AGENTS.md models.review.* uses a single provider (${[...providers][0]}); reviewers must span at least two`);
	}
	const b = config.budgets;
	if (b.max_runs_per_tree < b.max_attempts_controller + b.max_attempts_master) {
		errors.push(
			`AGENTS.md budgets.max_runs_per_tree (${b.max_runs_per_tree}) is below max_attempts_controller + max_attempts_master (${b.max_attempts_controller + b.max_attempts_master}); no issue could ever finish`,
		);
	}
	if (b.max_split_depth > 1 && process.env.PIPELINE_ALLOW_DEEP_SPLIT !== "1") {
		errors.push(
			`AGENTS.md budgets.max_split_depth is ${b.max_split_depth}; depth above 1 grows exponentially. Set PIPELINE_ALLOW_DEEP_SPLIT=1 to override deliberately`,
		);
	}
	eachMappedRole(m, (path, entry) => {
		const thinking = thinkingRef(entry);
		if (!thinking) return;
		if (!THINKING_LEVELS.has(thinking)) {
			errors.push(
				`AGENTS.md models.${path}.thinking (${thinking}) is not a pi thinking level (off, minimal, low, medium, high, xhigh, max)`,
			);
		}
		if (!entry.model) {
			warnings.push(`AGENTS.md models.${path}.thinking is set but model is absent; thinking is ignored`);
		}
	});
	// Warnings: legal configurations that defeat the point of the design.
	const masterReview = modelRef(m.master_review);
	if (master && masterReview && master === masterReview) {
		warnings.push(
			`AGENTS.md models.master_review (${masterReview}) equals models.implement_master; the escalated model would review its own work`,
		);
	}
	const noSelfReview = m.constraints?.no_self_review ?? true;
	if (noSelfReview) {
		for (const r of REVIEWERS) {
			const reviewer = modelRef(m.review?.[r]);
			if (!reviewer) continue;
			if (impl && reviewer === impl) {
				warnings.push(
					`AGENTS.md models.review.${r} (${reviewer}) equals models.implement; no_self_review drops it at run time, leaving fewer reviewers`,
				);
			}
			// The dangerous direction: the reviewer runs on the controller's
			// attempts and is dropped exactly when the master path starts — its
			// last verdict would otherwise linger and deadlock the issue.
			if (master && reviewer === master) {
				warnings.push(
					`AGENTS.md models.review.${r} (${reviewer}) equals models.implement_master; no_self_review drops it on the escalated path, where a lingering verdict would deadlock the issue`,
				);
			}
		}
		// Panel floor: one surviving reviewer is no independent check, and the
		// runtime gate blocks below two. Warn at generation time, not mid-run.
		for (const [label, implModel] of [["implement", impl], ["implement_master", master]]) {
			if (!implModel) continue;
			const collisions = REVIEWERS.filter((r) => modelRef(m.review?.[r]) === implModel).length;
			if (collisions > REVIEWERS.length - 2) {
				warnings.push(
					`AGENTS.md: ${collisions} of ${REVIEWERS.length} reviewers equal models.${label} (${implModel}); no_self_review leaves fewer than two reviewers on that path, where the runtime gate blocks instead of approving`,
				);
			}
		}
	}
	return { errors, warnings };
}

/* ------------------------------------------------------------- state store */

function statePath(dir, rootId) {
	return join(dir, "state", `${rootId}.json`);
}

function loadState(dir, rootId) {
	const path = statePath(dir, rootId);
	if (!existsSync(path)) throw new Error(`no state for ${rootId}; run \`state init\` first`);
	return JSON.parse(readFileSync(path, "utf8"));
}

// Written after every mutation, not at the end: a crashed run must resume with
// its counters intact, or the budget silently resets.
function saveState(dir, rootId, state) {
	const path = statePath(dir, rootId);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
	return state;
}

function stateCommand(args, config) {
	const [sub, dir, rootId, ...rest] = args;
	if (!sub || !dir || !rootId) usage();
	switch (sub) {
		case "init": {
			if (existsSync(statePath(dir, rootId))) return loadState(dir, rootId);
			return saveState(dir, rootId, {
				root_id: rootId,
				runs_used: 0,
				max_runs_per_tree: config.budgets.max_runs_per_tree,
				depth: 0,
				issues: { [rootId]: { attempts_controller: 0, attempts_master: 0, status: "open" } },
			});
		}
		case "show":
			return loadState(dir, rootId);
		case "issue": {
			const [issueId, status] = rest;
			if (!issueId) usage();
			const state = loadState(dir, rootId);
			const issue = (state.issues[issueId] ??= { attempts_controller: 0, attempts_master: 0, status: "open" });
			if (status) issue.status = status;
			return saveState(dir, rootId, state);
		}
		case "attempt": {
			const [issueId, kind] = rest;
			if (!issueId || !["controller", "master"].includes(kind)) usage();
			const state = loadState(dir, rootId);
			const issue = (state.issues[issueId] ??= { attempts_controller: 0, attempts_master: 0, status: "open" });
			issue[`attempts_${kind}`] += 1;
			// One implementation attempt, whoever implemented it.
			state.runs_used += 1;
			return saveState(dir, rootId, state);
		}
		case "attempts": {
			const [issueId] = rest;
			if (!issueId) usage();
			const state = loadState(dir, rootId);
			const issue = state.issues[issueId] ?? { attempts_controller: 0, attempts_master: 0, status: "open" };
			// Read back on resume: a crashed run restarts with its counters, not from zero.
			return {
				controller: issue.attempts_controller,
				master: issue.attempts_master,
				status: issue.status ?? "open",
			};
		}
		case "escalate": {
			const [issueId] = rest;
			if (!issueId) usage();
			const state = loadState(dir, rootId);
			const issue = (state.issues[issueId] ??= { attempts_controller: 0, attempts_master: 0, status: "open" });
			// The master takes over: the controller path is exhausted by decision,
			// not by counting further attempts. runs_used is untouched — no
			// implementation attempt happened here.
			issue.attempts_controller = config.budgets.max_attempts_controller;
			return saveState(dir, rootId, state);
		}
		case "budget": {
			const state = loadState(dir, rootId);
			const left = state.max_runs_per_tree - state.runs_used;
			process.stdout.write(`${JSON.stringify({ runs_used: state.runs_used, runs_left: left })}\n`);
			process.exit(left > 0 ? 0 : 3);
			break;
		}
		default:
			usage();
	}
}

/* --------------------------------------------------------------------- cli */

function usage() {
	process.stderr.write(
		[
			"usage:",
			"  governance.mjs config  <AGENTS.md>",
			"  governance.mjs model   <AGENTS.md> <role.path>",
			"  governance.mjs models  <AGENTS.md>",
			"  governance.mjs state init|show|budget <dir> <root_id>",
			"  governance.mjs state issue    <dir> <root_id> <issue_id> [status]",
			"  governance.mjs state attempt  <dir> <root_id> <issue_id> controller|master",
			"  governance.mjs state attempts <dir> <root_id> <issue_id>",
			"  governance.mjs state escalate <dir> <root_id> <issue_id>",
			"",
			`roles: ${ROLES.join(", ")}, review.${REVIEWERS.join(", review.")}`,
		].join("\n") + "\n",
	);
	process.exit(1);
}

function main(argv) {
	const [command, ...args] = argv;
	if (!command) usage();
	if (command === "models") {
		const [agentsPath] = args;
		if (!agentsPath) usage();
		const { config, warnings } = readConfig(agentsPath);
		for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
		const resolved = {};
		for (const role of ROLES) resolved[role] = resolveModel(config, role);
		for (const r of REVIEWERS) resolved[`review.${r}`] = resolveModel(config, `review.${r}`);
		process.stdout.write(`${JSON.stringify(resolved)}\n`);
		return;
	}
	if (command === "config" || command === "model") {
		const [agentsPath, rolePath] = args;
		if (!agentsPath) usage();
		const { config, warnings } = readConfig(agentsPath);
		for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
		if (command === "model") {
			if (!rolePath) usage();
			process.stdout.write(`${resolveModel(config, rolePath)}\n`);
			return;
		}
		const { errors, warnings: contractWarnings } = validate(config);
		for (const w of contractWarnings) process.stderr.write(`contract warning: ${w}\n`);
		if (errors.length > 0) {
			for (const e of errors) process.stderr.write(`contract error: ${e}\n`);
			process.exit(2);
		}
		process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
		return;
	}
	if (command === "state") {
		const { config, warnings } = readConfig(process.env.GOVERNANCE_AGENTS ?? "AGENTS.md");
		for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
		const result = stateCommand(args, config);
		if (result) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return;
	}
	usage();
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("governance.mjs")) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`error: ${error.message}\n`);
		process.exit(1);
	}
}
