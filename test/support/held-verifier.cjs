// Real aggregate acceptance command, held until production cancellation; never succeeds naturally.
const fs = require('node:fs');
const path = require('node:path');
const [root, runId, nonce] = process.argv.slice(2);
const identity = JSON.parse(fs.readFileSync(path.join(root, 'identity.json'), 'utf8'));
if (identity.id !== runId || identity.nonce !== nonce) throw new Error('Verifier identity mismatch');
const base = { runId, nonce, pid: process.pid, ppid: process.ppid, agent: 'aggregate-verifier', stepIndex: 1 };
function record(type, extra = {}) {
 const file = path.join(root, `fixture-verifier-${type}.json`);
 fs.writeFileSync(file + '.tmp', JSON.stringify({ ...base, type, at: Date.now(), ...extra }));
 fs.renameSync(file + '.tmp', file);
}
process.on('SIGTERM', () => { record('sigterm'); process.exit(0); });
const owned = path.join(root, `owned-fixture-verifier-${process.pid}.json`);
fs.writeFileSync(owned + '.tmp', JSON.stringify(base));
fs.renameSync(owned + '.tmp', owned);
record('verifier-ready');
setTimeout(() => { record('watchdog', { failed: true }); process.exit(96); }, 20000);
