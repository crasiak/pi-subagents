import assert from "node:assert/strict";
import { it } from "node:test";
import { resolveEffectiveAcceptance } from "../../src/runs/shared/acceptance.ts";
import { requireLeafAcceptanceSnapshot } from "../../src/runs/shared/acceptance-contract.ts";

const policy = resolveEffectiveAcceptance({ agentName: "reviewer", explicit: { effects: "advisory", level: "checked", criteria: ["Inspect"], stopRules: ["Stay in scope"] }, effectsLocation: "tasks[2].acceptance.effects" });
it("snapshot recovery preserves the exact resolved contract without re-inference or aliasing", () => {
	const recovered = requireLeafAcceptanceSnapshot(JSON.parse(JSON.stringify(policy)));
	assert.deepEqual(recovered, policy);
	recovered.stopRules.push("new array member");
	assert.deepEqual(policy.stopRules, ["Stay in scope"]);
});
for (const value of [
	undefined, {}, { ...policy, effects: undefined }, { ...policy, level: undefined }, { ...policy, level: "auto" },
	{ ...policy, effects: { ...policy.effects, policyVersion: 2 } },
	{ ...policy, effects: { ...policy.effects, source: "aggregate" } },
	{ ...policy, effects: { ...policy.effects, declared: "implementation" } },
	{ ...policy, effects: { policyVersion: 1, effective: "advisory", source: "conservative-default", location: "acceptance.effects" } },
	{ ...policy, effects: { policyVersion: 1, effective: "implementation", source: "conservative-default", location: "acceptance.effects" }, level: "attested" },
	{ ...policy, level: "checked", requireVerification: true },
	{ ...policy, review: { required: true }, level: "checked" },
	{ ...policy, criteria: ["Unresolved string"] },
]) it(`refuses unsupported snapshot ${JSON.stringify(value)}`, () => assert.throws(() => requireLeafAcceptanceSnapshot(value), /fresh invocation/));
