import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const probe = fileURLToPath(new URL("../support/deadline-launcher-probe.ts", import.meta.url));
function ownedEnvironment(root: string) {
	const env = { ...process.env, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
		TMPDIR: path.join(root, "tmp"), TEMP: path.join(root, "tmp"), TMP: path.join(root, "tmp"),
		XDG_CACHE_HOME: path.join(root, "cache"), CRA879_CONFIG_CAPTURE: path.join(root, "config.json") };
	delete env.NODE_TEST_CONTEXT;
	delete env.NODE_OPTIONS;
	for (const name of ["home", "tmp", "cache"]) fs.mkdirSync(path.join(root, name));
	return env;
}

describe("private launcher deadline composition", () => {
	for (const mode of ["single", "chain", "unbounded", "invalid"]) {
		it(`${mode}: preserves the pre-spawn absolute deadline and validation ordering`, () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadline-wiring-"));
			try {
				const child = spawnSync(process.execPath, ["--experimental-transform-types", probe, mode], {
					cwd: root, env: ownedEnvironment(root), encoding: "utf8", timeout: 25_000,
				});
				assert.equal(child.status, 0, child.stderr);
				const p = JSON.parse(child.stdout);
				assert.ok(p.TEMP_ROOT_DIR.startsWith(path.join(root, "tmp") + path.sep), p.TEMP_ROOT_DIR);
				if (mode === "invalid") {
					assert.equal(p.result.isError, true);
					assert.equal(p.samples, 0, "validation precedes deadline origin");
					assert.equal(p.emitted.length, 0);
					return;
				}
				assert.equal(p.samples, mode === "unbounded" ? 0 : 1);
				const deadline = mode === "unbounded" ? undefined : 11_500;
				assert.equal(p.config.deadlineAt, deadline);
				assert.equal(p.result.details.deadlineAt, deadline);
				assert.equal(p.emitted.length, 1);
				assert.equal(p.emitted[0].event.deadlineAt, deadline);
				assert.equal(p.config.timeoutMs, mode === "unbounded" ? undefined : 1_500);
				assert.equal(p.config.deadlineClock, undefined);
				assert.equal(p.config.runnerEntry, undefined);
				assert.equal(p.config.asyncDir, path.join(p.ASYNC_DIR, p.config.id));
				assert.deepEqual(p.remainingConfigFiles, [], "shared config reader consumes launcher config");
			} finally { fs.rmSync(root, { recursive: true, force: true }); }
		});
	}

	it("runner core imports without consuming CLI arguments, stdin or starting a run", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-import-"));
		try {
			const env = ownedEnvironment(root);
			const sentinel = path.join(root, "sentinel.json");
			fs.writeFileSync(sentinel, "not config");
			const core = pathToFileURL(fileURLToPath(new URL("../../src/runs/background/subagent-runner-core.ts", import.meta.url))).href;
			const script = `process.argv[2]=${JSON.stringify(sentinel)}; const before=process.stdin.listenerCount('data'); const m=await import(${JSON.stringify(core)}); if(typeof m.runSubagent!=='function'||process.stdin.listenerCount('data')!==before) process.exit(2); console.log('import-safe');`;
			const child = spawnSync(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", script], { cwd: root, env, encoding: "utf8", timeout: 10_000 });
			assert.equal(child.status, 0, child.stderr);
			assert.equal(child.stdout.trim(), "import-safe");
			assert.equal(fs.readFileSync(sentinel, "utf8"), "not config");
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});
});
