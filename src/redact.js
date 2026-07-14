'use strict';

/**
 * redact.js — Deterministic PII redaction (0-dep, no AI, runs locally).
 *
 * Masks personally identifiable information in text BEFORE it reaches the
 * model / leaves the machine. Regex-based and conservative: credit cards are
 * Luhn-validated so order numbers don't get eaten; CPF/CNPJ (Brazil) included.
 * Placeholders keep the text readable: [email], [phone], [cpf], [card]…
 */

function luhnOk(digits) {
  let sum = 0; let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

const RULES = [
  { name: 'email', re: /[\w.+-]+@[\w-]+\.[\w.-]{2,}/g, tag: '[email]' },
  // 13–19 digit runs (allowing space/dash groups) — only redacted when Luhn passes.
  {
    name: 'card',
    re: /\b(?:\d[ -]?){13,19}\b/g,
    tag: '[card]',
    check: (m) => { const d = m.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && luhnOk(d); },
  },
  { name: 'cpf', re: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, tag: '[cpf]' },
  { name: 'cnpj', re: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, tag: '[cnpj]' },
  // Phones: +55 11 91234-5678 · (11) 91234-5678 · +1 (415) 555-0100 — needs 8+ digits total.
  {
    name: 'phone',
    re: /(?:(?:\+|00)\d{1,3}[ .-]?)?(?:\(?\d{2,3}\)?[ .-]?)?\d{4,5}[ .-]?\d{4}\b/g,
    tag: '[phone]',
    check: (m) => { const d = m.replace(/\D/g, ''); return d.length >= 8 && d.length <= 14; },
  },
  { name: 'ipv4', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, tag: '[ip]', check: (m) => m.split('.').every((o) => +o <= 255) },
];

/**
 * @param {string} text
 * @param {object} [o]  { only: ['email','phone',...] } to restrict rule set
 * @returns {{text:string, redactions:Object<string,number>}}
 */
function redactPII(text, o = {}) {
  let out = String(text || '');
  const counts = {};
  for (const rule of RULES) {
    if (o.only && o.only.length && !o.only.includes(rule.name)) continue;
    out = out.replace(rule.re, (...args) => {
      const m = args[0];
      const offset = args[args.length - 2];
      const full = args[args.length - 1];
      // Digit-boundary guard: never redact a fragment INSIDE a longer digit run
      // (e.g. a 13-digit order id must not lose its tail to the phone rule).
      const before = offset > 0 ? full[offset - 1] : '';
      const after = full[offset + m.length] || '';
      if (/\d/.test(before) || /\d/.test(after)) return m;
      if (rule.check && !rule.check(m)) return m;
      counts[rule.name] = (counts[rule.name] || 0) + 1;
      return rule.tag;
    });
  }
  return { text: out, redactions: counts };
}

module.exports = { redactPII };
