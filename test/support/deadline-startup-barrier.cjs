// Test-only preload. It holds exactly the production runner before Jiti imports it.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const root = process.env.CRA879_TEST_CHANNEL;
if (root && fs.existsSync(path.join(root, 'barrier-identity.json'))) {
	const identity = JSON.parse(fs.readFileSync(path.join(root, 'barrier-identity.json'), 'utf8'));
	if (process.argv[2] === identity.entry) {
		const fail = (message) => {
			fs.writeFileSync(path.join(root, 'barrier-failure.json'), JSON.stringify({ failed: true, message, at: Date.now(), pid: process.pid }));
			process.stderr.write(message + '\n');
			process.exit(96);
		};
		if (process.argv.length !== 4 || !/jiti-cli\.mjs$/.test(process.argv[1])) fail('Unexpected runner argv layout');
		const configPath = process.argv[3];
		if (!path.resolve(configPath).startsWith(path.join(root, 'tmp') + path.sep)) fail('Config escaped owned root');
		const bytes = fs.readFileSync(configPath);
		const config = JSON.parse(bytes);
		const budget = identity.budgetMs ?? 1500;
		if (![1000, 1500].includes(budget) || config.id !== identity.id || config.timeoutMs !== budget || !Number.isFinite(config.deadlineAt)) fail('Runner config identity mismatch');
		const ack = { type: 'runner-preload-held', id: config.id, nonce: identity.nonce, pid: process.pid,
			configPath, config, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), argv: process.argv, at: Date.now() };
		fs.writeFileSync(path.join(root, 'preload-held.tmp'), JSON.stringify(ack));
		fs.renameSync(path.join(root, 'preload-held.tmp'), path.join(root, 'preload-held.json'));
		const started = performance.now();
		const wait = new Int32Array(new SharedArrayBuffer(4));
		while (!fs.existsSync(path.join(root, 'release-startup.json'))) {
			if (performance.now() - started > 20000) fail('Runner preload watchdog expired');
			Atomics.wait(wait, 0, 0, 10);
		}
		const release = JSON.parse(fs.readFileSync(path.join(root, 'release-startup.json'), 'utf8'));
		if (release.id !== identity.id || release.nonce !== identity.nonce || Date.now() <= config.deadlineAt) fail('Premature/mismatched startup release');
		fs.writeFileSync(path.join(root, 'preload-released.json'), JSON.stringify({ ...ack, releasedAt: Date.now() }));
	}
}
