import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { armRunDeadline, nativeDeadlineClock } from "../../src/runs/background/deadline-clock.ts";
import { ManualDeadlineClock } from "../support/manual-deadline-clock.ts";

describe("per-run deadline clock", () => {
	it("rejects backwards synthetic advancement", () => {
		const clock = new ManualDeadlineClock(200);
		assert.throws(() => clock.advanceTo(199), /backwards/);
	});

	for (const now of [1_500, 1_501]) {
		it(`defers an already-due deadline at ${now}, rather than firing inline`, () => {
			const clock = new ManualDeadlineClock(now);
			let calls = 0;
			armRunDeadline(clock, 1_500, () => calls++);
			assert.equal(calls, 0);
			assert.deepEqual(clock.pendingDelays, [0]);
			assert.equal(clock.unrefCount, 1);
			clock.advanceTo(now);
			assert.equal(calls, 1);
			clock.advanceTo(now + 10);
			assert.equal(calls, 1);
		});
	}

	it("charges startup against the absolute deadline and fires the armed callback once", () => {
		const clock = new ManualDeadlineClock(200);
		let calls = 0;
		armRunDeadline(clock, 1_500, () => calls++);
		assert.deepEqual(clock.pendingDelays, [1_300]);
		clock.advanceTo(1_499);
		assert.equal(calls, 0);
		clock.advanceTo(1_500);
		assert.equal(calls, 1);
		clock.advanceTo(1_600);
		assert.equal(calls, 1);
	});

	it("completion cancels on the creating adapter and clocks do not affect each other", () => {
		const a = new ManualDeadlineClock(0);
		const b = new ManualDeadlineClock(0);
		let calls = 0;
		const cancel = armRunDeadline(a, 1_500, () => calls++);
		armRunDeadline(b, 1_500, () => calls++);
		cancel();
		cancel();
		a.advanceTo(2_000);
		assert.equal(calls, 0);
		b.advanceTo(1_500);
		assert.equal(calls, 1);
		assert.equal(a.pendingDelays.length, 0);
	});

	it("an omitted budget does not sample or schedule any clock", () => {
		const forbidden = () => { throw new Error("clock used for unbounded run"); };
		armRunDeadline({ now: forbidden, setTimeout: forbidden, clearTimeout: forbidden }, undefined, forbidden)();
	});

	it("native defaults use a real deferred timer and can cancel it", async () => {
		let inline = true;
		const watchdog = setTimeout(() => assert.fail("native deadline did not fire"), 2_000);
		try {
			await new Promise<void>((resolve) => {
				armRunDeadline(nativeDeadlineClock, nativeDeadlineClock.now(), () => {
					assert.equal(inline, false);
					resolve();
				});
				inline = false;
			});
			let canceledCalls = 0;
			const cancel = armRunDeadline(nativeDeadlineClock, nativeDeadlineClock.now(), () => canceledCalls++);
			cancel();
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(canceledCalls, 0);
		} finally {
			clearTimeout(watchdog);
		}
	});
});
