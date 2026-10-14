import { it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

it("malformed readiness and one corrupt native record cannot skip owned descendant settlement", { timeout: 5_000 }, async () => {
	const { cleanupDeadlineCase } = await import("../support/fixture-custody.ts");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "custody-negative-"));
	const id = "custody-run", nonce = "custody-nonce";
	fs.writeFileSync(path.join(root, "identity.json"), JSON.stringify({ id, nonce }));
	fs.writeFileSync(path.join(root, "fixture-bad.json"), "{malformed readiness");
	const runner = spawn(process.execPath, ["-e", `
		const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
		const [root,id,nonce]=process.argv.slice(1);
		const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
		child.once('spawn',()=>fs.writeFileSync(path.join(root,'observations.jsonl'),'{bad record\\n'+JSON.stringify({type:'child-spawn',runId:id,nonce,pid:child.pid,ppid:process.pid})+'\\n'));
		setInterval(()=>{},1000);
	`, root, id, nonce], { stdio: "ignore" });
	const closed = new Promise((resolve) => runner.once("close", resolve));
	try {
		const end = Date.now() + 2_000;
		while (!fs.existsSync(path.join(root, "observations.jsonl"))) {
			assert.ok(Date.now() < end, "native fixture setup watchdog");
			await new Promise((r) => setTimeout(r, 10));
		}
		fs.writeFileSync(path.join(root, "cleanup-started.json"), JSON.stringify({ failed: true }));
		const receipt = await cleanupDeadlineCase(root, { id, nonce, runnerPid: runner.pid! }, 1_000);
		assert.equal(receipt.settled, true);
		assert.equal(receipt.targets.length, 2);
		assert.ok(receipt.errors.some((e: string) => e.includes("observations")));
		await closed;
	} finally { runner.kill("SIGKILL"); }
});

it("custody rejects self, negative and mismatched PIDs from fixture ownership files", async () => {
	const { cleanupFixtureGroup } = await import("../support/fixture-custody.ts");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "custody-reject-"));
	for (const [index, pid] of [process.pid, -1, 0].entries()) {
		fs.writeFileSync(path.join(root, `owned-fixture-${index}.json`), JSON.stringify({ nonce: "expected", pid, ppid: process.pid }));
	}
	fs.writeFileSync(path.join(root, "owned-fixture-other.json"), JSON.stringify({ nonce: "wrong", pid: 999999, ppid: process.pid }));
	const receipt = await cleanupFixtureGroup(root, "expected", process.pid, 50);
	assert.deepEqual(receipt.targets, []);
	assert.equal(receipt.errors.length, 4);
	assert.equal(receipt.settled, true, "settled covers valid owned targets only, not rejected evidence");
});

for (const body of [null, false, 0]) {
	it(`invalid ownership body ${JSON.stringify(body)} records incompleteness without skipping the runner`, async () => {
		const { cleanupDeadlineCase } = await import("../support/fixture-custody.ts");
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "custody-invalid-body-"));
		fs.writeFileSync(path.join(root, "owned-fixture-verifier.json"), JSON.stringify(body));
		const runner = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
		const closed = new Promise((resolve) => runner.once("close", resolve));
		try {
			const receipt = await cleanupDeadlineCase(root, { id: "run", nonce: "nonce", runnerPid: runner.pid! }, 500);
			assert.equal(receipt.completeOwnership, false);
			assert.ok(receipt.errors.some((e: string) => e.includes("invalid ownership body")));
			assert.equal(receipt.settled, true);
			assert.deepEqual(receipt.targets, [runner.pid]);
			await closed;
		} finally { runner.kill("SIGKILL"); await closed; }
	});
}

it("two cleanup invocations retain both append-only custody receipts", async () => {
	const { cleanupDeadlineCase } = await import("../support/fixture-custody.ts");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "custody-append-"));
	const ids: number[] = [];
	for (let i = 0; i < 2; i++) {
		const runner = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
		const closed = new Promise((resolve) => runner.once("close", resolve));
		try {
			ids.push(runner.pid!);
			const receipt = await cleanupDeadlineCase(root, { id: `run-${i}`, nonce: `nonce-${i}`, runnerPid: runner.pid! }, 500);
			assert.equal(receipt.settled, true); await closed;
		} finally { runner.kill("SIGKILL"); await closed; }
	}
	const receipts = fs.readFileSync(path.join(root, "cleanup-custody.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(receipts.length, 2);
	assert.deepEqual(receipts.map((r) => r.targets[0]), ids);
});
