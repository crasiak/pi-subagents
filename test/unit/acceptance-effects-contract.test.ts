import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateAcceptance, formatAcceptancePrompt, resolveEffectiveAcceptance, validateAcceptanceInput } from "../../src/runs/shared/acceptance.ts";
import { evaluateCompletionMutationGuard } from "../../src/runs/shared/completion-guard.ts";

// Approved CRA-617 v2: declarations select evidence, never additional task authority.
// Synthetic report claims here are fixtures, not real implementation evidence.
const ambiguousTasks = [
	"Review the renderer. Do not edit source files that contain\nreport findings unless there is a blocker.",
	"Review the renderer. Do not edit source files containing archived\nreport findings unless there is a blocker.",
	"Review the renderer. Do not edit machine-generated, source-derived\nreport findings unless there is a blocker.",
	"Review the renderer. Do not edit source files, configuration, and report findings unless there is a blocker.",
	"Review the renderer. Do not edit configuration, metadata, and report findings unless there is a blocker.",
	"Read-only review. Do not edit fragile, experimental files, and report findings unless there are none.",
	"Read-only review. Do not edit source files that are archived\nReport findings unless there are none.",
	"Implement the renderer change.",
];

function fixtureReport(criteria: Array<{ id: string }>, tests: string[] = []) {
	return {
		criteriaSatisfied: criteria.map(({ id }) => ({ id, status: "satisfied" as const, evidence: "synthetic inspection" })),
		changedFiles: ["fixture.ts"], testsAddedOrUpdated: tests,
		commandsRun: [{ command: "fixture command (not executed)", result: "passed" as const, summary: "synthetic claim" }],
		validationOutput: ["synthetic inspection"], reviewFindings: [], residualRisks: [], noStagedFiles: true,
	};
}

describe("explicit task effects contract", () => {
	for (const effects of ["advisory", "implementation"]) {
		it(`validates ${effects}`, () => assert.deepEqual(validateAcceptanceInput({ effects }), []));
	}
	for (const effects of [null, false, true, "auto", "readonly", {}, []]) {
		it(`rejects invalid effects ${JSON.stringify(effects)}`, () => {
			assert.match(validateAcceptanceInput({ effects }, "tasks[2].acceptance").join(" "), /tasks\[2\]\.acceptance\.effects/);
		});
	}

	for (const task of ambiguousTasks) for (const agentName of ["worker", "reviewer"]) for (const async of [false, true]) {
		for (const effects of [undefined, "advisory", "implementation"] as const) {
			it(`${agentName}/${async ? "async" : "foreground"}/${effects ?? "undeclared"}: ${task}`, () => {
				const policy = resolveEffectiveAcceptance({ agentName, task, async, explicit: { level: "attested", ...(effects ? { effects } : {}) } });
				const advisory = effects === "advisory";
				assert.equal(policy.level, advisory ? "attested" : async ? "reviewed" : "checked");
				for (const kind of ["changed-files", "tests-added", "commands-run"] as const) assert.equal(policy.evidence.includes(kind), !advisory);
				assert.deepEqual(policy.effects, {
					policyVersion: 1, ...(effects ? { declared: effects } : {}), effective: effects ?? "implementation",
					source: effects ? "caller" : "conservative-default", location: "acceptance.effects",
				});
			});
		}
	}

	it("prose and role never silently turn omitted acceptance advisory", () => {
		const policy = resolveEffectiveAcceptance({ agentName: "scout", task: "Return findings only." });
		assert.equal(policy.level, "checked");
		assert.equal(policy.explicit, false);
		assert.equal(policy.effects.source, "conservative-default");
	});
	for (const context of [{ task: "Review security." }, { dynamic: true }]) {
		it(`elevated rigor retains advisory evidence: ${JSON.stringify(context)}`, () => {
			const policy = resolveEffectiveAcceptance({ agentName: "reviewer", explicit: { effects: "advisory", level: "attested" }, ...context });
			assert.equal(policy.level, "reviewed");
			assert.equal(policy.evidence.includes("tests-added"), false);
			assert.equal(policy.evidence.includes("validation-output"), true);
		});
	}
	it("prompts display effects and do not grant edit authority", () => {
		const policy = resolveEffectiveAcceptance({ agentName: "reviewer", task: "Do not edit files." });
		const prompt = formatAcceptancePrompt(policy);
		assert.match(prompt, /implementation/);
		assert.match(prompt, /conservative-default/);
		assert.match(prompt, /do not (?:authorize|permit|widen)/i);
	});

	it("freezes policy values independently of later caller object mutation", () => {
		const explicit = { effects: "advisory" as const, level: "verified" as const, verify: [{ id: "v", command: "original", env: { FIXTURE: "original" } }], review: { required: false, focus: "original" }, stopRules: ["original"] };
		const policy = resolveEffectiveAcceptance({ agentName: "reviewer", explicit });
		explicit.verify[0].command = "changed"; explicit.verify[0].env.FIXTURE = "changed";
		explicit.review.focus = "changed"; explicit.stopRules.push("changed");
		assert.equal(policy.verify[0].command, "original");
		assert.equal(policy.verify[0].env?.FIXTURE, "original");
		assert.equal(policy.review && policy.review.focus, "original");
		assert.deepEqual(policy.stopRules, ["original"]);
	});

	it("explicit required evidence at attested raises checked and rejects empty tests", async () => {
		const policy = resolveEffectiveAcceptance({ agentName: "reviewer", explicit: { effects: "advisory", level: "attested", evidence: ["tests-added"] } });
		assert.equal(policy.level, "checked");
		const ledger = await evaluateAcceptance({ acceptance: policy, report: fixtureReport(policy.criteria), output: "", cwd: "/nonexistent" });
		assert.equal(ledger.status, "rejected");
		assert.equal(ledger.runtimeChecks.find(({ id }) => id === "evidence:tests-added")?.status, "failed");
	});
	for (const severity of ["required", "recommended"] as const) {
		it(`preserves ${severity} criterion evidence severity`, async () => {
			const criterion = { id: "custom", must: "Inspect the change", severity, evidence: ["tests-added" as const] };
			const policy = resolveEffectiveAcceptance({ agentName: "reviewer", explicit: { effects: "advisory", level: "attested", criteria: [criterion] } });
			assert.equal(policy.level, "checked");
			assert.deepEqual(policy.criteria[0], criterion);
			assert.equal(policy.evidence.includes("tests-added"), severity === "required");
			const ledger = await evaluateAcceptance({ acceptance: policy, report: fixtureReport(policy.criteria), output: "", cwd: "/nonexistent" });
			assert.equal(ledger.status, severity === "required" ? "rejected" : "checked");
		});
	}
	it("explicit global evidence remains required even when a criterion recommends it", () => {
		const policy = resolveEffectiveAcceptance({ agentName: "reviewer", explicit: { effects: "advisory", evidence: ["tests-added"], criteria: [{ id: "optional", must: "Optional testing", severity: "recommended", evidence: ["tests-added"] }] } });
		assert.ok(policy.evidence.includes("tests-added"));
	});
	it("a verify command raises the required level without fabricating a run", () => {
		const verify = [{ id: "real-command", command: "exit 7", timeoutMs: 1234, cwd: "/nonexistent", env: { FIXTURE: "yes" } }];
		const policy = resolveEffectiveAcceptance({ agentName: "reviewer", explicit: { effects: "advisory", level: "attested", verify } });
		assert.equal(policy.level, "verified");
		assert.deepEqual(policy.verify, verify);
	});
	it("explicit required review raises reviewed and cannot become optional", async () => {
		const review = { agent: "reviewer", required: true, focus: "contract" };
		const policy = resolveEffectiveAcceptance({ agentName: "reviewer", explicit: { effects: "advisory", level: "attested", review } });
		assert.equal(policy.level, "reviewed");
		assert.deepEqual(policy.review, review);
		const ledger = await evaluateAcceptance({ acceptance: policy, report: fixtureReport(policy.criteria), output: "", cwd: "/nonexistent" });
		assert.equal(ledger.status, "rejected");
		assert.equal(ledger.reviewResult?.status, "needs-parent-decision");
	});
	it("pure attested defaults remain unvalidated requests, not passed structural gates", async () => {
		const policy = resolveEffectiveAcceptance({ agentName: "reviewer", explicit: { effects: "advisory" } });
		const ledger = await evaluateAcceptance({ acceptance: policy, report: { criteriaSatisfied: [{ id: "criterion-1", status: "not-applicable", evidence: "not checked" }] }, output: "", cwd: "/nonexistent" });
		assert.equal(policy.level, "attested");
		assert.equal(ledger.status, "attested");
		assert.deepEqual(ledger.runtimeChecks, []);
	});
	it("intentional disabling is not acceptance", async () => {
		const policy = resolveEffectiveAcceptance({ agentName: "worker", explicit: { effects: "advisory", level: "none", reason: "parent owns acceptance" } });
		const ledger = await evaluateAcceptance({ acceptance: policy, output: "", cwd: "/nonexistent" });
		assert.equal(ledger.status, "not-required");
		assert.equal(policy.effects.effective, "advisory");
	});
	it("advisory guard requires no mutation even when prose says implement", () => {
		const policy = resolveEffectiveAcceptance({ agentName: "worker", explicit: { effects: "advisory" } });
		const guard = evaluateCompletionMutationGuard({ agent: "worker", task: "Implement the fix", messages: [], effects: policy.effects });
		assert.deepEqual(guard, { expectedMutation: false, attemptedMutation: false, triggered: false });
	});
	it("implementation capability alone does not require a mutation", () => {
		const policy = resolveEffectiveAcceptance({ agentName: "reviewer", explicit: { effects: "implementation" } });
		const guard = evaluateCompletionMutationGuard({ agent: "reviewer", task: "Review and suggest alternatives", messages: [], effects: policy.effects });
		assert.deepEqual(guard, { expectedMutation: false, attemptedMutation: false, triggered: false });
	});
});
