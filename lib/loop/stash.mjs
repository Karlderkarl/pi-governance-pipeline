// stash.mjs — take_over discards the rejected implementation, not the
// governance that routes the run, not the issue list, and not the harness
// itself. `git stash -u` cannot tell them apart, and an unmodified setup can
// have all of them untracked. The preserved set is copied out beforehand and
// written back afterwards; a refused stash is reported, never swallowed.

import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, gitText } from "../util/exec.mjs";
import { preservePaths } from "../integrity/governance-paths.mjs";
import { controlPaths } from "../integrity/control.mjs";
import { guardGitOperation } from "../integrity/git-operation.mjs";

function pinPipelineExclude(root) {
	// stash -u skips ignored files. Pin .pipeline in info/exclude so the
	// harness state survives even when the project has not gitignored it.
	// (Passing ':!.pipeline' as a pathspec makes git exit 1 after saving.)
	const gitdir = gitText(root, ["rev-parse", "--git-dir"]);
	if (!gitdir) return;
	const abs = gitdir.startsWith("/") || /^[A-Za-z]:/.test(gitdir) ? gitdir : join(root, gitdir);
	const excl = join(abs, "info", "exclude");
	mkdirSync(dirname(excl), { recursive: true });
	const current = existsSync(excl) ? readFileSync(excl, "utf8") : "";
	if (!current.split(/\r?\n/).includes(".pipeline/")) writeFileSync(excl, `${current}${current.endsWith("\n") || current === "" ? "" : "\n"}.pipeline/\n`);
}

export function stashRejectedTree({ root, workDir, preserve, message, stderr, protectedPaths }) {
	pinPipelineExclude(root);
	// `git stash push -u` runs the project's clean filters, and the checkout
	// that restores the tree runs its smudge filters — project code, executed
	// with the operator's rights, exactly as during diff capture and approval.
	// Those two are wrapped; this one was not, which left one filter-running
	// Git operation able to rewrite `.pipeline/state`, `.git/config` or HEAD
	// unobserved (a smudge filter resetting runs_used undoes the budget).
	// The guard spans the copy-out and the write-back too, so the governance
	// this function legitimately removes and restores is byte-identical again
	// by the time the check runs.
	const guarded = protectedPaths ?? [...preservePaths(root), ...controlPaths(root, join(root, ".pipeline"))];
	return guardGitOperation(root, guarded, "stash", () => stashUnchecked({ root, workDir, preserve, message, stderr }));
}

function stashUnchecked({ root, workDir, preserve, message, stderr }) {
	// Copy the preserved set out and write it back: a later block_issue then
	// still appends to the existing MEMORY.md history, the reviewers after
	// this point still get SOUL.md, routing keeps reading a real AGENTS.md,
	// and a rerun still finds the issue source and the wrapper. workDir lives
	// under .pipeline, which info/exclude already pins. Restore merges into
	// directories instead of replacing them — no rm on a caller-supplied path.
	const bak = join(workDir, "pre-stash");
	rmSync(bak, { recursive: true, force: true });
	mkdirSync(bak, { recursive: true });
	const kept = [];
	const seen = new Set();
	let n = 0;
	for (const p of preserve) {
		if (!existsSync(p)) continue;
		// The preserved set carries both spellings of the context files pi
		// accepts (AGENTS.md and AGENTS.MD, CLAUDE.md and CLAUDE.MD). On a
		// case-insensitive filesystem those are one file: copying it twice and
		// writing both names back renamed it on disk, which the integrity
		// guard then reports as one path created and another deleted. Restore
		// the name the filesystem actually holds, once.
		let path;
		try { path = realpathSync.native(p); } catch { path = p; }
		if (seen.has(path)) continue;
		seen.add(path);
		n++;
		kept.push({ path, copy: join(bak, String(n)), dir: statSync(path).isDirectory() });
		cpSync(path, join(bak, String(n)), { recursive: true });
	}
	const r = git(root, ["stash", "push", "-u", "-m", message]);
	writeFileSync(join(workDir, "stash.log"), Buffer.concat([r.stdout, r.stderr]));
	let stashed = false;
	if (r.status === 0) {
		stderr.write(`stashed working tree as ${message}\n`);
		stashed = true;
	} else {
		// A refused stash is not silence: implement_master would otherwise
		// inherit exactly the tree the master just rejected.
		const first = Buffer.concat([r.stdout, r.stderr]).toString("utf8").split(/\r?\n/)[0];
		stderr.write(`warning: git stash failed (${first}); implement_master starts from the rejected tree\n`);
	}
	for (const k of kept) {
		mkdirSync(dirname(k.path), { recursive: true });
		if (k.dir) {
			mkdirSync(k.path, { recursive: true });
			cpSync(k.copy, k.path, { recursive: true });
		} else {
			cpSync(k.copy, k.path);
		}
	}
	return stashed;
}
