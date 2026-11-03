// server/index.js — Ghostfox Zero control layer (deploy on a Vultr VM)
import express from 'express';
import { config } from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTask, resolveApproval, hasPendingApproval } from './orchestrator.js';
import { inferenceInfo } from './inference.js';

config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(__dirname, '..', 'web')));

// SSE-style event bus per run (simple in-memory; one active run at a time)
let listeners = new Set();
let runScreenshots = [];
function broadcast(evt) {
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of listeners) res.write(line);
  console.log(`[evt] ${evt.type} ${JSON.stringify(evt.data || {}).slice(0, 140)}`);
}

let activeRun = null;

app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('data: {"type":"hello"}\n\n');
  listeners.add(res);
  req.on('close', () => listeners.delete(res));
});

app.post('/run', async (req, res) => {
  const { goal } = req.body || {};
  if (!goal || typeof goal !== 'string' || goal.length > 2000) {
    return res.status(400).json({ error: 'goal required (max 2000 chars)' });
  }
  if (activeRun) {
    return res.status(409).json({ error: 'a run is already active' });
  }
  res.json({ started: true });

  runScreenshots = [];
  activeRun = runTask(goal, (evt) => {
    if (evt.type === 'screenshot' && evt.data?.b64) {
      runScreenshots.push(evt.data.b64);
      broadcast({ type: 'screenshot', data: { index: runScreenshots.length - 1 } });
      return; // don't broadcast the heavy payload twice
    }
    if (evt.type === 'done' && Array.isArray(evt.data?.screenshots)) {
      runScreenshots = evt.data.screenshots;
    }
    broadcast(evt);
  })
    .then((result) => {
      if (Array.isArray(result?.screenshots)) runScreenshots = result.screenshots;
      broadcast({ type: 'done', data: result });
      activeRun = null;
    })
    .catch((e) => {
      broadcast({ type: 'error', data: { message: e.message } });
      activeRun = null;
    });
});

app.post('/approve', (req, res) => {
  const { approved } = req.body || {};
  if (!hasPendingApproval()) return res.status(404).json({ error: 'no pending approval' });
  resolveApproval(Boolean(approved));
  res.json({ ok: true });
});

app.get('/status', (req, res) => {
  res.json({
    running: activeRun !== null,
    pendingApproval: hasPendingApproval(),
    inference: inferenceInfo(),
  });
});

app.get('/screenshots', (req, res) => {
  res.json({ shots: runScreenshots });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🦊 Ghostfox Zero control layer listening on :${PORT}`);
  const inf = inferenceInfo(); console.log(`   Inference: ${inf.baseUrl} (chat=${inf.chatModel}, vision=${inf.visionModel})`);
});
