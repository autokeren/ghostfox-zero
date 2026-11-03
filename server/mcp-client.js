// server/mcp-client.js — minimal MCP stdio client that spawns the official
// Ghostfox container image (engine + Rust MCP runtime) and speaks JSON-RPC
// over docker run -i. One container per task, destroyed after (--rm).

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export class GhostfoxClient extends EventEmitter {
  constructor(dockerArgs) {
    super();
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
  }

  start(image, extraArgs = []) {
    const args = ['run', '-i', '--rm', ...extraArgs, image];
    this.proc = spawn('docker', args);
    this.proc.stdout.on('data', (d) => this._onStdout(d));
    this.proc.stderr.on('data', (d) => this.emit('log', d.toString()));
    this.proc.on('close', (code) => this.emit('close', code));
    return this;
  }

  _onStdout(d) {
    this.buf += d.toString();
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        } else {
          this.emit('notification', msg);
        }
      } catch {
        this.emit('log', line);
      }
    }
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.killed) return reject(new Error('container not running'));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  /** Full MCP handshake. */
  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'ghostfox-zero', version: '1.0.0' },
    });
    this.notify('notifications/initialized', {});
    return result;
  }

  /** tools/call — returns the tool result content text. */
  async call(name, args) {
    const result = await this.request('tools/call', { name, arguments: args });
    if (result.isError) {
      throw new Error(`tool ${name} failed: ${JSON.stringify(result.content).slice(0, 200)}`);
    }
    return result;
  }

  /** tools/call returning the first text content block, parsed as JSON if possible. */
  async callJSON(name, args) {
    const result = await this.call(name, args);
    const text = (result.content || []).find((c) => c.type === 'text')?.text ?? '';
    try { return JSON.parse(text); } catch { return text; }
  }

  stop() {
    if (this.proc && !this.proc.killed) {
      try { this.proc.stdin.end(); } catch {}
      setTimeout(() => { try { this.proc.kill('SIGKILL'); } catch {} }, 3000);
    }
  }
}
