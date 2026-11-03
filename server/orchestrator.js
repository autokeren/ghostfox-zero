// server/orchestrator.js — the TRUE agentic loop
// The LLM doesn't pre-plan rigid steps: it sees the live page through
// Ghostfox's semantic accessibility layer (page_a11y) and decides ONE action
// at a time. Every step is verified by a vision model on Vultr Serverless
// Inference, and final actions require explicit human approval.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { chat, vision } from './inference.js';
import { startGhostfoxSandbox } from './sandbox.js';

const MAX_STEPS = 20;

const DECIDE_SYSTEM = `You are the reasoning core of Ghostfox Zero, a sandboxed browser agent.
You receive: the user's goal, the page URL, and a semantic accessibility snapshot of the current
page (interactive elements carry stable refs like "e1"). Reply with exactly ONE next action.

Reply format — strict JSON, one object, no prose:
{"action":"goto","url":"https://..."}          open the first page (only when no page is open)
{"action":"click","ref":"e12"}                 click an element by its ref
{"action":"type","ref":"e7","text":"..."}      type text into a field by its ref
{"action":"press","key":"Enter"}              press a single key
{"action":"wait","ms":5000}                    wait for slow/loading pages (SPA, skeleton screens)
{"action":"screenshot"}                        take a fresh screenshot (use after waiting)
{"action":"dismiss_modal"}                    dismiss cookie banners, popups, overlays
{"action":"solve_captcha"}                    if a CAPTCHA is visible on the page, solve it automatically
{"action":"final_click","ref":"e3"}           click that COMMITS data (submit/send/purchase button) — triggers human approval
{"action":"done","result":"<full answer for the user — the actual summary/data requested>","summary":"one line"}  goal achieved; ALWAYS put the complete answer in result (the UI shows it to the user)

Rules:
1. One action per reply. JSON only.
2. Use ONLY refs present in the snapshot; never invent refs.
3. Use final_click for anything that submits or commits data.
4. If the visible page already satisfies the goal, return done.
5. If the last screenshot looked blank/empty (SPA still loading), use {"action":"wait","ms":5000} then {"action":"screenshot"}.
6. When the goal asks for information (summarize/list/find/describe/what is...), the done action MUST carry the full answer text in "result" — that is the product the user gets.
7. Use dismiss_modal for cookie banners and popup overlays that block content.
8. If you see a CAPTCHA (checkbox challenge, image grid, slide puzzle), immediately use {"action":"solve_captcha"} — this engine has built-in CAPTCHA solving.
9. Do NOT waste steps dismissing ad banners, cookie popups or app-install promos unless they FULLY BLOCK the content you need. Read around them and go straight for the goal.`;

const VERIFY_PROMPT = (goal, lastAction) =>
  `You are the verification layer of Ghostfox Zero, a sandboxed browser agent.
The user's goal was: "${goal}".
The agent just performed: ${lastAction}.
Look at the screenshot. Judge ONLY whether the VISIBLE PAGE brings the goal closer or the action worked as intended.
Ad banners, cookie popups, app-install promos and other non-blocking clutter are NOT failures — ignore them entirely unless they fully cover the content the goal needs.
Answer STRICTLY as JSON: {"pass": true|false, "reason": "<one sentence>"}`;

let pendingApproval = null;

/** Live sandbox reference for the /live-view proxy (null when idle). */
export const liveState = { sandbox: null };

/** Near-realtime frame stream: while a mission runs, capture the fox's
 *  screen ~1x/second straight over MCP (no liveview server hop), compress
 *  to a small JPEG and push it to the UI as 'frame' events. */
let framesOn = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry MCP calls that race a page navigation — clicking a link can destroy
 *  the execution context and the next call arrives before the new one is
 *  ready. Wait a beat and try again. */
async function mcpRetry(fn, { delay = 2200, tries = 3 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === tries - 1) throw e;
      if (/execution context|channel|no such page|timed out/i.test(String(e.message || e))) {
        await sleep(delay);
        continue;
      }
      throw e;
    }
  }
}

/** Blank detector: a screenshot that is one uniform color (white/gray
 *  placeholder) means the page hasn't rendered yet — not a verify failure. */
async function screenshotIsBlank(pngBuf) {
  try {
    const { data } = await sharp(pngBuf).greyscale().resize(64, { kernel: 'nearest' }).raw().toBuffer({ resolveWithObject: true });
    const mean = data.reduce((a, b) => a + b, 0) / data.length;
    const variance = data.reduce((a, b) => a + (b - mean) ** 2, 0) / data.length;
    return Math.sqrt(variance) < 8;
  } catch { return false; }
}

/** The proper settle beat: wait for the render to settle (the engine's own
 *  page_wait_stable — built for exactly this), then confirm with a real
 *  screenshot. If the frame still looks blank, wait and shoot again —
 *  verification must judge a loaded page, not a placeholder. */
async function awaitSettled(client, sessionId, pageId, sb) {
  if (!pageId) return null;
  try { await mcpRetry(() => client.call('page_wait_stable', { session_id: sessionId, page_id: pageId, max_ms: 15000 })); } catch {}
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await mcpRetry(() => client.callText('page_screenshot', { session_id: sessionId, page_id: pageId }));
      const info = extractJSON(raw);
      if (!info.file) return null;
      const png = await readFile(join(sb.artifacts, info.file.replace(/^\/data\/?/, '')));
      if (!(await screenshotIsBlank(png)) || attempt === 2) {
        return png.toString('base64');
      }
      await sleep(2500);
    } catch { if (attempt === 2) return null; await sleep(2000); }
  }
  return null;
}

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

  let pageIdLive = null;
  let finalResult = '';
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
        finalResult = action.result || action.summary || '';
        emit('phase', `goal complete: ${finalResult.slice(0, 120)}`);
        emit('result', { text: finalResult });
        break;
      }

      // ---- Human approval gate for committing actions ----
      if (action.action === 'final_click') {
        const settled = await awaitSettled(client, sessionId, pageId, sb);
        if (settled) {
          emit('screenshot', { index: screenshots.length, b64: settled });
          screenshots.push(settled);
        }
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
      // With per-action error recovery: if a type/click fails, try fallbacks
      // instead of killing the whole mission.
      const receipt = await executeActionRobust(client, sessionId, pageId, action, emit, (pid) => {
        pageId = pid;
        if (pid && !pageIdLive) {
          pageIdLive = pid;
          framesOn = true;
          frameLoop({ client, sb, getSessionId: () => sessionId, getPageId: () => pageIdLive, emit })
            .catch(() => {});
        }
      }, (u) => { url = u; });
      if (receipt) emit('sandbox_log', receipt);

      // Lazy-load nudge: news sites & SPAs only fill content on scroll.
      if (pageId && action.action === 'goto') {
        try {
          await client.call('page_press', { session_id: sessionId, page_id: pageId, key: 'PageDown' });
          await sleep(2200);
          await client.call('page_press', { session_id: sessionId, page_id: pageId, key: 'Home' });
          await sleep(900);
        } catch {}
      }

      // ---- Await page settle, then vision verify (with CAPTCHA auto-detect) ----
      const b64 = await awaitSettled(client, sessionId, pageId, sb);
      if (b64) {
        emit('screenshot', { index: screenshots.length, b64 });
        screenshots.push(b64);
        try {
          const vRaw = await vision(VERIFY_PROMPT(goal, JSON.stringify(action)), b64);
          const vJson = extractJSON(vRaw);
          emit('verify', { step, ...vJson });
          // Auto-solve: if vision says CAPTCHA is blocking, trigger the solver
          if (/captcha/i.test(vJson.reason || '') && /unsolve|uncheck|fail|block|not.*solve/i.test(vJson.reason || '')) {
            emit('sandbox_log', '⚠️ CAPTCHA detected by vision — auto-triggering solver…');
            try {
              const capAction = { action: 'solve_captcha' };
              const capReceipt = await executeActionRobust(client, sessionId, pageId, capAction, emit, () => {}, () => {});
              if (capReceipt) emit('sandbox_log', capReceipt);
              await sleep(3000);
              const postB64 = await awaitSettled(client, sessionId, pageId, sb);
              if (postB64) {
                emit('screenshot', { index: screenshots.length, b64: postB64 });
                screenshots.push(postB64);
              }
            } catch (capErr) {
              emit('sandbox_log', `CAPTCHA solver error: ${String(capErr.message).slice(0, 100)}`);
            }
          }
        } catch (e) {
          emit('verify_error', { message: e.message });
        }
      }

      // ---- Read the page semantically (with tab recovery) ----
      let a11y = null;
      if (pageId) {
        try {
          a11y = (await mcpRetry(() => client.callText('page_a11y', { session_id: sessionId, page_id: pageId }))).slice(0, 8000);
        } catch (e) {
          emit('sandbox_log', `page ${pageId} unresponsive (${String(e.message).slice(0, 60)}) — checking for new tabs…`);
          try {
            const pages = await client.callText('session_pages', { session_id: sessionId });
            const ids = [...pages.matchAll(/[a-z0-9]{6,12}/gi)].map((m) => m[0]);
            const fresh = ids.filter((x) => x !== pageId && x !== sessionId);
            if (fresh.length) {
              pageId = fresh[fresh.length - 1];
              pageIdLive = pageId;
              emit('sandbox_log', `switched to new page: ${pageId}`);
              a11y = (await mcpRetry(() => client.callText('page_a11y', { session_id: sessionId, page_id: pageId }))).slice(0, 8000);
            }
          } catch (e2) {
            emit('sandbox_log', `tab recovery failed: ${String(e2.message).slice(0, 60)}`);
          }
        }
      }
      action = await decideNext(goal, url, a11y, history);
    }

    // Out-of-steps fallback: always give the user an answer
    if (!finalResult) {
      emit('phase', 'steps exhausted — composing final answer…');
      // Try up to 3 times — reasoning models sometimes return empty
      for (let fa = 0; fa < 3 && !finalResult; fa++) {
        try {
          const raw = await chat([
            { role: 'system', content: 'You are Ghostfox Zero. You explored a web task but ran out of steps. Based on ALL the actions you took and the page snapshots you saw, write a COMPLETE and USEFUL final answer for the user RIGHT NOW. Be specific about what you accomplished and what you found. Never return an empty response.' },
            { role: 'user', content: `Goal: ${goal}\nActions taken: ${history.map((a) => JSON.stringify(a)).join(' ; ')}\nLast page snapshot:\n${(a11y || '').slice(0, 4000)}\nScreenshots verified: ${screenshots.length}` },
          ], { maxTokens: 8000, temperature: 0.7 });
          finalResult = raw.trim() || `Task explored: opened and interacted with pages toward "${goal}". Completed ${history.length} actions with ${screenshots.length} verified screenshots before reaching the step limit. Partial results are shown in the screenshot gallery.`;
        } catch { /* retry */ }
        if (!finalResult) await sleep(2000);
      }
      if (!finalResult) finalResult = `Explored "${goal}" — ran out of steps after ${history.length} actions. See screenshots for what was accomplished.`;
      emit('result', { text: finalResult });
    }

    emit('phase', 'complete');
    return { ok: true, result: finalResult, screenshots, history };
  } catch (e) {
    emit('error', { message: e.message });
    return { ok: false, result: finalResult, screenshots, history };
  } finally {
    framesOn = false;
    liveState.sandbox = null;
    await sb.destroy();
    emit('phase', 'sandbox container destroyed (zero residue)');
  }
}

async function frameLoop({ client, sb, getSessionId, getPageId, emit }) {
  while (framesOn) {
    await sleep(950);
    const sid = getSessionId();
    const pid = getPageId();
    if (!framesOn || !sid || !pid) continue;
    try {
      const raw = await client.callText('page_screenshot', { session_id: sid, page_id: pid }, { timeoutMs: 15000 });
      const info = extractJSON(raw);
      if (!info.file) continue;
      const hostPath = join(sb.artifacts, info.file.replace(/^\/data\/?/, ''));
      const png = await readFile(hostPath);
      const jpg = await sharp(png).resize(1000).jpeg({ quality: 68 }).toBuffer();
      emit('frame', { b64: jpg.toString('base64'), w: 1000 });
    } catch { /* frame skipped — next tick */ }
  }
}

/**
 * Execute an action with built-in error recovery.
 * If the primary method fails, tries fallbacks before giving up:
 *  - type: page_type_ref → click_ref first + page_fill → page_press character by character
 *  - click: page_click_ref → page_click_native (trusted coordinates)
 */
async function executeActionRobust(client, sessionId, pageId, action, emit, setPage, setUrl) {
  switch (action.action) {
    case 'goto': {
      const pid = (await client.callText('page_open', { session_id: sessionId, url: action.url })).trim();
      setPage(pid);
      setUrl(action.url);
      return `opened ${action.url} (page ${pid})`;
    }

    case 'type': {
      if (!pageId) throw new Error('no page open');
      const text = String(action.text).slice(0, 500);
      // Method 1: standard type_ref
      try {
        await client.call('page_type_ref', { session_id: sessionId, page_id: pageId, ref: action.ref, text });
        return `typed into ${action.ref}`;
      } catch (e1) {
        emit('sandbox_log', `type_ref ${action.ref} failed (${String(e1.message).slice(0, 50)}) — trying click + fill…`);
      }
      // Method 2: click the ref first (focus the field), then type
      try {
        await client.call('page_click_ref', { session_id: sessionId, page_id: pageId, ref: action.ref });
        await sleep(300);
        await client.call('page_type_ref', { session_id: sessionId, page_id: pageId, ref: action.ref, text });
        return `typed into ${action.ref} (click + type)`;
      } catch (e2) {
        emit('sandbox_log', `click + type failed — trying page_fill…`);
      }
      // Method 3: page_fill (direct value set, fires input events)
      try {
        await client.call('page_fill', { session_id: sessionId, page_id: pageId, selector: `[data-ref="${action.ref}"], input, textarea`, value: text });
        return `filled ${action.ref} via page_fill`;
      } catch (e3) {
        throw new Error(`all type methods failed for ${action.ref}: ${String(e3.message).slice(0, 80)}`);
      }
    }

    case 'click': {
      if (!pageId) throw new Error('no page open');
      try {
        await mcpRetry(() => client.call('page_click_ref', { session_id: sessionId, page_id: pageId, ref: action.ref }));
        return `clicked ${action.ref}`;
      } catch (e) {
        emit('sandbox_log', `click_ref ${action.ref} failed (${String(e.message).slice(0, 50)}) — trying native click…`);
      }
      // Fallback: page_click_native (role+name from a11y)
      try {
        await client.call('page_click_native', { session_id: sessionId, page_id: pageId, role: 'button', name: '' });
        return `clicked via native coordinates`;
      } catch {
        throw new Error(`click ${action.ref} failed after all methods`);
      }
    }

    case 'press': {
      if (!pageId) throw new Error('no page open');
      await client.call('page_press', { session_id: sessionId, page_id: pageId, key: action.key || 'Enter' });
      return `pressed ${action.key || 'Enter'}`;
    }

    case 'wait': {
      await sleep(Math.min(parseInt(action.ms || '3000', 10) || 3000, 15000));
      return `waited ${action.ms || 3000}ms`;
    }

    case 'screenshot': {
      if (!pageId) throw new Error('no page open');
      await mcpRetry(() => client.call('page_screenshot', { session_id: sessionId, page_id: pageId }));
      return 'screenshot captured';
    }

    case 'dismiss_modal': {
      if (!pageId) throw new Error('no page open');
      try {
        await client.call('page_dismiss_modal', { session_id: sessionId, page_id: pageId });
        return 'modal dismissed';
      } catch {
        return 'no modal found (ok)';
      }
    }

    case 'solve_captcha': {
      if (!pageId) throw new Error('no page open');
      // Ghostfox has 8 BUILT-IN CAPTCHA solvers — all models run locally on
      // CPU (ddddocr, YOLOv8s, pixel math). Try each family in order.
      const attempts = [];
      const trySolver = async (name, args, label) => {
        try {
          const result = await client.call(name, { session_id: sessionId, page_id: pageId, ...args });
          const text = (result.content || []).map(c => c.text || '').join(' ').trim();
          attempts.push(`${label}: ${text.slice(0, 120)}`);
          return text || true;
        } catch (e) {
          attempts.push(`${label} failed: ${String(e.message).slice(0, 50)}`);
          return null;
        }
      };

      // 1. GeeTest slide (pure pixel math — 100% local)
      emit('sandbox_log', 'CAPTCHA: trying GeeTest slide solver…');
      const gtSlide = await trySolver('page_geetest_slide', {}, 'geetest_slide');
      if (gtSlide) return `CAPTCHA solved (geetest_slide): ${String(gtSlide).slice(0, 100)}`;

      // 2. GeeTest click (YOLOv8s ONNX — 100% local)
      emit('sandbox_log', 'CAPTCHA: trying GeeTest click solver…');
      const gtClick = await trySolver('page_geetest_click', { ref: '' }, 'geetest_click');
      if (gtClick) return `CAPTCHA solved (geetest_click): ${String(gtClick).slice(0, 100)}`;

      // 3. Image captcha OCR (ddddocr CRNN — 100% local)
      emit('sandbox_log', 'CAPTCHA: trying image captcha OCR…');
      const ocr = await trySolver('page_captcha_ocr', {}, 'captcha_ocr');
      if (ocr) return `CAPTCHA solved (ocr): ${String(ocr).slice(0, 100)}`;

      // 4. Rotate captcha (brute-force — 100% local)
      emit('sandbox_log', 'CAPTCHA: trying rotate solver…');
      const rot = await trySolver('page_captcha_rotate', { check_ref: '', reset_ref: '', rot_left_ref: '', rot_right_ref: '' }, 'captcha_rotate');
      if (rot) return `CAPTCHA solved (rotate): ${String(rot).slice(0, 100)}`;

      // 5. Dismiss modal first then retry (some CAPTCHAs need popup dismiss)
      try { await client.call('page_dismiss_modal', { session_id: sessionId, page_id: pageId }); } catch {}

      // 6. captcha_solve (generic — uses 2captcha if GHOSTFOX_CAPTCHA_KEY is set, otherwise attempts local)
      emit('sandbox_log', 'CAPTCHA: trying generic captcha_solve…');
      const generic = await trySolver('captcha_solve', {}, 'captcha_solve');
      if (generic) return `CAPTCHA solved (generic): ${String(generic).slice(0, 100)}`;

      // All solvers tried — report what happened
      return `CAPTCHA solvers attempted: ${attempts.join(' | ').slice(0, 400)}`;
    }

    default:
      throw new Error(`unknown action: ${action.action}`);
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
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await chat(msgs, { maxTokens: 8000 });
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
