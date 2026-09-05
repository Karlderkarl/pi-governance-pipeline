// prune.mjs — prompt archive retention. A single issue otherwise archives
// every full diff in plaintext with no bound. Keep the newest N run ids.

import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";

const RUN_SUFFIX = /-(\d{8}T\d{6})\.txt$/;

export function prunePrompts(promptsDir, keep) {
	if (!existsSync(promptsDir)) return 0;
	const files = [];
	const walk = (d) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			if (statSync(p).isDirectory()) walk(p);
			else files.push(p);
		}
	};
	walk(promptsDir);
	const ids = new Set();
	for (const p of files) {
		const m = basename(p).match(RUN_SUFFIX);
		if (m) ids.add(m[1]);
	}
	const sorted = [...ids].sort();
	const drop = new Set(sorted.slice(0, Math.max(0, sorted.length - keep)));
	let n = 0;
	for (const p of files) {
		const m = basename(p).match(RUN_SUFFIX);
		if (m && drop.has(m[1])) {
			unlinkSync(p);
			n++;
		}
	}
	return n;
}
