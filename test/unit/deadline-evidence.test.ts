import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { assertActiveTermination, type DeadlineEvidence } from "../support/deadline-harness.ts";

// These are tests of the test oracle, NOT native lifecycle evidence.
function fixture(): DeadlineEvidence {
	const root = path.resolve("oracle-fixture");
	const identities = [0, 1].map((stepIndex) => ({ runId: "run", nonce: "nonce", pid: 100 + stepIndex, ppid: 99, stepIndex, agent: `agent-${stepIndex}`, attempt: 0, model: "model" }));
	return {
		root, kind: "parallel", id: "run", nonce: "nonce", callCount: 2, wholeLaunchMs: 300,
		config: { timeoutMs: 1_500, deadlineAt: 1_500 },
		armed: { now: 200, delays: [1_300] }, beforeExpiry: [],
		payload: { success: false, exitCode: 1, timeoutMs: 1_500, deadlineAt: 1_500, results: [{ success: false }, { success: false }] },
		status: { timeoutMs: 1_500, deadlineAt: 1_500, steps: identities.map((i) => ({ agent: i.agent })) },
		events: [{ type: "subagent.run.timed_out" }],
		markers: identities.map((i) => ({ ...i, type: "ready", at: 60, callFile: path.join(root, `call-${i.pid}.json`), disposition: "default" })),
		observations: [
			...identities.map((i) => ({ ...i, type: "child-spawn", at: 50 })),
			{ type: "deadline-fired", runId: "run", nonce: "nonce", at: 100 },
			...identities.flatMap((i) => ["child-exit", "child-close"].map((type) => ({ ...i, type, at: 110, signal: "SIGTERM", code: null }))),
		],
	};
}

describe("native termination evidence oracle negatives", () => {
	it("accepts its complete identity-bound example", () => assertActiveTermination(fixture(), 2));
	for (const [name, corrupt] of [
		["historical readiness and normalized timedOut alone", (e: DeadlineEvidence) => { e.observations = e.observations.filter((o) => o.type !== "child-exit" && o.type !== "child-close"); }],
		["natural exit before the deadline", (e: DeadlineEvidence) => { e.observations.find((o) => o.type === "child-exit").at = 90; }],
		["wrong native PID", (e: DeadlineEvidence) => { e.observations.find((o) => o.type === "child-close").pid = 999; }],
		["wrong native run identity", (e: DeadlineEvidence) => { e.observations.find((o) => o.type === "child-exit").runId = "other"; }],
		["only one child closed", (e: DeadlineEvidence) => { e.observations = e.observations.filter((o) => !(o.type === "child-close" && o.stepIndex === 1)); }],
		["a duplicate child index", (e: DeadlineEvidence) => { e.markers[1].stepIndex = 0; }],
		["watchdog termination", (e: DeadlineEvidence) => { e.markers.push({ type: "watchdog" }); }],
		["an extra fallback attempt", (e: DeadlineEvidence) => { e.observations.push({ type: "child-spawn", attempt: 1 }); }],
		["a deadline fired early", (e: DeadlineEvidence) => { e.beforeExpiry!.push({ type: "deadline-fired" }); }],
	] as const) {
		it(`rejects ${name}`, () => {
			const e = fixture();
			corrupt(e);
			assert.throws(() => assertActiveTermination(e, 2));
		});
	}
});
