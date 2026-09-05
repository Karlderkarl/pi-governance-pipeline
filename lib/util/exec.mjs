// exec.mjs — process launching for the pipeline.
//
// Two shapes: an executable with arguments and a prompt on stdin (the
// harness), and a shell command line (gates, `!command` issue sources). The
// shell is bash where one exists, which keeps the 1.0.x semantics on every
// platform including Git Bash on Windows; `PIPELINE_SHELL` overrides it.
//
// Timeouts end the whole process tree, not only the direct child: a harness
// that started `npm test` and hangs must not keep the loop waiting on the
// grandchild that still holds stdout. Every launch therefore runs in its own
// process group (POSIX) or is ended with `taskkill /T` (Windows), and the
// result is settled on `exit` plus a short grace period for the pipes, never
// on `close` alone.
//
// On Windows, Node cannot start a script that has no extension, and refuses
// .cmd/.bat without a shell. `resolveCommand` reads the shebang of an
// extensionless file and launches its interpreter — that is how the npm shim
// of `pi` and the stub `pi` of the test suite both run under Node — and
// launches .cmd/.bat through an explicit `cmd.exe /d /s /c` with a quoted
// command line, never through `shell: true`.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";

export const isWindows = process.platform === "win32";

// Pipes may outlive the child when a grandchild inherited them; after `exit`
// this is how long stdout is still drained before the result is settled.
export const EXIT_GRACE_MS = 500;

function isFile(p) {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

function shebangOf(file) {
	try {
		const head = readFileSync(file, { encoding: "utf8", flag: "r" }).slice(0, 200);
		if (!head.startsWith("#!")) return null;
		return head.split(/\r?\n/)[0].slice(2).trim();
	} catch {
		return null;
	}
}

let bashCache;
function bashOnPath(env) {
	if (bashCache !== undefined) return bashCache;
	bashCache = findRaw("bash", env, [".exe", ""]) ?? findRaw("sh", env, [".exe", ""]);
	return bashCache;
}

function findRaw(name, env, exts) {
	const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
	for (const dir of dirs) {
		for (const ext of exts) {
			const p = join(dir, name + ext);
			if (isFile(p)) return p;
		}
	}
	return null;
}

// First directory on PATH that holds `name` in a launchable form. On
// Windows a native .exe wins; then the extensionless shim (npm writes one
// next to the .cmd), which runs under bash and needs no cmd.exe quoting;
// then .cmd/.bat.
export function findOnPath(name, env = process.env) {
	if (!isWindows) return findRaw(name, env, [""]);
	const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
	const bash = bashOnPath(env);
	for (const dir of dirs) {
		const exe = join(dir, `${name}.exe`);
		if (isFile(exe)) return exe;
		const plain = join(dir, name);
		if (isFile(plain)) {
			const shebang = shebangOf(plain);
			if (shebang && (/\bnode\b/.test(shebang) || bash)) return plain;
		}
		for (const ext of [".cmd", ".bat"]) {
			const p = join(dir, name + ext);
			if (isFile(p)) return p;
		}
	}
	return null;
}

// Turn a name or path into a launch spec for spawnCapture:
// { file, args, cmdScript? } — cmdScript marks a .cmd/.bat that is run via
// cmd.exe with a quoted command line.
export function resolveCommand(name, override, env = process.env) {
	let file = override && override !== "" ? override : findOnPath(name, env);
	if (!file) return null;
	if (!isAbsolute(file) && (file.includes("/") || file.includes("\\"))) file = resolve(file);
	if (!isFile(file)) {
		const onPath = findOnPath(file, env);
		if (!onPath) return null;
		file = onPath;
	}
	const ext = extname(file).toLowerCase();
	if (ext === ".mjs" || ext === ".js" || ext === ".cjs") return { file: process.execPath, args: [file] };
	if (ext === ".cmd" || ext === ".bat") return { file: env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c"], cmdScript: file };
	if (ext === "" || ext === ".sh") {
		const shebang = shebangOf(file);
		if (shebang && /\bnode\b/.test(shebang)) return { file: process.execPath, args: [file] };
		if (isWindows || ext === ".sh") {
			const bash = bashOnPath(env);
			if (bash) return { file: bash, args: [file] };
		}
	}
	return { file, args: [] };
}

// One argument for a cmd.exe command line. Our own arguments are flags and
// model refs; the script path is what usually needs the quotes.
export function quoteForCmd(arg) {
	const s = String(arg);
	if (s === "") return '""';
	if (/^[A-Za-z0-9_\-.:=,/\\@+]+$/.test(s)) return s;
	return `"${s.replace(/"/g, '\\"')}"`;
}

// The shell for command strings. bash keeps gate and issue commands
// portable across the platforms pi itself runs on.
export function resolveShell(env = process.env) {
	if (env.PIPELINE_SHELL) return { file: env.PIPELINE_SHELL, flag: "-c" };
	const bash = findRaw("bash", env, isWindows ? [".exe", ""] : [""]);
	if (bash) return { file: bash, flag: "-c" };
	if (!isWindows && existsSync("/bin/sh")) return { file: "/bin/sh", flag: "-c" };
	const sh = findRaw("sh", env, isWindows ? [".exe", ""] : [""]);
	if (sh) return { file: sh, flag: "-c" };
	if (isWindows) return { file: env.ComSpec ?? "cmd.exe", flag: "/c" };
	return { file: "sh", flag: "-c" };
}

// Children still running; ended when the engine itself is interrupted, so a
// Ctrl-C on the loop does not leave a harness process behind.
const active = new Set();
let signalsHooked = false;
function hookSignals() {
	if (signalsHooked) return;
	signalsHooked = true;
	for (const sig of ["SIGINT", "SIGTERM"]) {
		process.on(sig, () => {
			for (const child of active) killTree(child);
			process.exit(sig === "SIGINT" ? 130 : 143);
		});
	}
}

// End a launch and everything it started.
export function killTree(child) {
	if (!child || child.pid === undefined) return;
	if (isWindows) {
		spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		return;
	}
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		try {
			child.kill("SIGTERM");
		} catch {}
	}
	setTimeout(() => {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {}
	}, 1000).unref();
}

// Launch and capture. Resolves to { status, signal, timedOut, stdout, stderr,
// combined, error }. A timeout ends the process tree and reports timedOut;
// the caller decides what an empty answer means.
export function spawnCapture(spec, { stdin = null, cwd, env = process.env, timeoutMs = 0 } = {}) {
	return new Promise((resolvePromise) => {
		let child;
		const stdoutChunks = [];
		const stderrChunks = [];
		const combined = [];
		let timedOut = false;
		let timer = null;
		let graceTimer = null;
		const empty = () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), combined: Buffer.alloc(0) });
		let file = spec.file;
		let args = spec.args ?? [];
		const options = {
			cwd,
			env,
			stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
			windowsHide: true,
			detached: !isWindows,
		};
		if (spec.cmdScript) {
			// cmd.exe /d /s /c "<line>": /s strips the outer quotes and keeps
			// the inner ones, so the script path may carry spaces.
			const line = [spec.cmdScript, ...args.slice(3)].map(quoteForCmd).join(" ");
			args = [...args.slice(0, 3), `"${line}"`];
			options.windowsVerbatimArguments = true;
		}
		try {
			child = spawn(file, args, options);
		} catch (error) {
			resolvePromise({ status: null, signal: null, timedOut: false, ...empty(), error });
			return;
		}
		hookSignals();
		active.add(child);
		child.stdout?.on("data", (c) => {
			stdoutChunks.push(c);
			combined.push(c);
		});
		child.stderr?.on("data", (c) => {
			stderrChunks.push(c);
			combined.push(c);
		});
		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				killTree(child);
			}, timeoutMs);
		}
		let settled = false;
		const finish = (status, signal, error) => {
			if (settled) return;
			settled = true;
			active.delete(child);
			if (timer) clearTimeout(timer);
			if (graceTimer) clearTimeout(graceTimer);
			// A grandchild that inherited the pipes gets EPIPE from here on
			// instead of a reader that never comes.
			try {
				child.stdout?.destroy();
				child.stderr?.destroy();
			} catch {}
			resolvePromise({
				status,
				signal,
				timedOut,
				stdout: Buffer.concat(stdoutChunks),
				stderr: Buffer.concat(stderrChunks),
				combined: Buffer.concat(combined),
				error: error ?? null,
			});
		};
		child.on("error", (error) => finish(null, null, error));
		child.on("exit", (status, signal) => {
			graceTimer = setTimeout(() => finish(status, signal, null), EXIT_GRACE_MS);
		});
		child.on("close", (status, signal) => finish(status, signal, null));
		if (stdin !== null && child.stdin) {
			child.stdin.on("error", () => {});
			child.stdin.end(stdin);
		}
	});
}

// Run a command line through the shell. Returns the same shape as
// spawnCapture. `combined` keeps stdout and stderr in arrival order, which is
// what a gate log should show.
export function runShell(command, { cwd, env = process.env, timeoutMs = 0, stdin = null } = {}) {
	const sh = resolveShell(env);
	return spawnCapture({ file: sh.file, args: [sh.flag, command] }, { cwd, env, timeoutMs, stdin });
}

// Synchronous git helper: returns { status, stdout (Buffer), stderr }.
export function git(root, args, { input = null } = {}) {
	const r = spawnSync("git", ["-C", root, ...args], { encoding: null, input, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
	return { status: r.status, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr ?? Buffer.alloc(0), error: r.error ?? null };
}

export function gitText(root, args) {
	const r = git(root, args);
	return r.status === 0 ? r.stdout.toString("utf8").trim() : null;
}

export function hasGitBinary() {
	const r = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
	return !r.error && r.status === 0;
}

export function isGitWorkTree(root) {
	const r = git(root, ["rev-parse", "--is-inside-work-tree"]);
	return r.status === 0 && r.stdout.toString("utf8").trim() === "true";
}

export function hasHead(root) {
	return git(root, ["rev-parse", "--verify", "HEAD"]).status === 0;
}
