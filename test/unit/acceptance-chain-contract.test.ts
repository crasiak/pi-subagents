import assert from "node:assert/strict";
import { it } from "node:test";
import { parseChain, parseJsonChain, serializeChain, serializeJsonChain } from "../../src/agents/chain-serializer.ts";

const policy = { effects: "advisory", level: "checked", criteria: ["Report findings"], evidence: ["residual-risks"] };
const definition = { name: "effects", description: "Effects round trip", chain: [{ agent: "reviewer", task: "Inspect only", acceptance: policy }] };

it("JSON and Markdown chains preserve the full leaf acceptance object", () => {
	const parsed = parseJsonChain(JSON.stringify(definition), "project", "/tmp/effects.chain.json");
	const json = parseJsonChain(serializeJsonChain(parsed), "project", "/tmp/effects-again.chain.json");
	const markdown = parseChain(serializeChain(parsed), "project", "/tmp/effects.chain.md");
	assert.deepEqual(json.steps[0].acceptance, policy);
	assert.deepEqual(markdown.steps[0].acceptance, policy);
});
it("Markdown acceptance validation rejects invalid effects, not silently dropping it", () => {
	assert.throws(() => parseChain('---\nname: bad\ndescription: bad\n---\n## reviewer\nacceptance: {"effects":"auto"}\n\nInspect', "project", "/tmp/bad.chain.md"), /effects/);
});
it("JSON group effects are not inherited into children", () => {
	assert.throws(() => parseJsonChain(JSON.stringify({ ...definition, chain: [{ parallel: definition.chain, acceptance: policy }] }), "project", "/tmp/group.chain.json"), /executing leaf/);
});
it("JSON dynamic groups reject semantic caller criteria before output validation", () => {
	assert.throws(() => parseJsonChain(JSON.stringify({ ...definition, chain: [{ expand: {}, parallel: { agent: "reviewer" }, collect: {}, acceptance: { criteria: ["Check cross-item contradictions"] } }] }), "project", "/tmp/dynamic.chain.json"), /canonical/);
});
it("Markdown serializer refuses a lossy parallel policy representation", () => {
	const parsed = parseJsonChain(JSON.stringify(definition), "project", "/tmp/effects.chain.json");
	assert.throws(() => serializeChain({ ...parsed, steps: [{ parallel: definition.chain }] }), /chain\.json/);
});
