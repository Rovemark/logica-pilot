'use strict';

/**
 * perception.js — A camada que faz o Logica Pilot "enxergar" a página.
 *
 * Em vez de clicar em coordenadas x,y de um screenshot (o jeito BURRO do
 * Playwright legado), a gente injeta JS que indexa todos os elementos
 * interativos e devolve um MAPA SEMÂNTICO. A IA age por intenção:
 * "clica no [12] botão Comprar" — não por pixel.
 *
 * Híbrido: o mesmo índice serve pro modo texto (a11y/DOM) e pro modo
 * visão (badges numerados desenhados na própria página antes do screenshot).
 *
 * Agnóstico de transporte: só usa page.eval() e page.send() — funciona tanto
 * no motor headless (pipe) quanto no browser Electron (webContents.debugger).
 */

// ── Funções executadas DENTRO da página (injetadas via .toString()) ──────────

/* eslint-disable */
function __lp_collect(maxEls) {
  var SEL = [
    'a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]',
    '[role=tab]', '[role=menuitem]', '[role=menuitemcheckbox]', '[role=menuitemradio]',
    '[role=textbox]', '[role=combobox]', '[role=searchbox]', '[role=switch]',
    '[role=option]', '[contenteditable=""]', '[contenteditable=true]',
    '[onclick]', 'summary', '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return null;
    if (r.bottom < 0 || r.right < 0) return null;
    if (r.left > innerWidth || r.top > innerHeight * 4) return null;
    var st = window.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || parseFloat(st.opacity || '1') === 0) return null;
    if (el.disabled) return null;
    return r;
  }

  function labelOf(el) {
    var t = (el.getAttribute('aria-label') || '').trim();
    if (!t) t = (el.getAttribute('placeholder') || '').trim();
    if (!t) {
      var labelledby = el.getAttribute('aria-labelledby');
      if (labelledby) { var lb = document.getElementById(labelledby); if (lb) t = (lb.innerText || '').trim(); }
    }
    if (!t) t = ((el.innerText || el.textContent || '').trim()).replace(/\s+/g, ' ');
    if (!t) t = (el.getAttribute('title') || el.getAttribute('alt') || '').trim();
    if (!t && el.value != null) t = String(el.value).trim();
    if (!t && el.name) t = String(el.name);
    return t;
  }

  var nodes = document.querySelectorAll(SEL);
  var out = [];
  var i = 0;
  for (var k = 0; k < nodes.length && i < maxEls; k++) {
    var el = nodes[k];
    var r = rectOf(el);
    if (!r) continue;
    el.setAttribute('data-lpilot-id', String(i));
    out.push({
      id: i,
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute('type') || '').toLowerCase(),
      role: el.getAttribute('role') || '',
      name: labelOf(el).slice(0, 140),
      value: (el.value != null ? String(el.value) : '').slice(0, 80),
      placeholder: el.getAttribute('placeholder') || '',
      href: (el.getAttribute('href') || '').slice(0, 200),
      cx: Math.round(r.left + r.width / 2),
      cy: Math.round(r.top + r.height / 2),
      inView: (r.top >= 0 && r.top < innerHeight)
    });
    i++;
  }

  var bodyText = '';
  try { bodyText = (document.body ? document.body.innerText : '') || ''; } catch (e) {}
  bodyText = bodyText.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').slice(0, 3500);

  return {
    url: location.href,
    title: document.title,
    scrollY: Math.round(window.scrollY),
    scrollH: document.documentElement.scrollHeight,
    viewportH: innerHeight,
    viewportW: innerWidth,
    count: out.length,
    elements: out,
    text: bodyText
  };
}

function __lp_mark() {
  var old = document.getElementById('__lpilot_marks');
  if (old) old.remove();
  var box = document.createElement('div');
  box.id = '__lpilot_marks';
  box.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  var els = document.querySelectorAll('[data-lpilot-id]');
  var colors = ['#FF3B30', '#34C759', '#0A84FF', '#FF9F0A', '#BF5AF2', '#FF375F', '#64D2FF'];
  var n = 0;
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    if (r.bottom < 0 || r.top > innerHeight) continue;
    var id = el.getAttribute('data-lpilot-id');
    var c = colors[parseInt(id, 10) % colors.length];
    var b = document.createElement('div');
    b.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;border:2px solid ' + c + ';border-radius:3px;box-sizing:border-box;';
    var lab = document.createElement('div');
    lab.textContent = id;
    lab.style.cssText = 'position:absolute;left:-1px;top:-15px;background:' + c + ';color:#fff;font:bold 11px/14px ui-monospace,monospace;padding:0 4px;border-radius:3px;white-space:nowrap;';
    b.appendChild(lab);
    box.appendChild(b);
    n++;
  }
  document.documentElement.appendChild(box);
  return n;
}

function __lp_unmark() {
  var o = document.getElementById('__lpilot_marks');
  if (o) o.remove();
  return true;
}
/* eslint-enable */

// ── API (lado Node) ──────────────────────────────────────────────────────────

async function snapshot(page, { maxEls = 120 } = {}) {
  const expr = `(${__lp_collect.toString()})(${maxEls})`;
  const data = await page.eval(expr);
  return data || { url: null, title: '', elements: [], text: '' };
}

async function mark(page) {
  try {
    return await page.eval(`(${__lp_mark.toString()})()`);
  } catch {
    return 0;
  }
}

async function unmark(page) {
  try {
    return await page.eval(`(${__lp_unmark.toString()})()`);
  } catch {
    return false;
  }
}

/** Transforma o snapshot num texto compacto pra IA ler. */
function format(snap) {
  const lines = [];
  lines.push(`URL: ${snap.url || '(sem url)'}`);
  lines.push(`TÍTULO: ${snap.title || '(sem título)'}`);

  if (snap.scrollH && snap.viewportH) {
    const bottom = snap.scrollY + snap.viewportH;
    const more = bottom < snap.scrollH - 4;
    const pct = Math.min(100, Math.round((bottom / snap.scrollH) * 100));
    lines.push(`ROLAGEM: ${pct}% da página${more ? ' — HÁ MAIS CONTEÚDO ABAIXO (use scroll)' : ' (fim da página)'}`);
  }

  lines.push('');
  lines.push(`ELEMENTOS INTERATIVOS (${snap.elements.length}) — use o índice [n]:`);
  if (snap.elements.length === 0) {
    lines.push('  (nenhum elemento interativo detectado — tente scroll ou modo visão)');
  } else {
    for (const el of snap.elements) {
      const kind = el.role || (el.tag === 'input' ? `input[${el.type || 'text'}]` : el.tag);
      let desc = el.name || el.placeholder || el.value || el.href || '';
      desc = desc.replace(/\s+/g, ' ').trim();
      const extra = [];
      if (el.placeholder && el.placeholder !== desc) extra.push(`ph="${el.placeholder}"`);
      if (el.value && el.tag === 'input') extra.push(`val="${el.value}"`);
      if (!el.inView) extra.push('fora-da-tela');
      lines.push(`  [${el.id}] ${kind} "${desc}"${extra.length ? ' ' + extra.join(' ') : ''}`);
    }
  }

  lines.push('');
  lines.push('TEXTO VISÍVEL DA PÁGINA:');
  lines.push((snap.text || '').trim() || '(vazio)');

  return lines.join('\n');
}

module.exports = { snapshot, mark, unmark, format };
