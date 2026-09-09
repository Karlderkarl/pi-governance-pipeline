// A harness stub whose roles bury the decisive JSON behind prose that carries
// an unmatched `{` and an unmatched `"`, then repeat a harmless verdict in a
// code fence. Both are what a model writes when it explains itself before
// answering, and both used to erase the free-standing object: a scanner that
// carried brace and quote state through the prose never reached it.
//
// PROBE_TARGET picks which path is under test, so a pass on one cannot cover
// a regression on the other:
//   reviewer — the reviewers hide a `critical`, the master approves plainly
//   master   — the reviewers approve plainly, the master hides its `reject`
import { readFileSync, writeFileSync } from "node:fs";

const prompt = readFileSync(0, "utf8");
const target = process.env.PROBE_TARGET;
const fence = (object) => "```json\n" + object + "\n```";
// Unmatched `{` from a code quote, and an unmatched `"` from an aside.
const prose = 'The diff adds if (authorized) { with no else, and the comment reads "check this before shipping\n';
const critical = '{"role":"r","verdict":"reject","findings":[{"severity":"critical","file":"work.txt","title":"hardcoded secret"}]}';
const buried = (object, harmless) => `${prose}${object}\n\n${fence(harmless)}`;

if (prompt.startsWith("Implement this issue")) writeFileSync("work.txt", "API_KEY=hunter2\n");
else if (prompt.startsWith("You review")) {
	console.log(target === "reviewer" ? buried(critical, '{"role":"r","verdict":"approve","findings":[]}') : '{"role":"r","verdict":"approve","findings":[]}');
} else if (prompt.startsWith("Decide this attempt")) {
	console.log(target === "master" ? buried('{"decision":"reject","reasons":["critical"]}', '{"decision":"approve"}') : '{"decision":"approve"}');
} else console.log("notes");
