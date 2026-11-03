// server/sandbox.js — per-task Ghostfox engine container lifecycle manager
// Containment-first: one disposable container per task running the official
// Ghostfox image (Firefox engine + Rust MCP runtime). The control layer talks
// MCP over stdio; screenshots flow out through the mounted recordings dir.

import { mkdtemp, readdir, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GhostfoxClient } from './mcp-client.js';

const IMAGE = process.env.GHOSTFOX_IMAGE || 'ghcr.io/autokeren/ghostfox:latest';
const MEMORY = process.env.SANDBOX_MEMORY || '1g';
const CPUS = process.env.SANDBOX_CPUS || '1.0';
const TIMEOUT_MS = parseInt(process.env.SANDBOX_TIMEOUT_MS || '300000', 10);

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

  const extraArgs = [
    '--rm',
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

  return {
    client,
    artifacts,
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
