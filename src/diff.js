'use strict';

/**
 * diff.js — Minimal line diff (0-dep) for change tracking.
 *
 * Produces a unified-style, git-like text diff between two strings, line by
 * line, via a classic LCS. Built for the `watch` tool: the output is meant to
 * be READ BY A MODEL, so it is compact — context collapsed, long runs capped.
 */

/** Longest-common-subsequence table over two line arrays (small inputs only). */
function lcsMatrix(a, b) {
  const m = a.length; const n = b.length;
  // Uint16 keeps it lean; watch caps input lines well below 65k.
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

/**
 * Line diff of two texts.
 * @returns {{changed:boolean, added:number, removed:number, text:string}}
 *   text = git-like diff ("- old", "+ new", unchanged collapsed), capped.
 */
function lineDiff(before, after, { maxLines = 4000, maxOut = 120 } = {}) {
  const a = String(before || '').split('\n').slice(0, maxLines);
  const b = String(after || '').split('\n').slice(0, maxLines);
  if (before === after) return { changed: false, added: 0, removed: 0, text: '' };

  const dp = lcsMatrix(a, b);
  const ops = []; // {t:'='|'-'|'+', line}
  let i = 0; let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ t: '=', line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: '-', line: a[i] }); i++; }
    else { ops.push({ t: '+', line: b[j] }); j++; }
  }
  while (i < a.length) ops.push({ t: '-', line: a[i++] });
  while (j < b.length) ops.push({ t: '+', line: b[j++] });

  let added = 0; let removed = 0;
  for (const op of ops) { if (op.t === '+') added++; else if (op.t === '-') removed++; }
  if (!added && !removed) return { changed: false, added: 0, removed: 0, text: '' };

  // Render: keep 1 line of context around changes, collapse the rest.
  const keep = new Set();
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].t !== '=') { keep.add(k - 1); keep.add(k); keep.add(k + 1); }
  }
  const out = [];
  let skipping = false;
  for (let k = 0; k < ops.length && out.length < maxOut; k++) {
    if (!keep.has(k)) { if (!skipping) { out.push('  …'); skipping = true; } continue; }
    skipping = false;
    const p = ops[k].t === '=' ? '  ' : ops[k].t + ' ';
    out.push(p + ops[k].line);
  }
  if (out.length >= maxOut) out.push(`  … (diff truncated at ${maxOut} lines)`);
  return { changed: true, added, removed, text: out.join('\n') };
}

module.exports = { lineDiff };
