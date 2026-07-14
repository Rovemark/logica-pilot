'use strict';

/**
 * flight.js — Flight recorder (feature #10). Every autonomous `run` is saved as a
 * replayable record: goal, per-step action/result, token usage, and optional
 * screenshots. Renders a self-contained HTML report for debugging, auditing and
 * (bonus) marketing — each run is a GIF waiting to happen.
 *
 * Stored at ~/.logica-pilot/runs/<id>/ : run.json + report.html + step-NN.jpg
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

const RUNS_DIR = path.join(os.homedir(), '.logica-pilot', 'runs');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function newId() { return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15) + '-' + Math.random().toString(36).slice(2, 6); }

/** Start recording a run. Returns a recorder; call .step()/.shot() then .done(). */
function record({ goal, url, model } = {}) {
  const id = newId();
  const dir = path.join(RUNS_DIR, id);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const run = { id, goal: goal || '', url: url || '', model: model || '', startedAt: new Date().toISOString(), steps: [], usage: null, result: null };
  const rec = {
    id, dir,
    step(s) {
      const entry = { step: s.step, action: s.action, input: s.input, result: typeof s.result === 'string' ? s.result.slice(0, 600) : s.result };
      if (s.usage) entry.usage = { in: s.usage.input_tokens, out: s.usage.output_tokens, cacheRead: s.usage.cache_read_input_tokens };
      run.steps.push(entry);
    },
    shot(step, b64) {
      if (!b64) return;
      try { fs.writeFileSync(path.join(dir, `step-${String(step).padStart(2, '0')}.jpg`), Buffer.from(b64, 'base64')); run.steps.forEach((e) => { if (e.step === step) e.shot = `step-${String(step).padStart(2, '0')}.jpg`; }); } catch {}
    },
    done(result) {
      run.finishedAt = new Date().toISOString();
      run.result = result && { success: result.success, result: typeof result.result === 'string' ? result.result.slice(0, 4000) : result.result, steps: result.steps };
      run.usage = (result && result.usage) || null;
      try {
        fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run, null, 2));
        fs.writeFileSync(path.join(dir, 'report.html'), renderHTML(run));
      } catch {}
      return { id, dir, report: path.join(dir, 'report.html'), steps: run.steps.length };
    },
  };
  return rec;
}

function renderHTML(run) {
  const dur = run.finishedAt ? ((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000).toFixed(1) + 's' : '—';
  const u = run.usage || {};
  const billed = (u.cacheRead || 0) * 0.1 + (u.cacheWrite || 0) * 1.25 + (u.input || 0);
  const rows = run.steps.map((s) => `
    <div class="step ${s.action === 'done' ? 'done' : ''}">
      <div class="s-head"><span class="n">#${esc(s.step)}</span><span class="act">${esc(s.action)}</span>${s.usage ? `<span class="tok">${esc(s.usage.in)}→${esc(s.usage.out)} tok${s.usage.cacheRead ? ` · ${esc(s.usage.cacheRead)} cached` : ''}</span>` : ''}</div>
      ${s.input ? `<div class="inp">${esc(typeof s.input === 'string' ? s.input : JSON.stringify(s.input))}</div>` : ''}
      ${s.result ? `<div class="res">${esc(s.result)}</div>` : ''}
      ${s.shot ? `<img src="${esc(s.shot)}" loading="lazy">` : ''}
    </div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flight ${esc(run.id)} — Logica Pilot</title><style>
:root{--bg:#faf9f7;--fg:#1a1a1a;--mut:#6b7280;--card:#fff;--bd:#e5e7eb;--acc:#4f46e5;--ok:#059669;--code:#f3f4f6}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e5e7eb;--mut:#9ca3af;--card:#171a21;--bd:#262b36;--acc:#818cf8;--ok:#34d399;--code:#1f2430}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
.wrap{max-width:860px;margin:0 auto;padding:32px 20px}
h1{font-size:20px;margin:0 0 4px}.goal{color:var(--fg);font-size:16px;margin:0 0 16px}
.meta{display:flex;flex-wrap:wrap;gap:8px 20px;color:var(--mut);font-size:13px;margin-bottom:24px}
.meta b{color:var(--fg)}
.step{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px 16px;margin:12px 0}
.step.done{border-color:var(--ok)}
.s-head{display:flex;align-items:center;gap:10px;font-size:13px}
.n{color:var(--mut);font-variant-numeric:tabular-nums}.act{font-weight:600;color:var(--acc)}.step.done .act{color:var(--ok)}
.tok{margin-left:auto;color:var(--mut);font-size:12px;font-variant-numeric:tabular-nums}
.inp{margin-top:8px;font-family:ui-monospace,monospace;font-size:12.5px;background:var(--code);padding:6px 10px;border-radius:7px;overflow-x:auto}
.res{margin-top:6px;color:var(--mut);font-size:13.5px;white-space:pre-wrap}
img{margin-top:10px;max-width:100%;border-radius:8px;border:1px solid var(--bd)}
.final{background:var(--card);border:2px solid var(--ok);border-radius:12px;padding:16px;margin-top:20px;white-space:pre-wrap}
.final.fail{border-color:#dc2626}
</style></head><body><div class="wrap">
<h1>◢ Logica Pilot — flight recorder</h1>
<p class="goal">${esc(run.goal)}</p>
<div class="meta"><span>run <b>${esc(run.id)}</b></span><span>steps <b>${run.steps.length}</b></span><span>duration <b>${dur}</b></span>${run.model ? `<span>model <b>${esc(run.model)}</b></span>` : ''}${run.usage ? `<span>tokens <b>${esc(Math.round(billed).toLocaleString())}</b> billed-equiv</span>` : ''}${run.url ? `<span>start <b>${esc(run.url)}</b></span>` : ''}</div>
${rows}
${run.result ? `<div class="final ${run.result.success ? '' : 'fail'}"><b>${run.result.success ? '✓ Result' : '✗ Not completed'}</b>\n${esc(run.result.result)}</div>` : ''}
</div></body></html>`;
}

function list(limit = 20) {
  try {
    return fs.readdirSync(RUNS_DIR).sort().reverse().slice(0, limit).map((id) => {
      try { const r = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, id, 'run.json'), 'utf8')); return { id, goal: r.goal, steps: r.steps.length, success: r.result && r.result.success, startedAt: r.startedAt, report: path.join(RUNS_DIR, id, 'report.html') }; } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function reportPath(id) { const p = path.join(RUNS_DIR, id, 'report.html'); return fs.existsSync(p) ? p : null; }
function load(id) { try { return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, id, 'run.json'), 'utf8')); } catch { return null; } }

module.exports = { record, list, reportPath, load, RUNS_DIR };
