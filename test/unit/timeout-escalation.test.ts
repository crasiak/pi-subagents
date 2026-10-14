import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startTimeoutEscalation } from "../../src/runs/background/timeout-escalation.ts";

// This fake drives the actual shared policy, including on Windows. Integration
// tests separately exercise native process signals and the unmodified 3000ms timer.
function fixture() {
	const signals: string[] = [];
	const pending = new Map<object, () => void>();
	const delays: number[] = [];
	let unrefs = 0;
	let settled = false;
	const child = { kill(signal: string) { signals.push(signal); return true; } };
	const timers = {
		setTimeout(callback: () => void, delay: number) {
			delays.push(delay);
			const handle = { unref() { unrefs++; } };
			pending.set(handle, callback);
			return handle;
		},
		clearTimeout(handle: object) { pending.delete(handle); },
	};
	return {
		signals, delays, pending,
		start: () => startTimeoutEscalation(child as any, () => settled, timers),
		settle: () => { settled = true; },
		unrefs: () => unrefs,
		fire: () => { for (const cb of [...pending.values()]) cb(); pending.clear(); },
	};
}

describe("native timeout escalation policy", () => {
	it("sends TERM then schedules KILL at the real policy's 3000ms delay", () => {
		const f = fixture();
		f.start();
		assert.deepEqual(f.signals, ["SIGTERM"]);
		assert.deepEqual(f.delays, [3_000]);
		assert.equal(f.unrefs(), 1);
		f.fire();
		assert.deepEqual(f.signals, ["SIGTERM", "SIGKILL"]);
	});

	it("cooperative exit cancels escalation without a hard kill", () => {
		const f = fixture();
		const cancel = f.start();
		cancel();
		cancel();
		f.fire();
		assert.equal(f.pending.size, 0);
		assert.deepEqual(f.signals, ["SIGTERM"]);
	});

	it("does not signal a settled child even if cancellation races with delivery", () => {
		const f = fixture();
		f.start();
		f.settle();
		f.fire();
		assert.deepEqual(f.signals, ["SIGTERM"]);
	});
});
