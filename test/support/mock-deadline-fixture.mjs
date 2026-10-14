import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/** Opt-in fixture only; ordinary mock calls have no extra timer or receipt. */
export function deadlineFixture(options, args) {
	if (!options) return undefined;
	const root = process.env.CRA879_TEST_CHANNEL;
	assert.equal(options.root, root);
	const identity = JSON.parse(fs.readFileSync(path.join(root, 'identity.json'), 'utf8'));
	assert.equal(options.nonce, identity.nonce);
	assert.equal(options.runId, process.env.PI_SUBAGENT_RUN_ID);
	assert.equal(options.runId, identity.id);
	const modelIndex = args.indexOf('--model');
	const base = { nonce: identity.nonce, runId: identity.id, pid: process.pid, ppid: process.ppid,
		stepIndex: Number(process.env.PI_SUBAGENT_CHILD_INDEX), agent: process.env.PI_SUBAGENT_CHILD_AGENT,
		attempt: 0, model: modelIndex >= 0 ? args[modelIndex + 1] : undefined };
	const owned = path.join(root, `owned-fixture-${process.pid}.json`);
	fs.writeFileSync(`${owned}.tmp`, JSON.stringify(base));
	fs.renameSync(`${owned}.tmp`, owned);
	let sequence = 0;
	const record = (type, extra = {}) => {
		const name = `fixture-${process.pid}-${++sequence}`;
		fs.writeFileSync(path.join(root, `${name}.tmp`), JSON.stringify({ ...base, type, at: Date.now(), ...extra }));
		fs.renameSync(path.join(root, `${name}.tmp`), path.join(root, `${name}.json`));
	};
	const hold = () => new Promise(() => {
		// A timeout here FAILS first; it cannot release a child into successful output.
		setTimeout(() => { record('watchdog'); process.exit(98); }, 25_000);
	});
	return {
		record,
		beforeReady: async () => { if (options.hold === 'before-ready') { record('before-ready'); await hold(); } },
		afterReady: async (callFile) => {
			record('ready', { callFile, disposition: options.ignoreSigterm ? 'ignore-SIGTERM' : 'default' });
			if (options.hold === 'after-ready') await hold();
		},
	};
}
