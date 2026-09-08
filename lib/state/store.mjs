// store.mjs — counters and budget, owned by the harness.
//
// One file per root issue under .pipeline/state/. Written after every
// mutation, not at the end: a crashed run must resume with its counters
// intact, or the budget silently resets. No model ever holds these numbers.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { acquireRunLock } from "./lock.mjs";

export function statePath(dir, rootId) {
	return join(dir, "state", `${rootId}.json`);
}

export function validateState(state, rootId) {
	const map = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
	const count = (x) => Number.isSafeInteger(x) && x >= 0;
	const bad = (field) => { throw Object.assign(new Error(`invalid state ${rootId}: ${field}`), { code: "PIPELINE_CONTROL" }); };
	if (!map(state) || state.root_id !== rootId) bad("root_id");
	if (!count(state.runs_used) || !count(state.max_runs_per_tree) || state.max_runs_per_tree < 1 || state.runs_used > state.max_runs_per_tree) bad("tree budget");
	if (!count(state.depth) || !map(state.issues) || !state.issues[rootId]) bad("issues/depth");
	for (const [id, issue] of Object.entries(state.issues)) {
		if (!map(issue) || !count(issue.attempts_controller) || !count(issue.attempts_master)) bad(`issue ${id} counters`);
		if (!["open", "done", "blocked", "split", "paused"].includes(issue.status)) bad(`issue ${id} status`);
		if (issue.review_pause !== undefined && typeof issue.review_pause !== "string") bad(`issue ${id} review_pause`);
		if (issue.depth !== undefined && !count(issue.depth)) bad(`issue ${id} depth`);
		if (issue.children !== undefined && (!Array.isArray(issue.children) || issue.children.some((child) => typeof child !== "string" || !state.issues[child]))) bad(`issue ${id} children`);
		if (issue.parent != null && (typeof issue.parent !== "string" || !state.issues[issue.parent])) bad(`issue ${id} parent`);
		if (issue.contributors !== undefined && (!Array.isArray(issue.contributors) || issue.contributors.some((m) => typeof m !== "string"))) bad(`issue ${id} contributors`);
		const seen = new Set([id]);
		let parent = issue.parent;
		while (parent != null) {
			if (seen.has(parent)) bad(`issue ${id} parent cycle`);
			seen.add(parent);
			parent = state.issues[parent]?.parent;
		}
	}
	return state;
}

// Every tree's state, keyed by root id; an unreadable file is reported, not thrown.
export function readAllStates(pipelineDir) {
	const dir = join(pipelineDir, "state");
	if (!existsSync(dir)) return {};
	const out = {};
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
		try {
			out[file.replace(/\.json$/, "")] = loadState(pipelineDir, file.replace(/\.json$/, ""));
		} catch (error) {
			out[file.replace(/\.json$/, "")] = { error: `unreadable state file: ${error.message}` };
		}
	}
	return out;
}

export function loadState(dir, rootId) {
	const path = statePath(dir, rootId);
	if (!existsSync(path)) throw new Error(`no state for ${rootId}; run \`state init\` first`);
	try { return validateState(JSON.parse(readFileSync(path, "utf8")), rootId); }
	catch (error) { throw Object.assign(new Error(`state ${path}: ${error.message}`), { code: "PIPELINE_CONTROL" }); }
}

export function saveState(dir, rootId, state) {
	validateState(state, rootId);
	const path = statePath(dir, rootId);
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(temp, "wx", 0o600);
	try {
		try { writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`); fsyncSync(fd); }
		finally { closeSync(fd); }
		renameSync(temp, path);
	} finally { rmSync(temp, { force: true }); }
	return state;
}

const freshIssue = (extra = {}) => ({ attempts_controller: 0, attempts_master: 0, status: "open", ...extra });

export function ensureIssue(state, issueId, extra = {}) {
	return (state.issues[issueId] ??= freshIssue(extra));
}

// init is a no-op when the file exists: max_runs_per_tree is frozen at tree
// creation. A resource limit that resets when someone edits a file is not a
// limit; `budget --set` is the deliberate way to raise it.
export function initState(dir, rootId, config) {
	if (existsSync(statePath(dir, rootId))) return loadState(dir, rootId);
	return saveState(dir, rootId, {
		root_id: rootId,
		runs_used: 0,
		max_runs_per_tree: config.budgets.max_runs_per_tree,
		depth: 0,
		issues: { [rootId]: freshIssue() },
	});
}

export function setIssueStatus(dir, rootId, issueId, status) {
	const state = loadState(dir, rootId);
	const issue = ensureIssue(state, issueId);
	if (status) issue.status = status;
	return saveState(dir, rootId, state);
}

export function recordAttempt(dir, rootId, issueId, kind, model = null) {
	if (!["controller", "master"].includes(kind)) throw new Error(`attempt kind must be controller or master; got ${kind}`);
	const state = loadState(dir, rootId);
	if (state.runs_used >= state.max_runs_per_tree) throw new Error(`Tree budget exhausted for ${rootId}`);
	const issue = ensureIssue(state, issueId);
	if (model) issue.contributors = [...new Set([...(issue.contributors ?? []), model])];
	issue[`attempts_${kind}`] += 1;
	// One implementation attempt, whoever implemented it.
	state.runs_used += 1;
	return saveState(dir, rootId, state);
}

export function setReviewPause(dir, rootId, issueId, reason) {
	const state = loadState(dir, rootId);
	const issue = ensureIssue(state, issueId);
	issue.status = reason ? "paused" : "open";
	if (reason) issue.review_pause = reason;
	else delete issue.review_pause;
	return saveState(dir, rootId, state);
}

export function attemptsOf(dir, rootId, issueId) {
	const state = loadState(dir, rootId);
	const issue = state.issues[issueId] ?? freshIssue();
	return {
		controller: issue.attempts_controller,
		master: issue.attempts_master,
		status: issue.status ?? "open",
		depth: issue.depth ?? 0,
		parent: issue.parent ?? null,
	};
}

export function setContributors(dir, rootId, issueId, models) {
	const state = loadState(dir, rootId);
	ensureIssue(state, issueId).contributors = [...new Set(models)];
	return saveState(dir, rootId, state);
}

// The master takes over: the controller path is exhausted by decision, not
// by counting further attempts. runs_used is untouched — no implementation
// attempt happened here.
export function escalate(dir, rootId, issueId, config) {
	const state = loadState(dir, rootId);
	const issue = ensureIssue(state, issueId);
	issue.attempts_controller = config.budgets.max_attempts_controller;
	return saveState(dir, rootId, state);
}

export function budgetOf(dir, rootId) {
	const state = loadState(dir, rootId);
	const left = state.max_runs_per_tree - state.runs_used;
	return { runs_used: state.runs_used, runs_left: left, exhausted: left <= 0 };
}

export function setBudget(dir, rootId, n) {
	if (!Number.isInteger(n) || n < 1) throw new Error(`max_runs_per_tree must be an integer >= 1; got ${n}`);
	const state = loadState(dir, rootId);
	if (n < state.runs_used) throw new Error(`cannot lower max_runs_per_tree to ${n}; ${state.runs_used} runs already used`);
	state.max_runs_per_tree = n;
	return saveState(dir, rootId, state);
}

// A split registers the children in the parent's tree: same file, same
// budget, attempts of their own. The parent's status becomes `split`.
export function registerSplit(dir, rootId, parentId, childIds) {
	const state = loadState(dir, rootId);
	const parent = ensureIssue(state, parentId);
	const depth = (parent.depth ?? 0) + 1;
	parent.status = "split";
	parent.children = childIds;
	for (const id of childIds) {
		state.issues[id] = freshIssue({ parent: parentId, depth });
	}
	if (depth > (state.depth ?? 0)) state.depth = depth;
	return saveState(dir, rootId, state);
}

// CLI surface used by lib/governance.mjs. Kept argument-compatible with the
// 1.0.x `governance.mjs state ...` commands.
export function stateCommand(args, config) {
	const [sub, dir] = args;
	const readOnly = ["show", "attempts"].includes(sub) || (sub === "budget" && !args.includes("--set"));
	if (!dir || readOnly) return stateCommandUnlocked(args, config);
	const abs = resolve(dir);
	mkdirSync(abs, { recursive: true });
	const release = acquireRunLock(basename(abs) === ".pipeline" ? dirname(abs) : abs);
	try { return stateCommandUnlocked(args, config); } finally { release(); }
}

function stateCommandUnlocked(args, config) {
	const [sub, dir, rootId, ...rest] = args;
	if (!sub || !dir || !rootId) return { usage: true };
	switch (sub) {
		case "init":
			return initState(dir, rootId, config);
		case "show":
			return loadState(dir, rootId);
		case "issue": {
			const [issueId, status] = rest;
			if (!issueId) return { usage: true };
			return setIssueStatus(dir, rootId, issueId, status);
		}
		case "attempt": {
			const [issueId, kind] = rest;
			if (!issueId || !["controller", "master"].includes(kind)) return { usage: true };
			return recordAttempt(dir, rootId, issueId, kind);
		}
		case "attempts": {
			const [issueId] = rest;
			if (!issueId) return { usage: true };
			const a = attemptsOf(dir, rootId, issueId);
			return { controller: a.controller, master: a.master, status: a.status };
		}
		case "escalate": {
			const [issueId] = rest;
			if (!issueId) return { usage: true };
			return escalate(dir, rootId, issueId, config);
		}
		case "split": {
			const [parentId, ...children] = rest;
			if (!parentId || children.length === 0) return { usage: true };
			return registerSplit(dir, rootId, parentId, children);
		}
		case "budget": {
			const setAt = rest.indexOf("--set");
			if (setAt !== -1) {
				const raw = rest[setAt + 1];
				const n = Number(raw);
				if (!Number.isInteger(n) || n < 1) throw new Error(`max_runs_per_tree must be an integer >= 1; got ${raw}`);
				return setBudget(dir, rootId, n);
			}
			const b = budgetOf(dir, rootId);
			return { budget: { runs_used: b.runs_used, runs_left: b.runs_left }, exit: b.exhausted ? 3 : 0 };
		}
		default:
			return { usage: true };
	}
}
