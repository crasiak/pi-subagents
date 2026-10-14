import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as acceptance from "../../src/runs/shared/acceptance.ts";

const child = (id: string, effects: "advisory" | "implementation") => ({
	id, acceptance: acceptance.resolveEffectiveAcceptance({ agentName: "reviewer", explicit: { effects } }),
});

describe("truthful group acceptance", () => {
	it("rejects container effects rather than silently inheriting", () => {
		assert.match(acceptance.validateAcceptanceInput({ effects: "advisory" }, "acceptance", "container").join(" "), /executing leaf/);
	});
	for (const criteria of [["Review every contradiction"], [{ id: "criterion-1", must: "Semantic cross-check" }]]) {
		it(`rejects custom group criteria ${JSON.stringify(criteria)}`, () => {
			assert.match(acceptance.validateAcceptanceInput({ criteria }, "chain[0].acceptance", "dynamic-group").join(" "), /canonical/);
		});
	}
	it("allows supported group evidence and empty default criteria", () => {
		assert.deepEqual(acceptance.validateAcceptanceInput({ level: "checked", criteria: [], evidence: ["validation-output"] }, "group", "dynamic-group"), []);
	});
	for (const effects of [["advisory", "advisory"], ["advisory", "implementation"]] as const) {
		it(`derives aggregate effect from children ${effects}`, () => {
			const children = effects.map((effect, i) => child(`child-${i}`, effect));
			const policy = acceptance.resolveGroupAcceptance({ children, location: "chain[0].acceptance", explicit: "attested" });
			assert.equal(policy.effects.effective, effects.includes("implementation") ? "implementation" : "advisory");
			assert.equal(policy.effects.source, "aggregate");
			assert.equal(policy.effects.declared, undefined);
			assert.equal(policy.level, "reviewed");
			assert.deepEqual(policy.criteria.map(({ id }) => id), ["group-children-completed", "group-evidence-collected"]);
			assert.equal(policy.criteria.some(({ must }) => must.includes("Implement")), false);
			assert.deepEqual(policy.effects.children, children.map(({ id, acceptance: policy }) => ({ id, effects: policy.effects })));
		});
	}
	it("unknown child policy is conservative, never an advisory declaration", () => {
		const policy = acceptance.resolveGroupAcceptance({ children: [child("known", "advisory"), { id: "legacy" }], location: "group" });
		assert.equal(policy.effects.effective, "implementation");
	});
	it("empty groups use template effects but cannot claim successful child evidence", () => {
		const policy = acceptance.resolveGroupAcceptance({ children: [], template: child("template", "advisory").acceptance, location: "group" });
		const report = acceptance.aggregateAcceptanceReport({ results: [] });
		assert.equal(policy.effects.effective, "advisory");
		assert.deepEqual(report.criteriaSatisfied?.slice(0, 2).map(({ status }) => status), ["not-satisfied", "not-satisfied"]);
	});
	it("a completed child without a parsed report does not satisfy collection", () => {
		const report = acceptance.aggregateAcceptanceReport({ results: [{ agent: "reviewer", exitCode: 0 }] });
		assert.equal(report.criteriaSatisfied?.find(({ id }) => id === "group-children-completed")?.status, "satisfied");
		assert.equal(report.criteriaSatisfied?.find(({ id }) => id === "group-evidence-collected")?.status, "not-satisfied");
	});
});
