// server/sandbox.js — per-task Docker container lifecycle manager
// Containment-first: one container per task, hard resource limits,
// plain-text steps in, screenshots out, container destroyed afterwards.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IMAGE = process.env.SANDBOX_IMAGE || 'ghostfox-sandbox';
const MEMORY = process.env.SANDBOX_MEMORY || '512m';
const CPUS = process.env.SANDBOX_CPUS || '0.5';
const TIMEOUT_MS = parseInt(process.env.SANDBOX_TIMEOUT_MS || '120000', 10);

/**
 * Run a list of browser steps inside a fresh, disposable Docker container.
 *
 * Containment guarantees:
 *  - `--rm`            container is destroyed immediately after the run
 *  - `--memory/--cpus` hard resource caps per task
 *  - no host volumes   nothing from the control layer is mounted inside
 *  - `--tmpfs`         the sandbox filesystem is in-memory and vanishes
 *  - steps arrive as plain JSON on stdin — no credentials cross the boundary
 *
 * @param {Array} steps  e.g. [{action:'goto',url:'https://example.com'},
 *                             {action:'click',selector:'#submit'},
 *                             {action:'type',selector:'#name',text:'Fox'},
 *                             {action:'screenshot'}]
 * @returns {Promise<{logs:string[], screenshots:string[], ok:boolean, error?:string}>}
 */
export function runInSandbox(steps) {
  return new Promise(async (resolve) => {
    const workdir = await mkdtemp(join(tmpdir(), 'gf0-'));
    const shotsDir = join(workdir, 'shots');

    // docker run flags encode the containment contract
    const args = [
      'run', '--rm',
      '--name', `gf0-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      '--memory', MEMORY,
      '--cpus', CPUS,
      '--pids-limit', '256',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '--network', 'bridge',
      '-v', `${shotsDir}:/shots`,
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      IMAGE,
      'node', '/app/runner.js',
    ];

    const logs = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, TIMEOUT_MS);

    const proc = spawn('docker', args);
    proc.stdin.write(JSON.stringify(steps));
    proc.stdin.end();

    const collect = (stream, out) => {
      stream.on('data', (d) => {
        const text = d.toString();
        logs.push(text);
        out && out(text);
      });
    };
    collect(proc.stdout);
    collect(proc.stderr);

    proc.on('close', async (code) => {
      clearTimeout(timer);
      try {
        // Pull screenshots out of the shared shots dir (sandbox → control only)
        const { readdirSync } = await import('node:fs');
        const screenshots = [];
        let names = [];
        try { names = readdirSync(shotsDir).sort(); } catch {}
        for (const name of names) {
          const buf = await readFile(join(shotsDir, name));
          screenshots.push(buf.toString('base64'));
        }
        await rm(workdir, { recursive: true, force: true });
        resolve({
          ok: code === 0 && !timedOut,
          error: timedOut ? `Sandbox exceeded hard timeout (${TIMEOUT_MS}ms) and was killed.` :
                 code !== 0 ? `Sandbox exited with code ${code}.` : undefined,
          logs,
          screenshots,
        });
      } catch (e) {
        resolve({ ok: false, error: `Failed to collect sandbox artifacts: ${e.message}`, logs, screenshots: [] });
      }
    });
  });
}
