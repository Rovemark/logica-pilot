'use strict';

/**
 * actions.js — High-level actions, by INTENT/index (not by pixel).
 *
 * All operate on a transport-agnostic `page` that exposes:
 *   - page.send(method, params)  → CDP command
 *   - page.eval(expression)      → Runtime.evaluate (returnByValue)
 *   - page.goto(url)             → navigation (optional; fallback to Page.navigate)
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Visual "hand" da IA: só faz algo quando o overlay de feedback está injetado (run
// headful assistido); no-op caso contrário. A seta AZUL da IA desliza até o alvo e
// pisca o clique — movida SÓ pelas ações do agente, nunca pelo mouse físico do usuário.
let _fb = null;
function fb() { if (_fb === null) { try { _fb = require('./feedback'); } catch { _fb = {}; } } return _fb; }
async function signalPoint(page, x, y, { ripple = true, glide = 140 } = {}) {
  const f = fb();
  try { if (f.showCursor) await f.showCursor(page, x, y); } catch {}
  if (glide) await sleep(glide);           // deixa a seta deslizar (transição CSS) antes do clique
  if (ripple) { try { if (f.showRipple) await f.showRipple(page, x, y); } catch {} }
}

const KEYMAP = {
  Enter: { keyCode: 13, code: 'Enter', key: 'Enter', text: '\r' },
  Tab: { keyCode: 9, code: 'Tab', key: 'Tab' },
  Escape: { keyCode: 27, code: 'Escape', key: 'Escape' },
  Backspace: { keyCode: 8, code: 'Backspace', key: 'Backspace' },
  Delete: { keyCode: 46, code: 'Delete', key: 'Delete' },
  ArrowDown: { keyCode: 40, code: 'ArrowDown', key: 'ArrowDown' },
  ArrowUp: { keyCode: 38, code: 'ArrowUp', key: 'ArrowUp' },
  ArrowLeft: { keyCode: 37, code: 'ArrowLeft', key: 'ArrowLeft' },
  ArrowRight: { keyCode: 39, code: 'ArrowRight', key: 'ArrowRight' },
  PageDown: { keyCode: 34, code: 'PageDown', key: 'PageDown' },
  PageUp: { keyCode: 33, code: 'PageUp', key: 'PageUp' },
};

function q(id) {
  // Safe selector for data-lpilot-id
  return `[data-lpilot-id="${String(id).replace(/"/g, '')}"]`;
}

async function navigate(page, url) {
  if (typeof page.goto === 'function') {
    await page.goto(url);
  } else {
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) url = 'https://' + url;
    await page.send('Page.navigate', { url });
    await sleep(1200);
  }
  return `navigated to ${url}`;
}

async function click(page, id) {
  const pt = await page.eval(
    `(function(){var el=document.querySelector('${q(id)}');if(!el)return null;` +
      `el.scrollIntoView({block:'center',inline:'center'});` +
      `var r=el.getBoundingClientRect();` +
      `return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),tag:el.tagName.toLowerCase()};})()`,
  );
  if (!pt) return `index [${id}] not found on page`;

  await signalPoint(page, pt.x, pt.y); // seta da IA desliza até o alvo + ripple
  // "real" click: mouse move + press + release at actual coordinates
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, buttons: 0 });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', buttons: 1, clickCount: 1,
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', buttons: 0, clickCount: 1,
  });
  await sleep(180);
  return `clicked on [${id}] (${pt.tag}) @ ${pt.x},${pt.y}`;
}

// Click at a COORDINATE (x,y in pixels of the image the model sees). Since the screenshot is
// captured in CSS px (scale 1, see screenshot()), these coords map 1:1 to the click.
// Use when the element is visible in the screenshot but NOT in the indexed list (canvas/SVG).
async function clickAt(page, x, y) {
  const px = Math.round(Number(x)), py = Math.round(Number(y));
  if (!Number.isFinite(px) || !Number.isFinite(py)) return `invalid coordinates: ${x},${y}`;
  await signalPoint(page, px, py); // seta da IA
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, buttons: 0 });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(180);
  return `clicked at (${px},${py})`;
}

// Click the smallest VISIBLE element whose text matches (exact first, then contains). Far more
// robust than click_at/index for buttons, cards and chip "×" whose coordinates/indices are flaky:
// the model gives the human-readable label and we resolve the real click point from the DOM.
async function clickText(page, text, { exact = false } = {}) {
  const pt = await page.eval(
    `(function(){var t=${JSON.stringify(String(text))}.trim().toLowerCase();var ex=${exact ? 'true' : 'false'};` +
      `var els=[].slice.call(document.querySelectorAll('button,a,[role="button"],div,span,label,li,p,td'));` +
      `function vis(e){var r=e.getBoundingClientRect();var s=getComputedStyle(e);return r.width>2&&r.height>2&&s.visibility!=="hidden"&&s.display!=="none"&&s.pointerEvents!=="none"&&r.top<window.innerHeight+40&&r.bottom>-40;}` +
      `var c=els.filter(function(e){var x=(e.innerText||e.textContent||"").replace(/\\s+/g," ").trim().toLowerCase();return vis(e)&&(ex?x===t:(x===t||x.indexOf(t)>=0));});` +
      `if(!c.length)return null;` +
      `c.sort(function(a,b){var ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();return (ra.width*ra.height)-(rb.width*rb.height);});` +
      `var el=c[0];el.scrollIntoView({block:"center",inline:"center"});var r=el.getBoundingClientRect();` +
      `return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),tag:el.tagName.toLowerCase(),n:c.length};})()`,
  );
  if (!pt) return `text not found: "${text}"`;
  await signalPoint(page, pt.x, pt.y); // seta da IA
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, buttons: 0 });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(200);
  return `clicked text "${text}" (${pt.tag}) @ ${pt.x},${pt.y}${pt.n > 1 ? ` [${pt.n} matches, took smallest]` : ''}`;
}

async function type(page, id, text, submit = false) {
  // Focus the field. Works for input, textarea and contenteditable/rich editors
  // (rich editors use contenteditable, where el.value='' does NOT clear it — so the new
  // text used to get appended in the middle of the old one).
  const info = await page.eval(
    `(function(){var el=document.querySelector('${q(id)}');if(!el)return null;` +
      `el.scrollIntoView({block:'center'});el.focus();try{el.click&&el.click();}catch(e){}` +
      `return {mac:/Mac/i.test((navigator.platform||'')+' '+(navigator.userAgent||''))};})()`,
  );
  if (!info) return `index [${id}] not found for typing`;
  try { const f = fb(); if (f.showKeystroke && text) await f.showKeystroke(page, String(text)); } catch {}

  const fieldLen = () => page.eval(
    `(function(){var el=document.querySelector('${q(id)}');if(!el)return 0;var t=(('value'in el)?el.value:(el.textContent||el.innerText||''));return (t||'').length;})()`,
  );
  // Clear the field with SELECT-ALL + DELETE (pressKey now emits the real modifier keydown,
  // so Cmd/Ctrl+A is recognized even by rich editors like Lexical/Draft). Delete removes the
  // whole selection in one shot — no char-by-char Backspace, which would overshoot on an empty
  // Lexical block and delete the whole block (popping a confirm modal). The loop is just a
  // safety net for stubborn editors and stops the moment the field stops shrinking.
  await pressKey(page, info.mac ? 'Meta+a' : 'Control+a');
  await sleep(50);
  await pressKey(page, 'Delete');
  await sleep(60);
  let left = await fieldLen();
  let guard = 0;
  while (left > 2 && guard < 40) {
    await pressKey(page, info.mac ? 'Meta+a' : 'Control+a');
    await sleep(30);
    await pressKey(page, 'Delete');
    await sleep(50);
    const before = left;
    left = await fieldLen();
    guard++;
    if (left >= before) break; // not shrinking → stop (don't risk the delete-block modal)
  }
  // Force-clear via the NATIVE value setter. Controlled <input>/<textarea> (React/Vue) ignore
  // Select-all+Delete — the framework re-applies its state — so insertText then CONCATENATES the
  // new text onto the old value instead of replacing it. The prototype's own setter bypasses the
  // framework's overridden `value`, and dispatching 'input' lets the framework re-sync to empty.
  await page.eval(
    `(function(){var el=document.querySelector('${q(id)}');if(!el)return;` +
      `if(el.isContentEditable){el.textContent='';el.dispatchEvent(new Event('input',{bubbles:true}));return;}` +
      `var proto=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:(el.tagName==='INPUT'?window.HTMLInputElement.prototype:null);` +
      `if(proto){var d=Object.getOwnPropertyDescriptor(proto,'value');if(d&&d.set){d.set.call(el,'');el.dispatchEvent(new Event('input',{bubbles:true}));}}` +
      `})()`,
  );
  await sleep(40);
  // Type the new text (Input.insertText simulates real typing — reactive editors pick it up).
  await page.send('Input.insertText', { text: String(text) });
  await page.eval(
    `(function(){var el=document.querySelector('${q(id)}');if(el){el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}return true;})()`,
  );
  // Verify the effect: read the field back and confirm it matches, otherwise WARN the agent
  // in the result so it notices the action didn't take and tries something else.
  let now = await page.eval(
    `(function(){var el=document.querySelector('${q(id)}');if(!el)return '';return (('value'in el)?el.value:(el.textContent||el.innerText))||'';})()`,
  );
  let want = String(text).trim(), got = String(now || '').replace(/\s+/g, ' ').trim();
  // Fallback: if insertText didn't land cleanly (framework swallowed it / concatenated), set the
  // full value directly via the native setter — guarantees the field equals exactly `text`.
  if (want && (!got || !got.startsWith(want.slice(0, 20)) || got.length > want.length * 1.3)) {
    await page.eval(
      `(function(){var el=document.querySelector('${q(id)}');if(!el)return;var v=${JSON.stringify(String(text))};` +
        `if(el.isContentEditable){el.textContent=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return;}` +
        `var proto=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:(el.tagName==='INPUT'?window.HTMLInputElement.prototype:null);` +
        `if(proto){var d=Object.getOwnPropertyDescriptor(proto,'value');if(d&&d.set){d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}}` +
        `})()`,
    );
    await sleep(60);
    now = await page.eval(
      `(function(){var el=document.querySelector('${q(id)}');if(!el)return '';return (('value'in el)?el.value:(el.textContent||el.innerText))||'';})()`,
    );
    got = String(now || '').replace(/\s+/g, ' ').trim();
  }
  let msg = `typed in [${id}]: "${text}"`;
  if (want && got && got.length > want.length * 1.3 && !got.startsWith(want.slice(0, 20))) {
    msg += ` ⚠️ the field now shows "${got.slice(0, 70)}..." (longer than expected) — it probably did NOT replace the old text. Clear the field (select-all + delete) and try again, or delete it manually.`;
  }
  if (submit) {
    await pressKey(page, 'Enter');
    msg += ' + Enter';
  }
  return msg;
}

const MODMAP = { ctrl: 2, control: 2, alt: 1, option: 1, shift: 8, meta: 4, cmd: 4, command: 4, super: 4 };
// Real keydown descriptors for the modifier keys themselves — rich editors (Lexical/Draft)
// only recognize a shortcut (e.g. Cmd+A) when they SEE the modifier's own keydown, not just
// the `modifiers` bitmask on the letter event.
const MODKEY = {
  ctrl: { vk: 17, code: 'ControlLeft', key: 'Control' }, control: { vk: 17, code: 'ControlLeft', key: 'Control' },
  meta: { vk: 91, code: 'MetaLeft', key: 'Meta' }, cmd: { vk: 91, code: 'MetaLeft', key: 'Meta' }, command: { vk: 91, code: 'MetaLeft', key: 'Meta' }, super: { vk: 91, code: 'MetaLeft', key: 'Meta' },
  alt: { vk: 18, code: 'AltLeft', key: 'Alt' }, option: { vk: 18, code: 'AltLeft', key: 'Alt' },
  shift: { vk: 16, code: 'ShiftLeft', key: 'Shift' },
};
async function pressKey(page, key) {
  // supports "Mod+Key" combos (e.g. Control+a to select all, Meta+a on mac, Shift+Tab)
  const parts = String(key).split('+').map((s) => s.trim()).filter(Boolean);
  const base = parts.pop();
  let modifiers = 0;
  const mods = [];
  for (const p of parts) { const m = MODMAP[p.toLowerCase()]; if (m) { modifiers |= m; mods.push(p.toLowerCase()); } }
  let k = KEYMAP[base];
  if (!k && base && base.length === 1) {
    // single-character key (e.g. 'a'): build the descriptor
    const code = /[a-z]/i.test(base) ? 'Key' + base.toUpperCase() : base;
    k = { keyCode: base.toUpperCase().charCodeAt(0), code, key: base };
  }
  if (!k) return `unknown key: ${key}`;
  // press modifier keys down first (real keydown), then the base key with the modifier bitmask
  for (const p of mods) { const md = MODKEY[p]; if (md) await page.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: md.vk, code: md.code, key: md.key, modifiers }); }
  const evt = { windowsVirtualKeyCode: k.keyCode, code: k.code, key: k.key };
  if (modifiers) evt.modifiers = modifiers;
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...evt, text: modifiers ? '' : (k.text || '') });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...evt });
  for (const p of mods.reverse()) { const md = MODKEY[p]; if (md) await page.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: md.vk, code: md.code, key: md.key }); }
  await sleep(90);
  return `pressed ${key}`;
}

async function scroll(page, direction = 'down', amount = 600) {
  const dy = direction === 'up' ? -Math.abs(amount) : Math.abs(amount);
  await page.eval(`window.scrollBy({top:${dy},left:0,behavior:'instant'})`);
  await sleep(220);
  return `scrolled ${direction} ${Math.abs(amount)}px`;
}

async function extract(page, query) {
  if (query && /[.#\[]|^[a-z]+$/i.test(query)) {
    // looks like a CSS selector → extract text from matches
    try {
      const texts = await page.eval(
        `(function(){try{return [...document.querySelectorAll(${JSON.stringify(query)})].slice(0,30).map(e=>(e.innerText||e.textContent||'').trim()).filter(Boolean);}catch(e){return null;}})()`,
      );
      if (texts && texts.length) return texts.join('\n');
    } catch {}
  }
  // fallback: visible text
  const txt = await page.eval(`document.body?document.body.innerText.slice(0,4000):''`);
  return txt || '(no text)';
}

async function screenshot(page, { format = 'jpeg', quality = 70, fullPage = false } = {}) {
  const params = { format, fromSurface: true };
  if (format === 'jpeg') params.quality = quality;
  if (fullPage) {
    params.captureBeyondViewport = true;
  } else {
    // capture in CSS px (scale 1) so the coords the model reads off the screenshot map
    // 1:1 to the click coords (dispatchMouseEvent uses CSS px). Without this, on retina the
    // screenshot comes out 2x and a click_at by coordinate would miss the target.
    try {
      const vp = await page.eval('({w:Math.round(window.innerWidth),h:Math.round(window.innerHeight)})');
      if (vp && vp.w && vp.h) params.clip = { x: 0, y: 0, width: vp.w, height: vp.h, scale: 1 };
    } catch { /* fallback: captura padrão */ }
  }
  const res = await page.send('Page.captureScreenshot', params);
  return res.data; // base64
}

async function wait(page, ms = 1000) {
  await sleep(Math.min(ms, 10000));
  return `waited ${ms}ms`;
}

module.exports = { navigate, click, clickAt, clickText, type, pressKey, scroll, extract, screenshot, wait, KEYMAP };
