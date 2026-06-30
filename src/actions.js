'use strict';

/**
 * actions.js — Ações de alto nível, por INTENÇÃO/índice (não por pixel).
 *
 * Todas operam sobre uma `page` agnóstica de transporte que expõe:
 *   - page.send(method, params)  → comando CDP
 *   - page.eval(expression)      → Runtime.evaluate (returnByValue)
 *   - page.goto(url)             → navegação (opcional; fallback p/ Page.navigate)
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  // seletor seguro pra data-lpilot-id
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
  return `navegou para ${url}`;
}

async function click(page, id) {
  const pt = await page.eval(
    `(function(){var el=document.querySelector('${q(id)}');if(!el)return null;` +
      `el.scrollIntoView({block:'center',inline:'center'});` +
      `var r=el.getBoundingClientRect();` +
      `return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),tag:el.tagName.toLowerCase()};})()`,
  );
  if (!pt) return `índice [${id}] não encontrado na página`;

  // clique "de verdade": mouse move + press + release nas coordenadas reais
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, buttons: 0 });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', buttons: 1, clickCount: 1,
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', buttons: 0, clickCount: 1,
  });
  await sleep(180);
  return `cliquei em [${id}] (${pt.tag}) @ ${pt.x},${pt.y}`;
}

async function type(page, id, text, submit = false) {
  const ok = await page.eval(
    `(function(){var el=document.querySelector('${q(id)}');if(!el)return false;` +
      `el.scrollIntoView({block:'center'});el.focus();` +
      `if('value' in el){el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));}` +
      `return true;})()`,
  );
  if (!ok) return `índice [${id}] não encontrado para digitar`;

  await page.send('Input.insertText', { text: String(text) });
  // dispara input/change pra frameworks reativos
  await page.eval(
    `(function(){var el=document.querySelector('${q(id)}');if(el){el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}return true;})()`,
  );
  let msg = `digitei em [${id}]: "${text}"`;
  if (submit) {
    await pressKey(page, 'Enter');
    msg += ' + Enter';
  }
  return msg;
}

async function pressKey(page, key) {
  const k = KEYMAP[key];
  if (!k) return `tecla desconhecida: ${key}`;
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown', windowsVirtualKeyCode: k.keyCode, code: k.code, key: k.key, text: k.text || '',
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp', windowsVirtualKeyCode: k.keyCode, code: k.code, key: k.key,
  });
  await sleep(90);
  return `pressionei ${key}`;
}

async function scroll(page, direction = 'down', amount = 600) {
  const dy = direction === 'up' ? -Math.abs(amount) : Math.abs(amount);
  await page.eval(`window.scrollBy({top:${dy},left:0,behavior:'instant'})`);
  await sleep(220);
  return `rolei ${direction} ${Math.abs(amount)}px`;
}

async function extract(page, query) {
  if (query && /[.#\[]|^[a-z]+$/i.test(query)) {
    // parece um seletor CSS → extrai texto dos matches
    try {
      const texts = await page.eval(
        `(function(){try{return [...document.querySelectorAll(${JSON.stringify(query)})].slice(0,30).map(e=>(e.innerText||e.textContent||'').trim()).filter(Boolean);}catch(e){return null;}})()`,
      );
      if (texts && texts.length) return texts.join('\n');
    } catch {}
  }
  // fallback: texto visível
  const txt = await page.eval(`document.body?document.body.innerText.slice(0,4000):''`);
  return txt || '(sem texto)';
}

async function screenshot(page, { format = 'jpeg', quality = 70, fullPage = false } = {}) {
  const params = { format, fromSurface: true };
  if (format === 'jpeg') params.quality = quality;
  if (fullPage) params.captureBeyondViewport = true;
  const res = await page.send('Page.captureScreenshot', params);
  return res.data; // base64
}

async function wait(page, ms = 1000) {
  await sleep(Math.min(ms, 10000));
  return `aguardei ${ms}ms`;
}

module.exports = { navigate, click, type, pressKey, scroll, extract, screenshot, wait, KEYMAP };
