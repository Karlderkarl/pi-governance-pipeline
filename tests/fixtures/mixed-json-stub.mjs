// A harness stub whose roles state their verdict as free-standing JSON and
// then repeat it inside a code fence — the shape that used to erase the free
// one entirely, because the only candidate that could hold it was the whole
// text, cut from the first `{` to the last `}` across both objects.
//
// A real file rather than a string inside the test: a mis-escaped inline stub
// crashes, the run ends on an empty diff, and every "nothing was approved"
// assertion then passes for the wrong reason.
import { readFileSync, writeFileSync } from "node:fs";

const prompt = readFileSync(0, "utf8");
const fence = (object) => "```json\n" + object + "\n```";
const critical = '{"role":"r","verdict":"reject","findings":[{"severity":"critical","file":"work.txt","title":"hardcoded secret"}]}';

if (prompt.startsWith("Implement this issue")) writeFileSync("work.txt", "API_KEY=hunter2\n");
else if (prompt.startsWith("You review")) console.log(`${critical}\n\n${fence('{"role":"r","verdict":"approve","findings":[]}')}`);
else if (prompt.startsWith("Decide this attempt")) console.log(`{"decision":"reject","reasons":["critical"]}\n\n${fence('{"decision":"approve"}')}`);
else console.log("notes");
