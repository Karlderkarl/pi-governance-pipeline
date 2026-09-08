// snapshot.mjs — governance integrity around a tool-bearing role.
//
// The interactive guard matches command strings; `eval`, `bash -c` and a
// script that writes a file walk past it. The property the pipeline needs is
// simpler and checkable: governance is byte-identical after a role that had
// tools. So: snapshot before, compare after, restore from the snapshot (not
// from HEAD — an untracked AGENTS.override.md or .pi/ has no HEAD to restore
// from), and count the attempt as rejected with the paths named.
//
// Files are compared by hash. Content is kept for the restore: in memory up
// to `keepBytes` per file, on disk under `spillDir` above that, so a large
// package checkout under .pi/ costs I/O, not heap. The "after" snapshot is
// hash-only.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, rmdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const SKIP_DIRS = new Set([".pipeline", "node_modules", ".git"]);
export const DEFAULT_KEEP_BYTES = 1024 * 1024;

function walk(abs, into, opts) {
	let st;
	try {
		st = lstatSync(abs);
	} catch {
		return;
	}
	if (st.isSymbolicLink()) {
		const target = readlinkSync(abs);
		let linkType = "file";
		try { if (statSync(abs).isDirectory()) linkType = process.platform === "win32" ? "junction" : "dir"; } catch {}
		into.set(abs, { type: "link", target, linkType, hash: `link:${target}`, size: 0, content: null, spill: null });
		return;
	}
	if (st.isDirectory()) {
		abs = realpathSync.native(abs);
		into.set(abs, { type: "dir", hash: "directory", size: 0, content: null, spill: null });
		for (const name of readdirSync(abs)) {
			if (SKIP_DIRS.has(name)) continue;
			walk(join(abs, name), into, opts);
		}
		return;
	}
	if (!st.isFile()) return;
	// Key by the on-disk path: on a case-insensitive filesystem AGENTS.md and
	// AGENTS.MD are one file and must not count twice.
	const key = realpathSync.native(abs);
	if (into.has(key)) return;
	const buf = readFileSync(abs);
	const entry = { type: "file", hash: createHash("sha256").update(buf).digest("hex"), size: buf.length, content: null, spill: null };
	if (!opts.hashOnly) {
		if (buf.length <= opts.keepBytes) entry.content = buf;
		else if (opts.spillDir) {
			mkdirSync(opts.spillDir, { recursive: true });
			entry.spill = join(opts.spillDir, `${opts.counter.n++}`);
			copyFileSync(abs, entry.spill);
		}
	}
	into.set(key, entry);
}

// Map absolute path -> { hash, size, content, spill } for every file that
// exists under `paths`.
export function takeSnapshot(paths, { spillDir = null, keepBytes = DEFAULT_KEEP_BYTES, hashOnly = false } = {}) {
	if (spillDir && !hashOnly) rmSync(spillDir, { recursive: true, force: true });
	const snap = new Map();
	const opts = { spillDir, keepBytes, hashOnly, counter: { n: 0 } };
	// Resolve only the parent of each explicit root (workspace aliases), never
	// links discovered inside a protected tree. Links are objects, not contents.
	snap.roots = paths.map((p) => {
		try { return join(realpathSync.native(dirname(resolve(p))), basename(p)); }
		catch { return resolve(p); }
	});
	for (const p of snap.roots) walk(p, snap, opts);
	return snap;
}

export function compareSnapshots(before, after) {
	const changed = [];
	const added = [];
	const removed = [];
	for (const [p, e] of before) {
		const a = after.get(p);
		if (!a) removed.push(p);
		else if (a.hash !== e.hash || a.size !== e.size) changed.push(p);
	}
	for (const p of after.keys()) if (!before.has(p)) added.push(p);
	return { changed, added, removed, clean: changed.length + added.length + removed.length === 0 };
}

// Put `before` back: rewrite changed and removed files, delete added ones.
// Returns the paths whose content the snapshot did not keep (hash-only).
export function restoreSnapshot(before, diff) {
	const unrestored = [];
	const remove = (p) => {
		const st = lstatSync(p);
		if (st.isDirectory() && !st.isSymbolicLink()) rmdirSync(p); // empty only
		else rmSync(p, { force: true });
	};
	// Remove new paths and changed objects before recreating any originals.
	// Deepest first; no recursive deletion and no following links to targets.
	for (const p of [...diff.added, ...diff.changed].sort((a, b) => b.length - a.length)) {
		try {
			remove(p);
		} catch (error) { if (error.code !== "ENOENT") unrestored.push(p); }
	}
	for (const p of [...diff.changed, ...diff.removed].sort((a, b) => a.length - b.length)) {
		const e = before.get(p);
		try {
			// A parent replaced by a link must never redirect a restore write.
			for (let parent = dirname(p); parent !== dirname(parent); parent = dirname(parent)) {
				if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error("linked restore parent");
			}
			mkdirSync(dirname(p), { recursive: true });
			if (e.type === "dir") mkdirSync(p, { recursive: true });
			else if (e.type === "link") symlinkSync(e.target, p, e.linkType);
			else if (e.content) writeFileSync(p, e.content);
			else if (e.spill && existsSync(e.spill)) copyFileSync(e.spill, p);
			else unrestored.push(p);
		} catch { unrestored.push(p); }
	}
	if (before.roots) {
		const remaining = compareSnapshots(before, takeSnapshot(before.roots, { hashOnly: true }));
		unrestored.push(...remaining.changed, ...remaining.added, ...remaining.removed);
	}
	return [...new Set(unrestored)];
}

export function describeDiff(root, diff) {
	// Snapshot keys use realpath; use the same base for junctions, symlinks
	// and Windows short-path aliases (notably the hosted runner's TEMP).
	let base = root;
	try {
		base = realpathSync.native(root);
	} catch {}
	const rel = (p) => relative(base, p).replace(/\\/g, "/");
	const parts = [];
	if (diff.changed.length) parts.push(`modified: ${diff.changed.map(rel).join(", ")}`);
	if (diff.added.length) parts.push(`created: ${diff.added.map(rel).join(", ")}`);
	if (diff.removed.length) parts.push(`deleted: ${diff.removed.map(rel).join(", ")}`);
	return parts.join("; ");
}
