import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { TEMP_ROOT_DIR, type ResolvedAcceptanceConfig } from "../../shared/types.ts";
import { validateAcceptanceInput } from "./acceptance.ts";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Shared by normal dispatch, appends and deferred launches: validation before effects. */
export function validateAcceptanceRequest(value: unknown): string[] {
	if (!record(value)) return ["Acceptance request must be an object."];
	const container = (Array.isArray(value.tasks) && value.tasks.length > 0) || (Array.isArray(value.chain) && value.chain.length > 0);
	const errors = validateAcceptanceInput(value.acceptance, "acceptance", container ? "container" : "leaf");
	if (value.tasks !== undefined && !Array.isArray(value.tasks)) errors.push("tasks must be an array.");
	if (Array.isArray(value.tasks)) value.tasks.forEach((task, index) => {
		if (record(task)) errors.push(...validateAcceptanceInput(task.acceptance, `tasks[${index}].acceptance`));
	});
	if (value.chain !== undefined && !Array.isArray(value.chain)) errors.push("chain must be an array.");
	if (Array.isArray(value.chain)) value.chain.forEach((step, index) => {
		if (!record(step)) return;
		const scope = Array.isArray(step.parallel) ? "container" : record(step.parallel) ? "dynamic-group" : "leaf";
		errors.push(...validateAcceptanceInput(step.acceptance, `chain[${index}].acceptance`, scope));
		if (Array.isArray(step.parallel)) step.parallel.forEach((task, child) => {
			if (record(task)) errors.push(...validateAcceptanceInput(task.acceptance, `chain[${index}].parallel[${child}].acceptance`));
		});
		else if (record(step.parallel)) errors.push(...validateAcceptanceInput(step.parallel.acceptance, `chain[${index}].parallel.acceptance`));
	});
	return errors;
}

/** A revival may reuse a supported snapshot, never reinterpret a legacy transcript. */
export function requireLeafAcceptanceSnapshot(value: unknown): ResolvedAcceptanceConfig {
	const fail = () => new Error("Missing, invalid or unsupported leaf acceptance policy snapshot; start a fresh invocation with an explicit contract.");
	if (!record(value) || !record(value.effects)) throw fail();
	const effects = value.effects;
	if (effects.policyVersion !== 1 || !["advisory", "implementation"].includes(effects.effective as string)
		|| typeof effects.location !== "string" || !effects.location.trim()) throw fail();
	if (effects.source === "caller") {
		if (effects.declared !== effects.effective) throw fail();
	} else if (effects.source !== "conservative-default" || effects.declared !== undefined || effects.effective !== "implementation") throw fail();
	const rank = ["none", "attested", "checked", "verified", "reviewed"].indexOf(value.level as string);
	if (rank < 0 || (rank > 0 && (
		(effects.effective === "implementation" && rank < 2)
		|| (value.requireVerification === true && rank < 3)
		|| (record(value.review) && value.review.required === true && rank < 4)
	))) throw fail();
	if (typeof value.explicit !== "boolean"
		|| !Array.isArray(value.inferredReason) || !value.inferredReason.every((reason) => typeof reason === "string")
		|| !Array.isArray(value.criteria) || !value.criteria.every((gate) => record(gate) && typeof gate.id === "string" && Array.isArray(gate.evidence) && ["required", "recommended"].includes(gate.severity as string))
		|| !Array.isArray(value.evidence) || !Array.isArray(value.verify) || !Array.isArray(value.stopRules)
		|| (value.requireVerification !== undefined && typeof value.requireVerification !== "boolean")) throw fail();
	const errors = validateAcceptanceInput({
		effects: effects.effective, level: value.level, criteria: value.criteria, evidence: value.evidence,
		verify: value.verify, review: value.review, stopRules: value.stopRules, reason: value.reason,
	}, "snapshot");
	if (errors.length) throw fail();
	return structuredClone(value) as unknown as ResolvedAcceptanceConfig;
}

export function selectLeafAcceptanceSnapshot(...values: unknown[]): ResolvedAcceptanceConfig {
	const snapshots = values.filter((value) => value !== undefined).map(requireLeafAcceptanceSnapshot);
	if (!snapshots.length) return requireLeafAcceptanceSnapshot(undefined);
	if (snapshots.some((snapshot) => !isDeepStrictEqual(snapshot, snapshots[0]))) {
		throw new Error("Conflicting acceptance policy snapshots; start a fresh invocation rather than choosing a weaker contract.");
	}
	return snapshots[0];
}

export function persistAcceptanceSnapshot(policy: ResolvedAcceptanceConfig): string {
	fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
	const filename = path.join(fs.mkdtempSync(path.join(TEMP_ROOT_DIR, "acceptance-contract-")), "policy.json");
	fs.writeFileSync(filename, JSON.stringify(policy), { flag: "wx", mode: 0o600 });
	return filename;
}

export function immutableContractFollowUp(message: string): string {
	return `The existing acceptance/effects contract is unchanged. This follow-up does not authorize wider effects; changed scope requires a fresh invocation.\n\n${message}`;
}
