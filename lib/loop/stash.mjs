// stash.mjs — take_over discards the rejected implementation, not the
// governance that routes the run, not the issue list, and not the harness
// itself. `git stash -u` cannot tell them apart, and an unmodified setup can
// have all of them untracked. The preserved set is copied out beforehand and
// written back afterwards; a refused stash is reported, never swallowed.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, gitText } from "../util/exec.mjs";

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

export function stashRejectedTree({ root, workDir, preserve, message, stderr }) {
	pinPipelineExclude(root);
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
	let n = 0;
	for (const p of preserve) {
		if (!existsSync(p)) continue;
		n++;
		kept.push({ path: p, copy: join(bak, String(n)), dir: statSync(p).isDirectory() });
		cpSync(p, join(bak, String(n)), { recursive: true });
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
