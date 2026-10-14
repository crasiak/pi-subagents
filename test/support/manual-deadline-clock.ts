import type { DeadlineClock, DeadlineHandle } from "../../src/runs/background/deadline-clock.ts";

/** Synthetic deadline time only. Native I/O, child signals and watchdogs keep running. */
export class ManualDeadlineClock implements DeadlineClock {
	private time: number;
	private pending = new Map<DeadlineHandle, { at: number; delay: number; callback: () => void }>();
	unrefCount = 0;

	constructor(now: number) { this.time = now; }
	now(): number { return this.time; }
	get pendingDelays(): number[] { return [...this.pending.values()].map((timer) => timer.delay); }
	setTimeout(callback: () => void, delay: number): DeadlineHandle {
		const handle = { unref: () => { this.unrefCount++; } };
		this.pending.set(handle, { at: this.time + Math.max(0, delay), delay, callback });
		return handle;
	}
	clearTimeout(handle: DeadlineHandle): void { this.pending.delete(handle); }
	advanceTo(now: number): void {
		if (!Number.isFinite(now) || now < this.time) throw new Error("Synthetic clock cannot advance backwards or to non-finite time");
		this.time = now;
		// Snapshot the turn: a newly queued 0ms callback is deferred to another flush.
		for (const [handle, timer] of [...this.pending]) {
			if (timer.at > now || !this.pending.has(handle)) continue;
			this.pending.delete(handle);
			timer.callback();
		}
	}
}
