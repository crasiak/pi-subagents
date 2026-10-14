import * as fs from "node:fs";
import { runRunnerCli } from "../../src/runs/background/runner-config.ts";

// Layer A observes real launcher serialization, not execution/termination evidence.
runRunnerCli(async (config) => {
	fs.writeFileSync(process.env.CRA879_CONFIG_CAPTURE!, JSON.stringify(config), { flag: "wx" });
});
