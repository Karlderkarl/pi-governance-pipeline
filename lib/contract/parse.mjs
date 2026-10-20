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

export const ROLES = ["research", "implement", "implement_master", "master_review"];
// Roles a contract may still map but the loop no longer runs. They warn with
// the reason instead of the generic unknown-key text, and launch nothing.
export const RETIRED_ROLES = {
	controller: "the deterministic review gate merges the reviewer findings, and master_review decides on the original reviewer output; remove the entry",
};
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
// A role entry: where the model comes from and how hard it thinks.
export const KNOWN_ROLE_KEYS = new Set(["provider", "model", "thinking"]);
// pi --model <pattern> accepts an optional :<thinking> suffix; these are the
// levels from pi's --thinking flag. Identity comparisons strip this suffix.
export const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

// Markers `govern` writes when a human still has to decide. A contract field
// carrying one is not configured, whatever else it parses as.
export const DECISION_MARKERS = ["USER DECISION REQUIRED", "NEEDS PRD CLARIFICATION", "NEEDS CLARIFICATION"];

// Engine-authored history quotes model/tool text; those quotations are not
// new human decisions. HTML entities preserve readable Markdown without
// leaving an active marker in the source scanned at startup.
export function quoteDecisionMarkers(text) {
	let result = String(text);
	for (const marker of DECISION_MARKERS) result = result.replaceAll(marker, marker.replaceAll(" ", "&#32;"));
	return result;
}

export function decisionMarker(value) {
	const texts = Array.isArray(value) ? value : [value];
	for (const t of texts) {
		if (typeof t !== "string") continue;
		for (const m of DECISION_MARKERS) if (t.includes(m)) return m;
	}
	return null;
}

// Did the author try to write a contract that then failed to parse? That is a
// contract error; genuine absence is the documented default path.
//
// A bare `models:` or `review:` line is NOT the signal. AGENTS.md is prose,
// and governance-files.md tells the author to give it a "review rules"
// section — a line `review:` at the start of a paragraph used to refuse the
// whole run (doctor FAIL, init 1, run 2) on a perfectly valid file.
//
// Intent is the explicit marker, or a contract key inside something that
// opens like a YAML fence: a `~~~` fence, a fence the closing backticks never
// arrived for, or a ``` fence whose language tag is missing. In each of those
// the reader found no block, and the keys sit inside the attempt.
function looksLikeContractIntent(text, fences) {
	if (text.includes("pipeline-contract")) return true;
	return fences.some(isFailedAttempt);
}

const CONTRACT_KEY = /^[ \t]*(?:models|budgets|review|contract_version|issues|gates)[ \t]*:/m;

// Fences as a Markdown reader sees them: opened and closed on a line of their
// own. A regex over the whole text let three backticks inside a sentence open
// or close a block, so prose could swallow the contract or a contract absorb
// prose. A closing line uses the same character, at least as many times.
function scanFences(text) {
	const fences = [];
	let open = null;
	for (const line of text.split(/\r?\n/)) {
		if (open) {
			const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
			if (close && close[1][0] === open.char && close[1].length >= open.length) {
				fences.push({ ...open, closed: true, body: open.lines.map((l) => `${l}\n`).join("") });
				open = null;
			} else open.lines.push(line);
			continue;
		}
		const start = /^[ \t]*(`{3,}|~{3,})[ \t]*([^`]*)$/.exec(line);
		if (start) open = { char: start[1][0], length: start[1].length, info: start[2].trim(), lines: [] };
	}
	if (open) fences.push({ ...open, closed: false, body: open.lines.join("\n") });
	return fences;
}

// The one kind of fence the reader takes: closed, backticks, tagged yaml or yml.
const isYamlFence = (f) => f.closed && f.char === "`" && /^ya?ml(?:\s|$)/.test(f.info);

// Opens like a YAML fence and holds contract keys, but is not one the reader
// takes: a `~~~` fence, one whose closing line never came, or one with no
// language tag. A ```bash example that contains `review:` is not one.
const isFailedAttempt = (f) => !isYamlFence(f) && (f.info === "" || /^ya?ml\b/i.test(f.info)) && CONTRACT_KEY.test(f.body);

function warnUnknownKeys(parsed, warnings) {
	if (!parsed || typeof parsed !== "object") return;
	const note = "ignored — unknown keys stay warnings so later contract fields remain forward-compatible";
	const walk = (obj, known, prefix, retired = {}) => {
		if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
		for (const key of Object.keys(obj)) {
			if (Object.hasOwn(retired, key)) warnings.push(`contract key \`${prefix}${key}\` is no longer used: ${retired[key]}`);
			else if (!known.has(key)) warnings.push(`unknown contract key \`${prefix}${key}\`; ${note}`);
		}
	};
	walk(parsed, KNOWN_TOP, "");
	if (parsed.models && typeof parsed.models === "object") {
		walk(parsed.models, KNOWN_MODEL_KEYS, "models.", RETIRED_ROLES);
		walk(parsed.models.review, KNOWN_REVIEWERS, "models.review.");
		// A typo inside a role (`thinkng`) used to vanish: the role still
		// validated and ran, only without the level.
		for (const role of KNOWN_MODEL_KEYS) {
			if (role !== "review" && role !== "constraints") walk(parsed.models[role], KNOWN_ROLE_KEYS, `models.${role}.`);
		}
		for (const name of KNOWN_REVIEWERS) walk(parsed.models.review?.[name], KNOWN_ROLE_KEYS, `models.review.${name}.`);
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

// A retired role has had its warning; past that point it must not exist. Left
// in, it reached the merged config, resolved through the facade and failed
// validation on a marker in a role nothing runs.
function withoutRetiredRoles(parsed) {
	const models = parsed.models;
	if (!models || typeof models !== "object" || Array.isArray(models)) return parsed;
	return { ...parsed, models: Object.fromEntries(Object.entries(models).filter(([key]) => !Object.hasOwn(RETIRED_ROLES, key))) };
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
	// Only a missing key means v1. An empty `contract_version:` is null and
	// fails validation; read as v1 it would drop the v2 requirements in silence.
	const version = Object.hasOwn(parsed, "contract_version") ? parsed.contract_version : 1;
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
	const all = scanFences(text);
	const fences = all.filter(isYamlFence);
	const candidates = fences.filter((f) => CONTRACT_KEY.test(f.body));
	const marked = fences.filter((f) => /\bpipeline-contract\b/.test(f.info));
	if (marked.length > 1) throw contractError(`AGENTS.md has ${marked.length} pipeline-contract blocks; exactly one may be marked`);
	const brokenMark = all.find((f) => !isYamlFence(f) && /\bpipeline-contract\b/.test(f.info));
	if (brokenMark) {
		const why = brokenMark.char === "~" ? "a ~~~ fence" : !brokenMark.closed ? "its closing backticks are missing" : "it has no yaml tag";
		throw contractError(`AGENTS.md marks a block as pipeline-contract that the reader cannot take (${why}); write it as a closed \`\`\`yaml pipeline-contract fence`);
	}
	let block = null;
	if (marked.length > 0) {
		block = marked[0].body;
	} else if (all.some(isFailedAttempt)) {
		// An unmarked example above a contract the reader cannot take would
		// otherwise become the routing in silence.
		throw contractError(
			"AGENTS.md has a block with contract keys that is not a closed ```yaml fence (a ~~~ fence, a missing language tag or missing closing backticks); fix it and mark the real contract as `yaml pipeline-contract`",
		);
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
		if (looksLikeContractIntent(text, all)) {
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
	if (marked.length && !Object.keys(parsed).some((key) => KNOWN_TOP.has(key))) {
		throw contractError("AGENTS.md marked pipeline-contract block contains no recognized top-level contract fields; refusing to run on defaults");
	}
	warnUnknownKeys(parsed, warnings);
	const contract = withoutRetiredRoles(parsed);
	const decisions = [];
	collectDecisions(contract, "", decisions);
	const noSelfReviewExplicit = contract.models?.constraints?.no_self_review === true;
	// Defaulted no_self_review still degrades here (compat). The concrete
	// effect: implement and all three reviewers share the session default,
	// and a default/default collision cannot be proven at run time.
	if (!parsed.models) {
		warnings.push(
			"no `models:` block; every role runs the default model — no_self_review cannot fire, so three reviewers are one model",
		);
	}
	return {
		config: withDefaults(contract),
		warnings,
		hadModelsBlock: Boolean(parsed.models),
		noSelfReviewExplicit,
		decisions,
		raw: contract,
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

// Providers that resell other vendors' models under `<vendor>/<model>` ids.
// `openrouter/google/gemini-2.5-flash` is Google's model, not an OpenRouter
// one: counting the aggregator as the provider refused every OpenRouter-only
// panel as "single provider", and let `google/x` review `openrouter/google/x`.
export const AGGREGATOR_PROVIDERS = new Set(["openrouter"]);

// The model a ref names, for comparison only — never for launching; pi still
// receives the ref as written. Strips pi's :<thinking> suffix (sonnet:high
// and sonnet:low are one model) and an aggregator prefix in front of a
// vendor-qualified id.
export function modelIdentity(ref) {
	if (typeof ref !== "string") return ref;
	let id = ref;
	const i = id.lastIndexOf(":");
	if (i !== -1 && THINKING_LEVELS.has(id.slice(i + 1))) id = id.slice(0, i);
	const slash = id.indexOf("/");
	if (slash !== -1 && AGGREGATOR_PROVIDERS.has(id.slice(0, slash)) && id.indexOf("/", slash + 1) !== -1) id = id.slice(slash + 1);
	return id;
}

// The vendor whose model a ref names: the diversity unit of a review panel.
export function vendorOf(ref) {
	const id = modelIdentity(ref);
	if (typeof id !== "string") return null;
	const slash = id.indexOf("/");
	return slash === -1 ? null : id.slice(0, slash);
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
