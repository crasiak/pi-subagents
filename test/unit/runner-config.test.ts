import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const probe = fileURLToPath(new URL("../support/runner-config-probe.ts", import.meta.url));
function run(args: string[], input = "") {
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	return spawnSync(process.execPath, ["--experimental-strip-types", probe, ...args], {
		input, encoding: "utf8", env, timeout: 5_000,
	});
}

describe("shared runner CLI config consumption", () => {
	it("reports unreadable and malformed config without consuming malformed input", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-config-"));
		try {
			const missing = run([path.join(dir, "missing.json")]);
			assert.equal(missing.status, 1);
			assert.match(missing.stderr, /Subagent runner error:.*ENOENT/s);
			const file = path.join(dir, "bad.json");
			fs.writeFileSync(file, "{");
			const invalid = run([file]);
			assert.equal(invalid.status, 1);
			assert.match(invalid.stderr, /Subagent runner error:.*SyntaxError/s);
			assert.equal(fs.readFileSync(file, "utf8"), "{");
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("reports async run failures after consuming the file", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-config-"));
		try {
			const file = path.join(dir, "reject.json");
			fs.writeFileSync(file, '{"id":"reject"}');
			const result = run([file]);
			assert.equal(result.status, 1);
			assert.match(result.stderr, /Subagent runner error:.*probe execution rejected/s);
			assert.equal(fs.existsSync(file), false);
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("reads and unlinks a config path, preserving its absolute deadline", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-config-"));
		try {
			const file = path.join(dir, "config with spaces.json");
			const config = { id: "test", timeoutMs: 1_500, deadlineAt: 12_345, steps: [] };
			fs.writeFileSync(file, JSON.stringify(config));
			const result = run([file]);
			assert.equal(result.status, 0, result.stderr);
			assert.deepEqual(JSON.parse(result.stdout), config);
			assert.equal(fs.existsSync(file), false);
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("retains stdin fallback and malformed-stdin error behavior", () => {
		const config = { id: "stdin", timeoutMs: 1_500, deadlineAt: 99 };
		const valid = run([], JSON.stringify(config));
		assert.equal(valid.status, 0, valid.stderr);
		assert.deepEqual(JSON.parse(valid.stdout), config);
		const invalid = run([], "{");
		assert.equal(invalid.status, 1);
		assert.match(invalid.stderr, /Subagent runner error:.*SyntaxError/s);
	});
});
