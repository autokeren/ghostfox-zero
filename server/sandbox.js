// server/sandbox.js — per-task Ghostfox engine container lifecycle manager
// Containment-first: one disposable container per task running the official
// Ghostfox image (Firefox engine + Rust MCP runtime). The control layer talks
// MCP over stdio; screenshots flow out through the mounted recordings dir.

import { mkdtemp, readdir, readFile, rm, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GhostfoxClient } from './mcp-client.js';

const IMAGE = process.env.GHOSTFOX_IMAGE || 'ghcr.io/autokeren/ghostfox:latest';
const MEMORY = process.env.SANDBOX_MEMORY || '1g';
const CPUS = process.env.SANDBOX_CPUS || '1.0';
const TIMEOUT_MS = parseInt(process.env.SANDBOX_TIMEOUT_MS || '600000', 10);

/**
 * Spawn a disposable Ghostfox engine container and return a live MCP client
 * wired to it, plus the host dir receiving session artifacts (screenshots).
 *
 * Containment contract:
 *  - `--rm`                  container destroyed on close
 *  - `--memory/--cpus`       hard resource caps
 *  - `--cap-drop ALL`        no Linux capabilities
 *  - `--pids-limit`          process count cap
 *  - `no-new-privileges`     no privilege escalation inside
 *  - only artifact dir mounted; the MCP stream carries plain-text commands
 */
export async function startGhostfoxSandbox() {
  const artifacts = await mkdtemp(join(tmpdir(), 'gf0-'));
  // The engine inside the container writes as a different uid — make the
  // artifact dir world-writable so screenshots can flow out.
  await chmod(artifacts, 0o777);

  const name = `gf0-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const extraArgs = [
    '--rm',
    '--name', name,
    '-e', 'GHOSTFOX_LIVE_VIEW_PORT=7900',
    '--memory', MEMORY,
    '--cpus', CPUS,
    '--pids-limit', '400',
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--network', 'bridge',
    '-v', `${artifacts}:/data`,
  ];

  const client = new GhostfoxClient([]);
  client.start(IMAGE, extraArgs);

  const killTimer = setTimeout(() => {
    client.emit('log', 'sandbox hard timeout reached — killing container\n');
    client.stop();
  }, TIMEOUT_MS);
  client.once('close', () => clearTimeout(killTimer));

  await client.initialize();

  /**
   * Relay a request to the engine's built-in live view (binds 127.0.0.1
   * inside the sandbox, so we reach it through docker exec + bash /dev/tcp
   * instead of opening any inbound port on the sandbox).
   */
  function relayLiveView(path) {
    if (!/^\/[A-Za-z0-9/_.-]*$/.test(path)) return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile('docker', ['exec', name, 'bash', '-c',
        `exec 3<>/dev/tcp/127.0.0.1/7900 && printf 'GET ${path} HTTP/1.0\r\nConnection: close\r\n\r\n' >&3 && cat <&3`],
        { encoding: 'buffer', timeout: 8000, maxBuffer: 15e6 },
        (err, stdout) => {
          if (err) console.error('[live-view relay] docker exec failed:', err.message);
          if (!stdout || stdout.length < 16) { console.error('[live-view relay] empty/bad relay output'); return resolve(null); }
          const sep = stdout.indexOf('\r\n\r\n');
          if (sep === -1) { console.error('[live-view relay] no HTTP header sep'); return resolve(null); }
          const head = stdout.slice(0, sep).toString();
          const status = parseInt(head.split(' ')[1] || '500', 10);
          const ct = (/content-type:\s*([^\r\n]+)/i.exec(head) || [])[1] || 'text/html';
          resolve({ status, contentType: ct.trim(), body: stdout.slice(sep + 4) });
        });
    });
  }

  return {
    client,
    artifacts,
    name,
    relayLiveView,
    async screenshots() {
      const shots = [];
      const walk = async (dir) => {
        let entries = [];
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const p = join(dir, e.name);
          if (e.isDirectory()) await walk(p);
          else if (e.name.endsWith('.png')) {
            shots.push({ path: p, b64: (await readFile(p)).toString('base64') });
          }
        }
      };
      await walk(artifacts);
      return shots;
    },
    async destroy() {
      clearTimeout(killTimer);
      client.stop();
      // Force-destroy any container still alive (killing the docker CLI
      // process alone leaves the container running).
      try {
        const { execSync } = await import('node:child_process');
        execSync(`docker ps -q --filter ancestor=${IMAGE} | xargs -r docker kill`, { stdio: 'ignore' });
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
      await rm(artifacts, { recursive: true, force: true });
    },
  };
}

export { MEMORY, CPUS, IMAGE, TIMEOUT_MS };
