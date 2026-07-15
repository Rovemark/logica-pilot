'use strict';

/**
 * humanize.js — Human-like mouse movement (Apify anti-detection polish). Some bot
 * walls score pointer trajectories; a click that teleports to exact coordinates is a
 * tell. This dispatches a curved (cubic-Bézier) sequence of mousemove events with
 * jitter and variable timing before/at a target, via CDP Input.dispatchMouseEvent.
 *
 *   await humanMoveTo(page, x, y);   // curved approach
 *   await humanClickAt(page, x, y);  // approach + click
 *   await humanClickIndex(page, i);  // approach + click an indexed element's center
 *
 * Opt-in (mouse curves cost time). Zero-dependency (CDP + Math.random for jitter).
 */

function cubic(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Move the pointer to (x,y) along a jittered Bézier curve. */
async function humanMoveTo(page, x, y, { from, steps = 22 } = {}) {
  const start = from || { x: Math.max(0, x * 0.2 + 20), y: Math.max(0, y * 0.15 + 30) };
  // two control points offset perpendicular-ish to create a natural arc
  const c1 = { x: start.x + (x - start.x) * 0.35 + (Math.random() - 0.5) * 80, y: start.y + (y - start.y) * 0.3 + (Math.random() - 0.5) * 80 };
  const c2 = { x: start.x + (x - start.x) * 0.7 + (Math.random() - 0.5) * 60, y: start.y + (y - start.y) * 0.75 + (Math.random() - 0.5) * 60 };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const px = cubic(start.x, c1.x, c2.x, x, t) + (Math.random() - 0.5) * 1.5;
    const py = cubic(start.y, c1.y, c2.y, y, t) + (Math.random() - 0.5) * 1.5;
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(px), y: Math.round(py) }).catch(() => {});
    // ease-in-out: slower at the ends
    await sleep(4 + Math.round(10 * Math.sin(t * Math.PI)));
  }
  return { x, y };
}

async function humanClickAt(page, x, y, opts = {}) {
  await humanMoveTo(page, x, y, opts);
  await sleep(30 + Math.round(Math.random() * 60));
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }).catch(() => {});
  await sleep(40 + Math.round(Math.random() * 70));
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {});
  return { clickedAt: { x, y } };
}

/** Move to and click the center of an indexed element (data-lpilot-id). */
async function humanClickIndex(page, index) {
  const box = await page.eval(
    `(function(){var el=document.querySelector('[data-lpilot-id="${index}"]');if(!el)return null;` +
    `el.scrollIntoView({block:'center'});var r=el.getBoundingClientRect();` +
    `return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`,
  ).catch(() => null);
  if (!box) return { error: `element [${index}] not found` };
  return humanClickAt(page, box.x, box.y);
}

module.exports = { humanMoveTo, humanClickAt, humanClickIndex };
