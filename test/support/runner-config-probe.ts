import { runRunnerCli } from "../../src/runs/background/runner-config.ts";

runRunnerCli(async (config) => {
	if (config.id === "reject") throw new Error("probe execution rejected");
	process.stdout.write(JSON.stringify(config));
});
