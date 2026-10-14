import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertActiveTermination, runDeadlineScenario } from "../support/deadline-harness.ts";

describe("separated deadline lifecycle evidence", () => {
	it("expires through the native full launch before any child becomes ready", async () => {
		const e = await runDeadlineScenario("startup");
		assert.equal(e.preload.type, "runner-preload-held");
		assert.equal(e.preload.id, e.id);
		assert.equal(e.preload.nonce, e.nonce);
		assert.deepEqual(e.preload.config, e.config);
		assert.ok(e.preload.releasedAt > e.config.deadlineAt);
		assert.equal(e.config.timeoutMs, 1_500);
		assert.equal(e.payload.timeoutMs, 1_500);
		assert.equal(e.payload.deadlineAt, e.config.deadlineAt);
		assert.equal(e.status.deadlineAt, e.config.deadlineAt);
		assert.equal(e.payload.state, "failed");
		assert.equal(e.payload.exitCode, 1);
		assert.equal(e.payload.success, false);
		assert.equal(e.payload.timedOut, true);
		assert.equal(e.status.timedOut, true);
		assert.equal(e.callCount, 0);
		assert.equal(e.markers.filter((m) => m.type === "ready").length, 0);
		assert.equal(e.events.filter((m) => m.type === "subagent.run.timed_out").length, 1);
		assert.ok(e.status.steps.every((s: any) => s.status === "failed" && s.timedOut && s.error === "Subagent timed out after 1500ms."));
		assert.ok(e.payload.results.every((r: any) => r.timedOut && !r.success && !r.acceptance && !r.output?.includes("too late")));
		assert.ok(e.wholeLaunchMs < 7_000, `native whole launch ${e.wholeLaunchMs}ms; this red is never replaced`);
	});

	it("retains the1000ms dynamic native whole-launch startup guard", async () => {
		const e = await runDeadlineScenario("dynamic-startup");
		assert.equal(e.config.timeoutMs, 1_000);
		assert.equal(e.payload.timeoutMs, 1_000);
		assert.equal(e.payload.deadlineAt, e.config.deadlineAt);
		assert.equal(e.status.deadlineAt, e.config.deadlineAt);
		assert.equal(e.preload.id, e.id);
		assert.equal(e.preload.nonce, e.nonce);
		assert.deepEqual(e.preload.config, e.config);
		assert.ok(e.preload.releasedAt > e.config.deadlineAt);
		assert.equal(e.payload.state, "failed");
		assert.equal(e.payload.timedOut, true);
		assert.equal(e.payload.exitCode, 1);
		assert.equal(e.status.timedOut, true);
		assert.equal(e.callCount, 0);
		assert.equal(e.markers.some((m) => m.type === "ready"), false);
		assert.equal(e.events.filter((m) => m.type === "subagent.run.timed_out").length, 1);
		assert.ok(e.status.steps.every((s: any) => s.status === "failed" && s.timedOut && s.error === "Subagent timed out after 1000ms."));
		assert.ok(e.payload.results.every((r: any) => r.timedOut && !r.success && !r.acceptance));
		assert.ok(e.wholeLaunchMs < 3_000, `native whole launch ${e.wholeLaunchMs}ms; retain any red`);
	});

	it("terminates two active children without starting a pending third child", async () => {
		const e = await runDeadlineScenario("pending");
		assertActiveTermination(e, 2);
		assert.deepEqual(e.status.steps.map((s: any) => s.status), ["failed", "failed", "failed"]);
		assert.deepEqual(e.status.steps.map((s: any) => s.timedOut), [true, true, true]);
		assert.equal(e.callCount, 2);
		assert.equal(e.payload.results.some((r: any) => r.success), false);
	});

	it("propagates expiry when a child registers its timeout after the deadline callback", async () => {
		const e = await runDeadlineScenario("late-registration");
		const types = e.observations.map((o) => o.type);
		assert.ok(types.indexOf("child-spawn") < types.indexOf("deadline-fired"));
		assert.ok(types.indexOf("deadline-fired") < types.indexOf("child-close"));
		assert.equal(types.filter((t) => t === "deadline-fired").length, 1);
		assert.equal(e.payload.timedOut, true);
		assert.equal(e.payload.results[0].timedOut, true);
		assert.equal(e.markers.filter((m) => m.type === "ready").length, 0);
	});

	it("successful completion cancels the original deadline, even when advanced afterwards", async () => {
		const e = await runDeadlineScenario("success");
		assert.equal(e.payload.success, true);
		assert.equal(e.payload.timedOut, undefined);
		assert.equal(e.status.timedOut, undefined);
		assert.equal(e.observations.some((o) => o.type === "deadline-fired"), false);
		assert.equal(e.events.some((o) => o.type === "subagent.run.timed_out"), false);
		assert.equal(e.callCount, 1);
	});
});
