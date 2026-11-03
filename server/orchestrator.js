// server/orchestrator.js — the TRUE agentic loop
// The LLM doesn't pre-plan rigid steps: it sees the live page through
// Ghostfox's semantic accessibility layer (page_a11y) and decides ONE action
// at a time. Every step is verified by a vision model on Vultr Serverless
// Inference, and final actions require explicit human approval.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chat, vision } from './inference.js';
import { startGhostfoxSandbox } from './sandbox.js';

const MAX_STEPS = 12;

const DECIDE_SYSTEM = `You are the reasoning core of Ghostfox Zero, a sandboxed browser agent.
You receive: the user goal, the page URL, and a semantic accessibility snapshot of the current
page (interactive elements carry stable refs like "e1"). Reply with exactly ONE next action.

Reply format — strict JSON, one object, no prose:
{"action":"goto","url":"https://..."}          open the first page (only when no page is open)
{"action":"click","ref":"e12"}                 click an element by its ref
{"action":"type","ref":"e7","text":"..."}      type text into a field by its ref
{"action":"press","key":"Enter"}              press a single key
{"action":"wait","ms":5000}                    wait for slow/loading pages (SPA, skeleton screens)
{"action":"screenshot"}                        take a fresh screenshot (use after waiting)
{"action":"final_click","ref":"e3"}           click that COMMITS data (submit/send/purchase button) — triggers human approval
{"action":"done","summary":"..."}              goal achieved, stop

Rules:
1. One action per reply. JSON only.
2. Use ONLY refs present in the snapshot; never invent refs.
3. Use final_click for anything that submits or commits data.
4. If the visible page already satisfies the goal, return done.
5. If the last screenshot looked blank/empty (SPA still loading), use {"action":"wait","ms":5000} then {"action":"screenshot"}.`;

const VERIFY_PROMPT = (goal, lastAction) =>
  `You are the verification layer of Ghostfox Zero, a sandboxed browser agent.
The user's goal was: "${goal}".
The agent just performed: ${lastAction}.
Look at the screenshot of the current page. Answer STRICTLY as JSON: {"pass": true|false, "reason": "<one sentence>"}`;

let pendingApproval = null;

export async function runTask(goal, onEvent) {
  const emit = (type, data) => onEvent && onEvent({ type, data, ts: Date.now() });

  const sb = await startGhostfoxSandbox();
  const { client } = sb;
  client.on('log', (l) => emit('sandbox_log', l));

  let sessionId = null;
  let pageId = null;
  let url = null;
  const history = [];
  const screenshots = [];

  try {
    emit('phase', 'spawning ghostfox engine (disposable container)');

    sessionId = (await client.callText('session_create', {})).trim();
    if (!sessionId) throw new Error('session_create returned no session id');
    emit('phase', `engine session ${sessionId}`);

    let action = await decideNext(goal, url, null, history);

    for (let step = 0; step < MAX_STEPS; step++) {
      emit('step', { n: step + 1, action });
      history.push(action);

      if (action.action === 'done') {
        emit('phase', `goal complete: ${action.summary || ''}`);
        break;
      }

      // ---- Human approval gate for committing actions ----
      if (action.action === 'final_click') {
        await captureScreenshot({ emit, client, sb, screenshots, sessionId, pageId });
        emit('approval_required', { action, step });
        const approved = await new Promise((resolve) => { pendingApproval = { resolve }; });
        pendingApproval = null;
        if (!approved) {
          emit('phase', 'rejected by human — aborting');
          return { ok: false, rejected: true, screenshots, history };
        }
        action = { action: 'click', ref: action.ref };
      }

      // ---- Execute one action through the Ghostfox engine ----
      const receipt = await executeAction(client, sessionId, pageId, action, (pid) => { pageId = pid; }, (u) => { url = u; });
      if (receipt) emit('sandbox_log', receipt);

      // settle beat for dynamic pages
      if (pageId) {
        try { await client.call('page_wait_stable', { session_id: sessionId, page_id: pageId, max_ms: 15000 }); } catch {}
      }

      // ---- Screenshot + vision verification (Vultr Inference) ----
      const b64 = await captureScreenshot({ emit, client, sb, screenshots, sessionId, pageId });
      if (b64) {
        try {
          const vRaw = await vision(VERIFY_PROMPT(goal, JSON.stringify(action)), b64);
          const vJson = extractJSON(vRaw);
          emit('verify', { step, ...vJson });
        } catch (e) {
          emit('verify_error', { message: e.message });
        }
      }

      // ---- Read the page semantically, let the LLM decide next ----
      let a11y = null;
      if (pageId) {
        try {
          a11y = (await client.callText('page_a11y', { session_id: sessionId, page_id: pageId })).slice(0, 8000);
        } catch (e) {
          emit('sandbox_log', `a11y unavailable: ${e.message}`);
        }
      }
      action = await decideNext(goal, url, a11y, history);
    }

    emit('phase', 'complete');
    return { ok: true, screenshots, history };
  } catch (e) {
    emit('error', { message: e.message });
    return { ok: false, screenshots, history };
  } finally {
    await sb.destroy();
    emit('phase', 'sandbox container destroyed (zero residue)');
  }
}

async function executeAction(client, sessionId, pageId, action, setPage, setUrl) {
  switch (action.action) {
    case 'goto': {
      const pid = (await client.callText('page_open', { session_id: sessionId, url: action.url })).trim();
      setPage(pid);
      setUrl(action.url);
      return `opened ${action.url} (page ${pid})`;
    }
    case 'click': {
      if (!pageId) throw new Error('no page open');
      await client.call('page_click_ref', { session_id: sessionId, page_id: pageId, ref: action.ref });
      return `clicked ${action.ref}`;
    }
    case 'type': {
      if (!pageId) throw new Error('no page open');
      await client.call('page_type_ref', { session_id: sessionId, page_id: pageId, ref: action.ref, text: String(action.text).slice(0, 500) });
      return `typed into ${action.ref}`;
    }
    case 'wait': {
      await new Promise((r) => setTimeout(r, Math.min(parseInt(action.ms || '3000', 10) || 3000, 15000)));
      return `waited ${action.ms || 3000}ms`;
    }
    case 'screenshot': {
      if (!pageId) throw new Error('no page open');
      await client.call('page_screenshot', { session_id: sessionId, page_id: pageId });
      return 'screenshot captured';
    }
    case 'press': {
      if (!pageId) throw new Error('no page open');
      await client.call('page_press', { session_id: sessionId, page_id: pageId, key: action.key || 'Enter' });
      return `pressed ${action.key || 'Enter'}`;
    }
    default:
      throw new Error(`unknown action: ${action.action}`);
  }
}

/** Take a screenshot via the engine, push it to the artifacts, return base64. */
async function captureScreenshot({ emit, client, sb, screenshots, sessionId, pageId }) {
  if (!pageId) return null;
  try {
    const raw = await client.callText('page_screenshot', { session_id: sessionId, page_id: pageId });
    const info = extractJSON(raw); // { bytes, file }
    if (!info.file) return null;
    // in-container path /data/... maps to the mounted artifacts dir
    const hostPath = join(sb.artifacts, info.file.replace(/^\/data\/?/, ''));
    const b64 = (await readFile(hostPath)).toString('base64');
    emit('screenshot', { index: screenshots.length, b64 });
    screenshots.push(b64);
    return b64;
  } catch (e) {
    emit('sandbox_log', `screenshot failed: ${e.message}`);
    return null;
  }
}

async function decideNext(goal, url, a11y, history) {
  const userMsg = `Goal: ${goal}
Current URL: ${url || '(none yet)'}

Semantic page snapshot (refs are stable):
${a11y ? a11y.slice(0, 6000) : '(page not open yet)'}

Actions already taken: ${history.length ? history.map((a) => JSON.stringify(a)).join(' ; ') : 'none'}

Decide the next single action.`;
  const msgs = [
    { role: 'system', content: DECIDE_SYSTEM },
    { role: 'user', content: userMsg },
  ];
  // Reasoning models can burn the whole budget thinking on huge pages;
  // if the first reply comes back without JSON, retry once with a reminder.
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await chat(msgs, { maxTokens: 6000 });
    try {
      return extractJSON(raw);
    } catch {
      if (attempt === 1) throw new Error('model produced no action JSON twice');
      msgs.push({ role: 'assistant', content: raw.slice(0, 200) || '(empty)' });
      msgs.push({ role: 'user', content: 'Reply with the action JSON object ONLY. No reasoning prose.' });
    }
  }
}

function extractJSON(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`no JSON in model/tool reply: ${String(text).slice(0, 80)}`);
  return JSON.parse(text.slice(start, end + 1));
}

export function resolveApproval(approved) {
  if (pendingApproval) pendingApproval.resolve(approved);
}
export function hasPendingApproval() {
  return pendingApproval !== null;
}
