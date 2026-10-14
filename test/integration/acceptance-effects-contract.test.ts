import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { resolveEffectiveAcceptance } from "../../src/runs/shared/acceptance.ts";
import { ASYNC_DIR, RESULTS_DIR } from "../../src/shared/types.ts";
import { createEventBus, createMockPi, createTempDir, events, makeAgent, makeMinimalCtx, removeTempDir, type MockPi } from "../support/helpers.ts";

const writerTasks = [
	"Review the renderer. Do not edit source files that contain\nreport findings unless there is a blocker.",
	"Review the renderer. Do not edit source files containing archived\nreport findings unless there is a blocker.",
	"Review the renderer. Do not edit machine-generated, source-derived\nreport findings unless there is a blocker.",
	"Review the renderer. Do not edit source files, configuration, and report findings unless there is a blocker.",
	"Review the renderer. Do not edit configuration, metadata, and report findings unless there is a blocker.",
];

function report(hasTests = false, writer = false) {
	return ["fixture findings", "```acceptance-report", JSON.stringify({
		criteriaSatisfied: [1, 2].map((n) => ({ id: `criterion-${n}`, status: "satisfied", evidence: "synthetic inspection" })),
		changedFiles: writer ? ["fixture.ts"] : [], testsAddedOrUpdated: hasTests ? ["fixture.test.ts"] : [],
		commandsRun: writer ? [{ command: "synthetic command (not executed)", result: "passed", summary: "fixture" }] : [],
		validationOutput: ["synthetic inspection"], reviewFindings: [], residualRisks: [], noStagedFiles: true,
	}), "```"].join("\n");
}
async function complete(id: string) {
	const filename = path.join(RESULTS_DIR, `${id}.json`), deadline = Date.now() + 30_000;
	while (!fs.existsSync(filename)) {
		assert.ok(Date.now() < deadline, `Missing mock result: ${filename}`);
		await new Promise((r) => setTimeout(r, 25));
	}
	return JSON.parse(fs.readFileSync(filename, "utf8"));
}

describe("explicit effects through actual source executors", () => {
	let cwd: string, mock: MockPi;
	let state: Parameters<typeof createSubagentExecutor>[0]["state"];
	beforeEach(() => {
		cwd = createTempDir("effects-contract-"); mock = createMockPi(); mock.install();
		state = { baseCwd: cwd, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null };
	});
	afterEach(() => { mock.uninstall(); removeTempDir(cwd); });
	function execute(params: Record<string, unknown>) {
		const executor = createSubagentExecutor({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state,
			config: {}, asyncByDefault: false, tempArtifactsDir: cwd, getSubagentSessionRoot: () => cwd,
			expandTilde: (s: string) => s, discoverAgents: () => ({ agents: [makeAgent("worker"), makeAgent("reviewer")] }),
		});
		return executor.execute("effects-contract", params, new AbortController().signal, undefined, makeMinimalCtx(cwd));
	}
	const calls = () => fs.readdirSync(mock.dir).filter((name) => name.startsWith("call-"));

	for (const async of [false, true]) for (const agent of ["worker", "reviewer"]) {
		it(`${agent}/${async} advisory declaration reaches policy, prompt, guard and terminal ledger`, async () => {
			mock.onCall({ output: report() });
			const result = await execute({ agent, task: "Implement the renderer change.", async, acceptance: { effects: "advisory", level: "attested" } });
			const payload = async ? await complete(result.details.asyncId) : undefined;
			assert.equal(payload ? payload.success : !result.isError, true);
			const ledger = payload ? payload.results[0].acceptance : result.details.results[0].acceptance;
			assert.equal(ledger.status, "attested");
			assert.equal(ledger.effectiveAcceptance.effects.effective, "advisory");
			assert.equal(ledger.effectiveAcceptance.evidence.includes("tests-added"), false);
			assert.deepEqual(ledger.childReport.testsAddedOrUpdated, []);
			assert.equal(calls().length, 1);
			const call = JSON.parse(fs.readFileSync(path.join(mock.dir, calls()[0]), "utf8"));
			assert.match(call.args.at(-1), /Task effects: advisory/);
			if (async) {
				const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, result.details.asyncId, "status.json"), "utf8"));
				assert.equal(status.state, "complete");
				assert.deepEqual(status.steps[0].acceptance, ledger);
			}
		});
		for (const task of writerTasks) for (const effects of [undefined, "implementation"] as const) for (const hasTests of [false, true]) it(`${agent}/${async}/${effects ?? "undeclared"} tests present=${hasTests}: ${task}`, async () => {
			mock.onCall({ jsonl: [
				{ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "edit", arguments: { path: "fixture.ts" } }] } },
				events.assistantMessage(report(hasTests, true)),
			] });
			const result = await execute({ agent, task, async, acceptance: { ...(effects ? { effects } : {}), level: "attested" } });
			const payload = async ? await complete(result.details.asyncId) : undefined;
			assert.equal(payload ? payload.success : !result.isError, hasTests);
			const ledger = payload ? payload.results[0].acceptance : result.details.results[0].acceptance;
			assert.equal(ledger.status, hasTests ? "checked" : "rejected");
			assert.equal(ledger.effectiveAcceptance.effects.source, effects ? "caller" : "conservative-default");
			assert.equal(ledger.runtimeChecks.find(({ id }: { id: string }) => id === "evidence:tests-added")?.status, hasTests ? "passed" : "failed");
		});
	}

	it("empty alternative mode arrays do not turn a single leaf into a container", async () => {
		mock.onCall({ output: report() });
		const result = await execute({ agent: "reviewer", task: "Inspect", tasks: [], chain: [], async: false, acceptance: { effects: "advisory" } });
		assert.notEqual(result.isError, true, JSON.stringify(result.content));
		assert.equal(result.details.results[0].acceptance?.status, "attested");
	});

	for (const async of [false, true]) it(`${async} output routing does not become task-risk authority`, async () => {
		mock.onCall({ output: report() });
		const result = await execute({ agent: "reviewer", task: "Inspect the renderer", async, output: "security-review.md", acceptance: { effects: "advisory", level: "attested" } });
		const payload = async ? await complete(result.details.asyncId) : undefined;
		const ledger = payload ? payload.results[0].acceptance : result.details.results[0].acceptance;
		assert.equal(payload ? payload.success : !result.isError, true);
		assert.equal(ledger.effectiveAcceptance.level, "attested");
	});

	for (const async of [false, true]) it(`${async} omitted leaf acceptance records rejection without claiming checked success`, async () => {
		mock.onCall({ output: report(false, true) });
		const result = await execute({ agent: "reviewer", task: writerTasks[0], async });
		const payload = async ? await complete(result.details.asyncId) : undefined;
		assert.equal(payload ? payload.success : !result.isError, true);
		const ledger = payload ? payload.results[0].acceptance : result.details.results[0].acceptance;
		assert.equal(ledger.status, "rejected");
		assert.equal(ledger.explicit, false);
		assert.equal(ledger.effectiveAcceptance.effects.source, "conservative-default");
	});

	for (const async of [false, true]) it(`${async} repeated parallel declarations retain original location`, async () => {
		mock.onCall({ output: report() }); mock.onCall({ output: report() });
		const result = await execute({ tasks: [{ agent: "reviewer", task: "Return findings.", count: 2, acceptance: { effects: "advisory", level: "attested" } }], async });
		const payload = async ? await complete(result.details.asyncId) : undefined;
		assert.equal(payload ? payload.success : !result.isError, true);
		const results = payload ? payload.results : result.details.results;
		assert.equal(results.length, 2);
		for (const child of results) assert.equal(child.acceptance.effectiveAcceptance.effects.location, "tasks[0].acceptance.effects");
	});

	for (const async of [false, true]) for (const size of [0, 2]) for (const explicitGroup of [false, true]) {
		it(`${async} dynamic advisory group size=${size} explicit=${explicitGroup}`, async () => {
			mock.onCall({ output: report(), structuredOutput: { items: Array.from({ length: size }, (_, i) => ({ key: String(i) })) } });
			for (let i = 0; i < size; i++) mock.onCall({ output: report() });
			const result = await execute({ async, chain: [
				{ agent: "reviewer", task: "List targets", as: "targets", outputSchema: { type: "object", properties: { items: { type: "array" } }, required: ["items"] }, acceptance: { effects: "advisory", level: "attested" } },
				{ expand: { from: { output: "targets", path: "/items" }, key: "/key", maxItems: 2, onEmpty: "skip" }, parallel: { agent: "reviewer", task: "Inspect {item.key}", acceptance: { effects: "advisory", level: "attested" } }, collect: { as: "reviews" }, ...(explicitGroup ? { acceptance: "attested" } : {}) },
			] });
			const payload = async ? await complete(result.details.asyncId) : undefined;
			assert.equal(payload ? payload.success : !result.isError, size > 0 || !explicitGroup);
			const graph = payload ? payload.workflowGraph : result.details.workflowGraph;
			assert.equal(graph.nodes[1].acceptanceStatus, size > 0 ? "checked" : explicitGroup ? "rejected" : undefined);
			if (size > 0) {
				const results = payload ? payload.results : result.details.results;
				const children = results.filter((child: { task?: string; acceptance?: unknown }) => child.task?.includes("Inspect") && child.acceptance);
				// Async task summaries differ; both graph and terminal ledger carry effects.
				assert.equal(graph.nodes[1].effects.effective, "advisory");
				assert.equal(graph.nodes[1].effects.source, "aggregate");
				if (!async) assert.equal(children.length, size);
			}
		});
	}
	it("custom dynamic group criteria fail before even the producer is spawned", async () => {
		mock.onCall({ output: report(), structuredOutput: { items: [] } });
		const result = await execute({ async: false, chain: [
			{ agent: "reviewer", task: "List targets", as: "targets", outputSchema: { type: "object" } },
			{ expand: { from: { output: "targets", path: "/items" }, maxItems: 2 }, parallel: { agent: "reviewer", task: "Inspect" }, collect: { as: "reviews" }, acceptance: { criteria: [{ id: "criterion-1", must: "Semantic cross-item check" }] } },
		] });
		assert.equal(result.isError, true);
		assert.match(JSON.stringify(result.content), /canonical/);
		assert.equal(calls().length, 0);
	});

	for (const async of [false, true]) it(`${async} terminal revival preserves a supported policy snapshot and original outcome`, async () => {
		mock.onCall({ output: report() });
		const first = await execute({ agent: "reviewer", task: "Inspect the renderer", async, sessionDir: cwd, acceptance: { effects: "advisory", level: "checked", stopRules: ["Stay in scope"] } });
		const original = async ? await complete(first.details.asyncId) : undefined;
		assert.equal(original ? original.success : !first.isError, true);
		const id = async ? first.details.asyncId : [...state.foregroundRuns!.keys()][0];
		const ledger = original ? original.results[0].acceptance : first.details.results[0].acceptance;
		const statusFile = async ? path.join(ASYNC_DIR, id, "status.json") : undefined;
		const originalBytes = statusFile ? fs.readFileSync(statusFile, "utf8") : undefined;
		if (!async) {
			const result = first.details.results[0];
			assert.deepEqual(JSON.parse(fs.readFileSync(result.acceptanceSnapshotPath!, "utf8")), ledger.effectiveAcceptance);
		}
		mock.onCall({ output: report() });
		const revived = await execute({ action: "resume", id, message: "Inspect again without changing the contract" });
		assert.notEqual(revived.isError, true, JSON.stringify(revived.content));
		const payload = await complete(revived.details.asyncId);
		assert.equal(payload.success, true);
		assert.deepEqual(payload.results[0].acceptance.effectiveAcceptance, ledger.effectiveAcceptance);
		if (statusFile) assert.equal(fs.readFileSync(statusFile, "utf8"), originalBytes);
	});

	for (const carrier of ["direct", "ledger"]) it(`actual result-only ${carrier} revival preserves policy and failed history`, async () => {
		const id = `owned-result-${carrier}`, sessionFile = path.join(cwd, "past.jsonl");
		fs.writeFileSync(sessionFile, ""); fs.mkdirSync(RESULTS_DIR, { recursive: true });
		const policy = resolveEffectiveAcceptance({ agentName: "reviewer", explicit: { effects: "advisory", level: "checked" } });
		const originalPath = path.join(RESULTS_DIR, id + ".json");
		const bytes = JSON.stringify({ id, mode: "single", state: "failed", success: false, cwd, results: [{ agent: "reviewer", success: false, sessionFile, ...(carrier === "direct" ? { effectiveAcceptance: policy } : { acceptance: { status: "rejected", effectiveAcceptance: policy } }) }] });
		fs.writeFileSync(originalPath, bytes);
		mock.onCall({ output: report() });
		const result = await execute({ action: "resume", id, message: "Inspect the remaining details" });
		assert.notEqual(result.isError, true, JSON.stringify(result.content));
		const payload = await complete(result.details.asyncId);
		assert.equal(payload.success, true);
		assert.deepEqual(payload.results[0].acceptance.effectiveAcceptance, policy);
		assert.equal(payload.results[0].acceptance.status, "checked");
		assert.equal(fs.readFileSync(originalPath, "utf8"), bytes);
	});
	it("actual conflict refusal launches no child and leaves both histories intact", async () => {
		const id = "owned-conflicting-result", sessionFile = path.join(cwd, "past.jsonl");
		fs.writeFileSync(sessionFile, ""); fs.mkdirSync(path.join(ASYNC_DIR, id), { recursive: true }); fs.mkdirSync(RESULTS_DIR, { recursive: true });
		const advisory = resolveEffectiveAcceptance({ agentName: "reviewer", explicit: { effects: "advisory", level: "checked" } });
		const implementation = resolveEffectiveAcceptance({ agentName: "worker", async: true, explicit: { effects: "implementation", level: "attested" } });
		const files = new Map([
			[path.join(ASYNC_DIR, id, "status.json"), JSON.stringify({ runId: id, mode: "single", state: "complete", startedAt: 100, endedAt: 200, lastUpdate: 200, cwd, steps: [{ agent: "reviewer", status: "complete", sessionFile, effectiveAcceptance: advisory }] })],
			[path.join(RESULTS_DIR, id + ".json"), JSON.stringify({ id, mode: "single", state: "complete", success: true, cwd, results: [{ agent: "reviewer", sessionFile, acceptance: { status: "checked", effectiveAcceptance: implementation } }] })],
		]);
		for (const [filename, bytes] of files) fs.writeFileSync(filename, bytes);
		const result = await execute({ action: "resume", id, message: "Inspect again" });
		if (result.details.asyncId) await complete(result.details.asyncId);
		assert.equal(result.isError, true);
		assert.match(JSON.stringify(result.content), /Conflicting acceptance policy snapshots/);
		assert.equal(calls().length, 0);
		for (const [filename, bytes] of files) assert.equal(fs.readFileSync(filename, "utf8"), bytes);
	});

	for (const action of ["resume", "steer"]) it(`refuses ${action} contract override before looking up or interrupting a child`, async () => {
		const result = await execute({ action, id: "not-a-real-run", message: "Follow up", acceptance: { effects: "implementation" } });
		assert.equal(result.isError, true);
		assert.match(JSON.stringify(result.content), /contract.*fresh invocation/i);
		assert.equal(calls().length, 0);
	});
	it("refuses legacy terminal revival without rewriting its stored outcome", async () => {
		const id = "effects-legacy-terminal", dir = path.join(ASYNC_DIR, id), sessionFile = path.join(cwd, "legacy.jsonl");
		fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(sessionFile, "");
		const statusFile = path.join(dir, "status.json");
		const bytes = JSON.stringify({ runId: id, mode: "single", state: "complete", startedAt: 100, endedAt: 200, lastUpdate: 200, cwd, sessionFile, steps: [{ agent: "reviewer", status: "complete", sessionFile }] });
		fs.writeFileSync(statusFile, bytes);
		const result = await execute({ action: "resume", id, message: "Review follow-up" });
		assert.equal(result.isError, true);
		assert.match(JSON.stringify(result.content), /acceptance policy snapshot.*fresh invocation/i);
		assert.equal(calls().length, 0);
		assert.equal(fs.readFileSync(statusFile, "utf8"), bytes);
	});

	for (const params of [
		{ tasks: [{ agent: "reviewer", task: "Return findings." }], acceptance: { effects: "advisory" } },
		{ chain: [{ agent: "reviewer", task: "Return findings." }], acceptance: { effects: "advisory" } },
		{ chain: [{ parallel: [{ agent: "reviewer", task: "Return findings." }], acceptance: { effects: "advisory" } }] },
	]) it(`rejects misplaced effects before child spawn: ${JSON.stringify(params)}`, async () => {
		mock.onCall({ output: report() });
		const result = await execute({ ...params, async: false });
		assert.equal(result.isError, true);
		assert.match(JSON.stringify(result.content), /executing leaf/);
		assert.equal(calls().length, 0);
	});
});
