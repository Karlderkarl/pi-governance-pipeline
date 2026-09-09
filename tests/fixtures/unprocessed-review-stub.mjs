// Only security has damaged output. The other two reviewers and the master
// approve, so neither panel size nor another rejection can mask a lost blocker.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const prompt = readFileSync(0, "utf8");
const clean = '{"verdict":"approve","findings":[]}';
if (prompt.startsWith("Implement this issue")) writeFileSync("work.txt", "implementation\n");
else if (prompt.startsWith("You review a diff for one concern only: security")) {
	appendFileSync(".git/security-calls", "call\n");
	console.log(prompt.includes("REMINDER") ? clean : process.env.PROBE_REVIEW);
} else if (prompt.startsWith("You review")) console.log(clean);
else if (prompt.startsWith("Decide this attempt")) console.log('{"decision":"approve"}');
else console.log("notes");
