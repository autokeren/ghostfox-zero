import { GhostfoxClient } from '../server/mcp-client.js';
const c = new GhostfoxClient([]);
c.on('close', () => process.exit(0));
c.start('ghcr.io/autokeren/ghostfox:latest', [
  '--rm', '--memory', '1g', '--cpus', '1.0', '--pids-limit', '400',
  '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--network', 'bridge',
  '-v', '/tmp/gf0-artifacts:/root/.ghostfox',
]);
await c.initialize();
const sid = await c.callText('session_create', {});
const pid = await c.callText('page_open', { session_id: sid, url: 'https://example.com' });
const raw = await c.request('tools/call', { name: 'page_screenshot', arguments: { session_id: sid, page_id: pid } });
console.log('FULL_RESULT:', JSON.stringify(raw).slice(0, 600));
c.stop();
process.exit(0);
