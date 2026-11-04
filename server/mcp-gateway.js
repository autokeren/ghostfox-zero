// server/mcp-gateway.js — Public MCP endpoint for Ghostfox Zero
// Exposes the Ghostfox engine's MCP tools via SSE so ANY AI agent
// (Claude, GPT, Cursor, etc.) can connect and drive a browser.
//
// Architecture:
//   AI agent → SSE /mcp/sse → this gateway → spawns disposable Ghostfox
//   container → pipes JSON-RPC between agent and engine via stdio.
//
// Each connection gets its OWN disposable container (per-session isolation).
// When the agent disconnects, the container is destroyed (zero residue).

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const IMAGE = process.env.GHOSTFOX_IMAGE || 'ghostfox-zero-sandbox';
const MCP_API_KEY = process.env.MCP_API_KEY;

export class McpSseSession {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.proc = null;
    this.buf = '';
    this.eventQueue = [];
    this.ready = false;
    this.nextId = 1;
    this.pending = new Map();
  }

  start() {
    // Spawn a disposable Ghostfox engine container per MCP session
    const args = [
      'run', '-i', '--rm',
      '--name', `gf0-mcp-${this.sessionId.slice(0, 8)}`,
      '-e', 'GHOSTFOX_TOOLSET=full',
      '--memory', '1g', '--cpus', '1.0',
      '--pids-limit', '400',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '--network', 'bridge',
      IMAGE,
    ];
    this.proc = spawn('docker', args);
    this.ready = true; // MCP server is ready from boot — stdin is piped
    this.proc.stdout.on('data', (d) => {
      const s = d.toString();
      console.log(`[mcp-gateway] stdout: ${s.slice(0, 100)}`);
      this._onData(d);
    });
    this.proc.stderr.on('data', (d) => {
      console.log(`[mcp-gateway] stderr: ${d.toString().slice(0, 100)}`);
    });
    this.proc.on('close', (code) => {
      this.ready = false;
      console.error(`[mcp-gateway] container ${this.sessionId.slice(0, 8)} exited code=${code}`);
    });
    return this;
  }

  _onData(d) {
    this.buf += d.toString();
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        // Forward ALL messages from engine to the SSE client
        this.eventQueue.push(JSON.stringify(msg));
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          resolve(msg);
        }
      } catch { /* engine log noise */ }
    }
  }

  send(message) {
    if (!this.proc || this.proc.killed) return false;
    try {
      const line = JSON.stringify(message) + '\n';
      this.proc.stdin.write(line);
      console.log(`[mcp-gateway] sent: ${line.slice(0, 80)}`);
      return true;
    } catch (e) {
      console.error(`[mcp-gateway] send error: ${e.message}`);
      return false;
    }
  }

  stop() {
    if (this.proc && !this.proc.killed) {
      try { this.proc.stdin.end(); } catch {}
      try { this.proc.kill('SIGKILL'); } catch {}
    }
  }
}

/**
 * Register the MCP SSE gateway on an existing Express app.
 * Endpoint: GET /mcp/sse  (SSE stream for MCP client)
 *           POST /mcp/msg  (JSON-RPC messages from client)
 */
export function mountMcpGateway(app) {
  const sessions = new Map();

  // SSE endpoint — MCP client connects here
  app.get('/mcp/sse', (req, res) => {
    // Auth check (simple API key header)
    if (MCP_API_KEY && req.headers['x-api-key'] !== MCP_API_KEY) {
      return res.status(401).json({ error: 'invalid API key' });
    }

    const sessionId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session = new McpSseSession(sessionId);
    session.start();
    sessions.set(sessionId, session);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Mcp-Session-Id': sessionId,
    });
    res.write(`data: ${JSON.stringify({ type: 'mcp_connected', sessionId })}\n\n`);

    // Polling loop: forward engine messages to SSE client
    const poll = setInterval(() => {
      while (session.eventQueue.length > 0) {
        const msg = session.eventQueue.shift();
        res.write(`data: ${msg}\n\n`);
      }
    }, 50);

    req.on('close', () => {
      clearInterval(poll);
      session.stop();
      sessions.delete(sessionId);
      // Kill the container by name
      try {
        const { execSync } = require('node:child_process');
        execSync(`docker kill gf0-mcp-${sessionId.slice(4, 12)} 2>/dev/null || true`, { stdio: 'ignore' });
      } catch {}
    });
  });

  // POST endpoint — MCP client sends JSON-RPC messages here
  app.post('/mcp/msg', (req, res) => {
    if (MCP_API_KEY && req.headers['x-api-key'] !== MCP_API_KEY) {
      return res.status(401).json({ error: 'invalid API key' });
    }
    const sessionId = req.headers['x-mcp-session-id'] || req.body?.sessionId;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'session not found' });

    // Forward the message to the Ghostfox engine
    const ok = session.send(req.body);
    res.json({ ok });
  });

  // CORS preflight
  app.options('/mcp/sse', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-Mcp-Session-Id');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.sendStatus(200);
  });

  return sessions;
}
