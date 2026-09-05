// text.mjs — small text helpers shared by prompts and logs.

import { existsSync, readFileSync } from "node:fs";

// First n lines of a file, without trailing newlines — the shape a shell
// `$(sed -n "1,Np" file)` substitution produced in 1.0.x prompts.
export function excerpt(file, n = 200) {
	if (!file || !existsSync(file)) return "";
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return "";
	}
	return text.split("\n").slice(0, n).join("\n").replace(/\n+$/, "");
}

export function tailLines(text, n) {
	const lines = text.replace(/\n$/, "").split("\n");
	return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

// The first `head` and the last `tail` lines, with the cut named in between.
// A test runner prints its summary last and its progress first; a gate log
// that only kept its head would feed neither the failure nor the count back.
export function headTail(text, head, tail) {
	const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
	if (lines.length <= head + tail) return lines.join("\n");
	const omitted = lines.length - head - tail;
	return [...lines.slice(0, head), `[… ${omitted} lines omitted …]`, ...lines.slice(lines.length - tail)].join("\n");
}

export function countLines(text) {
	if (text === "") return 0;
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

// The id becomes a directory name — keep it path-safe whatever the source holds.
export function sanitizeIssueId(raw) {
	return raw.replace(/[^A-Za-z0-9._-]/g, "-");
}

export function attemptTag(n) {
	return `a${String(n).padStart(2, "0")}`;
}

// Local time with numeric offset, matching `date +%Y-%m-%dT%H:%M:%S%z`.
export function localTimestamp(d = new Date()) {
	const pad = (v, w = 2) => String(v).padStart(w, "0");
	const off = -d.getTimezoneOffset();
	const sign = off >= 0 ? "+" : "-";
	const hh = pad(Math.floor(Math.abs(off) / 60));
	const mm = pad(Math.abs(off) % 60);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${hh}${mm}`;
}

// `date +%Y%m%dT%H%M%S`: the run id that names prompt files and log files.
export function runIdNow(d = new Date()) {
	const pad = (v) => String(v).padStart(2, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function isoDate(d = new Date()) {
	const pad = (v) => String(v).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function intEnv(env, name, fallback, { min = 0 } = {}) {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	if (!/^[0-9]+$/.test(raw)) return fallback;
	const n = Number(raw);
	return n < min ? fallback : n;
}
