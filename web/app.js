// web/app.js — Ghostfox Zero control UI
// Visual product: live browser view (real screenshots from the fox),
// step timeline, approval modal, verified gallery.

const $ = (id) => document.getElementById(id);
const goalInput = $('goalInput'), goBtn = $('goBtn');
const workspace = $('workspace'), hero = $('hero');
const liveShot = $('liveShot'), bEmpty = $('bEmpty'), urlBar = $('urlBar');
const scan = $('scan'), dot = $('dot'), statusText = $('statusText');
const timeline = $('timeline'), gallery = $('gallery'), galleryCard = $('galleryCard');
const overlay = $('overlay'), gateShot = $('gateShot');
const doneBanner = $('doneBanner');

let currentUrl = '(none yet)';
let stepCount = 0;

/* ── helpers ─────────────────────────────── */
function setStatus(text, live) {
  statusText.textContent = text;
  dot.className = 'dot' + (live ? ' live' : '');
}
function setLiveShot(b64) {
  bEmpty.style.display = 'none';
  liveShot.style.display = 'block';
  liveShot.src = `data:image/png;base64,${b64}`;
}
function addStep({ cls, icon, label, sub, extra }) {
  const el = document.createElement('div');
  el.className = 'tstep ' + cls;
  el.innerHTML = `
    <div class="rail"><div class="node">${icon}</div></div>
    <div class="body">
      <div class="lbl">${label}${extra || ''}</div>
      ${sub ? `<div class="sub">${sub}</div>` : ''}
    </div>`;
  timeline.appendChild(el);
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return el;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ── mission start ───────────────────────── */
async function startMission() {
  const goal = goalInput.value.trim();
  if (!goal) return;

  // reset UI
  workspace.style.display = 'block';
  hero.style.display = 'none';
  timeline.innerHTML = '';
  gallery.innerHTML = '';
  galleryCard.hidden = true;
  doneBanner.classList.remove('on');
  liveShot.style.display = 'none';
  bEmpty.style.display = 'block';
  urlBar.textContent = 'about:blank';
  $('missionTxt').textContent = goal;
  scan.classList.add('on');
  goBtn.disabled = true;
  setStatus('engine spawning…', true);
  stepCount = 0;

  addStep({ cls: 'run', icon: '🦊', label: 'Spawning engine', sub: 'Fresh disposable container — Ghostfox Firefox + Rust MCP runtime' });

  const res = await fetch('/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    addStep({ cls: 'err', icon: '✕', label: 'Could not start', sub: esc(err.error || 'unknown error') });
    goBtn.disabled = false;
    scan.classList.remove('on');
    setStatus('idle');
  }
}

goBtn.onclick = startMission;
goalInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') startMission(); });
document.querySelectorAll('.chip').forEach((c) => {
  c.onclick = () => { goalInput.value = c.dataset.g; startMission(); };
});

/* ── live events (SSE) ───────────────────── */
const es = new EventSource('/events');
es.onmessage = (e) => {
  const { type, data } = JSON.parse(e.data);
  switch (type) {
    case 'phase':
      if (/session/.test(data)) {
        addStep({ cls: 'ok', icon: '✓', label: 'Engine online', sub: esc(data) });
        setStatus('working…', true);
      }
      break;

    case 'step':
      stepCount = data.n;
      {
        const a = data.action || {};
        const desc = {
          goto: `Navigate → ${a.url || ''}`,
          click: `Click element ${a.ref || ''}`,
          type: `Type into ${a.ref || ''}`,
          press: `Press key ${a.key || 'Enter'}`,
          final_click: `Ready to commit (click ${a.ref || ''})`,
          done: 'Wrap up',
        }[a.action] || a.action;
        addStep({ cls: 'run', icon: iconFor(a.action), label: `Step ${data.n}: ${esc(desc)}` });
        if (a.action === 'goto' && a.url) { currentUrl = a.url; urlBar.textContent = a.url; }
        setStatus(`step ${data.n}…`, true);
      }
      break;

    case 'screenshot':
      if (data.b64) setLiveShot(data.b64);
      break;

    case 'verify':
      {
        const el = timeline.lastElementChild;
        const pill = data.pass ? '<span class="pill ok">VERIFIED</span>' : '<span class="pill gate">CHECK FAILED</span>';
        if (el) {
          el.classList.remove('run');
          el.classList.add(data.pass ? 'ok' : 'gate');
          el.querySelector('.lbl').insertAdjacentHTML('beforeend', pill);
          el.querySelector('.body').insertAdjacentHTML('beforeend',
            `<div class="sub">👁 ${esc(data.reason || '')}</div>`);
        }
      }
      break;

    case 'approval_required':
      {
        addStep({ cls: 'gate', icon: '⏸', label: 'Awaiting your approval', sub: 'Final (committing) action — nothing happens until you decide.' });
        const imgs = [liveShot.src];
        gateShot.src = imgs[0];
        overlay.classList.add('on');
        setStatus('waiting for approval', true);
      }
      break;

    case 'done':
      scan.classList.remove('on');
      overlay.classList.remove('on');
      goBtn.disabled = false;
      setStatus('mission complete', false);
      dot.classList.add('ok');
      if (data.ok) {
        doneBanner.classList.add('on');
        addStep({ cls: 'ok', icon: '🏆', label: 'Mission complete', sub: 'Container destroyed — zero residue left behind.' });
      } else if (data.rejected) {
        addStep({ cls: 'gate', icon: '🛑', label: 'Rejected by human', sub: 'Aborted safely. Container destroyed.' });
      } else {
        addStep({ cls: 'err', icon: '✕', label: 'Mission ended', sub: 'Container destroyed. See steps above.' });
      }
      if (Array.isArray(data.screenshots) && data.screenshots.length) {
        gallery.innerHTML = '';
        data.screenshots.forEach((b64) => {
          const img = document.createElement('img');
          img.src = `data:image/png;base64,${b64}`;
          img.onclick = () => window.open(img.src, '_blank');
          gallery.appendChild(img);
        });
        galleryCard.hidden = false;
      }
      break;

    case 'error':
      addStep({ cls: 'err', icon: '✕', label: 'Error', sub: esc(data.message || '') });
      scan.classList.remove('on');
      goBtn.disabled = false;
      setStatus('error', false);
      break;
  }
};

function iconFor(action) {
  return ({ goto: '🧭', click: '👆', type: '⌨️', press: '⏎', final_click: '⚠️', done: '🏁' }[action] || '•');
}

/* ── approval buttons ───────────────────── */
$('approveBtn').onclick = async () => {
  await fetch('/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved: true }) });
  overlay.classList.remove('on');
  const el = timeline.lastElementChild;
  if (el) { el.classList.remove('gate'); el.classList.add('ok'); }
  addStep({ cls: 'ok', icon: '✅', label: 'Approved — executing', sub: 'The fox continues in the sealed container.' });
  setStatus('executing…', true);
};
$('rejectBtn').onclick = async () => {
  await fetch('/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved: false }) });
  overlay.classList.remove('on');
};

/* ── periodic state + gallery sync ───────── */
setInterval(async () => {
  try {
    const st = await (await fetch('/status')).json();
    if (st.pendingApproval && !overlay.classList.contains('on')) overlay.classList.add('on');
  } catch {}
  try {
    const res = await fetch('/screenshots');
    if (res.ok) {
      const { shots } = await res.json();
      if (shots && shots.length && liveShot.style.display === 'none') setLiveShot(shots[shots.length - 1]);
    }
  } catch {}
}, 2500);
