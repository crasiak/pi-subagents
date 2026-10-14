import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { resolveEffectiveAcceptance } from "../../src/runs/shared/acceptance.ts";
import { requireLeafAcceptanceSnapshot } from "../../src/runs/shared/acceptance-contract.ts";
import { resolveAsyncResumeTarget } from "../../src/runs/background/async-resume.ts";

const advisory = resolveEffectiveAcceptance({ agentName: "reviewer", explicit: { effects: "advisory", level: "checked" } });
const implementation = resolveEffectiveAcceptance({ agentName: "worker", async: true, explicit: { effects: "implementation", level: "attested" } });
type Carrier = { effectiveAcceptance?: unknown; acceptance?: { effectiveAcceptance?: unknown } };

function fixture(status: Carrier | undefined, result: Carrier | undefined, check: (load: () => unknown) => void) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-recovery-"));
	const asyncDirRoot = path.join(root, "runs"), resultsDir = path.join(root, "results"), id = "owned-terminal";
	const sessionFile = path.join(root, "session.jsonl"); fs.writeFileSync(sessionFile, "");
	const files = new Map<string, string>();
	if (status) files.set(path.join(asyncDirRoot, id, "status.json"), JSON.stringify({ runId: id, mode: "single", state: "complete", startedAt: 100, endedAt: 200, lastUpdate: 200, cwd: root, steps: [{ agent: "reviewer", status: "complete", sessionFile, ...status }] }));
	if (result) files.set(path.join(resultsDir, id + ".json"), JSON.stringify({ id, mode: "single", state: "complete", success: true, cwd: root, results: [{ agent: "reviewer", success: true, sessionFile, ...result }] }));
	for (const [file, bytes] of files) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
	try {
		check(() => resolveAsyncResumeTarget({ id }, { asyncDirRoot, resultsDir }));
	} finally {
		for (const [file, bytes] of files) assert.equal(fs.readFileSync(file, "utf8"), bytes, "terminal history must stay unchanged");
		fs.rmSync(root, { recursive: true, force: true });
	}
}
const snapshot = (load: () => unknown) => requireLeafAcceptanceSnapshot((load() as { effectiveAcceptance?: unknown }).effectiveAcceptance);

it("recovers a status-only supported policy exactly", () => fixture({ effectiveAcceptance: advisory }, undefined, (load) => assert.deepEqual(snapshot(load), advisory)));
for (const carrier of [{ effectiveAcceptance: advisory }, { acceptance: { effectiveAcceptance: advisory } }]) {
	it(`recovers result-only ${carrier.acceptance ? "ledger" : "direct"} policy exactly`, () => fixture(undefined, carrier, (load) => assert.deepEqual(snapshot(load), advisory)));
}
it("matching status and result policies remain valid", () => fixture({ effectiveAcceptance: advisory }, { acceptance: { effectiveAcceptance: advisory } }, (load) => assert.deepEqual(snapshot(load), advisory)));
it("refuses status/result conflict rather than choosing the advisory contract", () => fixture({ effectiveAcceptance: advisory }, { acceptance: { effectiveAcceptance: implementation } }, (load) => assert.throws(load, /Conflicting acceptance policy snapshots/)));
it("refuses result direct/ledger conflict even without a status file", () => fixture(undefined, { effectiveAcceptance: advisory, acceptance: { effectiveAcceptance: implementation } }, (load) => assert.throws(load, /Conflicting acceptance policy snapshots/)));
it("refuses unsupported result policy despite valid status policy", () => fixture({ effectiveAcceptance: advisory }, { effectiveAcceptance: { ...implementation, effects: { ...implementation.effects, policyVersion: 2 } } }, (load) => assert.throws(load, /unsupported.*policy snapshot/)));
it("legacy missing result policy remains unavailable, not inferred", () => fixture(undefined, {}, (load) => assert.throws(() => snapshot(load), /fresh invocation/)));
