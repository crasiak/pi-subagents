import { it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { concurrencyFixture, runWithAcknowledgedOverlap } from "../support/concurrency-harness.ts";

it("overlap oracle rejects successful completion without its phase prerequisite", async () => {
	const fixture = concurrencyFixture("premature-negative");
	await assert.rejects(runWithAcknowledgedOverlap({ fixture, queueDir: fixture.root, count: 1, concurrency: 1,
		execute: async () => "success without overlap",
	}), /execution ended without acknowledging/);
	assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.root, "cleanup-started.json"), "utf8")).failed, true);
	assert.equal(fs.existsSync(path.join(fixture.root, "evidence.json")), false);
});

for (const count of [0, 1]) {
	it(`overlap oracle bounds never-settling execution with ${count} unacknowledged fixtures`, { timeout: 1_000 }, async () => {
		const fixture = concurrencyFixture(`never-settles-${count}`);
		await assert.rejects(runWithAcknowledgedOverlap({ fixture, queueDir: fixture.root, count, concurrency: 1,
			watchdogMs: 25, cleanupMs: 25,
			execute: () => new Promise(() => {}),
		}), /watchdog/);
		const cleanup = JSON.parse(fs.readFileSync(path.join(fixture.root, "cleanup-finished.json"), "utf8"));
		assert.equal(cleanup.executorSettled, false);
		assert.equal(fs.existsSync(path.join(fixture.root, "evidence.json")), false);
	});
}

for (const executorReturns of [true, false]) {
	it(`released real child is cleaned when executor ${executorReturns ? "returns early" : "never settles"}`, { timeout: 8_000 }, async () => {
		const fixture = concurrencyFixture(`live-child-${executorReturns}`);
		const queueDir = path.join(fixture.root, "queue"); fs.mkdirSync(queueDir);
		const child = spawn(process.execPath, ["-e", `
			const fs=require('node:fs'),path=require('node:path'); const [root,nonce,queue]=process.argv.slice(1);
			const callFile=path.join(queue,'call.json'); fs.writeFileSync(callFile,JSON.stringify({args:['held-real-child']}));
			const body={nonce,index:0,pid:process.pid,ppid:process.ppid,callFile};
			fs.writeFileSync(path.join(root,'owned-fixture-0.json'),JSON.stringify(body));
			fs.writeFileSync(path.join(root,'ready-0.tmp'),JSON.stringify(body));
			fs.renameSync(path.join(root,'ready-0.tmp'),path.join(root,'ready-0.json'));
			setInterval(()=>{},1000);
		`, fixture.root, fixture.nonce, queueDir], { stdio: "ignore" });
		let failureBeforeExit = false;
		const closed = new Promise((resolve) => child.once("close", (code, signal) => { failureBeforeExit = fs.existsSync(path.join(fixture.root, "cleanup-started.json")); resolve({ code, signal }); }));
		let timer: ReturnType<typeof setInterval> | undefined;
		try {
			const end = Date.now() + 3_000;
			while (!fs.existsSync(path.join(fixture.root, "ready-0.json"))) { assert.ok(Date.now() < end, "fixture startup watchdog"); await new Promise((r) => setTimeout(r, 10)); }
			await assert.rejects(runWithAcknowledgedOverlap({ fixture, queueDir, count: 1, concurrency: 1, watchdogMs: 500, cleanupMs: 100,
				execute: (_signal, observe) => new Promise((resolve) => {
					observe([{ index: 0, status: "running" }]);
					if (executorReturns) timer = setInterval(() => {
						if (fs.existsSync(path.join(fixture.root, "release-0.json"))) { clearInterval(timer); resolve("early result while real child is live"); }
					}, 10);
				}),
			}));
			assert.equal(fs.existsSync(path.join(fixture.root, "release-0.json")), true, "exercise acknowledged/released work, not count0");
			const cleanup = JSON.parse(fs.readFileSync(path.join(fixture.root, "cleanup-finished.json"), "utf8"));
			assert.equal(cleanup.executorSettled, executorReturns);
			assert.equal(cleanup.custody?.settled, true, "native cleanup required regardless of executor settlement");
			assert.deepEqual(cleanup.custody.targets, [child.pid]);
			assert.equal(cleanup.custody.signals[0]?.pid, child.pid);
			await closed;
			assert.equal(failureBeforeExit, true);
		} finally { if (timer) clearInterval(timer); child.kill("SIGKILL"); await closed; }
	});
}

for (const bad of ["nonce", "call-path"] as const) {
	it(`overlap oracle rejects wrong ${bad} before releasing a fixture`, async () => {
		const fixture = concurrencyFixture(`${bad}-negative`);
		let abortSawFailure = false;
		fs.writeFileSync(path.join(fixture.root, "ready-0.json"), JSON.stringify({ nonce: bad === "nonce" ? "wrong" : fixture.nonce,
			index: 0, pid: process.pid, ppid: process.pid, callFile: path.join(fixture.root, "not-the-queue", "call.json") }));
		await assert.rejects(runWithAcknowledgedOverlap({ fixture, queueDir: path.join(fixture.root, "queue"), count: 1, concurrency: 1,
			execute: (signal, observe) => new Promise((resolve) => {
				observe([{ index: 0, status: "running" }]);
				signal.addEventListener("abort", () => {
					abortSawFailure = fs.existsSync(path.join(fixture.root, "cleanup-started.json")); resolve("aborted");
				}, { once: true });
			}),
		}));
		assert.equal(abortSawFailure, true, "failure must precede owned cleanup");
		assert.equal(fs.existsSync(path.join(fixture.root, "release-0.json")), false);
	});
}
