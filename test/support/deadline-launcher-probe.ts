import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createAsyncExecutors, isAsyncAvailable } from "../../src/runs/background/async-execution.ts";
import { ASYNC_DIR, TEMP_ROOT_DIR } from "../../src/shared/types.ts";
import { ManualDeadlineClock } from "./manual-deadline-clock.ts";

const mode = process.argv[2];
assert.equal(isAsyncAvailable(), true, "dependencies are required, not a skipped test");
const clock = new ManualDeadlineClock(10_000);
let samples = 0;
const now = clock.now.bind(clock);
clock.now = () => { samples++; return now(); };
const runnerEntry = fileURLToPath(new URL("./config-capture-runner.ts", import.meta.url));
const executors = createAsyncExecutors({ deadlineClock: clock, runnerEntry });
const emitted: unknown[] = [];
const agent = { name: "probe", source: "project", filePath: "probe.md", systemPrompt: "", tools: ["read"] };
const common = {
	ctx: { pi: { events: { emit(name: string, event: unknown) { emitted.push({ name, event }); } } }, cwd: process.cwd(), currentSessionId: "deadline-probe" },
	artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
	shareEnabled: false, maxSubagentDepth: 2,
	...(mode !== "unbounded" ? { timeoutMs: 1_500 } : {}),
};
const id = `deadline-probe-${process.pid}`;
const result = mode === "chain"
	? executors.executeAsyncChain(id, { ...common, chain: [{ agent: "probe", task: "Report only" }], agents: [agent] } as any)
	: executors.executeAsyncSingle(id, { ...common, agent: "probe", agentConfig: agent, task: "Report only",
		...(mode === "invalid" ? { output: false, outputMode: "file-only" } : {}),
		// User-shaped values must not replace the factory's closed-over dependencies.
		deadlineClock: { now: () => 999 }, runnerEntry: "/not/a/runner.ts",
	} as any);
if (mode !== "invalid") {
	assert.equal(result.isError, undefined, JSON.stringify(result));
	const limit = Date.now() + 15_000;
	while (!fs.existsSync(process.env.CRA879_CONFIG_CAPTURE!)) {
		assert.ok(Date.now() < limit, "config capture driver did not finish");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
process.stdout.write(JSON.stringify({ result, emitted, samples, ASYNC_DIR, TEMP_ROOT_DIR,
	config: mode === "invalid" ? undefined : JSON.parse(fs.readFileSync(process.env.CRA879_CONFIG_CAPTURE!, "utf8")),
	remainingConfigFiles: fs.existsSync(TEMP_ROOT_DIR) ? fs.readdirSync(TEMP_ROOT_DIR).filter((name) => name.includes(id)) : [],
}));
