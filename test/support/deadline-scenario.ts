import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createAsyncExecutors, executeAsyncChain, executeAsyncSingle, isAsyncAvailable } from "../../src/runs/background/async-execution.ts";
import { ASYNC_DIR, RESULTS_DIR, TEMP_ROOT_DIR } from "../../src/shared/types.ts";
import { deliverTimeoutRequest } from "../../src/runs/background/control-channel.ts";
import { ManualDeadlineClock } from "./manual-deadline-clock.ts";
import { createMockPi } from "./mock-pi.ts";
import type { DeadlineScenario } from "./deadline-harness.ts";

const kind = process.argv[2] as DeadlineScenario;
const root = process.argv[3];
const nonce = randomUUID();
const id = `deadline-${kind}-${nonce}`;
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
function atomic(name: string, value: unknown) {
	fs.writeFileSync(path.join(root, `${name}.tmp`), JSON.stringify(value));
	fs.renameSync(path.join(root, `${name}.tmp`), path.join(root, name));
}
function observations(): any[] {
	const file = path.join(root, "observations.jsonl");
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}
function markers(): any[] {
	return fs.readdirSync(root).filter((name) => name.startsWith("fixture-") && name.endsWith(".json")).map(read);
}
function assertNoHarnessFailure() {
	for (const name of ["barrier-failure.json", "driver-failure.json", "outer-watchdog.json"]) assert.equal(fs.existsSync(path.join(root, name)), false, name);
	assert.equal(markers().some((m) => m.type === "watchdog"), false, "fixture watchdog already failed");
}
async function waitFor(predicate: () => boolean, why: string, ms = 20_000) {
	const end = Date.now() + ms;
	while (!predicate()) {
		assertNoHarnessFailure();
		assert.ok(Date.now() < end, `watchdog waiting for ${why}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assertNoHarnessFailure();
}
function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

assert.equal(isAsyncAvailable(), true, "Jiti is required; no skip");
for (const p of [TEMP_ROOT_DIR, ASYNC_DIR, RESULTS_DIR]) assert.ok(p.startsWith(path.join(root, "tmp") + path.sep), `unowned artifact root ${p}`);
assert.equal(process.env.HOME, path.join(root, "home"));
atomic("identity.json", { kind, id, nonce });
const mock = createMockPi({ rootDir: path.join(root, "mock"), preserve: true });
mock.install();
const nativeStartup = kind === "startup";
const late = kind === "late-registration";
const activeCount = kind === "parallel" || kind === "pending" ? 2 : 1;
const names = kind === "parallel" ? ["one", "two"] : kind === "pending" ? ["one", "two", "pending"] : [kind === "stubborn" ? "stubborn" : "worker"];
for (const name of names) {
	mock.onCall({
		matchArgIncludes: `Wait for ${name}`,
		output: kind === "success" ? "success" : "too late",
		delay: kind === "stubborn" ? 60_000 : 5_000,
		ignoreSigterm: kind === "stubborn",
		...(kind !== "success" ? { deadlineFixture: { root, nonce, runId: id, hold: nativeStartup || late ? "before-ready" as const : "after-ready" as const, ignoreSigterm: kind === "stubborn" } } : { delay: 0 }),
	});
}
const makeAgent = (name: string) => ({ name, source: "project", filePath: "fixture.md", systemPrompt: "", tools: ["read"], model: "primary-model", ...(kind === "stubborn" ? { fallbackModels: ["fallback-model"] } : {}) });
const starts: any[] = [];
const common = {
	ctx: { pi: { events: { emit(name: string, event: any) { starts.push({ name, event }); } } }, cwd: root, currentSessionId: `test-${nonce}` },
	artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
	shareEnabled: false, maxSubagentDepth: 2, timeoutMs: 1_500,
};
const clock = new ManualDeadlineClock(Date.now());
const executors = nativeStartup ? { executeAsyncSingle, executeAsyncChain } : createAsyncExecutors({ deadlineClock: clock, runnerEntry: fileURLToPath(new URL("./deadline-test-runner.ts", import.meta.url)) });
if (nativeStartup) {
	const entry = fileURLToPath(new URL("../../src/runs/background/subagent-runner.ts", import.meta.url));
	atomic("barrier-identity.json", { id, nonce, entry });
	const preload = fileURLToPath(new URL("./deadline-startup-barrier.cjs", import.meta.url));
	process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
}
let runnerPid: number | undefined;
const resultPath = path.join(RESULTS_DIR, `${id}.json`);
const asyncDir = path.join(ASYNC_DIR, id);
let beforeExpiry: any[] | undefined;
let preload: any;
let armed: any;
let config: any;
let resultAt: number;
let launchAt: number;
try {
	// This is the original whole-launch metric: immediately before facade call.
	launchAt = Date.now();
	const launched = names.length > 1
		? executors.executeAsyncChain(id, { ...common, resultMode: "parallel", agents: names.map(makeAgent), chain: [{ parallel: names.map((agent) => ({ agent, task: `Wait for ${agent}` })), concurrency: 2 }] } as any)
		: executors.executeAsyncSingle(id, { ...common, agent: names[0], agentConfig: makeAgent(names[0]), task: `Wait for ${names[0]}` } as any);
	assert.equal(launched.isError, undefined, JSON.stringify(launched));
	assert.equal(starts.length, 1);
	runnerPid = starts[0].event.pid;
	assert.equal(typeof runnerPid, "number");
	atomic("owned.json", { id, nonce, runnerPid, launchAt, launched, starts });
	if (nativeStartup) {
		await waitFor(() => fs.existsSync(path.join(root, "preload-held.json")), "runner preload acknowledgement");
		const held = read("preload-held.json");
		assert.equal(held.nonce, nonce);
		assert.equal(held.pid, runnerPid);
		config = held.config;
		await waitFor(() => Date.now() > config.deadlineAt, "original native deadline");
		atomic("release-startup.json", { id, nonce });
	} else {
		await waitFor(() => fs.existsSync(path.join(root, "armed.json")), "actual deadline arming");
		config = read("driver-config.json");
		armed = read("armed.json");
		if (!late && kind !== "success") {
			assert.equal(armed.now, config.deadlineAt - 1_300);
			assert.deepEqual(armed.delays, [1_300], "the original absolute deadline, not a readiness-reset budget, must be armed");
			await waitFor(() => {
				assert.equal(fs.existsSync(resultPath), false, "run ended before active-child proof");
				return markers().filter((m) => m.type === "ready").length === activeCount;
			}, "both held-live readiness receipts");
			assert.equal(observations().filter((m) => m.type === "child-spawn").length, activeCount, "private native observer must reach every active child");
			for (const m of markers().filter((m) => m.type === "ready")) {
				assert.equal(m.nonce, nonce); assert.equal(m.runId, id); assert.equal(m.ppid, runnerPid); assert.equal(alive(m.pid), true);
				assert.ok(m.callFile.startsWith(mock.dir + path.sep));
				const call = JSON.parse(fs.readFileSync(m.callFile, "utf8"));
				assert.ok(call.args.join("\n").includes(`Wait for ${m.agent}`), "readiness must identify the actual recorded task");
			}
			assert.equal(observations().some((m) => m.type === "child-exit"), false, "historical readiness is not liveness");
			atomic("advance.json", { id, nonce, sequence: 1, now: config.deadlineAt - 1 });
			await waitFor(() => fs.existsSync(path.join(root, "advanced-1.json")), "deadline-1 flush");
			beforeExpiry = observations();
			assert.equal(beforeExpiry.some((m) => m.type === "deadline-fired" || m.type === "child-exit"), false);
			assert.equal(fs.existsSync(resultPath), false);
			atomic("advance.json", { id, nonce, sequence: 2, now: config.deadlineAt });
			await waitFor(() => fs.existsSync(path.join(root, "advanced-2.json")), "automatic armed deadline callback");
			if (kind === "stubborn") {
				// Repeated control requests must not create extra timeout transitions/attempts.
				deliverTimeoutRequest({ asyncDir, source: "test-duplicate" });
				deliverTimeoutRequest({ asyncDir, source: "test-duplicate" });
			}
		}
	}
	assert.equal(config.deadlineAt, launched.details.deadlineAt);
	assert.equal(config.deadlineAt, starts[0].event.deadlineAt);
	assert.equal(config.timeoutMs, 1_500);
	await waitFor(() => fs.existsSync(resultPath), "terminal result");
	resultAt = Date.now();
	if (nativeStartup) preload = read("preload-released.json");
	else await waitFor(() => fs.existsSync(path.join(root, "driver-finished.json")), "test driver completion");
	await waitFor(() => !alive(runnerPid!), "runner exit", 5_000);
	const observed = observations();
	const fixtureMarkers = markers();
	for (const pid of new Set([...observed, ...fixtureMarkers].filter((m) => m.pid && m.ppid === runnerPid).map((m) => m.pid))) assert.equal(alive(pid), false, `owned child ${pid} still alive`);
	assertNoHarnessFailure();
	const payload = JSON.parse(fs.readFileSync(resultPath, "utf8"));
	const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"));
	const events = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const fired = observed.find((m) => m.type === "deadline-fired");
	atomic("evidence.json", { root, kind, id, nonce, config, payload, status, observations: observed, markers: fixtureMarkers, events,
		callCount: mock.callCount(), wholeLaunchMs: resultAt - launchAt, terminationMs: fired ? resultAt - fired.at : undefined,
		beforeExpiry, armed, preload,
		evidenceKind: nativeStartup ? "native-whole-launch" : "synthetic-deadline-native-processes", declaredStartupMs: nativeStartup ? undefined : 200,
	});
	console.log(`PASS ${kind} (${nativeStartup ? "native launch" : "synthetic deadline; native termination"}) ${root}`);
} catch (error) {
	// Fail FIRST. Any subsequent harness kill is explicitly excluded from evidence.
	atomic("cleanup-started.json", { failed: true, at: Date.now(), id, nonce, error: String(error) });
	const owned = [...observations(), ...markers()].filter((m) => m.runId === id && m.ppid === runnerPid && m.pid);
	for (const pid of new Set(owned.map((m) => m.pid))) { try { process.kill(pid, "SIGKILL"); } catch {} }
	if (runnerPid) { try { process.kill(runnerPid, "SIGKILL"); } catch {} }
	console.error(error);
	process.exitCode = 1;
} finally { mock.uninstall(); }
