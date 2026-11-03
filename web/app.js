// web/app.js — control UI client for Ghostfox Zero
const $ = (id) => document.getElementById(id);
const logEl = $('log'), shotsEl = $('shots'), gateEl = $('gate');
const goalEl = $('goal'), statusEl = $('status'), goBtn = $('go');

function log(type, text) {
  const div = document.createElement('div');
  div.className = type === 'phase' ? 'phase' : type === 'error' ? 'err' : 'dim';
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

async function poll() {
  try {
    const st = await (await fetch('/status')).json();
    statusEl.textContent = st.running ? 'run active…' : 'idle';
    gateEl.style.display = st.pendingApproval ? 'block' : 'none';
  } catch {}
}

const es = new EventSource('/events');
es.onmessage = (e) => {
  const { type, data } = JSON.parse(e.data);
  switch (type) {
    case 'plan':
      log('phase', `planned ${data.steps.length} steps`);
      data.steps.forEach((s) => log('dim', `  · ${s.action}${s.url ? ' → ' + s.url : ''}`));
      break;
    case 'phase':        log('phase', data); break;
    case 'sandbox_log':  log('dim', data.trim()); break;
    case 'screenshot':   log('dim', `  📸 verified screenshot #${data.index + 1}`); break;
    case 'verify':       log(data.pass ? 'phase' : 'error', `verify: ${data.reason}`); break;
    case 'approval_required':
      log('phase', '⏸ human approval required');
      fetch(`/screenshot/${data.chunkIndex}`); // latest shot is refreshed below via status
      break;
    case 'done':
      log('phase', data.ok ? '✅ task complete — container destroyed' :
            data.rejected ? '🛑 rejected by human — container destroyed' :
            '❌ task failed — container destroyed');
      goBtn.disabled = false;
      break;
    case 'error':        log('error', `error: ${data.message}`); goBtn.disabled = false; break;
  }
  // keep the approval gate screenshot fresh
  const imgs = shotsEl.querySelectorAll('img');
  if (imgs.length) $('gateShot').src = imgs[imgs.length - 1].src;
};

goBtn.onclick = async () => {
  const goal = goalEl.value.trim();
  if (!goal) return;
  goBtn.disabled = true;
  logEl.innerHTML = '';
  shotsEl.innerHTML = '';
  log('phase', `🦊 deploying fox for: ${goal}`);
  const res = await fetch('/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal }),
  });
  if (!res.ok) {
    const err = await res.json();
    log('error', err.error || 'failed to start');
    goBtn.disabled = false;
  }
};

// fetch + render screenshots periodically while a run is active
setInterval(async () => {
  poll();
  try {
    const res = await fetch('/screenshots');
    if (res.ok) {
      const { shots } = await res.json();
      if (shots && shots.length !== shotsEl.children.length) {
        shotsEl.innerHTML = '';
        shots.forEach((b64) => {
          const img = document.createElement('img');
          img.src = `data:image/png;base64,${b64}`;
          shotsEl.appendChild(img);
        });
      }
    }
  } catch {}
}, 2000);

$('approveBtn').onclick = () => fetch('/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved: true }) });
$('rejectBtn').onclick = () => fetch('/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved: false }) });
