// Diagnostic reproductions for the full review. No real model or remote calls.
// Run: node docs/review-2026-09-08.repro.mjs [case-name]
// All project mutations occur in temporary repositories created by the fixture.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT, checkedGit, createProject } from '../tests/fixtures/project.mjs';
import { readConfig, validate } from '../lib/contract/index.mjs';
import { runPipeline } from '../lib/loop/run.mjs';
import { initState, registerSplit, setIssueStatus, loadState } from '../lib/state/store.mjs';
import { tasksMdSource } from '../lib/issues/source.mjs';
import { runDoctor } from '../lib/cli/doctor.mjs';
import { statusText } from '../lib/cli/status.mjs';
import { initCommand } from '../lib/cli/init.mjs';
import { runGate } from '../lib/review/gate.mjs';

export const cases = {};
function project(mode = 'healthy') {
  const root = createProject();
  const stub = join(root, '.git', 'review-stub.mjs');
  writeFileSync(stub, `
import {readFileSync,writeFileSync,appendFileSync,readdirSync} from 'node:fs';
const p=readFileSync(0,'utf8'); const mode=${JSON.stringify(mode)};
if(p.startsWith('Implement this issue')) {
  appendFileSync('.pipeline/implement-calls', p.match(/^Issue:\\n([^\\n]+)/m)?.[1]+'\\n');
  if(mode==='concurrent') {
    writeFileSync('.pipeline/arrival-'+process.pid,'ready');
    const deadline=Date.now()+5000;
    while(readdirSync('.pipeline').filter(n=>n.startsWith('arrival-')).length<2 && Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
  }
  appendFileSync('work.txt','implementation '+process.pid+'\\n');
} else if(p.startsWith('You review')) {
  if(mode==='failed-followup') {console.log(JSON.stringify({verdict:'approve',findings:[{severity:'high',file:'work.txt',title:'Followup per contract'}]}));process.exitCode=1;}
  else console.log(JSON.stringify({verdict:'approve',findings:[]}));
} else if(p.startsWith('Decide this attempt')) console.log(JSON.stringify({decision:mode==='concurrent'?'reject':'approve'}));
else console.log('notes');
`);
  return {root, stub};
}
async function run(p, flags = {}, extra = {}) {
  let output = '';
  const stream = {write(text) {output += text;}};
  const rc = await runPipeline({root:p.root, flags, env:{...process.env, PIPELINE_PI_BIN:p.stub, ...extra}, stdout:stream, stderr:stream});
  return {rc,output};
}

cases['failed-reviewers'] = async () => {
  const p=project('failed-followup');
  writeFileSync(join(p.root,'AGENTS.md'), CONTRACT.replace('gates: []','review:\n  blocking_severities: [critical, medium]\n  followup_severities: [high, low]\ngates: []'));
  const r=await run(p,{onlyIssue:'one',maxRuns:1});
  const gate=JSON.parse(readFileSync(join(p.root,'.pipeline/work/one/gate.json'),'utf8'));
  return {rc:r.rc, approved:r.output.includes('approved: one'), reviewersUsed:gate.reviewers_used, blocking:gate.blocking, verdict:gate.verdict};
};

cases['null-constraint'] = async () => {
  const p=project();
  writeFileSync(join(p.root,'AGENTS.md'),CONTRACT.replace('no_self_review: true','no_self_review: null'));
  const s=readConfig(join(p.root,'AGENTS.md'));
  return {errors:validate(s.config,s).errors, runtimeEnabled:s.config.models.constraints.no_self_review===true};
};

cases['concurrent-budget'] = async () => {
  const p=project('concurrent');
  const dir=join(p.root,'.pipeline');
  initState(dir,'one',{budgets:{max_runs_per_tree:1}});
  const results=await Promise.all([run(p,{onlyIssue:'one',maxRuns:1}),run(p,{onlyIssue:'one',maxRuns:1})]);
  const s=loadState(dir,'one');
  return {implementationCalls:readFileSync(join(dir,'implement-calls'),'utf8').trim().split('\n').length, budget:s.max_runs_per_tree, runsUsed:s.runs_used, exitCodes:results.map(r=>r.rc)};
};

cases['deep-split'] = async () => {
  const p=project(); const dir=join(p.root,'.pipeline');
  writeFileSync(join(p.root,'AGENTS.md'),CONTRACT.replace('gates: []','budgets:\n  max_split_depth: 2\ngates: []'));
  initState(dir,'one',{budgets:{max_runs_per_tree:10}});
  registerSplit(dir,'one','one',['one.1','one.2']);
  registerSplit(dir,'one','one.1',['one.1.1','one.1.2']);
  setIssueStatus(dir,'one','one.2','done');
  writeFileSync(join(p.root,'tasks.md'),'- [ ] one: root\n  - [ ] one.1: middle\n    - [ ] one.1.1: leaf A\n    - [ ] one.1.2: leaf B\n  - [x] one.2: done sibling\n');
  const saved=process.env.PIPELINE_ALLOW_DEEP_SPLIT;
  process.env.PIPELINE_ALLOW_DEEP_SPLIT='1';
  let r;
  try {r=await run(p,{}, {PIPELINE_ALLOW_DEEP_SPLIT:'1'});}
  finally {if(saved===undefined)delete process.env.PIPELINE_ALLOW_DEEP_SPLIT;else process.env.PIPELINE_ALLOW_DEEP_SPLIT=saved;}
  return {rc:r.rc,calls:readFileSync(join(dir,'implement-calls'),'utf8').trim().split('\n'),rootRuns:loadState(dir,'one').runs_used,extraTree:existsSync(join(dir,'state/one.1.json'))?loadState(dir,'one.1'):null};
};

cases['issue-prefix'] = async () => {
  const p=project();const file=join(p.root,'tasks.md');
  writeFileSync(file,'- [ ] one extra: another issue\n- [ ] one: selected issue\n');
  await tasksMdSource('tasks.md',p.root).markDone('one');
  return {tasks:readFileSync(file,'utf8')};
};

cases['relocated-governance'] = async () => {
  const p=project();mkdirSync(join(p.root,'config'));
  const file=join(p.root,'config/AGENTS.md');
  writeFileSync(file,CONTRACT);checkedGit(p.root,['add','config/AGENTS.md']);checkedGit(p.root,['commit','-qm','relocated governance']);
  writeFileSync(file,CONTRACT+'\nUncommitted operator decision.\n');
  const r=await run(p,{onlyIssue:'one'}, {AGENTS_FILE:'config/AGENTS.md'});
  return {rc:r.rc,committedPaths:checkedGit(p.root,['diff-tree','--no-commit-id','--name-only','-r','HEAD']).trim().split('\n'),reviewIncludesGovernance:readFileSync(join(p.root,'.pipeline/work/one/diff.patch'),'utf8').includes('config/AGENTS.md')};
};

cases['corrupt-state'] = async () => {
  const p=project();mkdirSync(join(p.root,'.pipeline/state'),{recursive:true});writeFileSync(join(p.root,'.pipeline/state/one.json'),'{broken');
  const d=runDoctor({root:p.root,env:{...process.env,PIPELINE_PI_BIN:p.stub}});
  let runError=null;try {await run(p,{onlyIssue:'one'});}catch(e){runError=e.message;}
  return {doctorFails:d.fails,stateDiagnostic:d.lines.filter(l=>/state|unreadable|one.json/i.test(l)),status:statusText(join(p.root,'.pipeline')),runError};
};

cases['malformed-findings'] = async () => {
  const p=project();const files=['a','b','c'].map(n=>join(p.root,'.git',n+'.json'));
  for(const f of files)writeFileSync(f,JSON.stringify({verdict:'reject',findings:['critical: authorization missing']}));
  return runGate({files,minReviewers:2});
};

cases['init-harness-change'] = async () => {
  const p=project();await initCommand(['--local'],{root:p.root});
  const before=readFileSync(join(p.root,'auto-develop.sh'),'utf8');
  const rc=await initCommand(['--local','--harness','anthropic=claude-code'],{root:p.root});
  const after=readFileSync(join(p.root,'auto-develop.sh'),'utf8');
  return {rc,unchanged:before===after,requestedHarnessPresent:after.includes('--harness anthropic=claude-code')};
};

cases['escalation-self-review'] = async () => {
  const p=project();
  writeFileSync(join(p.root,'AGENTS.md'),CONTRACT
    .replace('correctness: { provider: anthropic, model: correctness }','correctness: { provider: anthropic, model: impl }')
    .replace('gates: []','budgets:\n  max_attempts_controller: 1\n  max_attempts_master: 1\ngates: []'));
  writeFileSync(p.stub, `import {readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';
const p=readFileSync(0,'utf8');
const model=process.argv[process.argv.indexOf('--model')+1];
if(p.startsWith('Implement this issue')) {
  if(model==='anthropic/impl')writeFileSync('from-first-model.txt','original implementation');
  else writeFileSync('from-second-model.txt','repair');
} else if(p.startsWith('You review')) {
  if(model==='anthropic/impl' && existsSync('from-first-model.txt'))writeFileSync('.pipeline/self-reviewed','original model reviewed its retained file');
  console.log('{"verdict":"approve","findings":[]}');
} else if(p.startsWith('Decide this attempt'))console.log(JSON.stringify({decision:p.includes('Attempt 1.')?'reject':'approve'}));
else console.log('notes');`);
  const r=await run(p,{onlyIssue:'one'});
  return {rc:r.rc,approved:r.output.includes('approved: one'),originalModelReviewedRetainedCode:existsSync(join(p.root,'.pipeline/self-reviewed')),committedPaths:checkedGit(p.root,['diff-tree','--no-commit-id','--name-only','-r','HEAD']).trim().split('\n')};
};

const selected=process.argv[2];
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
if(selected && !cases[selected]) throw new Error('Unknown case: '+selected);
for(const [name,fn] of Object.entries(cases)) {
  if(selected && selected!==name) continue;
  try {console.log(JSON.stringify({case:name,observed:await fn()}));}
  catch(error) {console.log(JSON.stringify({case:name,error:error.stack}));process.exitCode=1;}
}
}
