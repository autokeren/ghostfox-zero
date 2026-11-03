// server/orchestrator.js — the TRUE agentic loop
// The LLM doesn't pre-plan rigid steps: it sees the live page through
// Ghostfox's semantic accessibility layer (page_a11y) and decides ONE action
// at a time. Every step is verified by a vision model on Vultr Serverless
// Inference, and final actions require explicit human approval.

import { chat, vision } from './inference.js';
import { startGhostfoxSandbox } from './sandbox.js';

const MAX_STEPS = 12;

const DECIDE_SYSTEM = `You are the reasoning core of Ghostfox Zero, a sandboxed browser agent.
You are given a user goal, the page URL, and a semantic accessibility snapshot of the current page
(element refs are shown as [eN]). Decide exactly ONE next action.

Actions you may return (strict JSON, no prose):
{"action":"goto","url":"https://..."}                          open the first page
{"action":"click","ref":"e12"}                                click an element by ref
{"action":"type","ref":"e7","text":"..."}                     type into a field by ref
{"action":"press","key":"Enter"}                               press a key
{"action":"screenshot"}                                        capture the page for verification
{"action":"final_click","ref":"e12"}                           click that COMMITS data (submit button) — triggers human approval
{"action":"done","summary":"..."}                               goal achieved, stop

Rules:
1. One action per reply. JSON only.
2. Use "final_click" for anything that submits/sends/purchases.
3. If the goal is achieved or the page shows the desired result, return done.
4. Prefer refs from the snapshot; never invent refs.`;

const VERIFY_PROMPT = (goal, lastAction) =>
  `You are the verification layer of Ghostfox Zero.
User goal: "${goal}".
Last action: ${lastAction}.
Look at the screenshot and answer STRICTLY as JSON: {"pass": true|false, "reason": "<one sentence>"}`;

let pendingApproval = null;

export async function runTask(goal, onEvent) {
  const emit = (type, data) => onEvent && onEvent({ type, data, ts: Date.now() });

  const sb = await startGhostfoxSandbox();
  const { client } = sb;
  client.on('log', (l) => emit('sandbox_log', l));

  let sessionId = null;
  let pageId = null;
  const history = [];
  const screenshots = [];

  try {
    // Session + first page
    emit('phase', 'spawning ghostfox engine (disposable container)');
    const session = await client.callJSON('session_create', {});
    sessionId = session.session_id;
    if (!sessionId) throw new Error('no session_id from session_create');

    const act = await decideNext(goal, null, null, history);
    let action = act;
    let lastUrl = null;

    for (let step = 0; step < MAX_STEPS; step++) {
      emit('step', { n: step + 1, action });
      history.push(action);

      if (action.action === 'done') {
        emit('phase', `goal complete: ${action.summary || ''}`);
        break;
      }

      // ---- Human approval gate for final actions ----
      if (action.action === 'final_click') {
        const shots = await sb.screenshots();
        if (shots.length) {
          emit('screenshot', { index: screenshots.length, b64: shots[shots.length - 1].b64 });
          screenshots.push(shots[shots.length - 1].b64);
        }
        emit('approval_required', { action, step });
        const approved = await new Promise((resolve) => { pendingApproval = { resolve }; });
        pendingApproval = null;
        if (!approved) {
          emit('phase', 'rejected by human — aborting');
          return { ok: false, rejected: true, screenshots };
        }
        action = { action: 'click', ref: action.ref };
      }

      // ---- Execute via Ghostfox MCP tools ----
      switch (action.action) {
        case 'goto': {
          const page = await client.callJSON('page_open', { session_id: sessionId, url: action.url });
          pageId = page.page_id;
          lastUrl = action.url;
          break;
        }
        case 'click': {
          if (!pageId) throw new Error('no page open');
          await client.call('page_click_ref', { session_id: sessionId, page_id: pageId, ref: action.ref });
          break;
        }
        case 'type': {
          if (!pageId) throw new Error('no page open');
          await client.call('page_type_ref', { session_id: sessionId, page_id: pageId, ref: action.ref, text: String(action.text).slice(0, 500) });
          break;
        }
        case 'press': {
          if (!pageId) throw new Error('no page open');
          await client.call('page_press', { session_id: sessionId, page_id: pageId, key: action.key || 'Enter' });
          break;
        }
        case 'screenshot': {
          if (!pageId) throw new Error('no page open');
          await client.call('page_screenshot', { session_id: sessionId, page_id: pageId });
          break;
        }
        default:
          throw new Error(`unknown action: ${action.action}`);
      }

      // small settle beat so dynamic pages render
      if (pageId) {
        try { await client.call('page_wait_stable', { session_id: sessionId, page_id: pageId, max_ms: 4000 }); } catch {}
      }

      // ---- Screenshot + vision verification (Vultr Inference) ----
      const shots = await sb.screenshots();
      const fresh = shots.slice(screenshots.length);
      if (fresh.length) {
        const last = fresh[fresh.length - 1];
        emit('screenshot', { index: screenshots.length, b64: last.b64 });
        screenshots.push(last.b64);

        try {
          const vRaw = await vision(VERIFY_PROMPT(goal, JSON.stringify(action)), last.b64);
          const vJson = extractJSON(vRaw);
          emit('verify', { step, ...vJson });
          if (vJson.pass === false) {
            emit('phase', `verification failed: ${vJson.reason}`);
          }
        } catch (e) {
          emit('verify_error', { message: e.message });
        }
      }

      // ---- Read the page semantically and let the LLM decide next ----
      let a11y = null;
      if (pageId) {
        const snap = await client.call('page_a11y', { session_id: sessionId, page_id: pageId });
        const text = (snap.content || []).map((c) => c.text || '').join('\n');
        a11y = text.slice(0, 6000);
      }
      action = await decideNext(goal, lastUrl, a11y, history);
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

async function decideNext(goal, url, a11y, history) {
  const userMsg = `Goal: ${goal}\nCurrent URL: ${url || '(none yet)'}\n
Semantic page snapshot:\n${a11y || '(page not open yet)'}\n
Actions already taken: ${history.length ? history.map((a) => JSON.stringify(a)).join(' ; ') : 'none'}\n
Decide the next single action.`;
  const raw = await chat([
    { role: 'system', content: DECIDE_SYSTEM },
    { role: 'user', content: userMsg },
  ], { maxTokens: 3000 });
  return extractJSON(raw);
}

function extractJSON(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON in model reply');
  return JSON.parse(text.slice(start, end + 1));
}

export function resolveApproval(approved) {
  if (pendingApproval) pendingApproval.resolve(approved);
}
export function hasPendingApproval() {
  return pendingApproval !== null;
}
