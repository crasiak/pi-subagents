import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { cleanupFixtureGroup, settledWithin } from "./fixture-custody.ts";

export function concurrencyFixture(name: string) {
	const root = fs.mkdtempSync(path.join(process.env.CRA879_EVIDENCE_DIR ?? os.tmpdir(), `concurrency-${name}-`));
	return { root, nonce: randomUUID() };
}

/** Positive overlap acknowledgement, not a sleep-based chance of overlapping output. */
export async function runWithAcknowledgedOverlap<T>(options: {
	fixture: { root: string; nonce: string };
	queueDir: string;
	concurrency: number;
	count: number;
	watchdogMs?: number;
	cleanupMs?: number;
	execute: (signal: AbortSignal, observe: (progress: Array<{ index?: number; status?: string }>) => void) => Promise<T>;
}): Promise<T> {
	const { root, nonce } = options.fixture;
	const controller = new AbortController();
	let progress: Array<{ index?: number; status?: string }> = [];
	let settled = false;
	let failure: unknown;
	let value: T;
	const history: unknown[] = [];
	let running: Promise<void> = Promise.resolve();
	const released = new Set<number>();
	const readReady = () => fs.readdirSync(root).filter((n) => /^ready-\d+\.json$/.test(n)).map((n) => JSON.parse(fs.readFileSync(path.join(root, n), "utf8")));
	const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return false; throw e; } };
	const end = Date.now() + (options.watchdogMs ?? 15_000);
	const cleanupMs = options.cleanupMs ?? 2_000;
	try {
		running = Promise.resolve().then(() => options.execute(controller.signal, (snapshot) => {
			progress = structuredClone(snapshot);
			history.push({ at: Date.now(), progress });
		})).then((result) => { value = result; settled = true; }, (error) => { failure = error; settled = true; });
		while (released.size < options.count) {
			assert.equal(settled, false, "execution ended without acknowledging the required overlap");
			assert.equal(fs.readdirSync(root).some((n) => n.startsWith("watchdog-")), false, "fixture watchdog failed before release");
			assert.ok(Date.now() < end, "watchdog waiting for acknowledged overlap");
			const ready = readReady().filter((r) => !released.has(r.index));
			const needed = Math.min(options.concurrency, options.count - released.size);
			if (ready.length >= needed && ready.every((r) => progress.some((p) => p.index === r.index && p.status === "running"))) {
				assert.ok(ready.length <= options.concurrency, "too many simultaneously held fixtures");
				for (const r of ready) {
					assert.equal(r.nonce, nonce); assert.equal(r.ppid, process.pid);
					assert.ok(Number.isInteger(r.index) && r.index >= 0 && r.index < options.count);
					assert.equal(alive(r.pid), true, "ready fixture must remain alive");
					assert.ok(r.callFile.startsWith(options.queueDir + path.sep));
					const call = JSON.parse(fs.readFileSync(r.callFile, "utf8"));
					assert.ok(Array.isArray(call.args), "readiness must bind a completed mock call");
					fs.copyFileSync(r.callFile, path.join(root, `call-${r.index}.json`));
				}
				history.push({ at: Date.now(), acknowledged: ready, progress: structuredClone(progress) });
				for (const r of ready) {
					const file = path.join(root, `release-${r.index}.json`);
					fs.writeFileSync(`${file}.tmp`, JSON.stringify({ nonce, index: r.index, pid: r.pid }));
					fs.renameSync(`${file}.tmp`, file); released.add(r.index);
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(await settledWithin(running, Math.max(1, end - Date.now())), true, "watchdog waiting for executor settlement after release");
		if (failure) throw failure;
		for (const r of readReady()) assert.equal(alive(r.pid), false, "executor result requires fixture process settlement");
		fs.writeFileSync(path.join(root, "evidence.json"), JSON.stringify({ nonce, count: options.count, concurrency: options.concurrency, released: [...released], history }, null, 2));
		return value!;
	} catch (error) {
		// Record failure BEFORE owned executor-handle cleanup. Abort cannot manufacture a pass.
		fs.writeFileSync(path.join(root, "cleanup-started.json"), JSON.stringify({ failed: true, at: Date.now(), error: String(error), history }, null, 2));
		controller.abort();
		let executorSettled = await settledWithin(running, cleanupMs);
		// Promise completion is not native settlement: that discrepancy may be the failure.
		// Only independent ownership records authorize signals; never readiness bodies.
		const custody = await cleanupFixtureGroup(root, nonce, process.pid, cleanupMs);
		if (!executorSettled) executorSettled = await settledWithin(running, cleanupMs);
		fs.writeFileSync(path.join(root, "cleanup-finished.json"), JSON.stringify({ executorSettled, custody }, null, 2));
		throw error;
	}
}
