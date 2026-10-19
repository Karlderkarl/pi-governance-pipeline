// source.mjs — the issue source behind an interface.
//
// list() yields open issues, markDone() closes one, create() adds a child
// (for a split) where the backend can. A backend without create() cannot be
// split into; the loop then turns a split decision into a reject with a note.
//
// Two backends ship: a tasks.md checkbox file and a command whose stdout
// lists `id: title` lines (the 1.0.x `!command` form). Command sources are
// treated as externally authored text unless the contract says otherwise.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { runShell } from "../util/exec.mjs";
import { sanitizeIssueId } from "../util/text.mjs";

const OPEN_RE = /^(\s*)- \[ \] (.*)$/;
const ANY_RE = /^(\s*)- \[[ xX]\] (.*)$/;

function parseLine(text) {
	const line = text.trim();
	const raw = line.split(":")[0].trim();
	const title = line.includes(":") ? line.slice(line.indexOf(":") + 1).trim() : "";
	return { raw, title, line };
}

// The file is read with either line ending and written back with the one it
// had. A checkout with core.autocrlf=true hands us CRLF, and `.` in the
// patterns above matches no `\r` — a CRLF file used to read as "no open issues".
function readLines(abs) {
	const text = readFileSync(abs, "utf8");
	return { lines: text.split(/\r?\n/), eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

function writeLines(abs, lines, eol) {
	writeFileSync(abs, lines.join(eol));
}

// The name a filesystem resolves an id's directory and state file to.
// Windows and macOS compare case-insensitively and Windows drops trailing
// dots and spaces, so `task`, `TASK` and `task.` are one file there. The key
// is the same on every platform: a backlog that runs on Linux must not break
// on the next clone to Windows.
const fsKey = (id) => id.toLowerCase().replace(/[. ]+$/, "");
// `.` and `..` resolve to the work directory itself and to .pipeline; an
// empty name and Windows device names cannot be files at all.
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

// Two raw ids that land on the same directory name would share a work
// directory, a state file and a budget. Refuse before anything runs.
function refuseCollisions(issues) {
	const seen = new Map();
	const refuse = (message) => {
		const err = new Error(message);
		err.code = "SOURCE";
		throw err;
	};
	for (const issue of issues) {
		const id = sanitizeIssueId(issue.raw);
		const key = fsKey(id);
		if (key === "" || RESERVED.test(id)) refuse(`issue id "${issue.raw}" becomes "${id}", which is not a usable directory or file name; rename it`);
		const prev = seen.get(key);
		if (prev?.id === id) refuse(`issue ids "${prev.raw}" and "${issue.raw}" both become "${id}" once sanitised for the work directory; rename one of them`);
		if (prev !== undefined) {
			refuse(`issue ids "${prev.raw}" and "${issue.raw}" share one work directory and state file on Windows and macOS ("${prev.id}" and "${id}" differ only in case or trailing dots); rename one of them`);
		}
		seen.set(key, { raw: issue.raw, id });
	}
	return issues;
}

function validateLines(lines) {
	return refuseCollisions(lines.flatMap((line) => {
		const m = ANY_RE.exec(line);
		return m ? [parseLine(m[2])] : [];
	}));
}

// What list() refuses in a file source, without the listing: for doctor,
// which must report an unusable backlog before a run does. Throws the same
// SOURCE error; a missing file is the caller's own check.
export function checkIssueFile(abs) {
	validateLines(readLines(abs).lines);
}

export function tasksMdSource(path, root) {
	const abs = isAbsolute(path) ? path : join(root, path);
	const rel = relative(root, abs).replace(/\\/g, "/");
	const insideRoot = !rel.startsWith("..") && !isAbsolute(rel);
	return {
		kind: "file",
		path: abs,
		relPath: insideRoot ? rel : null,
		trust: "internal",
		describe: () => path,
		async list() {
			if (!existsSync(abs)) throw new Error(`issue source not found: ${abs}`);
			const { lines } = readLines(abs);
			validateLines(lines);
			const issues = [];
			// parent tracking: the last item at each indent level
			const stack = [];
			for (const l of lines) {
				const any = ANY_RE.exec(l);
				if (!any) continue;
				const indent = any[1].length;
				const { raw, title, line } = parseLine(any[2]);
				while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
				const parent = stack.length ? stack[stack.length - 1].raw : null;
				stack.push({ indent, raw });
				if (OPEN_RE.test(l)) issues.push({ raw, title, line, parent, indent });
			}
			return refuseCollisions(issues);
		},
		async markDone(rawId) {
			if (!existsSync(abs)) return false;
			const { lines, eol } = readLines(abs);
			validateLines(lines);
			let n = 0;
			const out = lines.map((l) => {
				const m = OPEN_RE.exec(l);
				if (!n && m && parseLine(m[2]).raw === rawId) {
					n = 1;
					return l.replace("- [ ] ", "- [x] ");
				}
				return l;
			});
			writeLines(abs, out, eol);
			return n === 1;
		},
		async markBlocked() {
			// The state file carries `blocked`; the checkbox stays open so a
			// human sees the work is not done.
			return false;
		},
		// Children are indented under their parent: `  - [ ] parent.1: title`.
		// The id is the first unused `parent.<n>` in the whole file, not the
		// count of children plus one — a child renamed or removed by hand must
		// not make the next one a duplicate. Unused means unused under the key
		// the collision check compares: beside a closed `ONE.1`, `one.1` would
		// leave a backlog every later run refuses, so the file is validated
		// again before it is written. The title is one line, whatever
		// the caller passed: a newline here would write further issue lines.
		async create({ parentRaw, title }) {
			if (!existsSync(abs)) throw new Error(`issue source not found: ${abs}`);
			const { lines, eol } = readLines(abs);
			validateLines(lines);
			let at = -1;
			let indent = "";
			for (let i = 0; i < lines.length; i++) {
				const m = ANY_RE.exec(lines[i]);
				if (m && parseLine(m[2]).raw === parentRaw) {
					at = i;
					indent = m[1];
					break;
				}
			}
			if (at === -1) throw new Error(`parent issue ${parentRaw} not found in ${abs}`);
			// Insert after the parent's existing children.
			let end = at + 1;
			while (end < lines.length) {
				const m = ANY_RE.exec(lines[end]);
				if (!m || m[1].length <= indent.length) break;
				end++;
			}
			const used = new Set();
			for (const l of lines) {
				const m = ANY_RE.exec(l);
				if (m) used.add(fsKey(sanitizeIssueId(parseLine(m[2]).raw)));
			}
			let n = 1;
			while (used.has(fsKey(sanitizeIssueId(`${parentRaw}.${n}`)))) n++;
			const childRaw = `${parentRaw}.${n}`;
			const oneLine = String(title ?? "")
				.replace(/[\r\n\t\f\v\u2028\u2029]+/g, " ")
				.replace(/\s{2,}/g, " ")
				.trim();
			lines.splice(end, 0, `${indent}  - [ ] ${childRaw}: ${oneLine}`);
			validateLines(lines);
			writeLines(abs, lines, eol);
			return childRaw;
		},
	};
}

// timeoutMs caps the command like a gate: a `gh issue list` without network
// must not hold an unattended run forever.
export function commandSource(command, { root, trust = "external", env = process.env, spec, timeoutMs = 0 }) {
	return {
		kind: "command",
		path: null,
		relPath: null,
		trust,
		describe: () => spec ?? `!${command}`,
		async list() {
			const r = await runShell(command, { cwd: root, env, timeoutMs });
			if (r.timedOut) {
				const err = new Error(`issue source timed out after ${Math.round(timeoutMs / 1000)}s (GATE_TIMEOUT_SECONDS)`);
				err.code = "SOURCE";
				err.stderr = r.stderr.toString("utf8");
				throw err;
			}
			if (r.status !== 0) {
				const err = new Error(`issue source failed (exit ${r.status ?? "signal"})`);
				err.code = "SOURCE";
				err.stderr = r.stderr.toString("utf8");
				throw err;
			}
			return refuseCollisions(
				r.stdout
					.toString("utf8")
					.split("\n")
					.map((l) => l.replace(/\r$/, ""))
					.filter((l) => l.trim() !== "")
					.map((l) => ({ ...parseLine(l), parent: null, indent: 0 })),
			);
		},
		async markDone() {
			// Command sources own their done-state — we do not rewrite their stdout.
			return false;
		},
		async markBlocked() {
			return false;
		},
		create: null,
	};
}

// spec: the result of effectiveIssueSource().
export function openIssueSource(spec, { root, env = process.env, timeoutMs = 0 }) {
	if (spec.kind === "command") return commandSource(spec.command, { root, trust: spec.trust, env, spec: spec.spec, timeoutMs });
	return tasksMdSource(spec.path, root);
}
