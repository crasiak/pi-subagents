import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createAsyncExecutors, executeAsyncChain, isAsyncAvailable } from "../../src/runs/background/async-execution.ts";
import { ASYNC_DIR, RESULTS_DIR, TEMP_ROOT_DIR } from "../../src/shared/types.ts";
import { ManualDeadlineClock } from "./manual-deadline-clock.ts";
import { createMockPi } from "./mock-pi.ts";
import { cleanupDeadlineCase } from "./fixture-custody.ts";

const kind = process.argv[2];
const root = process.argv[3];
const delayBeforeDeadlineMs = Number(process.argv[4] ?? 0);
assert.ok(Number.isInteger(delayBeforeDeadlineMs) && delayBeforeDeadlineMs >= 0 && delayBeforeDeadlineMs <= 10_000);
assert.ok(kind === "dynamic-startup" || kind === "dynamic-acceptance");
const startup = kind === "dynamic-startup";
const nonce = randomUUID(), id = `${kind}-${nonce}`;
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
function atomic(name: string, value: unknown) {
	fs.writeFileSync(path.join(root, name + ".tmp"), JSON.stringify(value));
	fs.renameSync(path.join(root, name + ".tmp"), path.join(root, name));
}
function observations(): any[] {
	const file = path.join(root, "observations.jsonl");
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((s) => JSON.parse(s)) : [];
}
function markers(): any[] { return fs.readdirSync(root).filter((n) => n.startsWith("fixture-") && n.endsWith(".json")).map(read); }
function noFailure() {
	for (const n of ["barrier-failure.json", "driver-failure.json", "outer-watchdog.json"]) assert.equal(fs.existsSync(path.join(root, n)), false, n);
	assert.equal(markers().some((m) => m.failed || m.type === "watchdog"), false, "fixture watchdog must not produce passing cancellation");
}
async function waitFor(test: () => boolean, reason: string, ms = 20_000) {
	const end = Date.now() + ms;
	while (!test()) { noFailure(); assert.ok(Date.now() < end, `watchdog waiting for ${reason}`); await new Promise((r) => setTimeout(r, 10)); }
	noFailure();
}
function alive(pid: number) {
	try { process.kill(pid, 0); return true; }
	catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return false; throw e; }
}
assert.equal(isAsyncAvailable(), true, "real Jiti required; no skip");
for (const p of [ASYNC_DIR, RESULTS_DIR, TEMP_ROOT_DIR]) assert.ok(p.startsWith(path.join(root, "tmp") + path.sep));
assert.equal(process.env.HOME, path.join(root, "home"));
atomic("identity.json", { kind, id, nonce, budgetMs: 1_000 });
const mock = createMockPi({ rootDir: path.join(root, "mock"), preserve: true }); mock.install();
const producerHold = startup ? { deadlineFixture: { root, nonce, runId: id, hold: "before-ready" as const } } : {};
mock.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] }, ...producerHold } as any);
mock.onCall({ output: "review-a", structuredOutput: { ok: "a" } } as any);
const agent = (name: string) => ({ name, description: `Test agent: ${name}`, systemPrompt: "", systemPromptMode: "replace" as const, inheritProjectContext: false, inheritSkills: false });
const verifierScript = fileURLToPath(new URL("./held-verifier.cjs", import.meta.url));
const quote = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
// POSIX exec makes the verification handle own the actual held Node process.
// Windows uses its native shell semantics; native Windows evidence is not inferred from POSIX.
const verifyCommand = `${process.platform === "win32" ? "" : "exec "}${[process.execPath, verifierScript, root, id, nonce].map(quote).join(" ")}`;
const starts: any[] = [];
const common = {
	chain: [
		{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
		{ expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
			parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" }, acceptance: { level: "checked" } },
			collect: { as: "reviews" }, acceptance: { level: "verified", verify: [{ id: "slow", command: verifyCommand, timeoutMs: 60_000 }] } },
	],
	agents: [agent("producer"), agent("reviewer")],
	ctx: { pi: { events: { emit(name: string, event: any) { starts.push({ name, event }); } } }, cwd: root, currentSessionId: `dynamic-${nonce}` },
	artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
	shareEnabled: false, maxSubagentDepth: 2, timeoutMs: 1_000,
};
const executors = startup ? { executeAsyncChain } : createAsyncExecutors({ deadlineClock: new ManualDeadlineClock(Date.now()), runnerEntry: fileURLToPath(new URL("./deadline-test-runner.ts", import.meta.url)) });
if (startup) {
	atomic("barrier-identity.json", { id, nonce, budgetMs: 1_000, entry: fileURLToPath(new URL("../../src/runs/background/subagent-runner.ts", import.meta.url)) });
	process.env.NODE_OPTIONS = `--require ${JSON.stringify(fileURLToPath(new URL("./deadline-startup-barrier.cjs", import.meta.url)))}`;
}
const resultPath = path.join(RESULTS_DIR, `${id}.json`), asyncDir = path.join(ASYNC_DIR, id);
let runnerPid: number | undefined;
let config: any, armed: any, preload: any, verifier: any;
let beforeExpiry: any[] | undefined;
try {
	const launchAt = Date.now();
	const launched = executors.executeAsyncChain(id, common as any);
	assert.equal(launched.isError, undefined); assert.equal(starts.length, 1);
	runnerPid = starts[0].event.pid;
	assert.ok(Number.isSafeInteger(runnerPid) && runnerPid! > 1 && runnerPid !== process.pid, "validated runner PID required");
	atomic("owned.json", { id, nonce, runnerPid, launchAt, launched, starts });
	if (startup) {
		await waitFor(() => fs.existsSync(path.join(root, "preload-held.json")), "native pre-import hold");
		const held = read("preload-held.json"); assert.equal(held.nonce, nonce); assert.equal(held.pid, runnerPid);
		config = held.config;
		await waitFor(() => Date.now() > config.deadlineAt, "original native1000ms deadline");
		atomic("release-startup.json", { id, nonce });
	} else {
		await waitFor(() => fs.existsSync(path.join(root, "armed.json")), "actual deadline arming");
		config = read("driver-config.json"); armed = read("armed.json");
		assert.equal(armed.now, config.deadlineAt - 800); assert.deepEqual(armed.delays, [800]);
		await waitFor(() => {
			assert.equal(fs.existsSync(resultPath), false, "run ended before aggregate verifier readiness");
			return fs.existsSync(path.join(root, "fixture-verifier-verifier-ready.json"));
		}, "positively active aggregate verifier");
		verifier = read("fixture-verifier-verifier-ready.json");
		assert.equal(verifier.runId, id); assert.equal(verifier.nonce, nonce); assert.equal(verifier.stepIndex, 1);
		if (process.platform !== "win32") assert.equal(verifier.ppid, runnerPid);
		assert.equal(alive(verifier.pid), true); assert.equal(mock.callCount(), 2);
		const before = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"));
		assert.ok(before.steps.every((s: any) => s.status === "complete"));
		atomic("aggregate-active.json", { verifier, before, at: Date.now() });
		atomic("advance.json", { id, nonce, sequence: 1, now: config.deadlineAt - 1 });
		await waitFor(() => fs.existsSync(path.join(root, "advanced-1.json")), "deadline-1 acknowledgement");
		beforeExpiry = observations(); assert.equal(beforeExpiry.some((e) => e.type === "deadline-fired"), false);
		assert.equal(alive(verifier.pid), true); assert.equal(fs.existsSync(resultPath), false);
		// Negative-control comparison may consume native time while deadline time stays frozen.
		// The independent60s verifier timer cannot rescue cancellation before the40s outer watchdog.
		if (delayBeforeDeadlineMs) await new Promise((resolve) => setTimeout(resolve, delayBeforeDeadlineMs));
		noFailure(); assert.equal(alive(verifier.pid), true); assert.equal(fs.existsSync(resultPath), false);
		atomic("advance.json", { id, nonce, sequence: 2, now: config.deadlineAt });
		await waitFor(() => fs.existsSync(path.join(root, "advanced-2.json")), "actual deadline callback");
	}
	assert.equal(config.timeoutMs, 1_000); assert.equal(config.deadlineAt, launched.details.deadlineAt);
	assert.equal(config.deadlineAt, starts[0].event.deadlineAt);
	await waitFor(() => fs.existsSync(resultPath), "terminal result"); const resultAt = Date.now();
	if (startup) preload = read("preload-released.json");
	else await waitFor(() => fs.existsSync(path.join(root, "driver-finished.json")), "driver completion");
	await waitFor(() => !alive(runnerPid!), "runner exit", 5_000);
	const observed = observations(); const fired = observed.filter((e) => e.type === "deadline-fired");
	if (!startup) {
		assert.equal(fired.length, 1); assert.equal(fired[0].nonce, nonce); assert.equal(fired[0].runId, id);
		assert.ok(fired[0].at >= verifier.at);
		await waitFor(() => !alive(verifier.pid), "verifier settlement", 2_000);
		if (process.platform !== "win32") {
			const term = read("fixture-verifier-sigterm.json");
			assert.equal(term.pid, verifier.pid); assert.equal(term.nonce, nonce); assert.ok(term.at >= fired[0].at);
		}
		assert.equal(mock.callCount(), 2);
	}
	for (const pid of new Set([...observed, ...markers()].filter((m) => m.pid && m.ppid === runnerPid).map((m) => m.pid))) assert.equal(alive(pid), false);
	noFailure();
	const payload = JSON.parse(fs.readFileSync(resultPath, "utf8"));
	const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"));
	const events = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((s) => JSON.parse(s));
	atomic("evidence.json", { root, kind, id, nonce, config, payload, status, observations: observed, markers: markers(), events, callCount: mock.callCount(), verifier, beforeExpiry, armed, preload,
		wholeLaunchMs: resultAt - launchAt, terminationMs: fired[0] ? resultAt - fired[0].at : undefined,
		evidenceKind: startup ? "native-whole-launch" : "synthetic-deadline-native-verifier-cancellation", declaredStartupMs: startup ? undefined : 200, delayBeforeDeadlineMs });
	console.log(`PASS ${kind} ${root}`);
} catch (error) {
	atomic("cleanup-started.json", { failed: true, id, nonce, at: Date.now(), error: String(error) });
	try {
		const custody = await cleanupDeadlineCase(root, runnerPid ? { id, nonce, runnerPid } : undefined);
		if (!custody.settled || !custody.completeOwnership) console.error("Incomplete failure cleanup evidence", custody);
	} catch (cleanupError) { console.error("Failure cleanup error", cleanupError); }
	console.error(error); process.exitCode = 1;
} finally { mock.uninstall(); }
