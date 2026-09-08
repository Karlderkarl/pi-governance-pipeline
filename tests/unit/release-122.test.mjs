// INV-04, INV-15, INV-17, INV-18, INV-19, INV-20: F14–F18 and G01/G02.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runPipeline } from "../../lib/loop/run.mjs";
import { captureDiff } from "../../lib/diff/capture.mjs";
import { commitApproved } from "../../lib/loop/commit.mjs";
import { runGate } from "../../lib/review/gate.mjs";
import { takeSnapshot, compareSnapshots, restoreSnapshot } from "../../lib/integrity/snapshot.mjs";
import { acquireRunLock } from "../../lib/state/lock.mjs";
import { initState, loadState, registerSplit, setIssueStatus } from "../../lib/state/store.mjs";
import { runDoctor } from "../../lib/cli/doctor.mjs";
import { spawnCapture } from "../../lib/util/exec.mjs";
import { CONTRACT, checkedGit, createProject } from "../fixtures/project.mjs";
import { readConfig, validate } from "../../lib/contract/index.mjs";

function project(body = "") {
	const root = createProject();
	const stub = join(root, ".git/122-stub.mjs");
	writeFileSync(stub, `import {readFileSync,writeFileSync,symlinkSync} from 'node:fs';
const p=readFileSync(0,'utf8');
${body}
if(p.startsWith('Implement this issue')) writeFileSync('work.txt','ordinary implementation\\n');
else if(p.startsWith('You review')) console.log('{"verdict":"approve","findings":[]}');
else if(p.startsWith('Decide this attempt')) console.log('{"decision":"approve"}');
else console.log('notes');`);
	return { root, stub };
}
async function run(p, env = {}) {
	let output = "";
	const stream = { write(s) { output += s; } };
	const rc = await runPipeline({root:p.root,flags:{onlyIssue:"one",maxRuns:1},env:{...process.env,PIPELINE_PI_BIN:p.stub,...env},stdout:stream,stderr:stream});
	return {rc,output};
}
const fence = (o) => "```json\n" + JSON.stringify(o) + "\n```";

test("F14: a malformed candidate cannot erase critical evidence and approve a full run", async () => {
	const response = fence({verdict:"reject",findings:[{severity:"critical",file:"work.txt",title:"REAL_CRITICAL"}]}) + "\n" + fence({verdict:"approve",findings:[null]});
	const p = project(`if(p.startsWith('You review a diff for one concern only: security')) {console.log(${JSON.stringify(response)});process.exit(0);}`);
	const r = await run(p);
	assert.doesNotMatch(r.output, /approved: one/);
	const gate = JSON.parse(readFileSync(join(p.root,".pipeline/work/one/gate.json"),"utf8"));
	assert.equal(gate.verdict,"blocked");
	assert.equal(gate.blocking[0].title,"REAL_CRITICAL");
	assert.equal(checkedGit(p.root,["rev-list","--count","HEAD"]).trim(),"1");
});

test("F15: custom blocking membership survives candidate selection and cross-reviewer dedup", () => {
	const p = project();
	writeFileSync(join(p.root,"AGENTS.md"),CONTRACT.replace("gates: []","review:\n  blocking_severities: [critical, medium]\n  followup_severities: [high, low]\ngates: []"));
	const s = readConfig(join(p.root,"AGENTS.md"));
	assert.deepEqual(validate(s.config,s).errors,[]);
	const review = (severity) => ({verdict:"approve",findings:[{file:"a",line:1,title:"same",severity}]});
	const a = join(p.root,".git/a.json"), b = join(p.root,".git/b.json");
	const opts = {files:[a,b],blocking:["critical","medium"],followup:["high","low"],minReviewers:2};
	for (const reversed of [false,true]) {
		writeFileSync(a,JSON.stringify(review(reversed ? "high" : "medium")));
		writeFileSync(b,JSON.stringify(review(reversed ? "medium" : "high")));
		assert.equal(runGate(opts).result.blocking[0].severity,"medium");
		writeFileSync(a,[review(reversed ? "high" : "medium"),review(reversed ? "medium" : "high")].map(fence).join("\n"));
		writeFileSync(b,JSON.stringify({verdict:"approve",findings:[]}));
		assert.equal(runGate(opts).exit,4);
	}
});

test("F16: pipeline rollback removes a new junction without deleting its pre-existing target", async () => {
	const p = project(`if(p.startsWith('Implement this issue')) symlinkSync(process.cwd()+'/operator-data',process.cwd()+'/.pi/linked-data',process.platform==='win32'?'junction':'dir');`);
	mkdirSync(join(p.root,".pi")); mkdirSync(join(p.root,"operator-data"));
	const file = join(p.root,"operator-data/keep.txt");
	writeFileSync(file,"existing data");
	checkedGit(p.root,["add","operator-data"]); checkedGit(p.root,["commit","-qm","existing data"]);
	const r = await run(p);
	assert.match(r.output,/governance modified by implement/);
	assert.equal(readFileSync(file,"utf8"),"existing data");
	assert.equal(existsSync(join(p.root,".pi/linked-data")),false);
});

test("F16: replacing a protected directory with a junction restores files without writing into its target", () => {
	const root = createProject();
	const dir = join(root,".pi"); mkdirSync(dir);
	writeFileSync(join(dir,"kept"),"original");
	const before = takeSnapshot([dir]);
	// Rename preserves the original directory for inspection; all paths are fixtures.
	const target = join(root,"target"); mkdirSync(target);
	writeFileSync(join(target,"kept"),"external");
	return import("node:fs").then(({renameSync}) => {
		renameSync(dir,join(root,"old-pi"));
		symlinkSync(target,dir,process.platform === "win32" ? "junction" : "dir");
		assert.deepEqual(restoreSnapshot(before,compareSnapshots(before,takeSnapshot([dir]))),[]);
		assert.equal(readFileSync(join(dir,"kept"),"utf8"),"original");
		assert.equal(readFileSync(join(target,"kept"),"utf8"),"external");
	});
});

test("F17: approval commits the exact normalized reviewed blob even if the filter or worktree changes later", () => {
	const p = project();
	writeFileSync(join(p.root,".git/filter.mjs"),"import{readFileSync}from'node:fs';process.stdout.write(readFileSync(0,'utf8')+'REVIEWED_FILTER_CONTENT\\n');");
	checkedGit(p.root,["config","filter.probe.clean","node .git/filter.mjs"]);
	writeFileSync(join(p.root,".gitattributes"),"work.txt filter=probe\n");
	checkedGit(p.root,["add",".gitattributes"]);checkedGit(p.root,["commit","-qm","filter config"]);
	writeFileSync(join(p.root,"work.txt"),"ordinary implementation\n");
	const out = join(p.root,".git/review.patch");
	const coverage = captureDiff({root:p.root,out,maxBytes:65536,harnessRel:["tasks.md"]});
	assert.match(readFileSync(out,"utf8"),/REVIEWED_FILTER_CONTENT/);
	writeFileSync(join(p.root,"work.txt"),"UNREVIEWED_WORKTREE_CHANGE\n");
	writeFileSync(join(p.root,".git/filter.mjs"),"process.stdout.write('UNREVIEWED_FILTER_CHANGE');");
	const r = commitApproved({root:p.root,issueId:"one",issueLine:"one",pathsFile:out+".paths",reviewed:coverage.reviewed,stderr:{write(){}}});
	assert.equal(r.committed,true,r.reason);
	assert.equal(checkedGit(p.root,["show","HEAD:work.txt"]),"ordinary implementation\nREVIEWED_FILTER_CONTENT\n");
	assert.equal(readFileSync(join(p.root,"work.txt"),"utf8"),"UNREVIEWED_WORKTREE_CHANGE\n");
});

test("F18: a second process with different TEMP and TMPDIR cannot own the same working tree", async () => {
	const p = project();
	const helper = join(p.root,".git/lock-child.mjs");
	writeFileSync(helper,`import {acquireRunLock} from ${JSON.stringify(new URL('../../lib/state/lock.mjs',import.meta.url).href)}; const release=acquireRunLock(${JSON.stringify(p.root)});release();`);
	const release = acquireRunLock(p.root);
	try {
		const temp = mkdtempSync(join(tmpdir(),"different-temp-"));
		const result = await spawnCapture({file:process.execPath,args:[helper]},{env:{...process.env,TEMP:temp,TMPDIR:temp}});
		assert.notEqual(result.status,0);
		assert.match(result.stderr.toString(),/working tree is locked/);
	} finally { release(); }
});

test("G01/G02: binary pause spends no budget on unchanged restarts and resumes with a hash-bound human receipt", async () => {
	const p = project("if(p.startsWith('Implement this issue')) writeFileSync('asset.bin',Buffer.from([0,1,2,3]));");
	for (let n=0;n<3;n++) {
		const r = await run(p);
		assert.equal(r.rc,1);
		assert.match(r.output,/Binary content needs human review/);
		const state = loadState(join(p.root,".pipeline"),"one");
		assert.equal(state.runs_used,1);
		assert.equal(state.issues.one.status,"paused");
	}
	assert.match(readFileSync(join(p.root,"MEMORY.md"),"utf8"),/Review pause/);
	const receipt = JSON.parse(readFileSync(join(p.root,".pipeline/work/one/diff.patch.binary.json"),"utf8"));
	const receiptFile = join(mkdtempSync(join(tmpdir(),"human-review-")),"approved.json");
	receipt.approved = true;
	writeFileSync(receiptFile,JSON.stringify({...receipt,files:{"asset.bin":"0".repeat(64)}}));
	assert.equal((await run(p,{BINARY_REVIEW_FILE:receiptFile})).rc,1);
	assert.equal(loadState(join(p.root,".pipeline"),"one").runs_used,1);
	writeFileSync(receiptFile,JSON.stringify(receipt));
	const r = await run(p,{BINARY_REVIEW_FILE:receiptFile});
	assert.equal(r.rc,0,r.output);
	assert.match(r.output,/approved: one/);
	assert.deepEqual(Buffer.from(checkedGit(p.root,["show","HEAD:asset.bin"])),Buffer.from([0,1,2,3]));
});

test("G02: oversized text pauses before another model start, then resumes with increased capacity", async () => {
	const p = project("if(p.startsWith('Implement this issue')) writeFileSync('large.txt','x'.repeat(20000));");
	for (let n=0;n<3;n++) assert.equal((await run(p,{DIFF_MAX_BYTES:"128"})).rc,1);
	assert.equal(loadState(join(p.root,".pipeline"),"one").runs_used,1);
	assert.equal((await run(p)).rc,0);
	assert.equal(loadState(join(p.root,".pipeline"),"one").runs_used,2);
});

test("control integrity covers command issue-source reads when resuming a split", async () => {
	const p = project();
	writeFileSync(join(p.root,".git/source.mjs"),`import {existsSync,readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const f='.git/source-count';const n=existsSync(f)?Number(readFileSync(f,'utf8')):0;writeFileSync(f,String(n+1));
if(n>0)appendFileSync('.git/config','\\n[probe]\\n  changed = true\\n');
console.log('one: parent');`);
	writeFileSync(join(p.root,"AGENTS.md"),CONTRACT.replace("source: tasks.md","source:\n    command: node .git/source.mjs\n    trust: internal"));
	const dir=join(p.root,".pipeline");
	initState(dir,"one",{budgets:{max_runs_per_tree:10}});
	registerSplit(dir,"one","one",["one.1","one.2"]);
	setIssueStatus(dir,"one","one.1","done");setIssueStatus(dir,"one","one.2","done");
	const before=readFileSync(join(p.root,".git/config"),"utf8");
	const r=await run(p);
	assert.equal(r.rc,1);
	assert.match(r.output,/control files modified during split issue source/);
	assert.equal(readFileSync(join(p.root,".git/config"),"utf8"),before);
	assert.equal(loadState(dir,"one").runs_used,0);
});

test("doctor reports an existing per-worktree run lock and its recovery location", () => {
	const p=project();
	const release=acquireRunLock(p.root);
	try {
		const result=runDoctor({root:p.root});
		assert.ok(result.lines.some((s)=>/FAIL working tree lock exists:.*pipeline-run.lock/.test(s)));
	} finally {release();}
});
