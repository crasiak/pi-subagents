import { runSubagent } from "./subagent-runner-core.ts";
import { runRunnerCli } from "./runner-config.ts";

// Production entry: no config, environment or tool input can select test runtime.
runRunnerCli(runSubagent);
