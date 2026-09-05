// validate.mjs — generation-time and start-time validation of the contract.
//
// Runtime is too late: a correlated reviewer set only shows up as bad
// reviews, never as an error. Errors refuse the run (exit 2); warnings name
// configurations that are legal but defeat the design.

import { REVIEWERS, eachMappedRole, modelRef, thinkingRef, THINKING_LEVELS } from "./parse.mjs";

const SEVERITIES = new Set(["critical", "high", "medium", "low"]);

export function validate(config, source = {}) {
	const errors = [];
	const warnings = [];
	const m = config.models ?? {};

	const version = config.contract_version;
	if (version !== 1 && version !== 2) {
		errors.push(`AGENTS.md contract_version must be 1 or 2; got ${JSON.stringify(version)}`);
	}
	for (const d of source.decisions ?? []) {
		errors.push(`AGENTS.md ${d.path} still carries the marker [${d.marker}]; decide it in /govern before the pipeline can run`);
	}

	const impl = modelRef(m.implement);
	const master = modelRef(m.implement_master);
	if (impl && master && impl === master) {
		errors.push(`AGENTS.md models.implement_master (${master}) equals models.implement; escalation would change nothing`);
	}
	const providers = new Set();
	let mappedReviewerCount = 0;
	for (const r of REVIEWERS) {
		const entry = m.review?.[r];
		if (!entry || typeof entry !== "object" || !entry.model) continue;
		mappedReviewerCount++;
		const provider = entry.provider;
		if (typeof provider !== "string" || provider === "") {
			// Without a provider the diversity set and no_self_review identity
			// are both guessing. Name the role so the operator can fill it in.
			errors.push(
				`AGENTS.md models.review.${r} has a model but no provider; reviewers must name a provider so diversity and no_self_review can compare them`,
			);
			continue;
		}
		providers.add(provider);
	}
	if (mappedReviewerCount === 1) {
		// One mapped reviewer is one provider by construction; naming the
		// provider would send the operator after the wrong fix.
		errors.push(
			"AGENTS.md maps only one models.review.* role; a review panel needs at least two mapped reviewers on two providers",
		);
	} else if (providers.size === 1) {
		errors.push(`AGENTS.md models.review.* uses a single provider (${[...providers][0]}); reviewers must span at least two`);
	}

	const b = config.budgets;
	const requireInt = (field, v, min) => {
		if (!Number.isInteger(v) || v < min) {
			errors.push(`AGENTS.md budgets.${field} must be an integer >= ${min}; got ${JSON.stringify(v)}`);
			return false;
		}
		return true;
	};
	const ctrlOk = requireInt("max_attempts_controller", b.max_attempts_controller, 1);
	const masterOk = requireInt("max_attempts_master", b.max_attempts_master, 1);
	const treeOk = requireInt("max_runs_per_tree", b.max_runs_per_tree, 1);
	const splitOk = requireInt("max_split_depth", b.max_split_depth, 0);
	if (ctrlOk && masterOk && treeOk && b.max_runs_per_tree < b.max_attempts_controller + b.max_attempts_master) {
		errors.push(
			`AGENTS.md budgets.max_runs_per_tree (${b.max_runs_per_tree}) is below max_attempts_controller + max_attempts_master (${b.max_attempts_controller + b.max_attempts_master}); no issue could ever finish`,
		);
	}
	if (splitOk && b.max_split_depth > 1 && process.env.PIPELINE_ALLOW_DEEP_SPLIT !== "1") {
		errors.push(
			`AGENTS.md budgets.max_split_depth is ${b.max_split_depth}; depth above 1 grows exponentially. Set PIPELINE_ALLOW_DEEP_SPLIT=1 to override deliberately`,
		);
	}

	const requireSeverityList = (field, v) => {
		if (!Array.isArray(v)) {
			errors.push(
				`AGENTS.md ${field} must be an array of severity strings (critical, high, medium, low); got ${JSON.stringify(v)}. Write [critical, high] or a block sequence`,
			);
			return;
		}
		for (const item of v) {
			if (!SEVERITIES.has(String(item).toLowerCase())) {
				errors.push(`AGENTS.md ${field} contains unknown severity (${item}); expected critical, high, medium, low`);
			}
		}
	};
	requireSeverityList("review.blocking_severities", config.review.blocking_severities);
	requireSeverityList("review.followup_severities", config.review.followup_severities);
	// The two lists must partition the four severities. gate.mjs blocks on an
	// unlisted known severity, but the operator should learn that here, not
	// from a blocked run whose gate JSON names a severity nobody configured.
	if (Array.isArray(config.review.blocking_severities) && Array.isArray(config.review.followup_severities)) {
		const norm = (list) => list.map((s) => String(s).toLowerCase());
		const bl = norm(config.review.blocking_severities);
		const fl = norm(config.review.followup_severities);
		const missing = [...SEVERITIES].filter((s) => !bl.includes(s) && !fl.includes(s));
		if (missing.length > 0) {
			errors.push(
				`AGENTS.md review.blocking_severities and review.followup_severities together must cover critical, high, medium, low; missing: ${missing.join(", ")} — a finding at an unlisted severity is neither blocking nor a follow-up`,
			);
		}
		const both = bl.filter((s) => fl.includes(s));
		if (both.length > 0) {
			warnings.push(`AGENTS.md review lists ${both.join(", ")} as both blocking and follow-up; blocking wins at the gate`);
		}
	}

	eachMappedRole(m, (path, entry) => {
		// A role that is written down but names no model would run the default
		// model as if it were unmapped — silently, and with `provider` looking
		// like a complete entry. Absence is the documented default; a half
		// entry is a mistake.
		if (!entry.model) {
			errors.push(`AGENTS.md models.${path} is mapped but has no model; write { provider: <provider>, model: <id> } or remove the role`);
			return;
		}
		const thinking = thinkingRef(entry);
		if (!thinking) return;
		if (!THINKING_LEVELS.has(thinking)) {
			errors.push(
				`AGENTS.md models.${path}.thinking (${thinking}) is not a pi thinking level (off, minimal, low, medium, high, xhigh, max)`,
			);
		}
	});

	// ---- v2 fields: issues and gates -------------------------------------
	validateIssues(config, errors, warnings);
	validateGates(config, errors, warnings);

	// Warnings: legal configurations that defeat the point of the design.
	const masterReview = modelRef(m.master_review);
	if (master && masterReview && master === masterReview) {
		warnings.push(
			`AGENTS.md models.master_review (${masterReview}) equals models.implement_master; the escalated model would review its own work`,
		);
	}
	// A models: block that only carries constraints is not a routing map:
	// every role still runs the default, and the operator asked for a map.
	if (source.hadModelsBlock) {
		let mapped = 0;
		eachMappedRole(m, () => {
			mapped++;
		});
		if (mapped === 0) {
			warnings.push(
				"AGENTS.md has a `models:` block but no role is mapped; every role runs the default model — a constraints-only block is not a routing map",
			);
		}
	}
	const noSelfReview = m.constraints?.no_self_review ?? true;
	const mappedReviewers = REVIEWERS.filter((r) => modelRef(m.review?.[r]));
	// An unmapped review role runs pi's default model, and so does an unmapped
	// implement role. no_self_review compares refs; two unset roles never
	// collide, and a mapped implement never equals the string "default" either.
	// With fewer than two mapped reviewers the gate may approve a self-review.
	// Written down, that is a guarantee this config cannot honour (error).
	// Defaulted, it is the documented preference (warning). Absence is never
	// an error — that is the backward-compat path.
	if (noSelfReview && mappedReviewers.length < 2) {
		const message = `AGENTS.md maps ${mappedReviewers.length} of ${REVIEWERS.length} models.review.* roles; the rest run the default model, as does an unmapped models.implement. no_self_review cannot drop a reviewer it cannot tell apart from the implementer, so the gate may approve a diff that reviewed itself. Map at least two models.review.* roles.`;
		if (source.noSelfReviewExplicit === true) {
			errors.push(`${message} \`no_self_review\` is set explicitly in this file, so this is an error rather than a warning.`);
		} else {
			warnings.push(message);
		}
	}
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
		for (const [label, implModel] of [
			["implement", impl],
			["implement_master", master],
		]) {
			if (!implModel) continue;
			const collisions = REVIEWERS.filter((r) => modelRef(m.review?.[r]) === implModel).length;
			if (collisions > REVIEWERS.length - 2) {
				warnings.push(
					`AGENTS.md: ${collisions} of ${REVIEWERS.length} reviewers equal models.${label} (${implModel}); no_self_review leaves fewer than two reviewers on that path, so the runtime gate blocks every ${label} attempt instead of approving — that path's attempt budget is spent with no chance of approval`,
				);
			}
		}
	}
	return { errors, warnings };
}

function validateIssues(config, errors, warnings) {
	const issues = config.issues;
	const v2 = config.contract_version === 2;
	if (issues === null || issues === undefined) {
		if (v2) errors.push("AGENTS.md issues.source is required in contract version 2 (a tasks.md path, or { command: ... })");
		return;
	}
	if (typeof issues !== "object" || Array.isArray(issues)) {
		errors.push(`AGENTS.md issues must be a map with a source field; got ${JSON.stringify(issues)}`);
		return;
	}
	const src = issues.source;
	if (src === null || src === undefined || src === "") {
		errors.push("AGENTS.md issues.source is missing; write a tasks.md path or { command: \"...\" }");
		return;
	}
	if (typeof src === "string") {
		// A file outside the repository is not committed with approved work
		// and does not travel with the project. Legal, but rarely meant.
		if (/^([A-Za-z]:)?[\\/]/.test(src) || src.split(/[\\/]/).includes("..")) {
			warnings.push(`AGENTS.md issues.source (${src}) points outside the repository; it will not be committed with approved work`);
		}
		return;
	}
	if (typeof src === "object" && !Array.isArray(src)) {
		if (typeof src.command !== "string" || src.command.trim() === "") {
			errors.push("AGENTS.md issues.source.command must be a non-empty command string");
		}
		if (src.trust !== undefined && src.trust !== "external" && src.trust !== "internal") {
			errors.push(`AGENTS.md issues.source.trust must be external or internal; got ${JSON.stringify(src.trust)}`);
		}
		return;
	}
	errors.push(`AGENTS.md issues.source must be a path string or a { command: ... } map; got ${JSON.stringify(src)}`);
}

function validateGates(config, errors, warnings) {
	const gates = config.gates;
	const v2 = config.contract_version === 2;
	if (gates === null || gates === undefined) {
		if (v2) {
			errors.push(
				"AGENTS.md gates is required in contract version 2; list the deterministic gates (lint, test, ...) or write `gates: []` to run without one on purpose",
			);
		}
		return;
	}
	if (!Array.isArray(gates)) {
		errors.push(`AGENTS.md gates must be a list of { name, run } entries; got ${JSON.stringify(gates)}`);
		return;
	}
	const names = new Set();
	gates.forEach((g, i) => {
		if (!g || typeof g !== "object" || Array.isArray(g)) {
			errors.push(`AGENTS.md gates[${i}] must be a { name, run } map; got ${JSON.stringify(g)}`);
			return;
		}
		if (typeof g.name !== "string" || !/^[A-Za-z0-9_.-]+$/.test(g.name)) {
			errors.push(`AGENTS.md gates[${i}].name must be a short identifier (letters, digits, _ . -); got ${JSON.stringify(g.name)}`);
		} else if (names.has(g.name)) {
			errors.push(`AGENTS.md gates[${i}].name (${g.name}) is used twice`);
		} else names.add(g.name);
		if (typeof g.run !== "string" || g.run.trim() === "") {
			errors.push(`AGENTS.md gates[${i}].run must be a non-empty shell command; got ${JSON.stringify(g.run)}`);
		}
	});
	if (v2 && gates.length === 0) {
		warnings.push("AGENTS.md gates is empty on purpose; model review is the only gate for every run");
	}
}
