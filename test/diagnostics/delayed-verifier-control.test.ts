// Deliberate mutation control, not part of the default integration glob.
import { it } from "node:test";
import assert from "node:assert/strict";
import { runDeadlineScenario } from "../support/deadline-harness.ts";
it("requires deadline-driven verification cancellation even after8s native delay", async () => {
	const e = await runDeadlineScenario("dynamic-acceptance", 8_000);
	assert.equal(e.config.timeoutMs, 1_000);
	assert.equal(e.payload.timedOut, true);
	assert.equal(e.events.filter((x) => x.type === "subagent.run.timed_out").length, 1);
	assert.ok(e.terminationMs! < 3_000, `callback-to-result ${e.terminationMs}`);
});
