// INV-01, INV-03, INV-04, INV-09, INV-15, INV-16, INV-17, INV-20,
// INV-21, INV-28: boundary cases beyond the original thirteen reproductions.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runPipeline } from "../../lib/loop/run.mjs";
import { initState, loadState, readAllStates, registerSplit, setIssueStatus } from "../../lib/state/store.mjs";
import { runGate } from "../../lib/review/gate.mjs";
import { captureDiff } from "../../lib/diff/capture.mjs";
import { commitApproved } from "../../lib/loop/commit.mjs";
import { readConfig, validate } from "../../lib/contract/index.mjs";
import { tasksMdSource } from "../../lib/issues/source.mjs";
import { initCommand } from "../../lib/cli/init.mjs";
import { controlPath } from "../../lib/guard/patterns.mjs";
import { spawnCapture } from "../../lib/util/exec.mjs";
import { CONTRACT, checkedGit, createProject } from "../fixtures/project.mjs";

const cli = fileURLToPath(new URL("../../bin/pipeline.mjs", import.meta.url));
const stateCli = fileURLToPath(new URL("../../lib/governance.mjs", import.meta.url));
function setup(body = "") {
	const root = createProject();
	const stub = join(root, ".git", "boundary-stub.mjs");
	writeFileSync(stub, `import {readFileSync,writeFileSync,appendFileSync,existsSync,mkdirSync,rmSync} from 'node:fs';
const p=readFileSync(0,'utf8');
${body}
if(p.startsWith('Implement this issue')) writeFileSync('work.txt','reviewed implementation '+p.match(/^Issue:\\n([^\\n]+)/m)?.[1]+'\\n');
else if(p.startsWith('You review')) console.log('{"verdict":"approve","findings":[]}');
else if(p.startsWith('Decide this attempt')) console.log('{"decision":"approve"}');
else console.log('notes');`);
	return {root, stub};
}
async function run(p, flags = {onlyIssue: "one", maxRuns: 1}, extra = {}) {
	let output = "";
	const stream = {write(s) {output += s;}};
	const rc = await runPipeline({root:p.root, flags, env:{...process.env, PIPELINE_PI_BIN:p.stub, ...extra}, stdout:stream, stderr:stream});
	return {rc, output};
}

test("F02: two CLI processes share one lock, and the reserved count is visible before implementation", async () => {
	const p = setup(`if(p.startsWith('Implement this issue')) {
appendFileSync('.pipeline/actual-calls','x\\n');
writeFileSync('.pipeline/reserved', String(JSON.parse(readFileSync('.pipeline/state/one.json')).runs_used));
await new Promise(r=>setTimeout(r,500));
}`);
	initState(join(p.root,".pipeline"), "one", {budgets:{max_runs_per_tree:1}});
	const execute = () => spawnCapture({file:process.execPath,args:[cli,"run","--issue","one","--max-runs","1"]}, {cwd:p.root, env:{...process.env,PIPELINE_PI_BIN:p.stub}, timeoutMs:30000});
	const results = await Promise.all([execute(),execute()]);
	assert.deepEqual(results.map(r=>r.status).sort(),[0,1]);
	assert.ok(results.some(r=>r.stderr.toString().includes("working tree is locked")));
	assert.equal(readFileSync(join(p.root,".pipeline/actual-calls"),"utf8"),"x\n");
	assert.equal(readFileSync(join(p.root,".pipeline/reserved"),"utf8"),"1");
	assert.equal(loadState(join(p.root,".pipeline"),"one").runs_used,1);
});

test("F01: retry cannot replace configured blocking low evidence with higher-ranked followup evidence", async () => {
	const p=setup(`if(p.startsWith('You review')) {
const retry=p.includes('REMINDER');
console.log(JSON.stringify({verdict:'approve',findings:[{severity:retry?'high':'low',title:'evidence'}]}));
process.exit(retry?0:1);
}`);
	writeFileSync(join(p.root,"AGENTS.md"),CONTRACT.replace('gates: []','review:\n  blocking_severities: [critical, low]\n  followup_severities: [high, medium]\ngates: []'));
	const result=await run(p);
	assert.doesNotMatch(result.output,/approved:/);
	const gate=JSON.parse(readFileSync(join(p.root,".pipeline/work/one/gate.json"),"utf8"));
	assert.equal(gate.reviewers_used,0);
	assert.ok(gate.blocking.some(f=>f.severity==='low'));
});

test("F02/F13: the state CLI refuses a budget mutation while the pipeline owns the tree", async () => {
	const p = setup(`if(p.startsWith('Implement this issue')) {
const {spawnSync}=await import('node:child_process');
const r=spawnSync(process.execPath,[${JSON.stringify(stateCli)},'state','budget','.pipeline','one','--set','999'],{encoding:'utf8'});
writeFileSync('.pipeline/state-cli-result',JSON.stringify({status:r.status,stderr:r.stderr}));
}`);
	assert.equal((await run(p)).rc,0);
	const result=JSON.parse(readFileSync(join(p.root,".pipeline/state-cli-result"),"utf8"));
	assert.equal(result.status,1);
	assert.match(result.stderr,/working tree is locked/);
	assert.equal(loadState(join(p.root,".pipeline"),"one").max_runs_per_tree,25);
});

test("F03: nested splits pause through every ancestor and an explicit grandchild retains the root budget", async () => {
	const p=setup(); const dir=join(p.root,".pipeline");
	writeFileSync(join(p.root,"AGENTS.md"),CONTRACT.replace("gates: []","budgets:\n  max_split_depth: 2\ngates: []"));
	initState(dir,"one",{budgets:{max_runs_per_tree:10}});
	registerSplit(dir,"one","one",["one.1","one.2"]);
	registerSplit(dir,"one","one.1",["one.1.1","one.1.2"]);
	setIssueStatus(dir,"one","one.2","done");
	writeFileSync(join(p.root,"tasks.md"),"- [ ] one: root\n  - [ ] one.1: middle\n    - [ ] one.1.1: leaf A\n    - [ ] one.1.2: leaf B\n  - [x] one.2: done\n");
	const extra={PIPELINE_ALLOW_DEEP_SPLIT:"1"};
	assert.equal((await run(p,{maxRuns:1},extra)).rc,0);
	let state=loadState(dir,"one");
	assert.equal(state.issues.one.status,"split");
	assert.equal(state.issues["one.1"].status,"split");
	assert.equal((await run(p,{onlyIssue:"one.1.2",maxRuns:1},extra)).rc,0);
	assert.equal((await run(p,{},extra)).rc,0);
	state=loadState(dir,"one");
	assert.equal(state.runs_used,2);
	assert.equal(state.issues.one.status,"done");
	assert.equal(existsSync(join(dir,"state/one.1.json")),false);
});

test("F05: a malformed mixed array preserves a critical finding without filling a panel seat", () => {
	const p=setup(); const file=join(p.root,".git/review.json");
	writeFileSync(file,JSON.stringify({verdict:"approve",findings:[null,"bad",{severity:"critical",title:"must remain"}]}));
	const g=runGate({files:[file],minReviewers:1});
	assert.equal(g.exit,4);
	assert.equal(g.result.reviewers_used,0);
	assert.equal(g.result.blocking[0].title,"must remain");
});

test("F04: contributor identities survive invocation boundaries and routing changes", async () => {
	const p=setup(`const model=process.argv[process.argv.indexOf('--model')+1];
if(p.startsWith('Implement this issue')) writeFileSync(model==='anthropic/impl'?'original.txt':'repair.txt',model);
if(p.startsWith('You review') && model==='anthropic/impl') writeFileSync('.pipeline/self-review','bad');
if(p.startsWith('Decide this attempt')) {console.log(JSON.stringify({decision:p.includes('Attempt 1.')?'reject':'approve'}));process.exit(0);}`);
	const contract=CONTRACT.replace('correctness: { provider: anthropic, model: correctness }','correctness: { provider: anthropic, model: impl }')
		.replace('gates: []','budgets:\n  max_attempts_controller: 1\n  max_attempts_master: 1\ngates: []');
	writeFileSync(join(p.root,"AGENTS.md"),contract);
	assert.equal((await run(p)).rc,0);
	assert.deepEqual(loadState(join(p.root,".pipeline"),"one").issues.one.contributors,["anthropic/impl"]);
	writeFileSync(join(p.root,"AGENTS.md"),contract.replace('implement: { provider: anthropic, model: impl }','implement: { provider: anthropic, model: changed }'));
	const resumed=await run(p);
	assert.equal(resumed.rc,0,resumed.output);
	assert.match(resumed.output,/approved: one/);
	assert.equal(existsSync(join(p.root,".pipeline/self-review")),false);
	assert.equal(checkedGit(p.root,["show","HEAD:original.txt"]),"anthropic/impl");
});

test("F06: explicit null maps and empty YAML values refuse instead of disabling defaults", () => {
	const p=setup();
	for(const fragment of ["models: null", "models:\n  constraints: null", "models:\n  review: null", "models:\n  constraints:\n    no_self_review:", "budgets: null", "review: null"]) {
		writeFileSync(join(p.root,"AGENTS.md"),'```yaml pipeline-contract\n'+fragment+'\n```\n');
		const s=readConfig(join(p.root,"AGENTS.md"));
		assert.ok(validate(s.config,s).errors.some(e=>/must be.*null/.test(e)),fragment);
	}
});

test("F08: child creation matches the complete parent ID, and duplicates refuse before edits", async () => {
	const p=setup(); const file=join(p.root,"tasks.md"); const source=tasksMdSource(file,p.root);
	writeFileSync(file,"- [ ] one extra: other\n- [ ] one: parent\n");
	assert.equal(await source.create({parentRaw:"one",title:"child"}),"one.1");
	assert.match(readFileSync(file,"utf8"),/one: parent\n  - \[ \] one\.1: child/);
	const duplicate="- [x] one: old\n- [ ] one: new\n";
	writeFileSync(file,duplicate);
	await assert.rejects(source.markDone("one"),/both become/);
	assert.equal(readFileSync(file,"utf8"),duplicate);
});

test("F09: valid JSON with invalid state schema refuses real runs and status exits nonzero", async () => {
	const p=setup(); mkdirSync(join(p.root,".pipeline/state"),{recursive:true});
	const file=join(p.root,".pipeline/state/one.json");
	for(const value of [null,{}, {root_id:"one",runs_used:-1,max_runs_per_tree:25,depth:0,issues:{one:{}}}]) {
		writeFileSync(file,JSON.stringify(value));
		assert.match(readAllStates(join(p.root,".pipeline")).one.error,/invalid state/);
		assert.equal((await run(p)).rc,1);
	}
	const result=await spawnCapture({file:process.execPath,args:[cli,"status","--json"]},{cwd:p.root});
	assert.equal(result.status,1);
	assert.match(result.stdout.toString(),/error/);
});

test("F10: force applies a harness change and the resulting init is idempotent", async () => {
	const p=setup();
	assert.equal(await initCommand(["--local"],{root:p.root}),0);
	const args=["--local","--harness","anthropic=claude-code"];
	assert.equal(await initCommand([...args,"--force"],{root:p.root}),0);
	assert.equal(await initCommand(args,{root:p.root}),0);
	assert.match(readFileSync(join(p.root,"auto-develop.sh"),"utf8"),/--harness anthropic=claude-code/);
});

test("F11: raising the diff budget permits a complete review on resume", async () => {
	const p=setup(`if(p.startsWith('Implement this issue')) writeFileSync('large.txt','x'.repeat(10000)+'\\nEND_OF_REVIEWED_CONTENT\\n');`);
	const head=checkedGit(p.root,["rev-parse","HEAD"]);
	assert.equal((await run(p,undefined,{DIFF_MAX_BYTES:"128"})).rc,1);
	assert.equal(checkedGit(p.root,["rev-parse","HEAD"]),head);
	assert.equal((await run(p,undefined,{DIFF_MAX_BYTES:"65536"})).rc,0);
	assert.match(readFileSync(join(p.root,".pipeline/work/one/diff.patch"),"utf8"),/END_OF_REVIEWED_CONTENT/);
	assert.match(checkedGit(p.root,["show","HEAD:large.txt"]),/END_OF_REVIEWED_CONTENT/);
	assert.equal(loadState(join(p.root,".pipeline"),"one").runs_used,2);
});

test("F11: binary content is omitted coverage and cannot be approved as a text review", async () => {
	const p=setup("if(p.startsWith('Implement this issue')) writeFileSync('asset.bin',Buffer.from([0,1,2,3]));");
	const r=await run(p);
	assert.equal(r.rc,1);
	assert.match(r.output,/incomplete review diff.*asset.bin/);
	assert.equal(checkedGit(p.root,["rev-list","--count","HEAD"]).trim(),"1");
});

test("F12: approval ignores even pre-existing hooks, including post-commit", () => {
	const p=setup(); const hooks=join(p.root,".test-hooks"); mkdirSync(hooks);
	for(const name of ["pre-commit","post-commit"]) writeFileSync(join(hooks,name),"#!/bin/sh\necho hook > hook-executed.txt\n",{mode:0o755});
	writeFileSync(join(p.root,"work.txt"),"reviewed\n");
	mkdirSync(join(p.root,".pipeline")); const diff=join(p.root,".pipeline/diff.patch");
	captureDiff({root:p.root,out:diff,maxBytes:65536,harnessRel:["tasks.md",".test-hooks"]});
	const r=commitApproved({root:p.root,issueId:"one",issueLine:"one",pathsFile:diff+".paths",issueRel:"tasks.md",stderr:{write(){}}});
	assert.equal(r.committed,true);
	assert.equal(existsSync(join(p.root,"hook-executed.txt")),false);
});

test("F12: custom hooks and linked-worktree Git metadata are restored", async () => {
	const p=setup(); const linked=join(p.root,"linked");
	checkedGit(p.root,["worktree","add","-q","-b","linked-test",linked]);
	writeFileSync(p.stub,`import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const p=readFileSync(0,'utf8');
if(p.startsWith('Implement this issue')) { mkdirSync(${JSON.stringify(join(p.root,".test-hooks"))},{recursive:true});writeFileSync(${JSON.stringify(join(p.root,".test-hooks/pre-commit"))},'hook'); }
else console.log('notes');`);
	const r=await run({...p,root:linked});
	assert.equal(r.rc,1);
	assert.match(r.output,/pipeline control files modified/);
	assert.equal(existsSync(join(p.root,".test-hooks/pre-commit")),false);
});

test("F13: removing the entire .pipeline directory cannot erase the reserved attempt on resume", async () => {
	const p=setup("if(p.startsWith('Implement this issue') && !existsSync('.git/cleaned')) {writeFileSync('.git/cleaned','once');rmSync('.pipeline',{recursive:true,force:true});}");
	const r=await run(p);
	assert.equal(r.rc,1);
	assert.match(r.output,/pipeline control files modified/);
	assert.equal(loadState(join(p.root,".pipeline"),"one").runs_used,1);
	assert.equal((await run(p)).rc,0);
	assert.equal(loadState(join(p.root,".pipeline"),"one").runs_used,2);
});

for(const phase of ["You review", "Decide this attempt", "gate"]) test(`F13: state integrity also covers ${phase}`, async () => {
	const tamper="const s=JSON.parse(readFileSync('.pipeline/state/one.json'));s.runs_used=0;writeFileSync('.pipeline/state/one.json',JSON.stringify(s));";
	const p=setup(phase === "gate" ? "" : `if(p.startsWith(${JSON.stringify(phase)})){${tamper}}`);
	if(phase === "gate") {
		writeFileSync(join(p.root,".git/gate.mjs"),"import {readFileSync,writeFileSync} from 'node:fs';"+tamper);
		writeFileSync(join(p.root,"AGENTS.md"),CONTRACT.replace("gates: []","gates:\n  - name: integrity\n    run: node .git/gate.mjs"));
	}
	const r=await run(p);
	assert.equal(r.rc,1);
	assert.equal(loadState(join(p.root,".pipeline"),"one").runs_used,1);
	assert.doesNotMatch(r.output,/approved:/);
});

test("F12/F13: ordinary write/edit paths to control files are recognized by the guard", () => {
	for(const path of [".git/hooks/pre-commit","C:\\repo\\.git\\config",".git",".pipeline/state/one.json"]) assert.equal(controlPath(path),true,path);
	assert.equal(controlPath("src/git-state.mjs"),false);
});
