import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupDeadlineCase } from "./fixture-custody.ts";

export type DeadlineScenario = "startup" | "parallel" | "stubborn" | "pending" | "late-registration" | "success" | "dynamic-startup" | "dynamic-acceptance";
export interface DeadlineEvidence {
	root: string;
	kind: DeadlineScenario;
	nonce: string;
	id: string;
	payload: any;
	status: any;
	config: any;
	observations: any[];
	markers: any[];
	events: any[];
	callCount: number;
	wholeLaunchMs: number;
	terminationMs?: number;
	beforeExpiry?: any[];
	armed?: any;
	preload?: any;
}

function readJson(file: string) { return JSON.parse(fs.readFileSync(file, "utf8")); }

/** Fresh launcher environment BEFORE any launcher/types imports; no ambient clock selector. */
export async function runDeadlineScenario(kind: DeadlineScenario, delayBeforeDeadlineMs = 0): Promise<DeadlineEvidence> {
	assert.ok(Number.isInteger(delayBeforeDeadlineMs) && delayBeforeDeadlineMs >= 0 && delayBeforeDeadlineMs <= 10_000);
	assert.ok(delayBeforeDeadlineMs === 0 || kind === "dynamic-acceptance", "delayed callback control belongs only to the aggregate test driver");
	const parent = process.env.CRA879_EVIDENCE_DIR ?? os.tmpdir();
	const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, `deadline-${kind}-`)));
	const env: Record<string, string> = { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`, JITI_FS_CACHE: "true" };
	for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key]!;
	for (const name of ["home", "tmp", "cache", "config", "appdata", "localappdata"]) fs.mkdirSync(path.join(root, name));
	Object.assign(env, { HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
		TMPDIR: path.join(root, "tmp"), TEMP: path.join(root, "tmp"), TMP: path.join(root, "tmp"),
		XDG_CACHE_HOME: path.join(root, "cache"), XDG_CONFIG_HOME: path.join(root, "config"),
		APPDATA: path.join(root, "appdata"), LOCALAPPDATA: path.join(root, "localappdata"),
		CRA879_TEST_CHANNEL: root,
	});
	const entry = fileURLToPath(new URL(kind.startsWith("dynamic-") ? "./dynamic-deadline-scenario.ts" : "./deadline-scenario.ts", import.meta.url));
	const child = spawn(process.execPath, ["--experimental-transform-types", entry, kind, root, String(delayBeforeDeadlineMs)], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	let stdout = "", stderr = "";
	child.stdout.on("data", (b) => { stdout += b; });
	child.stderr.on("data", (b) => { stderr += b; });
	let watchdog = false;
	let cleanup: Promise<unknown> | undefined;
	const recordCleanup = () => cleanupDeadlineCase(root).catch((error) => {
		fs.writeFileSync(path.join(root, "outer-cleanup-error.json"), JSON.stringify({ failed: true, error: String(error) }));
	});
	const timer = setTimeout(() => {
		watchdog = true;
		fs.writeFileSync(path.join(root, "outer-watchdog.json"), JSON.stringify({ failed: true, at: Date.now(), launcherPid: child.pid }));
		cleanup = recordCleanup().finally(() => child.kill("SIGKILL"));
	}, 40_000);
	const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }).finally(() => clearTimeout(timer));
	if (code !== 0 || watchdog) {
		fs.writeFileSync(path.join(root, "outer-failure.json"), JSON.stringify({ failed: true, at: Date.now(), code, watchdog }));
		await (cleanup ?? recordCleanup());
	}
	fs.writeFileSync(path.join(root, "launcher.stdout.txt"), stdout);
	fs.writeFileSync(path.join(root, "launcher.stderr.txt"), stderr);
	fs.writeFileSync(path.join(root, "launcher-exit.json"), JSON.stringify({ code, watchdog }));
	assert.equal(watchdog, false, `outer watchdog: ${root}`);
	assert.equal(code, 0, `${kind} failed; retained ${root}\n${stderr}\n${stdout}`);
	return readJson(path.join(root, "evidence.json"));
}

export function assertActiveTermination(e: DeadlineEvidence, count: number, stubborn = false): void {
	const ready = e.markers.filter((m) => m.type === "ready");
	const deadline = e.observations.filter((m) => m.type === "deadline-fired");
	assert.equal(ready.length, count);
	assert.equal(deadline.length, 1);
	assert.equal(deadline[0].nonce, e.nonce);
	assert.equal(deadline[0].runId, e.id);
	assert.deepEqual(ready.map((m) => m.stepIndex).sort((a, b) => a - b), Array.from({ length: count }, (_, i) => i));
	assert.equal(e.events.filter((m) => m.type === "subagent.run.timed_out").length, 1);
	assert.equal(e.config.timeoutMs, 1_500);
	assert.equal(e.armed.now, e.config.deadlineAt - 1_300, "declared 200ms startup is charged");
	assert.deepEqual(e.armed.delays, [1_300]);
	assert.equal(e.beforeExpiry?.filter((m) => m.type === "deadline-fired" || m.type === "child-exit").length, 0);
	assert.equal(e.callCount, count);
	assert.equal(e.markers.some((m) => m.type === "watchdog" || m.type === "natural-exit"), false);
	assert.equal(e.payload.success, false);
	assert.equal(e.payload.exitCode, 1);
	assert.equal(e.payload.deadlineAt, e.config.deadlineAt);
	assert.equal(e.payload.timeoutMs, 1_500);
	assert.equal(e.status.deadlineAt, e.config.deadlineAt);
	assert.equal(e.status.timeoutMs, 1_500);
	assert.equal(e.observations.filter((m) => m.type === "child-spawn").length, count, "no fallback/additional attempt");
	for (const m of ready) {
		const identity = (x: any) => x.pid === m.pid && x.ppid === m.ppid && x.runId === e.id && x.stepIndex === m.stepIndex && x.agent === m.agent && x.attempt === m.attempt;
		const spawn = e.observations.find((x) => x.type === "child-spawn" && identity(x));
		assert.ok(spawn, `missing native spawn identity for ${m.pid}`);
		assert.equal(m.nonce, e.nonce);
		assert.equal(m.runId, e.id);
		assert.equal(m.agent, e.status.steps[m.stepIndex].agent);
		assert.equal(m.attempt, 0);
		assert.equal(m.disposition, stubborn ? "ignore-SIGTERM" : "default");
		assert.ok(m.callFile.startsWith(e.root + path.sep));
		assert.equal(spawn.model?.split(":")[0], m.model?.split(":")[0]);
		assert.ok(m.at <= deadline[0].at);
		for (const type of ["child-exit", "child-close"]) {
			const native = e.observations.filter((x) => x.type === type && identity(x));
			assert.equal(native.length, 1, `${type} required for PID ${m.pid}`);
			assert.ok(native[0].at >= deadline[0].at, "natural exit before timeout cannot count");
			if (process.platform !== "win32") assert.equal(native[0].signal, stubborn ? "SIGKILL" : "SIGTERM");
			else assert.ok(typeof native[0].signal === "string" || (typeof native[0].code === "number" && native[0].code !== 0), "Windows must report native unsuccessful termination");
		}
		if (stubborn && process.platform !== "win32") {
			const soft = e.markers.filter((x) => x.type === "sigterm" && x.pid === m.pid && x.nonce === e.nonce);
			assert.equal(soft.length, 1, "positive installed-handler receipt, not a timedOut payload");
			const exit = e.observations.find((x) => x.type === "child-exit" && identity(x));
			assert.ok(soft[0].at >= deadline[0].at && exit.at - soft[0].at >= 2_500, "child survives TERM until native escalation");
		}
	}
	assert.equal(e.payload.results.some((r: any) => r.success || r.acceptance?.status === "verified" || r.output?.includes("too late")), false);
}
