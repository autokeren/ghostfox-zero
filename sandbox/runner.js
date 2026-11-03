// sandbox/runner.js — executes a plain-text step list inside the container.
// Reads steps JSON on stdin, drives headless Chromium via Playwright,
// writes screenshots to /shots, then exits. The container is destroyed
// by the control layer (`docker run --rm`) — nothing survives this process.

const { chromium } = require('playwright');
const fs = require('fs');

const ALLOWED_ACTIONS = new Set([
  'goto', 'click', 'type', 'press', 'screenshot', 'wait',
]);

async function main() {
  const input = fs.readFileSync(0, 'utf8'); // steps arrive via stdin (no secrets)
  let steps;
  try {
    steps = JSON.parse(input);
  } catch {
    console.error('invalid steps JSON');
    process.exit(2);
  }

  if (!Array.isArray(steps)) {
    console.error('steps must be an array');
    process.exit(2);
  }

  // Reject anything outside the allowed vocabulary — containment is not
  // only about isolation, it is also about a minimal instruction surface.
  for (const step of steps) {
    if (!step || typeof step.action !== 'string' || !ALLOWED_ACTIONS.has(step.action)) {
      console.error(`disallowed action: ${step && step.action}`);
      process.exit(3);
    }
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(20000);

  let shotIndex = 0;
  try {
    for (const step of steps) {
      switch (step.action) {
        case 'goto':
          if (!/^https?:\/\//i.test(step.url || '')) throw new Error('non-http URL blocked');
          await page.goto(step.url, { waitUntil: 'domcontentloaded' });
          break;
        case 'click':
          await page.click(step.selector, { timeout: 15000 });
          break;
        case 'type':
          await page.fill(step.selector, String(step.text).slice(0, 500));
          break;
        case 'press':
          await page.keyboard.press(step.key === 'Enter' ? 'Enter' : String(step.key).slice(0, 12));
          break;
        case 'wait':
          await page.waitForTimeout(Math.min(parseInt(step.ms || '500', 10) || 500, 5000));
          break;
        case 'screenshot':
          fs.writeFileSync(`/shots/${String(++shotIndex).padStart(3, '0')}.png`, await page.screenshot());
          break;
      }
      console.log(`ok: ${step.action}`);
    }
  } catch (e) {
    // Screenshot on failure so the verifier (and the human) can see what happened.
    try {
      fs.writeFileSync(`/shots/${String(++shotIndex).padStart(3, '0')}.png`, await page.screenshot());
    } catch {}
    console.error(`step failed: ${e.message}`);
    await browser.close();
    process.exit(1);
  }

  await browser.close();
  process.exit(0);
}

main();
