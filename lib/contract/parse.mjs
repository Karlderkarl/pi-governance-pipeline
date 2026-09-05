// parse.mjs — reads the pipeline contract out of AGENTS.md.
//
// Contract v1 fields (models, budgets, review) are unchanged. Contract v2 adds
// `contract_version`, `issues` and `gates`, so that everything the pipeline
// needs to run is in governance rather than in the caller's environment. A
// file without `contract_version` is v1 and keeps every v1 default.

import { existsSync, readFileSync } from "node:fs";
import { contractError, parseYamlSubset } from "./yaml.mjs";

export const DEFAULTS = {
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

export const ROLES = ["research", "implement", "implement_master", "controller", "master_review"];
export const REVIEWERS = ["security", "quality", "correctness"];
export const KNOWN_TOP = new Set(["contract_version", "models", "budgets", "review", "issues", "gates"]);
export const KNOWN_MODEL_KEYS = new Set([...ROLES, "review", "constraints"]);
export const KNOWN_REVIEWERS = new Set(REVIEWERS);
export const KNOWN_CONSTRAINTS = new Set(["no_self_review"]);
export const KNOWN_BUDGETS = new Set([
	"max_attempts_controller",
	"max_attempts_master",
	"max_runs_per_tree",
	"max_split_depth",
]);
export const KNOWN_REVIEW_GATE = new Set(["blocking_severities", "followup_severities"]);
export const KNOWN_ISSUES = new Set(["source"]);
export const KNOWN_ISSUE_SOURCE = new Set(["command", "trust"]);
export const KNOWN_GATE = new Set(["name", "run"]);
// pi --model <pattern> accepts an optional :<thinking> suffix; these are the
// levels from pi's --thinking flag. Identity comparisons strip this suffix.
export const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

// Markers `govern` writes when a human still has to decide. A contract field
// carrying one is not configured, whatever else it parses as.
const DECISION_MARKERS = ["USER DECISION REQUIRED", "NEEDS PRD CLARIFICATION", "NEEDS CLARIFICATION"];

export function decisionMarker(value) {
	const texts = Array.isArray(value) ? value : [value];
	for (const t of texts) {
		if (typeof t !== "string") continue;
		for (const m of DECISION_MARKERS) if (t.includes(m)) return m;
	}
	return null;
}

function looksLikeContractIntent(text) {
	if (text.includes("pipeline-contract")) return true;
	return /^[ \t]*(models|budgets|review|contract_version)[ \t]*:/m.test(text);
}

function warnUnknownKeys(parsed, warnings) {
	if (!parsed || typeof parsed !== "object") return;
	const note = "ignored — unknown keys stay warnings so later contract fields remain forward-compatible";
	const walk = (obj, known, prefix) => {
		if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
		for (const key of Object.keys(obj)) {
			if (!known.has(key)) warnings.push(`unknown contract key \`${prefix}${key}\`; ${note}`);
		}
	};
	walk(parsed, KNOWN_TOP, "");
	if (parsed.models && typeof parsed.models === "object") {
		walk(parsed.models, KNOWN_MODEL_KEYS, "models.");
		walk(parsed.models.review, KNOWN_REVIEWERS, "models.review.");
		walk(parsed.models.constraints, KNOWN_CONSTRAINTS, "models.constraints.");
	}
	walk(parsed.budgets, KNOWN_BUDGETS, "budgets.");
	walk(parsed.review, KNOWN_REVIEW_GATE, "review.");
	walk(parsed.issues, KNOWN_ISSUES, "issues.");
	if (parsed.issues && typeof parsed.issues.source === "object" && parsed.issues.source && !Array.isArray(parsed.issues.source)) {
		walk(parsed.issues.source, KNOWN_ISSUE_SOURCE, "issues.source.");
	}
	if (Array.isArray(parsed.gates)) {
		parsed.gates.forEach((g, i) => walk(g, KNOWN_GATE, `gates[${i}].`));
	}
}

// Every field is checked for a decision marker, at any depth. The path names
// the field so the operator knows what to decide.
function collectDecisions(node, path, out) {
	if (node === null || node === undefined) return;
	const marker = decisionMarker(node);
	if (marker) {
		out.push({ path: path || "config", marker });
		return;
	}
	if (Array.isArray(node)) {
		node.forEach((v, i) => collectDecisions(v, `${path}[${i}]`, out));
	} else if (typeof node === "object") {
		for (const [k, v] of Object.entries(node)) collectDecisions(v, path ? `${path}.${k}` : k, out);
	}
}

// `gates` is a list of { name, run }. A map { lint: "cmd" } is accepted and
// normalised to the list form so the loop sees one shape.
export function normalizeGates(value) {
	if (value === null || value === undefined) return null;
	if (Array.isArray(value)) return value;
	if (typeof value === "object") {
		return Object.entries(value).map(([name, run]) => ({ name, run }));
	}
	return value;
}

export function withDefaults(parsed) {
	const models = parsed.models ?? {};
	const version = parsed.contract_version ?? 1;
	return {
		contract_version: version,
		models: {
			...models,
			review: models.review ?? {},
			constraints: { ...DEFAULTS.models.constraints, ...(models.constraints ?? {}) },
		},
		budgets: { ...DEFAULTS.budgets, ...(parsed.budgets ?? {}) },
		review: { ...DEFAULTS.review, ...(parsed.review ?? {}) },
		issues: parsed.issues ?? null,
		gates: normalizeGates(parsed.gates),
	};
}

// Prefer a fence marked `yaml pipeline-contract`. Otherwise the first fenced
// yaml block that declares a contract key wins — an example block above the
// real one would silently become routing.
export function readConfig(agentsPath) {
	const warnings = [];
	const empty = (extra) => ({
		config: withDefaults({}),
		warnings: extra,
		hadModelsBlock: false,
		noSelfReviewExplicit: false,
		decisions: [],
		raw: {},
	});
	if (!existsSync(agentsPath)) {
		return empty([
			`${agentsPath} not found; every role runs the default model — no_self_review cannot fire, so three reviewers are one model`,
		]);
	}
	const text = readFileSync(agentsPath, "utf8");
	const fences = [...text.matchAll(/```(ya?ml)([^\n]*)\n([\s\S]*?)```/g)].map((m) => ({
		info: m[2].trim(),
		body: m[3],
	}));
	const candidates = fences.filter((f) => /^\s*(models|budgets|review|contract_version|issues|gates)\s*:/m.test(f.body));
	const marked = candidates.filter((f) => /\bpipeline-contract\b/.test(f.info));
	let block = null;
	if (marked.length > 0) {
		block = marked[0].body;
	} else if (candidates.length > 0) {
		block = candidates[0].body;
		if (candidates.length > 1) {
			warnings.push(
				`AGENTS.md has ${candidates.length} YAML blocks with contract keys; using the first. Mark the real one as \`yaml pipeline-contract\``,
			);
		}
	}
	if (!block) {
		// A fence that never closed, or a ~~~ fence, still contains the keys.
		// That is an author who tried to set a contract, not absence. Absence
		// is the documented default path and must stay a warning.
		if (looksLikeContractIntent(text)) {
			throw contractError(
				"AGENTS.md looks like it contains a pipeline contract (pipeline-contract, or a models:/budgets:/review: line) but no fenced YAML block parsed; refusing to run on defaults that would silently drop the configured budgets and models",
			);
		}
		warnings.push(
			"no contract config block in AGENTS.md; defaults apply to every field — no_self_review cannot fire, so three reviewers are one model",
		);
		return { ...empty(warnings), warnings };
	}
	const parsed = parseYamlSubset(block);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw contractError("AGENTS.md contract block is not a YAML map of contract fields");
	}
	warnUnknownKeys(parsed, warnings);
	const decisions = [];
	collectDecisions(parsed, "", decisions);
	const noSelfReviewExplicit = parsed.models?.constraints?.no_self_review === true;
	// Defaulted no_self_review still degrades here (compat). The concrete
	// effect: implement and all three reviewers share the session default,
	// and a default/default collision cannot be proven at run time.
	if (!parsed.models) {
		warnings.push(
			"no `models:` block; every role runs the default model — no_self_review cannot fire, so three reviewers are one model",
		);
	}
	return {
		config: withDefaults(parsed),
		warnings,
		hadModelsBlock: Boolean(parsed.models),
		noSelfReviewExplicit,
		decisions,
		raw: parsed,
	};
}

export function thinkingRef(entry) {
	if (!entry || typeof entry !== "object") return null;
	if (entry.thinking == null || entry.thinking === "") return null;
	return String(entry.thinking);
}

// Identity: provider/model. Thinking is a launch parameter, not a new model.
export function modelRef(entry) {
	if (!entry || typeof entry !== "object") return null;
	if (!entry.model) return null;
	return entry.provider ? `${entry.provider}/${entry.model}` : String(entry.model);
}

// What pi --model accepts: provider/model or provider/model:thinking.
export function invokeRef(entry) {
	const id = modelRef(entry);
	if (!id) return null;
	const thinking = thinkingRef(entry);
	return thinking ? `${id}:${thinking}` : id;
}

export function roleEntry(config, rolePath) {
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

// Every role to its invoke ref, "default" where unmapped.
export function resolveAllModels(config) {
	const resolved = {};
	for (const role of ROLES) resolved[role] = resolveModel(config, role);
	for (const r of REVIEWERS) resolved[`review.${r}`] = resolveModel(config, `review.${r}`);
	return resolved;
}

// Strip pi's :<thinking> suffix: sonnet:high and sonnet:low are one model.
export function modelIdentity(ref) {
	if (typeof ref !== "string") return ref;
	const i = ref.lastIndexOf(":");
	if (i === -1) return ref;
	return THINKING_LEVELS.has(ref.slice(i + 1)) ? ref.slice(0, i) : ref;
}

export function eachMappedRole(models, fn) {
	for (const role of ROLES) {
		if (models[role] && typeof models[role] === "object") fn(role, models[role]);
	}
	for (const r of REVIEWERS) {
		const entry = models.review?.[r];
		if (entry && typeof entry === "object") fn(`review.${r}`, entry);
	}
}
