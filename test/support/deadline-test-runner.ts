import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { runRunnerCli } from "../../src/runs/background/runner-config.ts";
import { runSubagent, type RunnerObservation } from "../../src/runs/background/subagent-runner-core.ts";
import { ManualDeadlineClock } from "./manual-deadline-clock.ts";

const root = process.env.CRA879_TEST_CHANNEL!;
const identity = JSON.parse(fs.readFileSync(path.join(root, "identity.json"), "utf8"));
function atomic(name: string, value: unknown) {
	fs.writeFileSync(path.join(root, `${name}.tmp`), JSON.stringify(value));
	fs.renameSync(path.join(root, `${name}.tmp`), path.join(root, `${name}.json`));
}

// Production entry never imports this module. Config consumption is the SAME helper.
runRunnerCli(async (config) => {
	assert.equal(config.id, identity.id);
	const expectedBudget = identity.budgetMs ?? 1_500;
	assert.ok(expectedBudget === 1_000 || expectedBudget === 1_500);
	assert.equal(config.timeoutMs, expectedBudget);
	assert.ok(Number.isFinite(config.deadlineAt));
	atomic("driver-config", config); // consumed deadline is retained, not rewritten
	const clock = new ManualDeadlineClock(config.deadlineAt! - config.timeoutMs! + 200);
	let firedDuringSpawn = false;
	const observer = (event: RunnerObservation) => {
		fs.appendFileSync(path.join(root, "observations.jsonl"), JSON.stringify({ ...event, nonce: identity.nonce }) + "\n");
		if (identity.kind === "late-registration" && event.type === "child-spawn" && !firedDuringSpawn) {
			firedDuringSpawn = true;
			// Exercise the real armed timer BEFORE this child registers its timeout.
			clock.advanceTo(config.deadlineAt!);
		}
	};
	let sequence = 0;
	const poll = setInterval(() => {
		try {
			const file = path.join(root, "advance.json");
			if (!fs.existsSync(file)) return;
			const command = JSON.parse(fs.readFileSync(file, "utf8"));
			if (command.sequence <= sequence) return;
			assert.equal(command.nonce, identity.nonce);
			assert.equal(command.id, config.id);
			clock.advanceTo(command.now);
			sequence = command.sequence;
			atomic(`advanced-${sequence}`, { ...command, at: Date.now() });
		} catch (error) {
			atomic("driver-failure", { failed: true, at: Date.now(), error: String(error) });
			process.exit(97);
		}
	}, 10);
	try {
		const running = runSubagent(config, { deadlineClock: clock, observer });
		atomic("armed", { now: clock.now(), delays: clock.pendingDelays, deadlineAt: config.deadlineAt });
		await running;
		clock.advanceTo(config.deadlineAt! + 1);
		atomic("driver-finished", { at: Date.now(), remainingTimers: clock.pendingDelays.length });
	} finally { clearInterval(poll); }
});
