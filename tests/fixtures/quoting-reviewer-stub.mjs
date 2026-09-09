// A harness stub whose reviewers quote a JSON line out of the diff to explain
// themselves and then answer cleanly. The quoted `"severity"` sits in no
// parseable object, so the attempt carries the unprocessed-review marker and
// cannot be approved — correctly, because an unread key may be the critical
// nobody saw.
//
// It is a reviewer format problem, though, and the implementer cannot fix it:
// left alone the loop would spend every attempt of the tree on it. This stub
// drives the streak that ends the issue after two.
import { readFileSync, writeFileSync } from "node:fs";

const prompt = readFileSync(0, "utf8");

if (prompt.startsWith("Implement this issue")) writeFileSync("work.txt", `attempt ${Date.now()}\n`);
else if (prompt.startsWith("You review")) {
	// Only one reviewer quotes. With all three the panel falls below its floor
	// and the existing MIN_REVIEWERS streak ends the issue first; the case this
	// stub is for is the one where the panel still holds and only the marker
	// blocks, attempt after attempt.
	if (prompt.includes("one concern only: security")) {
		console.log('The config hard-codes "severity": "critical" for every request, which is fine here.');
	}
	console.log('{"role":"r","verdict":"approve","findings":[]}');
} else if (prompt.startsWith("Decide this attempt")) console.log('{"decision":"approve"}');
else console.log("notes");
