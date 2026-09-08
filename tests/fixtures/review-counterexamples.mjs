// Verify the fixed review claims and counterexamples without models or repository edits.
// INV-15, INV-18, INV-19, INV-20, INV-28: regression scenarios for both reviews.
// Run: node tests/fixtures/review-counterexamples.mjs [core|timeout]
// Fixtures are retained under the OS temporary directory for inspection.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CONTRACT } from './project.mjs';
import { runPipeline } from '../../lib/loop/run.mjs';
import { runDoctor } from '../../lib/cli/doctor.mjs';
import { initCommand } from '../../lib/cli/init.mjs';
import { readConfig, validate } from '../../lib/contract/index.mjs';
import { invokeRole, parseHarnessSpec } from '../../lib/harness/adapter.mjs';

const baseEnv = { ...process.env };
for (const k of ['AGENTS_FILE', 'SOUL_FILE', 'MEMORY_FILE', 'ISSUE_SOURCE', 'LINT_CMD', 'TEST_CMD', 'COMMIT_APPROVED', 'BINARY_REVIEW_FILE', 'DIFF_MAX_BYTES', 'PIPELINE_WRAPPER', 'PIPELINE_ALLOW_DEEP_SPLIT', 'ROLE_TIMEOUT_SECONDS', 'GATE_TIMEOUT_SECONDS']) delete baseEnv[k];
baseEnv.MIN_REVIEWERS = '2';
const results = [];
function git(root, ...args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function project() {
  const root = mkdtempSync(join(tmpdir(), 'codex-review-verify-'));
  git(root, 'init', '-q');
  for (const [k, v] of Object.entries({ 'user.name': 'Review Fixture', 'user.email': 'test@example.invalid', 'commit.gpgsign': 'false', 'core.hooksPath': join(root, '.git', 'empty-hooks'), 'core.autocrlf': 'false' })) git(root, 'config', k, v);
  writeFileSync(join(root, 'AGENTS.md'), CONTRACT);
  writeFileSync(join(root, 'tasks.md'), '- [ ] one: first issue\n- [ ] two: second issue\n');
  writeFileSync(join(root, '.gitignore'), '.pipeline/\n');
  commit(root);
  const source = readConfig(join(root, 'AGENTS.md'));
  assert.deepEqual(validate(source.config, source, baseEnv).errors, []);
  return root;
}
function commit(root) { git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture'); }
function stub(root, body = '') {
  const file = join(root, '.git', 'roles.mjs');
  writeFileSync(file, `import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const p=readFileSync(0,'utf8');
${body}
if(p.startsWith('Implement this issue'))writeFileSync('work.txt','implementation\\n');
else if(p.startsWith('You review'))console.log('{"verdict":"approve","findings":[]}');
else if(p.startsWith('Decide this attempt'))console.log('{"decision":"approve"}');
else console.log('notes');`);
  return file;
}
async function run(root, binary, env = {}, flags = { onlyIssue: 'one', maxRuns: 1 }) {
  let output = ''; const stream = { write(s) { output += s; } };
  let rc = null, error = null;
  try { rc = await runPipeline({ root, flags, env: { ...baseEnv, PIPELINE_PI_BIN: binary, ...env }, stdout: stream, stderr: stream }); }
  catch (e) { error = e.message; }
  return { rc, error, output, approved: /^approved: one$/m.test(output) };
}
function json(root, file) { return JSON.parse(readFileSync(join(root, file), 'utf8')); }
function record(id, result) { results.push({ id, ...result }); console.log(JSON.stringify(results.at(-1))); }

export async function core() {
  // C1: original, critical-first control, and valid-retry control.
  for (const variant of ['lost-retry', 'critical-first', 'valid-retry']) {
    const root = project();
    const binary = stub(root, `if(p.startsWith('You review a diff for one concern only: security')) {
      const retry=p.includes('REMINDER');
      const severity=retry || ${variant === 'critical-first'} ? 'critical':'low';
      const response={verdict:'approve',findings:[...(${variant === 'valid-retry'} && retry ? []:[null]),{severity,file:'work.txt',title:severity.toUpperCase()}]};
      writeFileSync('.pipeline/security-'+(retry?'retry':'initial')+'.json',JSON.stringify(response));
      console.log(JSON.stringify(response));process.exit(0);
    }`);
    const r = await run(root, binary), gate = json(root, '.pipeline/work/one/gate.json');
    assert.equal(r.error, null);
    assert.equal(json(root, '.pipeline/security-retry.json').findings.at(-1).severity, 'critical');
    assert.equal(r.approved, false, r.output);
    assert.equal(gate.verdict, 'blocked');
    assert.ok(gate.blocking.some(f => f.severity === 'critical'));
    assert.equal(gate.reviewers_used, variant === 'valid-retry' ? 3 : 2);
    assert.equal(git(root, 'rev-list', '--count', 'HEAD'), '1');
    record('C1/' + variant, { root, approved: r.approved, blocking: gate.blocking, reviewers: gate.reviewers_used });
  }

  // C2: an initially harmless tracked filter is changed by the implementer.
  const poison = `import {readFileSync,writeFileSync} from 'node:fs';\nconst t=readFileSync('tasks.md','utf8');writeFileSync('tasks.md',t.replace('- [ ] two:','- [x] two:'));process.stdout.write(readFileSync(0));\n`;
  for (const variant of ['model-changed-filter', 'harmless-filter', 'direct-governance-write']) {
    const root = project(); mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts/clean.mjs'), "import{readFileSync}from'node:fs';process.stdout.write(readFileSync(0));\n");
    writeFileSync(join(root, '.gitattributes'), 'work.txt filter=probe\n');
    git(root, 'config', 'filter.probe.clean', 'node scripts/clean.mjs'); commit(root);
    const binary = stub(root, `if(p.startsWith('Implement this issue')) {
      ${variant === 'model-changed-filter' ? `writeFileSync('scripts/clean.mjs',${JSON.stringify(poison)});` : ''}
      ${variant === 'direct-governance-write' ? `writeFileSync('tasks.md',readFileSync('tasks.md','utf8').replace('- [ ] two:','- [x] two:'));` : ''}
      writeFileSync('.pipeline/tasks-at-end-of-implementation',readFileSync('tasks.md'));
    }`);
    const before = git(root, 'rev-parse', 'HEAD'), r = await run(root, binary);
    const tasks = git(root, 'show', 'HEAD:tasks.md');
    assert.equal(r.error, null);
    if (variant === 'model-changed-filter') {
      assert.match(readFileSync(join(root, '.pipeline/tasks-at-end-of-implementation'), 'utf8'), /\[ \] two:/);
      assert.equal(r.approved, false, r.output); assert.match(tasks, /\[ \] two:/);
      assert.match(readFileSync(join(root, 'tasks.md'), 'utf8'), /\[ \] two:/);
      assert.equal(git(root, 'rev-parse', 'HEAD'), before);
      assert.match(r.output, /protected files or HEAD modified during diff capture/);
    } else {
      assert.match(tasks, /\[ \] two:/);
      assert.equal(r.approved, variant === 'harmless-filter', r.output);
      if (variant === 'direct-governance-write') { assert.match(r.output, /governance modified/); assert.equal(git(root, 'rev-parse', 'HEAD'), before); }
    }
    record('C2/' + variant, { root, approved: r.approved, committedTasks: tasks });
  }

  for (const variant of ['preexisting-update', 'implementer-update']) {
    const root = project(), source = project();
    const old = git(source, 'rev-parse', 'HEAD');
    writeFileSync(join(source, 'next.txt'), 'next version\n'); commit(source);
    const next = git(source, 'rev-parse', 'HEAD');
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'vendor/component');
    git(join(root, 'vendor/component'), 'checkout', '-q', old); commit(root);
    if (variant === 'preexisting-update') git(join(root, 'vendor/component'), 'checkout', '-q', next);
    const binary = stub(root, variant === 'implementer-update' ? `if(p.startsWith('Implement this issue'))execFileSync('git',['-C','vendor/component','checkout','-q',${JSON.stringify(next)}]);` : '');
    const before = git(root, 'rev-parse', 'HEAD'), r = await run(root, binary);
    assert.equal(r.error, null); assert.equal(r.rc, 1); assert.equal(r.approved, false);
    assert.match(r.output, /submodule/i);
    assert.doesNotMatch(r.output, /cat-file/);
    assert.equal(git(root, 'rev-parse', 'HEAD'), before);
    const state = json(root, '.pipeline/state/one.json');
    assert.equal(state.runs_used, variant === 'preexisting-update' ? 0 : 1);
    assert.equal(state.issues.one.status, 'paused');
    const again = await run(root, binary);
    assert.equal(again.rc, 1, again.output);
    assert.equal(json(root, '.pipeline/state/one.json').runs_used, state.runs_used);
    // After manual review/commit of the pointer, normal work can resume.
    git(root, 'add', 'vendor/component'); git(root, 'commit', '-qm', 'manually reviewed submodule');
    const resumed = await run(root, stub(root));
    assert.equal(resumed.approved, true, resumed.output);
    record('C3/' + variant, { root, error: r.error, runsUsed: state.runs_used, status: state.issues.one.status });
  }

  // C4: explicit env versus actual process env, both doctor and init.
  const root = project();
  writeFileSync(join(root, 'AGENTS.md'), CONTRACT.replace('gates: []', 'budgets:\n  max_split_depth: 2\ngates: []'));
  const env = { ...baseEnv, PIPELINE_ALLOW_DEEP_SPLIT: '1' };
  const previous = process.env.PIPELINE_ALLOW_DEEP_SPLIT;
  try {
    delete process.env.PIPELINE_ALLOW_DEEP_SPLIT;
    const c = readConfig(join(root, 'AGENTS.md')); assert.deepEqual(validate(c.config, c, env).errors, []);
    const fails = runDoctor({ root, env }).lines.filter(x => x.startsWith('FAIL'));
    assert.equal(fails.some(x => x.includes('max_split_depth')), false);
    const explicitInit = await initCommand(['--local'], { root, env }); assert.equal(explicitInit, 0);
    assert.equal(existsSync(join(root, 'auto-develop.sh')), true);
    process.env.PIPELINE_ALLOW_DEEP_SPLIT = '1';
    assert.equal(runDoctor({ root, env }).lines.some(x => x.startsWith('FAIL') && x.includes('max_split_depth')), false);
    const exportedInit = await initCommand(['--local'], { root, env }); assert.equal(exportedInit, 0);
    record('C4/explicit-versus-process-env', { root, explicitInit, exportedInit, fails });
  } finally { if (previous === undefined) delete process.env.PIPELINE_ALLOW_DEEP_SPLIT; else process.env.PIPELINE_ALLOW_DEEP_SPLIT = previous; }

  const followupRoot = project();
  const followupRun = await run(followupRoot, stub(followupRoot, `if(p.startsWith('You review a diff for one concern only: security')){console.log('{"verdict":"approve","findings":[{"severity":"medium","file":"work.txt","title":"FOLLOW_UP"}]}');process.exit(0);}`));
  assert.equal(followupRun.approved, true);
  assert.equal(json(followupRoot, '.pipeline/work/one/gate.json').followups.length, 1);
  assert.equal(git(followupRoot, 'show', 'HEAD:tasks.md'), '- [x] one: first issue\n- [ ] two: second issue');
  // R6: recorded and visible, never ticketed. The approval appends the accepted
  // follow-ups to MEMORY.md, because gate.json lives under the gitignored
  // .pipeline/; the issue source gains no entry and MEMORY.md is not committed.
  const followupMemory = readFileSync(join(followupRoot, 'MEMORY.md'), 'utf8');
  assert.match(followupMemory, /^## Follow-ups — one \(\d{4}-\d{2}-\d{2}\)$/m);
  assert.match(followupMemory, /- medium in work\.txt \(FOLLOW_UP\)/);
  assert.doesNotMatch(git(followupRoot, 'show', '--stat', '--name-only', 'HEAD'), /MEMORY\.md/);
  record('I1/followup-on-approval', { root: followupRoot, gateFollowups: 1, newTickets: 0, memorySection: true });

  const freshRoot = mkdtempSync(join(tmpdir(), 'codex-review-fresh-'));
  git(freshRoot, 'init', '-q'); writeFileSync(join(freshRoot, 'AGENTS.md'), CONTRACT);
  assert.ok(runDoctor({ root: freshRoot, env: baseEnv }).lines.some(x => x.startsWith('FAIL no commit yet')));
  assert.equal(await initCommand(['--local'], { root: freshRoot, env: baseEnv }), 0);
  assert.ok(runDoctor({ root: freshRoot, env: baseEnv }).lines.some(x => x.startsWith('FAIL no commit yet')));
  record('I2/init-without-head', { root: freshRoot, initSucceeded: true, doctorStillFailsOnMissingHead: true });
}

export async function timeout() {
  const root = project(), binary = join(root, '.git', 'hang.sh');
  const smoke = readFileSync(new URL('../smoke.sh', import.meta.url), 'utf8');
  const match = smoke.match(/cat > "\$stub_hang\/pi" <<'EOF'\r?\n([\s\S]*?)\r?\nEOF/);
  assert.ok(match); writeFileSync(binary, match[1].replace(/\r\n/g, '\n') + '\n', { mode: 0o755 });
  const env = { ...baseEnv };
  if (process.platform === 'win32') {
    env.PATH = ['C:\\Program Files\\Git\\bin', 'C:\\Program Files\\Git\\usr\\bin', env.PATH ?? env.Path ?? ''].join(delimiter);
    env.PIPELINE_SHELL = 'C:\\Program Files\\Git\\bin\\bash.exe';
  }
  env.PIPELINE_PI_BIN = binary;
  const start = performance.now();
  const direct = await invokeRole({ spec: parseHarnessSpec('pi'), role: 'review.security', model: 'google/security', promptText: 'You review a diff\n', outPath: join(root, '.git', 'answer'), cwd: root, trusted: false, timeoutMs: 1000, env });
  const elapsed = performance.now() - start;
  assert.equal(direct.status, 124);
  assert.ok(elapsed < 10000, `one timed-out role waited ${elapsed} ms for a 20-second descendant`);
  record('timeout/direct-smoke-stub', { root, milliseconds: Math.round(elapsed), status: direct.status });
  const fullStart = performance.now();
  const r = await run(root, binary, { ...env, ROLE_TIMEOUT_SECONDS: '1' }, { onlyIssue: 'one' });
  const total = performance.now() - fullStart;
  assert.equal(r.error, null); assert.equal(r.rc, 1); assert.equal(r.approved, false);
  assert.ok(total <= 60000, `timeout integration exceeded its separate 60s ceiling: ${total} ms`);
  assert.match(r.output, /Configuration error/);
  const state = json(root, '.pipeline/state/one.json'); assert.equal(state.runs_used, 2);
  const events = readdirSync(join(root, '.pipeline/logs/one')).flatMap(f => readFileSync(join(root, '.pipeline/logs/one', f), 'utf8').trim().split('\n').map(JSON.parse));
  const timedOut = events.filter(e => String(e.status) === '124'); assert.equal(timedOut.length, 12);
  record('timeout/full-smoke-stub', { root, milliseconds: Math.round(total), timedOutRoles: timedOut.length, attempts: state.runs_used });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const mode = process.argv[2] ?? 'core';
assert.ok(['core', 'timeout'].includes(mode), 'expected core or timeout');
await (mode === 'timeout' ? timeout() : core());
console.log(JSON.stringify({ verificationComplete: true, scenarios: results.length, mode }));

}
