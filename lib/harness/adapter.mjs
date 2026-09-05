// adapter.mjs — one interface, several harnesses.
//
// The harness is chosen per invocation from the model's provider, never
// from governance: the same AGENTS.md must run on pi alone and on pi plus
// Claude Code. Claude Code can only execute Anthropic models, so it can never
// be the harness for a whole panel that spans two providers — it takes the
// roles whose provider it serves, pi takes the rest. The mapping comes from
// the wrapper or the command line (`--harness anthropic=claude-code`), with
// pi as the default for every provider.

import { writeFileSync } from "node:fs";
import * as pi from "./pi.mjs";
import * as claudeCode from "./claude-code.mjs";

export const ADAPTERS = { pi, "claude-code": claudeCode };

// Harnesses that execute the models of one provider only. pi is absent on
// purpose: it routes any provider/model ref itself.
export const HARNESS_PROVIDERS = { "claude-code": ["anthropic"] };

// "pi" | "claude-code" | "anthropic=claude-code,openai=pi" | "" -> spec
export function parseHarnessSpec(text) {
	const spec = { default: "pi", byProvider: {} };
	const raw = (text ?? "").trim();
	if (raw === "") return spec;
	for (const part of raw.split(",")) {
		const item = part.trim();
		if (item === "") continue;
		const eq = item.indexOf("=");
		if (eq === -1) {
			if (!ADAPTERS[item]) throw new Error(`unknown harness ${item}; expected pi or claude-code`);
			spec.default = item;
			continue;
		}
		const provider = item.slice(0, eq).trim();
		const harness = item.slice(eq + 1).trim();
		if (provider === "") throw new Error(`empty provider in --harness item "${item}"; expected provider=harness`);
		if (!ADAPTERS[harness]) throw new Error(`unknown harness ${harness} for provider ${provider}; expected pi or claude-code`);
		spec.byProvider[provider] = harness;
	}
	return spec;
}

// A role routed to a harness that cannot run its provider would fail at the
// first call, six times, looking like an implementer that wrote nothing.
// Checked once at start and in doctor; unmapped roles and refs without a
// provider are left to the harness.
export function routingErrors(models, spec) {
	const errors = [];
	for (const [role, ref] of Object.entries(models)) {
		if (!ref || ref === "default") continue;
		const harness = harnessFor(ref, spec);
		const allowed = HARNESS_PROVIDERS[harness];
		if (!allowed) continue;
		const provider = providerOf(ref);
		if (!provider || allowed.includes(provider)) continue;
		errors.push(
			`role ${role} (${ref}) is routed to ${harness}, which runs only ${allowed.join(", ")} models; map only that provider (--harness ${allowed[0]}=${harness}) or send ${provider} to pi (--harness ${provider}=pi)`,
		);
	}
	return errors;
}

export function providerOf(modelRef) {
	if (!modelRef || modelRef === "default") return null;
	const i = modelRef.indexOf("/");
	return i === -1 ? null : modelRef.slice(0, i);
}

export function harnessFor(modelRef, spec) {
	const provider = providerOf(modelRef);
	if (provider && spec.byProvider[provider]) return spec.byProvider[provider];
	return spec.default;
}

// Every harness used by the resolved model map, so the startup check can
// verify each binary once.
export function harnessesInUse(models, spec) {
	const set = new Set();
	for (const ref of Object.values(models)) set.add(harnessFor(ref, spec));
	return [...set];
}

// Isolation class per role. Reviewers are read-only and context-free;
// judges have no tools at all (the diff is inline); research reads only;
// implementers need the project's own tooling.
export function isolationOf(role) {
	if (role.startsWith("review.")) return "reviewer";
	if (role === "controller" || role === "master_review") return "judge";
	if (role === "research") return "research";
	return "implementer";
}

// The harness's own error channel. pi -p puts "no API key", "unknown model"
// and a refused request here and exits 1 with nothing on stdout; without this
// text an auth failure is indistinguishable from an implementer that wrote
// nothing. Kept whole up to a cap; the first line is what the loop reports.
const STDERR_MAX_BYTES = 64 * 1024;
function stderrOf(result) {
	const buf = result.stderr ?? Buffer.alloc(0);
	const text = (buf.length > STDERR_MAX_BYTES ? buf.subarray(buf.length - STDERR_MAX_BYTES) : buf).toString("utf8");
	const firstLine = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.find((l) => l !== "");
	return { stderr: text, firstLine: (firstLine ?? "").slice(0, 200) };
}

// Launch one role. Writes the answer text to outPath (empty on timeout or
// launch failure) and returns { status, timedOut, harness, error, stderr, firstLine }.
export async function invokeRole({ spec, role, model, promptText, outPath, cwd, trusted, timeoutMs, env }) {
	const harness = harnessFor(model, spec);
	const adapter = ADAPTERS[harness];
	const isolation = isolationOf(role);
	const launch = adapter.resolve(env);
	if (!launch) {
		writeFileSync(outPath, "");
		return { status: 127, timedOut: false, harness, error: `${adapter.BINARY} is not on PATH`, stderr: "", firstLine: "" };
	}
	const args = adapter.buildArgs({ isolation, model, trusted: trusted && isolation === "implementer" });
	const result = await adapter.launch(launch, args, { promptText, cwd, env, timeoutMs });
	if (result.timedOut) {
		// Empty the file so the existing unavailable path treats this as a
		// role failure, not as partial JSON.
		writeFileSync(outPath, "");
		return { status: 124, timedOut: true, harness, error: null, ...stderrOf(result) };
	}
	writeFileSync(outPath, adapter.parseOutput(result).text);
	const status = result.error ? 127 : result.status === null ? 1 : result.status;
	return { status, timedOut: false, harness, error: result.error ? String(result.error.message ?? result.error) : null, ...stderrOf(result) };
}
