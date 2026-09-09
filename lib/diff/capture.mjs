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
import { createHash } from "node:crypto";
import { join } from "node:path";
import { diffPathspecExcludes, isGovernanceTreePath, preservePaths } from "../integrity/governance-paths.mjs";
import { controlPaths } from "../integrity/control.mjs";
import { guardGitOperation } from "../integrity/git-operation.mjs";
import { git, hasHead, isGitWorkTree } from "../util/exec.mjs";
import { sliceUtf8 } from "../util/text.mjs";
import { indexEntries, withIndex } from "./index.mjs";

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
export function captureDiff(options) {
	const { root, harnessRel = [], protectedPaths } = options;
	if (!isGitWorkTree(root)) return captureUnchecked(options);
	const paths = protectedPaths ?? [...preservePaths(root, { extra: harnessRel.map((p) => join(root, p)) }), ...controlPaths(root, join(root, ".pipeline"))];
	return guardGitOperation(root, paths, "diff capture", () => captureUnchecked(options));
}

function captureUnchecked({ root, out, maxBytes, harnessRel = [], binaryReviews = {} }) {
	writeFileSync(out, "");
	writeFileSync(`${out}.paths`, "");
	if (!isGitWorkTree(root)) return { included: [], omitted: [], truncated: [], empty: true };
	const harness = new Set(harnessRel.filter(Boolean));
	const isHarness = (p) => [...harness].some((h) => p === h || p.startsWith(`${h}/`));
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
	if (untracked.status !== 0) throw new Error(`diff capture: git ls-files failed: ${untracked.stderr}`);
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
	if (tracked.status !== 0) throw new Error(`diff capture: git diff failed: ${tracked.stderr}`);
	for (const f of nulList(tracked.stdout)) {
		if (isGovernanceTreePath(f) || isHarness(f)) continue;
		push(f, "tracked");
	}
	// Every reviewed path, NUL-terminated (not just separated: a `read -d ''`
	// style consumer drops an unterminated last record): the approve step
	// commits exactly this set, so what was reviewed is what lands in the commit.
	writeFileSync(`${out}.paths`, rows.map((r) => `${r.path}\0`).join(""));
	const baseHead = head ? git(root, ["rev-parse", "HEAD"]).stdout.toString().trim() : null;
	const normalized = new Map();
	const reviewed = withIndex(root, ({ command }) => {
		command(baseHead ? ["read-tree", baseHead] : ["read-tree", "--empty"]);
		if (rows.length) command(["add", "-A", "--", ...rows.map((r) => `:(literal)${r.path}`)]);
		const entries = new Map(indexEntries(command(["ls-files", "--stage", "-z"])).map((e) => [e.path, e]));
		const selected = rows.map((row) => {
			const e = entries.get(row.path) ?? { path: row.path, mode: "0", oid: "0".repeat(baseHead?.length ?? 40) };
			const body = ["0", "160000"].includes(e.mode) ? Buffer.alloc(0) : command(["cat-file", "blob", e.oid]);
			const patch = command(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--submodule=short", ...(baseHead ? [baseHead] : []), "--", `:(literal)${row.path}`]);
			if (body.subarray(0,8000).includes(0) || /^Binary files .* differ$/m.test(patch.toString())) row.kind = "binary";
			if (e.mode === "160000" || /^[-+]Subproject commit /m.test(patch.toString())) row.kind = "submodule";
			normalized.set(row.path, { body, patch });
			return e;
		});
		return { baseHead, entries: selected };
	});
	writeFileSync(`${out}.entries.json`, JSON.stringify(reviewed));
	const binary = {};
	const submodules = rows.filter((r) => r.kind === "submodule").map((r) => r.path);

	const load = (row) => {
		const { body, patch } = normalized.get(row.path);
		if (row.kind === "submodule") return Buffer.alloc(0);
		if (row.kind === "binary") {
			const sha = createHash("sha256").update(body).digest("hex");
			binary[row.path] = sha;
			if (binaryReviews[row.path] === sha) {
				row.kind = "binary-approved";
				return Buffer.from(`\n--- binary content manually reviewed: ${row.path}; bytes=${body.length}; sha256=${sha} ---\n${patch.toString()}`);
			}
			return Buffer.alloc(0);
		}
		if (row.kind === "untracked") {
			return Buffer.concat([Buffer.from(`\n--- new file (untracked): ${row.path} ---\n`), body]);
		}
		// The path is verbatim, so a name holding * or [ would be read as a
		// wildcard and one starting with : as pathspec magic. :(literal) pins it.
		return patch;
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
		if (row.kind === "binary") {
			omitted.push(row.path);
			continue;
		}
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
			// Cut on a character boundary: the reviewers read this as text, and
			// half a UTF-8 sequence reaches them as U+FFFD.
			const head = sliceUtf8(buf, room);
			chunks.push(head);
			chunks.push(Buffer.from(`\n[file truncated at ${head.length} bytes: ${row.path}]\n`));
			used += room;
			included.push(row.path);
			truncated.push(row.path);
		}
	}
	writeFileSync(`${out}.binary.json`, JSON.stringify({ version: 1, approved: false, files: binary }, null, 2) + "\n");
	// A manifest with no diff bytes behind it is not a diff. The empty-diff
	// guard tests the file size, and a lone footer would satisfy it — the
	// three reviewers would then rubber-stamp "nothing changed".
	if (n === 0 || chunks.length === 0) {
		writeFileSync(out, "");
		return { included, omitted, truncated, binary, submodules, reviewed, empty: true };
	}
	const footer = ["\n[review diff manifest]", `included: ${included.length ? included.join(", ") : "(none)"}`];
	if (truncated.length) footer.push(`truncated: ${truncated.join(", ")}`);
	footer.push(`omitted: ${omitted.length ? omitted.join(", ") : "(none)"}`);
	writeFileSync(out, Buffer.concat([...chunks, Buffer.from(`${footer.join("\n")}\n`)]));
	return { included, omitted, truncated, binary, submodules, reviewed, empty: false };
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
