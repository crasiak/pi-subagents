/** Internal per-run deadline dependency. Other clocks and escalation stay native. */
export interface DeadlineHandle {
	unref?(): unknown;
}

export interface DeadlineClock {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): DeadlineHandle;
	clearTimeout(handle: DeadlineHandle): void;
}

export const nativeDeadlineClock: DeadlineClock = Object.freeze({
	now: () => Date.now(),
	setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
	clearTimeout: (handle: DeadlineHandle) => clearTimeout(handle as NodeJS.Timeout),
});

/** Consume the launcher's absolute deadline; never restart the budget at readiness. */
export function armRunDeadline(clock: DeadlineClock, deadlineAt: number | undefined, callback: () => void): () => void {
	if (deadlineAt === undefined) return () => {};
	let active = true;
	const handle = clock.setTimeout(() => {
		if (!active) return;
		active = false;
		callback();
	}, Math.max(0, deadlineAt - clock.now()));
	handle.unref?.();
	return () => {
		active = false;
		clock.clearTimeout(handle);
	};
}
