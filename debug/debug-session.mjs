import { GhostfoxClient } from '../server/mcp-client.js';

const c = new GhostfoxClient([]);
c.on('log', (l) => process.stdout.write(`[log] ${l}`));
c.on('close', (code) => { console.log(`[close] code=${code}`); process.exit(0); });

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

c.start('ghcr.io/autokeren/ghostfox:latest', [
  '--rm', '--memory', '1g', '--cpus', '1.0', '--pids-limit', '400',
  '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--network', 'bridge', '-v', '/tmp/gf0-artifacts:/root/.ghostfox',
]);
await c.initialize();

const sid = await c.callText('session_create', {});
console.log(`${ts()} session_id = "${sid}"`);

const pid = await c.callText('page_open', { session_id: sid, url: 'https://httpbin.org/forms/post' });
console.log(`${ts()} page_open → "${pid}"`);

const a11y = await c.callText('page_a11y', { session_id: sid, page_id: pid });
console.log(`${ts()} a11y (${a11y.length} chars): ${a11y.slice(0, 400).replace(/\n/g, ' | ')}`);

const shot = await c.callText('page_screenshot', { session_id: sid, page_id: pid });
console.log(`${ts()} screenshot path → "${shot}"`);

console.log(`${ts()} DONE`);
c.stop();
process.exit(0);
