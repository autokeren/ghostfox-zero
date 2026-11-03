// server/orchestrator.js — the plan → dispatch → verify → approve loop
// The control layer's brain. All LLM calls use Vultr Serverless Inference.

import { chat, vision } from './inference.js';
import { runInSandbox } from './sandbox.js';

// Actions that commit data. Anything in this list requires explicit human
// approval before the sandbox is allowed to execute it.
const FINAL_ACTIONS = new Set(['submit', 'click_submit', 'press_enter_submit']);

const PLAN_SYSTEM = `You are Ghostfox Zero, a browser-automation planner.
Turn the user's goal into a SHORT list of steps for a headless Chromium browser driven by Playwright.

Available step actions:
- {"action":"goto","url":"https://..."}          navigate
- {"action":"click","selector":"CSS selector"}   click an element
- {"action":"type","selector":"CSS selector","text":"..."}  type into a field
- {"action":"press","key":"Enter"}
- {"action":"screenshot"}                        capture the current page

Rules:
1. At most 12 steps. Keep it minimal.
2. ALWAYS end with a {"action":"screenshot"} step.
3. Before any data-committing action (form submit), insert {"action":"screenshot"} so the human can review.
4. Output ONLY a JSON array of steps. No prose, no markdown fences.`;

const VERIFY_PROMPT = (goal, stepDesc) =>
  `You are the verification layer of Ghostfox Zero, a sandboxed browser agent.
The user's goal was: "${goal}".
The last executed step was: ${stepDesc}.
Look at the screenshot. Answer STRICTLY in this JSON format:
{"pass": true|false, "reason": "<one sentence>"}
Judge only what is visible.`;

export async function runTask(goal, onEvent) {
  const emit = (type, data) => onEvent && onEvent({ type, data, ts: Date.now() });

  // ---- 1. PLAN (chat model on Vultr Serverless Inference) ----
  emit('phase', 'planning');
  let steps;
  try {
    const raw = await chat([
      { role: 'system', content: PLAN_SYSTEM },
      { role: 'user', content: `Goal: ${goal}` },
    ]);
    const json = raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1);
    steps = JSON.parse(json);
    if (!Array.isArray(steps) || !steps.length) throw new Error('empty plan');
  } catch (e) {
    emit('error', { message: `Planning failed: ${e.message}` });
    return { ok: false };
  }
  emit('plan', { steps });

  // ---- 2. DISPATCH — split at approval gates ----
  // We execute step-by-step in chunks: every FINAL_ACTION or the terminal
  // screenshot forms a chunk boundary requiring human approval.
  const chunks = [];
  let current = [];
  for (const step of steps) {
    current.push(step);
    if (FINAL_ACTIONS.has(step.action) || step === steps[steps.length - 1]) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length) chunks.push(current);

  const screenshots = [];
  const verificationLog = [];

  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    const isFinalChunk = chunk.some((s) => FINAL_ACTIONS.has(s.action));

    if (isFinalChunk) {
      emit('approval_required', { chunkIndex: c, chunk });
      // The web UI resolves this promise via the /approve endpoint.
      const approved = await new Promise((resolve) => {
        pendingApproval = { resolve };
      });
      pendingApproval = null;
      if (!approved) {
        emit('phase', 'rejected_by_human');
        return { ok: false, rejected: true, screenshots };
      }
    }

    emit('phase', `executing chunk ${c + 1}/${chunks.length}`);
    const result = await runInSandbox(chunk);
    result.logs.forEach((l) => emit('sandbox_log', l));
    if (result.error) {
      emit('error', { message: result.error });
      return { ok: false, screenshots };
    }

    // ---- 3. VERIFY (vision model on Vultr Serverless Inference) ----
    const lastShot = result.screenshots[result.screenshots.length - 1];
    if (lastShot) {
      screenshots.push(lastShot);
      emit('screenshot', { index: screenshots.length - 1, b64: lastShot });
      try {
        const vRaw = await vision(
          VERIFY_PROMPT(goal, JSON.stringify(chunk[chunk.length - 1])),
          lastShot
        );
        const vJson = JSON.parse(vRaw.slice(vRaw.indexOf('{'), vJsonEnd(vRaw) + 1) || '{}');
        verificationLog.push({ chunk: c, ...vJson });
        emit('verify', { chunk: c, ...vJson });
        if (vJson.pass === false) {
          emit('phase', 'verification_failed');
          return { ok: false, verificationLog, screenshots };
        }
      } catch (e) {
        // Vision verification is best-effort; log and continue.
        emit('verify_error', { message: e.message });
      }
    }
  }

  emit('phase', 'complete');
  return { ok: true, screenshots, verificationLog };
}

// Exported approval hook used by the HTTP layer.
let pendingApproval = null;
export function resolveApproval(approved) {
  if (pendingApproval) pendingApproval.resolve(approved);
}
export function hasPendingApproval() {
  return pendingApproval !== null;
}
function vJsonEnd(s) { return s.lastIndexOf('}'); }
