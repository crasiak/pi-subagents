import * as fs from "node:fs";
import * as path from "node:path";

type Owner = { id: string; nonce: string; runnerPid: number };
export interface CleanupReceipt {
	targets: number[]; signals: Array<{ pid: number; signal: string; error?: string }>;
	unsettled: number[]; errors: string[]; settled: boolean; completeOwnership: boolean;
}
const validPid = (pid: unknown): pid is number => Number.isSafeInteger(pid) && (pid as number) > 1 && pid !== process.pid;
function readJson(file: string, errors: string[]): any {
	try { return JSON.parse(fs.readFileSync(file, "utf8")); }
	catch (e) { errors.push(`${path.basename(file)}: ${String(e)}`); return undefined; }
}
function ownedFixtures(root: string, nonce: string, parentPid: number, errors: string[], runId?: string): number[] {
	const result: number[] = [];
	for (const name of fs.readdirSync(root).filter((n) => /^owned-fixture-.+\.json$/.test(n))) {
		const value = readJson(path.join(root, name), errors);
		if (value === undefined) continue; // parse failure already recorded
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			errors.push(`${name}: invalid ownership body`); continue;
		}
		if (value.nonce !== nonce || !validPid(value.pid) || value.ppid !== parentPid || (runId && value.runId !== runId)) {
			errors.push(`${name}: rejected ownership identity`); continue;
		}
		result.push(value.pid);
	}
	return result;
}
function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return false; return true; }
}
async function settle(pids: number[], ms: number): Promise<number[]> {
	const end = Date.now() + ms;
	let pending = pids.filter(alive);
	while (pending.length && Date.now() < end) { await new Promise((r) => setTimeout(r, 10)); pending = pending.filter(alive); }
	return pending;
}
async function terminate(children: Iterable<number>, runner: number | undefined, ms: number, errors: string[]): Promise<CleanupReceipt> {
	const targets = [...new Set([...children].filter((pid) => validPid(pid) && pid !== runner))];
	const signals: CleanupReceipt["signals"] = [];
	let pending: number[] = [];
	const kill = (pid: number) => {
		if (!alive(pid)) return;
		try { process.kill(pid, "SIGKILL"); signals.push({ pid, signal: "SIGKILL" }); }
		catch (e) { signals.push({ pid, signal: "SIGKILL", error: String(e) }); }
	};
	try {
		for (const pid of targets) kill(pid);
		// Keep the runner alive to reap its children before killing that known owner.
		pending = await settle(targets, ms);
	} finally {
		if (runner && validPid(runner)) { targets.push(runner); kill(runner); }
	}
	pending = await settle([...pending, ...(runner && validPid(runner) ? [runner] : [])], ms);
	return { targets, signals, unsettled: pending, errors, settled: pending.length === 0, completeOwnership: errors.length === 0 };
}

/** Failure-only cleanup: never reads readiness markers, never promotes a rejected readiness PID. */
export async function cleanupDeadlineCase(root: string, known?: Owner, ms = 2_000): Promise<CleanupReceipt> {
	const errors: string[] = [];
	let owner = known;
	if (!owner) {
		const identity = readJson(path.join(root, "identity.json"), errors);
		const saved = readJson(path.join(root, "owned.json"), errors);
		if (identity && saved && identity.id === saved.id && identity.nonce === saved.nonce) owner = saved;
	}
	if (!owner || !validPid(owner.runnerPid) || typeof owner.id !== "string" || typeof owner.nonce !== "string") {
		return { targets: [], signals: [], unsettled: [], errors: [...errors, "No validated runner ownership; no signals sent"], settled: false, completeOwnership: false };
	}
	const active = new Set<number>(), closed = new Set<number>();
	try {
		const file = path.join(root, "observations.jsonl");
		if (fs.existsSync(file)) {
			const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
			for (const [index, line] of lines.entries()) {
				let e: any;
				try { e = JSON.parse(line); } catch { errors.push(`observations line${index + 1}: malformed`); continue; }
				if (!e || typeof e !== "object" || typeof e.type !== "string") { errors.push(`observations line${index + 1}: malformed event`); continue; }
				if (!e.type.startsWith("child-")) continue;
				if (e.runId !== owner.id || e.nonce !== owner.nonce || e.ppid !== owner.runnerPid || !validPid(e.pid) || e.pid === owner.runnerPid) { errors.push(`observations line${index + 1}: rejected ownership`); continue; }
				if (e.type === "child-spawn") { active.add(e.pid); closed.delete(e.pid); }
				if (e.type === "child-exit" || e.type === "child-close") { active.delete(e.pid); closed.add(e.pid); }
			}
		}
		for (const pid of ownedFixtures(root, owner.nonce, owner.runnerPid, errors, owner.id)) if (!closed.has(pid)) active.add(pid);
	} catch (e) { errors.push(`Ownership collection: ${String(e)}`); }
	// No parser can bypass known-runner cleanup: collection failures become receipt data.
	const receipt = await terminate(active, owner.runnerPid, ms, errors);
	// Inner and outer failure handling may both run; keep BOTH completed receipts.
	fs.appendFileSync(path.join(root, "cleanup-custody.jsonl"), JSON.stringify({ at: Date.now(), ...receipt }) + "\n");
	return receipt;
}

export async function cleanupFixtureGroup(root: string, nonce: string, parentPid: number, ms = 2_000): Promise<CleanupReceipt> {
	const errors: string[] = []; let children: number[] = [];
	try { children = ownedFixtures(root, nonce, parentPid, errors); } catch (e) { errors.push(String(e)); }
	return terminate(children, undefined, ms, errors);
}

export async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try { return await Promise.race([promise.then(() => true, () => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]); }
	finally { if (timer) clearTimeout(timer); }
}
