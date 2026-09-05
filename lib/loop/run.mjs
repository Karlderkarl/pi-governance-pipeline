// run.mjs — the governance-driven pipeline loop.
//
// Per issue: research (cached) → implement → integrity check → deterministic
// gates → review diff → three independent reviewers → gate → controller →
// master review → approve | reject | take_over | split. Counters and budget
// live in .pipeline/state; the master cannot approve over a blocking gate;
// an abort writes MEMORY.md and names the issue. Every model call is a
// separate process of the harness chosen for its provider.
//
// Messages on stderr are stable: operators grep them, and so does the parity
// suite that pins every rule this loop encodes.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { effectiveGates, effectiveIssueSource, modelIdentity, readConfig, resolveAllModels, validate } from "../contract/index.mjs";
import { captureDiff, readDiffPaths } from "../diff/capture.mjs";
import { ADAPTERS, harnessesInUse, invokeRole, parseHarnessSpec, routingErrors } from "../harness/adapter.mjs";
import { preservePaths } from "../integrity/governance-paths.mjs";
import { compareSnapshots, describeDiff, restoreSnapshot, takeSnapshot } from "../integrity/snapshot.mjs";
import { openIssueSource } from "../issues/source.mjs";
import { createLogger } from "../log/events.mjs";
import { prunePrompts } from "../log/prune.mjs";
import {
	REVIEW_REMINDER,
	buildControllerPrompt,
	buildImplementPrompt,
	buildMasterPrompt,
	buildResearchPrompt,
	buildReviewPrompt,
} from "../prompts/build.mjs";
import { findingsToProse } from "../review/findings-prose.mjs";
import { allDroppedGate, runGate } from "../review/gate.mjs";
import { parseMasterDecision } from "../review/master-decision.mjs";
import { checkReviewerText } from "../review/reviewer-output.mjs";
import { attemptsOf, budgetOf, escalate, initState, loadState, recordAttempt, registerSplit, setIssueStatus } from "../state/store.mjs";
import { git, hasGitBinary, hasHead, isGitWorkTree, runShell } from "../util/exec.mjs";
import { attemptTag, excerpt, headTail, intEnv, runIdNow, sanitizeIssueId, tailLines } from "../util/text.mjs";
import { blockIssue } from "./blocker.mjs";
import { commitApproved } from "./commit.mjs";
import { stashRejectedTree } from "./stash.mjs";

export const USAGE = `auto-develop — the governance-driven pipeline (pi-governance-pipeline).

  pipeline run [flags]                run every open issue of the issue source
  --dry-run                           routing and prompts, zero model calls
  --issue <id>                        run a single issue
  --unattended [--yes]                privileged steps allowed (confirmed once, before the loop)
  --auto-merge [--yes]                adaptation point: parsed and confirmed, not implemented
  --max-runs <n>                      optional invocation cap across issues
  --harness <spec>                    pi (default) | claude-code | provider=harness,...
  --yes, -y                           answer every startup gate yes (non-interactive runs)
  --help, -h

Everything else is read from governance (AGENTS.md). LINT_CMD, TEST_CMD and
ISSUE_SOURCE in the environment override the contract for one run.`;

const RANK_TAG = { 0: 2, 2: 1 };
const rankOfCheck = (exit) => RANK_TAG[exit] ?? 0;

class Die extends Error {
	constructor(message, exit = 1) {
		super(message);
		this.exit = exit;
		this.die = true;
	}
}

function ask(question) {
	return new Promise((resolvePromise) => {
		const rl = createInterface({ input: process.stdin, output: process.stderr });
		rl.question(question, (answer) => {
			rl.close();
			resolvePromise(answer);
		});
	});
}

const hasTty = () => Boolean(process.stdin.isTTY);

export async function runPipeline({ root, flags, env = process.env, stdout = process.stdout, stderr = process.stderr }) {
	try {
		return await run({ root: resolve(root), flags, env, stdout, stderr });
	} catch (error) {
		if (error?.die) {
			stderr.write(`error: ${error.message}\n`);
			return error.exit;
		}
		if (error?.code === "CONTRACT") {
			stderr.write(`contract error: ${error.message}\n`);
			return 2;
		}
		throw error;
	}
}

async function run({ root, flags, env, stdout, stderr }) {
	const warn = (m) => stderr.write(`${m}\n`);
	const childEnv = { ...env };
	const ctx = { root, flags, env, childEnv, stdout, stderr, warn };

	// ---------------------------------------------------------------- knobs
	ctx.pipelineDir = join(root, ".pipeline");
	ctx.agentsFile = env.AGENTS_FILE ? resolve(root, env.AGENTS_FILE) : join(root, "AGENTS.md");
	ctx.soulFile = env.SOUL_FILE ? resolve(root, env.SOUL_FILE) : join(root, "SOUL.md");
	ctx.memoryFile = env.MEMORY_FILE ? resolve(root, env.MEMORY_FILE) : join(root, "MEMORY.md");
	ctx.commitApproved = (env.COMMIT_APPROVED ?? "1") !== "0";
	ctx.diffMaxBytes = intEnv(env, "DIFF_MAX_BYTES", 65536);
	ctx.reviewersMaxBytes = intEnv(env, "REVIEWERS_MAX_BYTES", 65536);
	ctx.exclusionsMaxLines = intEnv(env, "EXCLUSIONS_MAX_LINES", 200);
	ctx.blockerHistoryMax = intEnv(env, "BLOCKER_HISTORY_MAX", 5);
	ctx.blockerHistoryMaxBytes = intEnv(env, "BLOCKER_HISTORY_MAX_BYTES", 16384);
	ctx.promptKeepRuns = intEnv(env, "PROMPT_KEEP_RUNS", 3, { min: 1 });
	ctx.roleTimeoutSeconds = intEnv(env, "ROLE_TIMEOUT_SECONDS", 0);
	// Gates and `!command` sources run project commands; a test run stuck in
	// watch mode must not hold an unattended loop. Falls back to the role cap.
	ctx.gateTimeoutSeconds = intEnv(env, "GATE_TIMEOUT_SECONDS", ctx.roleTimeoutSeconds);
	// Unlike the byte caps above, a bad value here is fatal rather than
	// reset: those are performance knobs, this is the floor of the review panel.
	const minRaw = env.MIN_REVIEWERS ?? "2";
	if (!/^[1-9][0-9]*$/.test(minRaw)) throw new Die(`MIN_REVIEWERS must be an integer >= 1; got '${minRaw}'`);
	ctx.minReviewers = Number(minRaw);
	if (flags.maxRuns !== null && flags.maxRuns !== undefined) {
		if (!/^[1-9][0-9]*$/.test(String(flags.maxRuns))) throw new Die(`--max-runs must be an integer >= 1; got '${flags.maxRuns}'`);
		ctx.maxRuns = Number(flags.maxRuns);
	} else ctx.maxRuns = null;
	try {
		ctx.harnessSpec = parseHarnessSpec(flags.harness ?? "pi");
	} catch (error) {
		throw new Die(error.message);
	}

	// The flag is parsed and confirmed at the safety gate so an adapted
	// pipeline can hook a real merge here. The reference does not merge.
	if (flags.autoMerge) warn("auto-merge: not implemented in the reference script — adapt this step");

	// ---------------------------------------------------------- safety gate
	// pi has no permission dialog and `pi -p` has no UI. This startup gate is
	// the only place a human can intervene, so it runs before the loop. Trust
	// comes from the flag the human confirmed here, never from the environment:
	// a PIPELINE_UNATTENDED=1 exported in a shell to quiet the guard must not
	// turn a plain run into a trusted one.
	if (env.PIPELINE_UNATTENDED === "1" && !flags.unattended && !flags.autoMerge) {
		warn("warning: PIPELINE_UNATTENDED=1 in the environment is ignored; child processes are trusted only after --unattended has passed the startup gate");
	}
	delete childEnv.PIPELINE_UNATTENDED;
	if (flags.unattended || flags.autoMerge) {
		if (!flags.assumeYes) {
			if (!hasTty()) throw new Die("--unattended/--auto-merge on a non-interactive stdin requires --yes");
			const reply = await ask(`Run unattended (privileged steps, auto-merge=${flags.autoMerge ? 1 : 0})? [y/N] `);
			if (!/^[yY]/.test(reply)) throw new Die("aborted at the safety gate");
		}
		// The pipeline-guard extension cannot ask under `pi -p` and would block
		// every privileged step of the child processes. The human confirmed
		// above, once — the two halves of the safety rule meet at this variable.
		childEnv.PIPELINE_UNATTENDED = "1";
	}
	ctx.trusted = Boolean(flags.unattended || flags.autoMerge);

	// ------------------------------------------------------------ binaries
	// Dry-run never launches a model, so the harness can be missing there.
	// A real run without it would burn the tree budget on empty reviewer files.
	ctx.gitOk = isGitWorkTree(root);

	// ------------------------------------------------------------- contract
	const source = readConfig(ctx.agentsFile);
	for (const w of source.warnings) warn(`warning: ${w}`);
	const { errors, warnings } = validate(source.config, source);
	for (const w of warnings) warn(`contract warning: ${w}`);
	if (errors.length > 0) {
		for (const e of errors) warn(`contract error: ${e}`);
		return 2;
	}
	ctx.config = source.config;
	ctx.models = resolveAllModels(ctx.config);
	ctx.blocking = ctx.config.review.blocking_severities.map((s) => String(s).toLowerCase());
	ctx.followup = ctx.config.review.followup_severities.map((s) => String(s).toLowerCase());
	ctx.maxCtrl = ctx.config.budgets.max_attempts_controller;
	ctx.maxMaster = ctx.config.budgets.max_attempts_master;
	ctx.maxSplitDepth = ctx.config.budgets.max_split_depth;
	ctx.noSelfReview = ctx.config.models.constraints.no_self_review === true;

	// A harness that runs one provider cannot take another provider's role;
	// refused here, not discovered six attempts later as "empty diff".
	const routing = routingErrors(ctx.models, ctx.harnessSpec);
	if (routing.length > 0) throw new Die(routing.map((e) => `harness: ${e}`).join("\n"));

	// Credential preflight is warn-only and never asks the harness about a
	// model id: passing an AGENTS.md id to `pi auth check --model` treats the
	// first path segment as a native provider, and google/gemini-2.5-flash is
	// an openrouter id there — a healthy run would abort. The binary has to
	// exist; whether its keys work is what the first role call tells us.
	const inUse = harnessesInUse(ctx.models, ctx.harnessSpec);
	for (const name of inUse) {
		const adapter = ADAPTERS[name];
		const found = adapter.resolve(env);
		if (found) continue;
		if (!flags.dryRun) throw new Die(`${adapter.BINARY} is required (every ${name === "pi" ? "role" : "Anthropic role"} runs as ${adapter.BINARY} -p)`);
		warn(`note: ${adapter.BINARY} not on PATH — a real run will fail here`);
	}
	// Reviewers read the working-tree diff. Without a repo the empty-diff
	// check would burn the whole tree budget and then block a correct implementation.
	// The harness check comes first: a missing pi is the more likely mistake.
	if (!hasGitBinary()) throw new Die("git is required (the review diff, the take_over stash and the approve commit all need it)");
	if (!ctx.gitOk) throw new Die("auto-develop requires a git repository");
	// take_over stashes against HEAD and the approve step commits on top of it.
	// `git stash` refuses without an initial commit, silently leaving the
	// rejected tree in place for implement_master — so refuse up front instead.
	if (!hasHead(root)) {
		if (flags.dryRun) warn("note: the repository has no commit yet — a real run refuses to start until there is one (take_over needs a HEAD to stash against)");
		else throw new Die("the repository has no commit yet; create one first (git commit --allow-empty -m init is enough) — take_over needs a HEAD to stash against");
	}
	// pi loads the first hit of AGENTS.override.md, AGENTS.md, … from cwd and
	// ancestors. The harness still routes from AGENTS_FILE. If both exist,
	// every child process follows different instructions than the script.
	if (existsSync(join(root, "AGENTS.override.md"))) {
		warn(`warning: AGENTS.override.md exists — pi loads it instead of AGENTS.md in every child process; routing still reads ${ctx.agentsFile}`);
	}

	// ---------------------------------------------------------------- gates
	const gates = effectiveGates(ctx.config, env);
	ctx.gates = gates.gates;
	ctx.gatesConfigured = ctx.gates.length ? ctx.gates.map((g) => g.name).join(",") : "none";
	if (ctx.gates.length === 0) {
		warn("warning: neither LINT_CMD nor TEST_CMD is set and the contract lists no gates — model review is the only gate for this run");
	}

	// --------------------------------------------------------- issue source
	const sourceSpec = effectiveIssueSource(ctx.config, env);
	ctx.issueSource = openIssueSource(sourceSpec, { root, env, timeoutMs: ctx.gateTimeoutSeconds * 1000 });
	ctx.issueRel = ctx.issueSource.relPath;
	if (sourceSpec.trust === "external" && !flags.dryRun) {
		// Foreign-authored issue text feeds every prompt of the loop. The
		// prompts frame it as untrusted input; that is a mitigation, not a
		// boundary, so the operator acknowledges it once, before the loop.
		if (!flags.assumeYes) {
			if (!hasTty()) {
				throw new Die(
					`issue source ${ctx.issueSource.describe()} is external (its text is not authored by you); pass --yes to feed it into the loop, and containerize the run`,
				);
			}
			const reply = await ask(`Issue source ${ctx.issueSource.describe()} is external; feed its text into the loop? [y/N] `);
			if (!/^[yY]/.test(reply)) throw new Die("aborted at the safety gate (external issue source)");
		}
	}

	// ------------------------------------------------------------- logging
	ctx.runId = runIdNow();
	ctx.logger = createLogger({ pipelineDir: ctx.pipelineDir, runId: ctx.runId, gates: ctx.gatesConfigured });
	for (const d of ["state", "logs", "prompts", "work"]) mkdirSync(join(ctx.pipelineDir, d), { recursive: true });
	if (git(root, ["check-ignore", "-q", ".pipeline"]).status !== 0) {
		warn("warning: .pipeline/ is not gitignored; it holds diffs and prompts in plaintext and must be ignored");
	}
	prunePrompts(join(ctx.pipelineDir, "prompts"), ctx.promptKeepRuns);

	// Harness paths that are never an implementation: the wrapper and the
	// issue source stay out of the review diff and survive the take_over stash.
	ctx.wrapperRel = env.PIPELINE_WRAPPER ? relativeOrNull(root, resolve(root, env.PIPELINE_WRAPPER)) : "auto-develop.sh";
	ctx.harnessRel = [ctx.wrapperRel, ctx.issueRel].filter(Boolean);
	ctx.preserve = preservePaths(root, {
		agentsFile: ctx.agentsFile,
		soulFile: ctx.soulFile,
		memoryFile: ctx.memoryFile,
		extra: [join(root, ctx.wrapperRel ?? "auto-develop.sh"), ctx.issueSource.path].filter(Boolean),
	});
	// The integrity snapshot covers the same set: governance, .pi/, the issue
	// source and the wrapper. An implementer that appended issues to tasks.md
	// used to pass unnoticed — the diff filter hid it from the reviewers and
	// the approve step committed it along with the checkbox.
	ctx.integrityPaths = ctx.preserve;

	ctx.failed = [];
	ctx.globalRuns = 0;
	ctx.haltReason = "";

	return mainLoop(ctx);
}

function relativeOrNull(root, abs) {
	const rel = relative(root, abs).replace(/\\/g, "/");
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
	return rel;
}

async function mainLoop(ctx) {
	const { flags, stdout, stderr } = ctx;
	// A failed !command source is an error, never "no open issues" with status 0.
	let issues;
	try {
		issues = await ctx.issueSource.list();
	} catch (error) {
		if (error?.code === "SOURCE") {
			if (error.stderr) stderr.write(error.stderr);
			throw new Die(error.message);
		}
		throw new Die(error.message);
	}
	if (issues.length === 0) {
		// --issue naming something that is not open is a mistake, not a quiet no-op.
		if (flags.onlyIssue) {
			stderr.write(`error: --issue ${flags.onlyIssue} is not an open issue in ${ctx.issueSource.describe()}\n`);
			return 1;
		}
		stdout.write(`no open issues in ${ctx.issueSource.describe()}\n`);
		return 0;
	}
	let matched = 0;
	const notStarted = [];
	// Children of a split run under their parent, which resumes them; a child
	// named by --issue, or one whose parent is no longer open, runs on its own
	// under the parent's tree.
	const openTop = new Set(issues.filter((i) => !i.parent).map((i) => i.raw));
	for (const issue of issues) {
		const isChild = Boolean(issue.parent);
		if (flags.onlyIssue) {
			if (issue.raw !== flags.onlyIssue) continue;
		} else if (isChild && openTop.has(issue.parent)) continue;
		matched++;
		if (ctx.haltReason) {
			notStarted.push(issue.raw);
			continue;
		}
		if (ctx.maxRuns !== null && ctx.globalRuns >= ctx.maxRuns) {
			stderr.write(`global --max-runs ${ctx.maxRuns} reached\n`);
			break;
		}
		if (isChild) {
			const root = sanitizeIssueId(issue.parent);
			const childId = sanitizeIssueId(issue.raw);
			stdout.write(`=== ${issue.raw} (child of ${issue.parent}) ===\n`);
			await processIssue(ctx, { ...issue, text: readChildBody(ctx, root, childId) }, { root, depth: childDepth(ctx, root, childId) });
			continue;
		}
		stdout.write(`=== ${issue.raw} ===\n`);
		await processIssue(ctx, issue, { root: sanitizeIssueId(issue.raw), depth: 0 });
	}
	if (flags.onlyIssue && matched === 0) {
		stderr.write(`error: --issue ${flags.onlyIssue} is not an open issue in ${ctx.issueSource.describe()}\n`);
		return 1;
	}
	let rc = ctx.haltExit ?? 0;
	if (ctx.haltReason) {
		stderr.write(`stopped: ${ctx.haltReason}. ${ctx.haltAdvice ?? "Commit it before the next issue reviews it as its own diff."}\n`);
		if (notStarted.length) {
			stderr.write(`not started: ${notStarted.join(" ")}\n`);
			rc = 1;
		}
	}
	// A blocked or aborted issue is not "approved": the run exits non-zero.
	if (ctx.failed.length) {
		stderr.write(`blocked: ${ctx.failed.join(" ")}\n`);
		rc = 1;
	}
	return rc;
}

// Approval is retained when git fails, but the operational failure is never
// success, even for the last issue or a split-parent closing commit. Leave
// the approved work and checkbox changes intact for the operator to commit.
function commitApproval(ctx, args) {
	const result = commitApproved({ root: ctx.root, issueRel: ctx.issueRel, stderr: ctx.stderr, ...args });
	if (!result.committed) {
		ctx.haltReason = `approved work of ${args.issueId} could not be committed (${result.reason}; see git output above)`;
		ctx.haltExit = 1;
	}
	return result;
}

// One role, one process, one fresh context. Reviewers stay independent
// because they are separate processes, not because we asked them to be.
async function runRole(ctx, { root, issueId, role, prompt, outPath, attemptTagText = "" }) {
	const model = ctx.models[role] ?? "default";
	const pdir = join(ctx.pipelineDir, "prompts", root);
	mkdirSync(pdir, { recursive: true });
	mkdirSync(join(outPath, ".."), { recursive: true });
	// One file per attempt, not one per role: the earlier prompts are exactly
	// what you want when debugging a retry loop.
	const ppath = join(pdir, `${issueId}-${role.replace(/\./g, "_")}${attemptTagText ? `-${attemptTagText}` : ""}-${ctx.runId}.txt`);
	writeFileSync(ppath, `${prompt}\n`);
	if (ctx.flags.dryRun) {
		ctx.stdout.write(`[dry-run] ${role} -> ${model} (prompt: ${ppath})\n`);
		ctx.logger.logEvent({ root, issue: issueId, role, model, status: "dry-run", prompt: ppath });
		return { status: 0, timedOut: false, stderr: "", firstLine: "" };
	}
	const result = await invokeRole({
		spec: ctx.harnessSpec,
		role,
		model,
		promptText: `${prompt}\n`,
		outPath,
		cwd: ctx.root,
		trusted: ctx.trusted,
		timeoutMs: ctx.roleTimeoutSeconds * 1000,
		env: ctx.childEnv,
	});
	// The harness's stderr is kept next to its answer and its first line is
	// reported: a missing API key must read as a missing API key, not as an
	// implementer that wrote nothing.
	const errPath = `${outPath}.stderr`;
	const hasStderr = typeof result.stderr === "string" && result.stderr.trim() !== "";
	if (hasStderr) writeFileSync(errPath, result.stderr);
	else rmSync(errPath, { force: true });
	if (result.error) ctx.stderr.write(`warning: ${role} on ${result.harness}: ${result.error}\n`);
	else if (result.timedOut) ctx.stderr.write(`warning: ${role} timed out after ${ctx.roleTimeoutSeconds}s; its answer is discarded\n`);
	else if (result.status !== 0) {
		ctx.stderr.write(`warning: ${role} exited ${result.status}${result.firstLine ? `: ${result.firstLine}` : ""}${hasStderr ? ` (stderr in ${errPath})` : ""}\n`);
	}
	ctx.logger.logEvent({ root, issue: issueId, role, model, status: result.status, prompt: ppath, note: result.timedOut ? "timeout" : null });
	return result;
}

function readText(path) {
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

// The body of a sub-issue, written at split time next to the parent's work.
function readChildBody(ctx, root, childId) {
	return readText(join(ctx.pipelineDir, "work", root, "issues", `${childId}.md`)).replace(/\n$/, "");
}

// Depth of a child from its tree's state file; 1 when the state is not there
// yet (dry-run, or a hand-written child).
function childDepth(ctx, root, childId) {
	try {
		return attemptsOf(ctx.pipelineDir, root, childId).depth || 1;
	} catch {
		return 1;
	}
}

// Every child of a split, as the state file lists them, is done.
function allChildrenDone(ctx, root, issueId) {
	try {
		const state = loadState(ctx.pipelineDir, root);
		const ids = state.issues[issueId]?.children ?? [];
		return ids.length > 0 && ids.every((id) => state.issues[id]?.status === "done");
	} catch {
		return false;
	}
}

// Governance is byte-identical after a tool-bearing role, or the attempt is
// rejected and the files put back from the snapshot taken before the role.
// The snapshot before the role keeps content (in memory, or spilled under the
// work directory for big files); the one after is hash-only.
function governanceSnapshot(ctx, work) {
	return takeSnapshot(ctx.integrityPaths, { spillDir: join(work, "gov-snapshot") });
}

function integrityCheck(ctx, before, role, work, attemptNo, issueId, root) {
	const after = takeSnapshot(ctx.integrityPaths, { hashOnly: true });
	const diff = compareSnapshots(before, after);
	if (diff.clean) {
		rmSync(join(work, "gov-snapshot"), { recursive: true, force: true });
		return true;
	}
	const unrestored = restoreSnapshot(before, diff);
	const what = describeDiff(ctx.root, diff);
	ctx.stderr.write(`governance modified by ${role} (${what}); reverted, retrying implementation\n`);
	if (unrestored.length) ctx.stderr.write(`warning: could not restore ${unrestored.map((p) => relative(ctx.root, p)).join(", ")} — no content was kept for it\n`);
	appendFileSync(join(work, "exclusions.md"), `--- attempt ${attemptNo} (governance modified) ---\nThe ${role} step changed governance files (${what}). They were restored. Change the code only; never edit governance files.\n\n`);
	ctx.logger.logEvent({ root, issue: issueId, role, model: ctx.models[role] ?? "default", status: "governance-modified", prompt: "-", note: what });
	rmSync(join(work, "gov-snapshot"), { recursive: true, force: true });
	return false;
}

// The paths that differ from HEAD and count as implementation: governance,
// .pipeline/, .pi/, the issue source and the wrapper excluded. Goes through
// the diff capture so the filter is the one the reviewers get.
function implementationChanges(ctx, out) {
	captureDiff({ root: ctx.root, out, maxBytes: ctx.diffMaxBytes, harnessRel: ctx.harnessRel });
	const paths = readDiffPaths(`${out}.paths`);
	rmSync(out, { force: true });
	rmSync(`${out}.paths`, { force: true });
	return paths;
}

// A blocked issue must not hand its rejected tree to the next issue: the
// reviewers would judge that tree as the next issue's work, and the approve
// step would commit it. Same protection as take_over — governance, the issue
// source and the wrapper are copied out and written back.
function stashBlocked(ctx, { issueId, work }) {
	const paths = implementationChanges(ctx, join(work, "blocked.patch"));
	if (paths.length === 0) return false;
	ctx.stderr.write(`rejected work of ${issueId} is stashed so the next issue starts from HEAD: ${paths.join(" ")}\n`);
	return stashRejectedTree({ root: ctx.root, workDir: work, preserve: ctx.preserve, message: `pipeline: blocked ${issueId}-${ctx.runId}`, stderr: ctx.stderr });
}

async function processIssue(ctx, issue, { root, depth }) {
	const { flags, stdout, stderr, config } = ctx;
	const issueLine = issue.text ? `${issue.line}\n\n${issue.text}` : issue.line;
	const issueRaw = issue.raw;
	if (ctx.maxRuns !== null && ctx.globalRuns >= ctx.maxRuns) {
		stderr.write(`global --max-runs ${ctx.maxRuns} reached; skipping ${issueRaw}\n`);
		return "skipped";
	}
	const issueId = sanitizeIssueId(issueRaw);
	if (!issueId) {
		stderr.write(`cannot derive an issue id from: ${issue.line}\n`);
		ctx.failed.push(issue.line);
		return "failed";
	}
	const work = join(ctx.pipelineDir, "work", issueId);
	mkdirSync(work, { recursive: true });

	let ctrlAttempts = 0;
	let masterAttempts = 0;
	if (!flags.dryRun) {
		// init reads the contract for the tree budget. Resume: counters come
		// back from the state file, not from this run.
		initState(ctx.pipelineDir, root, config);
		setIssueStatus(ctx.pipelineDir, root, issueId);
		const a = attemptsOf(ctx.pipelineDir, root, issueId);
		ctrlAttempts = a.controller;
		masterAttempts = a.master;
		if (a.status === "blocked" || a.status === "done") {
			stdout.write(`skip ${issueId} (status: ${a.status})\n`);
			return a.status;
		}
		// An interrupted split: the parent is not implemented again, its open
		// children are, and the parent closes when every child is done.
		if (a.status === "split") {
			const children = await openChildren(ctx, { issueRaw, root });
			stderr.write(`resuming split ${issueId}: ${children.length} open sub-issue(s)\n`);
			return finishChildren(ctx, { issue, issueId, issueRaw, root, depth: a.depth ?? depth, work, children });
		}
	}
	const exclusionsFile = join(work, "exclusions.md");
	const findingsFile = join(work, "findings.md");
	if (!existsSync(exclusionsFile)) writeFileSync(exclusionsFile, ""); // resume keeps tool output of earlier attempts
	if (!existsSync(findingsFile)) writeFileSync(findingsFile, ""); // gate findings: never displaced by the line cap
	// A fresh issue should start from a clean tree. Whatever already differs
	// from HEAD lands in this issue's review diff and is judged as its work.
	if (!flags.dryRun && ctrlAttempts + masterAttempts === 0) {
		const paths = implementationChanges(ctx, join(work, "preexisting.patch"));
		if (paths.length > 0) {
			stderr.write(`warning: the working tree already differs from HEAD before the first attempt of ${issueId}; those changes will be reviewed as this issue's work — commit or stash them first: ${paths.join(" ")}\n`);
		}
	}
	// stderr once per issue: the run log records every attempt, the operator
	// does not need the same warning on every retry.
	let independenceWarned = false;
	let panelShortStreak = 0;
	// Consecutive implementer processes that exited non-zero and wrote
	// nothing: a harness or credential problem, not six attempts' worth of
	// quality signal.
	let harnessFailStreak = 0;
	const researchFile = join(work, "research.md");

	for (;;) {
		// Research runs once per issue and is cached. take_over deletes the
		// file so the next pass does not inherit the failed approach — that
		// regeneration must happen inside the loop, not only before it.
		if (!existsSync(researchFile) || readFileSync(researchFile).length === 0) {
			const before = flags.dryRun ? null : governanceSnapshot(ctx, work);
			await runRole(ctx, {
				root,
				issueId,
				role: "research",
				prompt: buildResearchPrompt({
					issueLine,
					soulFile: ctx.soulFile,
					memoryFile: ctx.memoryFile,
					issueId,
					historyMax: ctx.blockerHistoryMax,
					historyMaxBytes: ctx.blockerHistoryMaxBytes,
				}),
				outPath: researchFile,
			});
			if (before) integrityCheck(ctx, before, "research", work, ctrlAttempts + masterAttempts, issueId, root);
		}
		if (ctx.maxRuns !== null && ctx.globalRuns >= ctx.maxRuns) {
			stderr.write(`global --max-runs ${ctx.maxRuns} reached; stopping ${issueId}\n`);
			return "skipped";
		}
		// Budget is checked before the attempt, never after.
		if (!flags.dryRun) {
			let budget;
			try {
				budget = budgetOf(ctx.pipelineDir, root);
			} catch (error) {
				stderr.write(`state store error: budget check failed (${error.message})\n`);
				ctx.failed.push(issueId);
				return "failed";
			}
			if (budget.exhausted) {
				blockIssue({
					pipelineDir: ctx.pipelineDir,
					root,
					issueId,
					reason: `Tree budget exhausted after ${ctrlAttempts} controller and ${masterAttempts} master attempts.`,
					memoryFile: ctx.memoryFile,
					stderr,
				});
				stashBlocked(ctx, { issueId, work });
				ctx.failed.push(issueId);
				return "failed";
			}
		}

		const attemptN = ctrlAttempts + masterAttempts + 1;
		const att = attemptTag(attemptN);
		let role = "implement";
		let left = ctx.maxCtrl - ctrlAttempts;
		if (ctrlAttempts >= ctx.maxCtrl) {
			role = "implement_master";
			left = ctx.maxMaster - masterAttempts;
			if (masterAttempts >= ctx.maxMaster) {
				// The blocker is what the next attempt must not repeat: the
				// review findings (prose, no line numbers) and only the tail of
				// the tool log — not the whole log, which re-enters every later
				// prompt via MEMORY.md.
				blockIssue({
					pipelineDir: ctx.pipelineDir,
					root,
					issueId,
					reason: `Rejected at master review ${masterAttempts} times.\n\nUnresolved review findings:\n${readText(findingsFile)}\n\nLast tool output and master notes:\n${tailLines(readText(exclusionsFile), 40)}`,
					memoryFile: ctx.memoryFile,
					stderr,
				});
				stashBlocked(ctx, { issueId, work });
				ctx.failed.push(issueId);
				return "failed";
			}
		}

		// A role must leave HEAD unchanged, even when some edits remain uncommitted.
		const headBefore = hasHead(ctx.root) ? git(ctx.root, ["rev-parse", "HEAD"]).stdout.toString("utf8").trim() : "";
		const before = flags.dryRun ? null : governanceSnapshot(ctx, work);
		const impl = await runRole(ctx, {
			root,
			issueId,
			role,
			prompt: buildImplementPrompt({
				issueLine,
				researchFile,
				exclusionsText: readText(exclusionsFile),
				exclusionsMaxLines: ctx.exclusionsMaxLines,
				attemptsLeft: left,
				findingsText: readText(findingsFile),
				issueId,
				soulFile: ctx.soulFile,
				memoryFile: ctx.memoryFile,
				historyMax: ctx.blockerHistoryMax,
				historyMaxBytes: ctx.blockerHistoryMaxBytes,
			}),
			outPath: join(work, "implement.log"),
			attemptTagText: att,
		});
		if (role === "implement") ctrlAttempts++;
		else masterAttempts++;
		ctx.globalRuns++;
		if (!flags.dryRun) recordAttempt(ctx.pipelineDir, root, issueId, role === "implement" ? "controller" : "master");
		const attemptNo = ctrlAttempts + masterAttempts;
		const integrityOk = !before || integrityCheck(ctx, before, role, work, attemptNo, issueId, root);
		if (!flags.dryRun) {
			const headAfter = hasHead(ctx.root) ? git(ctx.root, ["rev-parse", "HEAD"]).stdout.toString("utf8").trim() : "";
			if (headBefore !== headAfter) {
				const reason = `HEAD moved during ${role} (${headBefore.slice(0, 7)} -> ${headAfter.slice(0, 7) || "missing"}); committed changes have not been reviewed`;
				ctx.haltReason = reason;
				ctx.haltAdvice = "Inspect the unexpected commits and restore a reviewed baseline before starting another run.";
				blockIssue({ pipelineDir: ctx.pipelineDir, root, issueId, reason, memoryFile: ctx.memoryFile, stderr });
				ctx.logger.logEvent({ root, issue: issueId, role, model: ctx.models[role] ?? "default", status: "head-moved", prompt: "-", note: reason });
				ctx.failed.push(issueId);
				// Preserve commits and uncommitted work for inspection. Continuing or
				// stashing against the new HEAD would hide the unreviewed changes.
				return "failed";
			}
		}
		if (!integrityOk) continue;

		// Deterministic gates first. A gate failure must not consume a review
		// cycle. The failure output goes into exclusions.md — without it the
		// retry re-runs the identical prompt, learns nothing, and burns the
		// whole tree budget.
		if (!flags.dryRun) {
			let gateFailed = false;
			for (const gate of ctx.gates) {
				const r = await runShell(gate.run, { cwd: ctx.root, env: ctx.childEnv, timeoutMs: ctx.gateTimeoutSeconds * 1000 });
				const log = join(work, `${gate.name}.log`);
				writeFileSync(log, r.combined);
				if (!r.timedOut && r.status === 0) continue;
				const what = r.timedOut ? `timed out after ${ctx.gateTimeoutSeconds}s` : "failed";
				stderr.write(`${gate.name} ${what}; feeding the output back and retrying implementation\n`);
				// Head and tail of the log: a test runner prints its summary last.
				appendFileSync(exclusionsFile, `--- ${gate.name} ${what} (attempt ${attemptNo}) ---\n${headTail(r.combined.toString("utf8"), 20, 60)}\n\n`);
				gateFailed = true;
				break;
			}
			if (gateFailed) continue;
		}

		const diffFile = join(work, "diff.patch");
		captureDiff({ root: ctx.root, out: diffFile, maxBytes: ctx.diffMaxBytes, harnessRel: ctx.harnessRel });

		// Empty diff is fail-closed: "nothing to find" is not "no findings".
		if (!flags.dryRun && readFileSync(diffFile).length === 0) {
			const harnessFailed = !impl.timedOut && impl.status !== 0;
			const exitNote = `exited ${impl.status}${impl.firstLine ? ` (${impl.firstLine})` : ""}`;
			let reason;
			if (impl.timedOut) {
				reason = `The implementer timed out after ${ctx.roleTimeoutSeconds}s and the working tree was unchanged.`;
			} else if (harnessFailed) {
				reason = `The implementer process ${exitNote} and the working tree was unchanged. That is a harness or credential problem, not an implementation attempt.`;
			} else {
				reason = "The working tree was unchanged. Leave the implementation uncommitted.";
			}
			harnessFailStreak = harnessFailed ? harnessFailStreak + 1 : 0;
			stderr.write("empty diff; retrying implementation\n");
			appendFileSync(exclusionsFile, `--- attempt ${attemptNo} (empty diff) ---\n${reason}\n\n`);
			if (harnessFailStreak >= 2) {
				const why = `Configuration error: two consecutive implementation attempts ended with the harness process having ${exitNote} and an unchanged working tree. This is a harness or credential problem, not a code-quality signal. Check the harness binary, the model ids in ${ctx.agentsFile} and the API keys; the harness's stderr is kept under ${work}.`;
				stderr.write(`${why}\n`);
				blockIssue({ pipelineDir: ctx.pipelineDir, root, issueId, reason: why, memoryFile: ctx.memoryFile, stderr });
				stashBlocked(ctx, { issueId, work });
				ctx.failed.push(issueId);
				return "failed";
			}
			continue;
		}
		harnessFailStreak = 0;
		const diffText = readFileSync(diffFile, "utf8");

		// Three reviewers, three processes, in parallel, no shared verdicts.
		// no_self_review: the model that wrote the diff never reviews it. Two
		// roles that both resolve to "default" are in fact the same model, but
		// the drop compares refs and an unset ref carries no identity to
		// compare, so it cannot fire on exactly that pair. `ran` records
		// exactly the reviewers started in THIS attempt — gate, controller,
		// master and the retry loop consume this list, never a directory glob.
		const implModel = ctx.models[role] ?? "default";
		const ran = [];
		let unmappedN = 0;
		const launches = [];
		for (const focus of ["security", "quality", "correctness"]) {
			const rmodel = ctx.models[`review.${focus}`] ?? "default";
			if (rmodel === "default") unmappedN++;
			const rfile = join(work, `review-${focus}.json`);
			if (ctx.noSelfReview && implModel !== "default" && modelIdentity(rmodel) === modelIdentity(implModel)) {
				stderr.write(`no_self_review: reviewer ${focus} dropped — ${rmodel} implemented this diff\n`);
				ctx.logger.logEvent({ root, issue: issueId, role: `review.${focus}`, model: rmodel, status: "dropped-self-review", prompt: "-" });
				// A leftover file is a verdict on a different diff by a reviewer
				// that is now disqualified. Remove it so nothing downstream reads it.
				if (!flags.dryRun) rmSync(rfile, { force: true });
				continue;
			}
			ran.push({ focus, file: rfile });
			launches.push(
				runRole(ctx, {
					root,
					issueId,
					role: `review.${focus}`,
					prompt: buildReviewPrompt({ focus, issueLine, diffText, soulFile: ctx.soulFile }),
					outPath: rfile,
					attemptTagText: att,
				}),
			);
		}
		await Promise.all(launches);
		const ranN = ran.length;

		// Three states, three sentences. Never a default that claims a check
		// which did not run.
		let independenceNote;
		if (!ctx.noSelfReview) independenceNote = "Panel independence: no_self_review is off; independence is not checked.";
		else if (ranN === 0) independenceNote = "Panel independence: no reviewer ran this attempt; the decision rests on the deterministic gate.";
		else if (unmappedN > 0) {
			independenceNote = `Panel independence: ${unmappedN} of ${ranN} reviewers ran on pi's unmapped default model, which may be the model that wrote this diff. Independence is not verified for this attempt — weigh the reviewer agreement accordingly.`;
		} else independenceNote = "Panel independence: every reviewer ran on an explicitly mapped model.";
		if (!independenceWarned) {
			if (!ctx.noSelfReview) {
				stderr.write(`warning: ${independenceNote}\n`);
				if (unmappedN > 0) ctx.logger.logEvent({ root, issue: issueId, role: "review", model: "default", status: "independence-unverified", prompt: "-" });
			} else if (ranN === 0) {
				stderr.write(`warning: ${independenceNote}\n`);
			} else if (unmappedN > 0) {
				stderr.write(`warning: ${unmappedN} of ${ranN} reviewers are unmapped (default model); no_self_review cannot verify independence — map models.review.* in ${ctx.agentsFile}\n`);
				ctx.logger.logEvent({ root, issue: issueId, role: "review", model: "default", status: "independence-unverified", prompt: "-" });
			}
			independenceWarned = true;
		}

		if (flags.dryRun) {
			stdout.write(`[dry-run] stopping after one pass for ${issueId}\n`);
			return "dry-run";
		}

		// One retry per reviewer whose output is not parseable JSON. Still
		// unparseable afterwards: the gate treats the reviewer as unavailable
		// and gates on the rest — down to MIN_REVIEWERS, below which it blocks.
		// The retry is a fresh process with no memory of the first pass; a
		// cleaner parse that carries less severe findings is not a better
		// review, it is a lost finding — strictest wins here as everywhere.
		for (const r of ran) {
			if (!existsSync(r.file)) continue;
			const check = checkReviewerText(readText(r.file));
			if (check.exit === 0) continue;
			stderr.write(`reviewer ${r.focus} did not return a usable verdict; one retry with an explicit reminder\n`);
			const retryFile = `${r.file}.retry`;
			await runRole(ctx, {
				root,
				issueId,
				role: `review.${r.focus}`,
				prompt: buildReviewPrompt({ focus: r.focus, issueLine, diffText, soulFile: ctx.soulFile }) + REVIEW_REMINDER,
				outPath: retryFile,
				attemptTagText: `${att}-retry`,
			});
			const again = existsSync(retryFile) ? checkReviewerText(readText(retryFile)) : { exit: 1, worst: -1 };
			if (rankOfCheck(again.exit) > rankOfCheck(check.exit) && again.worst >= check.worst) {
				stderr.write(`reviewer ${r.focus} retry taken (check ${check.exit} -> ${again.exit}, worst severity rank ${check.worst} -> ${again.worst})\n`);
				writeFileSync(r.file, readText(retryFile));
			} else {
				stderr.write(`reviewer ${r.focus} retry discarded (check ${check.exit} -> ${again.exit}, worst severity rank ${check.worst} -> ${again.worst}); keeping the original\n`);
			}
			rmSync(retryFile, { force: true });
			rmSync(`${retryFile}.stderr`, { force: true });
		}

		// Gate, controller, and master consume exactly this attempt's reviewers.
		let gateStatus = 0;
		let reviewersJson;
		const gateFile = join(work, "gate.json");
		if (ranN > 0) {
			const g = runGate({ files: ran.map((r) => r.file), blocking: ctx.blocking, followup: ctx.followup, minReviewers: ctx.minReviewers });
			writeFileSync(gateFile, `${JSON.stringify(g.result, null, 2)}\n`);
			gateStatus = g.exit;
			const concat = Buffer.concat(ran.map((r) => (existsSync(r.file) ? readFileSync(r.file) : Buffer.alloc(0))));
			writeFileSync(join(work, "reviewers.json"), concat);
			reviewersJson = concat.toString("utf8");
			if (concat.length > ctx.reviewersMaxBytes) {
				const trunc = Buffer.concat([
					concat.subarray(0, ctx.reviewersMaxBytes),
					Buffer.from(`\n[reviewer JSON truncated at ${ctx.reviewersMaxBytes} bytes; full files are in ${work}]\n`),
				]);
				writeFileSync(join(work, "reviewers.trunc"), trunc);
				reviewersJson = trunc.toString("utf8");
			}
		} else {
			// Every reviewer was dropped this attempt. Gating on nothing is not a gate.
			writeFileSync(gateFile, `${JSON.stringify(allDroppedGate(ctx.minReviewers))}\n`);
			gateStatus = 4;
			reviewersJson = "(no reviewer output: every reviewer was dropped by no_self_review in this attempt)";
		}

		// Two consecutive attempts below MIN_REVIEWERS are a broken setup, not a
		// quality signal. Abort before controller and master of the second.
		let reviewersUsed = 0;
		try {
			reviewersUsed = Number(JSON.parse(readText(gateFile)).reviewers_used) || 0;
		} catch {}
		panelShortStreak = reviewersUsed < ctx.minReviewers ? panelShortStreak + 1 : 0;
		if (panelShortStreak >= 2) {
			const reason = `Configuration error: two consecutive attempts had fewer than ${ctx.minReviewers} parseable reviewers (last attempt: ${reviewersUsed}). This is a broken review setup, not a code-quality signal. Map models.review.* in ${ctx.agentsFile} and ensure reviewers emit JSON.`;
			stderr.write(`${reason}\n`);
			blockIssue({ pipelineDir: ctx.pipelineDir, root, issueId, reason, memoryFile: ctx.memoryFile, stderr });
			stashBlocked(ctx, { issueId, work });
			ctx.failed.push(issueId);
			return "failed";
		}

		// The controller proposes on a weak model; the master decides and sees
		// the original reviewer JSON, so an aggregation error is catchable.
		const controllerFile = join(work, "controller.json");
		await runRole(ctx, {
			root,
			issueId,
			role: "controller",
			prompt: buildControllerPrompt({ blocking: ctx.blocking.join(","), reviewersJson }),
			outPath: controllerFile,
			attemptTagText: att,
		});
		const splitAllowed = depth < ctx.maxSplitDepth && typeof ctx.issueSource.create === "function";
		const masterFile = join(work, "master.txt");
		await runRole(ctx, {
			root,
			issueId,
			role: "master_review",
			prompt: buildMasterPrompt({
				issueLine,
				diffText,
				reviewersJson,
				controllerText: readText(controllerFile),
				gateJson: readText(gateFile),
				independenceNote,
				attempt: attemptNo,
				splitAllowed,
			}),
			outPath: masterFile,
			attemptTagText: att,
		});

		const verdict = parseMasterDecision(readText(masterFile));
		let decision = verdict.decision;
		if (verdict.note) stderr.write(`master review: ${verdict.note}\n`);
		if (decision === "split" && !splitAllowed) {
			stderr.write(`master review asked to split ${issueId}, but ${depth >= ctx.maxSplitDepth ? `max_split_depth (${ctx.maxSplitDepth}) is reached` : "the issue source cannot create sub-issues"}; treating it as reject\n`);
			appendFileSync(exclusionsFile, `--- attempt ${attemptNo} (split refused) ---\nThe master asked to split this issue, which is not possible here. Solve it in one diff.\n\n`);
			decision = "reject";
		}

		if (decision === "approve" && gateStatus === 0) {
			setIssueStatus(ctx.pipelineDir, root, issueId, "done");
			stdout.write(`approved: ${issueId}\n`);
			await ctx.issueSource.markDone(issueRaw);
			if (ctx.commitApproved) {
				commitApproval(ctx, { issueId, issueLine: issue.line, pathsFile: `${diffFile}.paths` });
			} else {
				ctx.haltReason = `COMMIT_APPROVED=0: approved work of ${issueId} is left uncommitted`;
			}
			if (flags.autoMerge) stderr.write("auto-merge: not implemented in the reference script — adapt this step\n");
			return "done";
		}

		if (decision === "split") {
			return splitIssue(ctx, { issue, issueId, issueRaw, root, depth, work, subIssues: verdict.split, findingsFile, exclusionsFile, attemptNo, decision });
		}

		if (decision === "take_over") {
			stderr.write("master review takes over: implement_master re-implements from the issue, with the findings so far attached\n");
			// Controller retries repair in place. take_over promised a fresh
			// start — stash the rejected tree so the stronger model does not
			// inherit it.
			stashRejectedTree({ root: ctx.root, workDir: work, preserve: ctx.preserve, message: `pipeline: pre-take_over ${issueId}-${ctx.runId}`, stderr });
			ctrlAttempts = ctx.maxCtrl;
			escalate(ctx.pipelineDir, root, issueId, config);
			// The cached research shaped the failed approach. Drop it so the
			// master path gathers context again instead of inheriting it.
			rmSync(researchFile, { force: true });
		}

		appendFileSync(findingsFile, `--- attempt ${attemptNo} (decision: ${decision}) ---\n${findingsToProse(gateFile)}`);
		appendFileSync(exclusionsFile, `--- attempt ${attemptNo} (decision: ${decision}) ---\n--- master ---\n${excerpt(masterFile, 40)}\n`);
	}
}

// The master split the issue: create the children in the issue source,
// register them in the parent's tree (same budget, attempts of their own),
// and run them now. The parent is done when every child is.
async function splitIssue(ctx, { issue, issueId, issueRaw, root, depth, work, subIssues, findingsFile, exclusionsFile, attemptNo }) {
	const { stderr } = ctx;
	const children = [];
	for (const sub of subIssues) {
		const childRaw = await ctx.issueSource.create({ parentRaw: issueRaw, parentId: issueId, title: sub.title, text: sub.text });
		const childId = sanitizeIssueId(childRaw);
		const bodyDir = join(ctx.pipelineDir, "work", root, "issues");
		mkdirSync(bodyDir, { recursive: true });
		if (sub.text) writeFileSync(join(bodyDir, `${childId}.md`), `${sub.text}\n`);
		children.push({ raw: childRaw, id: childId, line: `${childRaw}: ${sub.title}`, title: sub.title, text: sub.text, parent: issueRaw, indent: 2 });
	}
	registerSplit(ctx.pipelineDir, root, issueId, children.map((c) => c.id));
	stderr.write(`master review splits ${issueId} into ${children.length} sub-issues: ${children.map((c) => c.raw).join(", ")}\n`);
	appendFileSync(findingsFile, `--- attempt ${attemptNo} (decision: split) ---\n${findingsToProse(join(work, "gate.json"))}`);
	appendFileSync(exclusionsFile, `--- attempt ${attemptNo} (decision: split into ${children.map((c) => c.raw).join(", ")}) ---\n`);
	// The rejected tree of the parent is not the starting point of a child.
	stashRejectedTree({ root: ctx.root, workDir: work, preserve: ctx.preserve, message: `pipeline: pre-split ${issueId}-${ctx.runId}`, stderr });
	return finishChildren(ctx, { issue, issueId, issueRaw, root, depth, work, children });
}

// The open children of a split parent, as the issue source lists them now,
// with the bodies written at split time.
async function openChildren(ctx, { issueRaw, root }) {
	const list = await ctx.issueSource.list();
	return list
		.filter((i) => i.parent === issueRaw)
		.map((i) => ({ ...i, id: sanitizeIssueId(i.raw), text: readChildBody(ctx, root, sanitizeIssueId(i.raw)) }));
}

// Run the children of a split (fresh or resumed), then close the parent
// when the state file shows every child done. A halt stops before the next
// child; a child that did not finish leaves the parent blocked.
async function finishChildren(ctx, { issue, issueId, issueRaw, root, depth, work, children }) {
	const { stderr, stdout } = ctx;
	for (const child of children) {
		if (ctx.haltReason) break;
		stdout.write(`=== ${child.raw} (child of ${issueRaw}) ===\n`);
		await processIssue(ctx, child, { root, depth: depth + 1 });
	}
	if (ctx.haltReason) {
		stderr.write(`split ${issueId} left open: the run stopped before the parent could be closed\n`);
		return "halted";
	}
	if (allChildrenDone(ctx, root, issueId)) {
		setIssueStatus(ctx.pipelineDir, root, issueId, "done");
		stdout.write(`approved: ${issueId} (all sub-issues done)\n`);
		await ctx.issueSource.markDone(issueRaw);
		if (ctx.commitApproved && ctx.issueRel) {
			commitApproval(ctx, { issueId, issueLine: `${issue.line} (split closed)`, pathsFile: join(work, "none.paths") });
		}
		return "done";
	}
	setIssueStatus(ctx.pipelineDir, root, issueId, "blocked");
	stderr.write(`blocked: ${issueId} — not every sub-issue finished\n`);
	ctx.failed.push(issueId);
	return "failed";
}
