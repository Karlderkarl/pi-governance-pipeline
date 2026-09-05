// capture.mjs — the working-tree diff the reviewers judge.
//
// Reviewers must see what actually changed. `git diff` alone hides untracked
// files — and TDD writes new test files — so new files are listed first and
// appended in full. Governance, the pipeline's own directories, the issue
// source and the wrapper never belong in the review diff: the implement
// prompt forbids them, the integrity check reverts them, and block_issue
// writes MEMORY.md between attempts. Truncation is per file, not a byte
// prefix of the concatenated patch, and omitted paths are named in a manifest
// so the reviewer prompt says what was not judged.

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diffPathspecExcludes, isGovernanceTreePath } from "../integrity/governance-paths.mjs";
import { git, hasHead, isGitWorkTree } from "../util/exec.mjs";

function isBinary(abs) {
	try {
		const st = statSync(abs);
		if (!st.isFile() || st.size === 0) return false;
		const buf = readFileSync(abs);
		const head = buf.subarray(0, Math.min(buf.length, 8000));
		return head.includes(0);
	} catch {
		return false;
	}
}

// NUL-separated path list from git, as strings. Git prints paths verbatim
// with -z; without it every non-ASCII path would come back C-quoted and match
// no file.
function nulList(buf) {
	return buf
		.toString("utf8")
		.split("\0")
		.filter((p) => p !== "");
}

// harnessRel: repository-relative paths that are the harness itself (the
// wrapper script, the issue source file). Exact match, no regex escaping.
export function captureDiff({ root, out, maxBytes, harnessRel = [] }) {
	writeFileSync(out, "");
	writeFileSync(`${out}.paths`, "");
	if (!isGitWorkTree(root)) return { included: [], omitted: [], truncated: [], empty: true };
	const harness = new Set(harnessRel.filter(Boolean));
	const isHarness = (p) => harness.has(p);
	const rows = [];
	const seen = new Set();
	const push = (path, kind) => {
		if (seen.has(path)) return;
		seen.add(path);
		rows.push({ path, kind });
	};
	// Untracked first: TDD writes new test files, and a byte-prefix of
	// `git diff` then the untracked append used to drop them first.
	const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
	for (const f of nulList(untracked.stdout)) {
		if (isGovernanceTreePath(f) || isHarness(f)) continue;
		push(f, isBinary(join(root, f)) ? "binary" : "untracked");
	}
	const head = hasHead(root);
	// Record both ends of a rename. A path-limited approval must include the
	// old path's deletion as well as the new path's content.
	const nameArgs = head ? ["diff", "HEAD", "--no-renames", "--name-only", "-z", "--", "."] : ["diff", "--no-renames", "--name-only", "-z", "--", "."];
	const excludes = [...diffPathspecExcludes(), ...[...harness].map((h) => `:(exclude,literal)${h}`)];
	const tracked = git(root, [...nameArgs, ...excludes]);
	for (const f of nulList(tracked.stdout)) {
		if (isGovernanceTreePath(f) || isHarness(f)) continue;
		push(f, "tracked");
	}
	// Every reviewed path, NUL-terminated (not just separated: a `read -d ''`
	// style consumer drops an unterminated last record): the approve step
	// commits exactly this set, so what was reviewed is what lands in the commit.
	writeFileSync(`${out}.paths`, rows.map((r) => `${r.path}\0`).join(""));

	const load = (row) => {
		if (row.kind === "binary") return Buffer.from(`\n--- new file (untracked, binary — omitted): ${row.path} ---\n`);
		if (row.kind === "untracked") {
			let body = Buffer.alloc(0);
			try {
				body = readFileSync(join(root, row.path));
			} catch {
				body = Buffer.alloc(0);
			}
			return Buffer.concat([Buffer.from(`\n--- new file (untracked): ${row.path} ---\n`), body]);
		}
		// The path is verbatim, so a name holding * or [ would be read as a
		// wildcard and one starting with : as pathspec magic. :(literal) pins it.
		const spec = `:(literal)${row.path}`;
		const r = git(root, head ? ["diff", "HEAD", "--", spec] : ["diff", "--", spec]);
		return r.stdout && r.stdout.length ? r.stdout : Buffer.alloc(0);
	};
	const n = rows.length;
	const share = n === 0 ? maxBytes : Math.max(64, Math.floor(maxBytes / n));
	const included = [];
	const omitted = [];
	const truncated = [];
	let used = 0;
	const chunks = [];
	for (const row of rows) {
		const buf = load(row);
		// Listed as changed, but nothing came back. Name it in the manifest
		// rather than dropping it: silence here reads as "reviewed and clean".
		if (!buf.length) {
			omitted.push(row.path);
			continue;
		}
		if (used >= maxBytes) {
			omitted.push(row.path);
			continue;
		}
		const room = Math.min(share, maxBytes - used);
		if (room <= 0) {
			omitted.push(row.path);
			continue;
		}
		if (buf.length <= room) {
			chunks.push(buf);
			used += buf.length;
			included.push(row.path);
		} else {
			chunks.push(buf.subarray(0, room));
			chunks.push(Buffer.from(`\n[file truncated at ${room} bytes: ${row.path}]\n`));
			used += room;
			included.push(row.path);
			truncated.push(row.path);
		}
	}
	// A manifest with no diff bytes behind it is not a diff. The empty-diff
	// guard tests the file size, and a lone footer would satisfy it — the
	// three reviewers would then rubber-stamp "nothing changed".
	if (n === 0 || chunks.length === 0) {
		writeFileSync(out, "");
		return { included, omitted, truncated, empty: true };
	}
	const footer = ["\n[review diff manifest]", `included: ${included.length ? included.join(", ") : "(none)"}`];
	if (truncated.length) footer.push(`truncated: ${truncated.join(", ")}`);
	footer.push(`omitted: ${omitted.length ? omitted.join(", ") : "(none)"}`);
	writeFileSync(out, Buffer.concat([...chunks, Buffer.from(`${footer.join("\n")}\n`)]));
	return { included, omitted, truncated, empty: false };
}

// Paths recorded next to a diff, as written by captureDiff.
export function readDiffPaths(pathsFile) {
	try {
		return readFileSync(pathsFile, "utf8")
			.split("\0")
			.filter((p) => p !== "");
	} catch {
		return [];
	}
}
