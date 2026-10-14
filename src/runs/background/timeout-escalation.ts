import { trySignalChild } from "../../shared/post-exit-stdio-guard.ts";
import type { DeadlineClock } from "./deadline-clock.ts";

// A separate unit seam for the shared escalation policy, NOT the run deadline clock.
// Runner runtime dependencies cannot override these native production timers.
const nativeEscalationTimers: Pick<DeadlineClock, "setTimeout" | "clearTimeout"> = {
	setTimeout: (callback, delay) => setTimeout(callback, delay),
	clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export function startTimeoutEscalation(
	child: Parameters<typeof trySignalChild>[0],
	isSettled: () => boolean,
	timers = nativeEscalationTimers,
): () => void {
	trySignalChild(child, "SIGTERM");
	const timer = timers.setTimeout(() => {
		if (!isSettled()) trySignalChild(child, "SIGKILL");
	}, 3_000);
	timer.unref?.();
	return () => timers.clearTimeout(timer);
}
