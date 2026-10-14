import * as fs from "node:fs";
import type { RunnerStep } from "../shared/parallel-utils.ts";
import type { ArtifactConfig, MaxOutputConfig, NestedRouteInfo, ResolvedControlConfig, ResolvedTurnBudget, ResolvedToolBudget, SubagentRunMode, WorkflowGraphSnapshot } from "../../shared/types.ts";

export interface SubagentRunConfig {
	id: string;
	steps: RunnerStep[];
	resultPath: string;
	cwd: string;
	placeholder: string;
	taskIndex?: number;
	totalTasks?: number;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: Partial<ArtifactConfig>;
	share?: boolean;
	sessionDir?: string;
	asyncDir: string;
	sessionId?: string | null;
	piPackageRoot?: string;
	piArgv1?: string;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	worktreeBaseDir?: string;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTargets?: Array<string | undefined>;
	resultMode?: SubagentRunMode;
	dynamicFanoutMaxItems?: number;
	workflowGraph?: WorkflowGraphSnapshot;
	nestedRoute?: NestedRouteInfo;
	nestedSelf?: { parentRunId: string; parentStepIndex?: number; depth: number; path?: Array<{ runId: string; stepIndex?: number; agent?: string }> };
	timeoutMs?: number;
	deadlineAt?: number;
	turnBudget?: ResolvedTurnBudget;
	toolBudget?: ResolvedToolBudget;
	/** Global cap on simultaneously-running subagent tasks within this run. */
	globalConcurrencyLimit?: number;
}

/** Shared CLI consumption, deliberately inert until called by an entrypoint. */
export function runRunnerCli(runSubagent: (config: SubagentRunConfig) => Promise<void>): void {
	const configArg = process.argv[2];
	if (configArg) {
		try {
			const configJson = fs.readFileSync(configArg, "utf-8");
			const config = JSON.parse(configJson) as SubagentRunConfig;
			try {
				fs.unlinkSync(configArg);
			} catch {
				// Temp config cleanup is best effort.
			}
			runSubagent(config).catch((runErr) => {
				console.error("Subagent runner error:", runErr);
				process.exit(1);
			});
		} catch (err) {
			console.error("Subagent runner error:", err);
			process.exit(1);
		}
	} else {
		let input = "";
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk) => {
			input += chunk;
		});
		process.stdin.on("end", () => {
			try {
				const config = JSON.parse(input) as SubagentRunConfig;
				runSubagent(config).catch((runErr) => {
					console.error("Subagent runner error:", runErr);
					process.exit(1);
				});
			} catch (err) {
				console.error("Subagent runner error:", err);
				process.exit(1);
			}
		});
	}
}
