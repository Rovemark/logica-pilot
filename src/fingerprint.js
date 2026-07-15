'use strict';

/**
 * fingerprint.js — Statistically-plausible, INTERNALLY-CONSISTENT browser fingerprints
 * (Apify fingerprint-suite's job). LP's old stealth is one frozen synthetic machine
 * with contradictory signals (e.g. macOS UA + Linux webgl); modern anti-bot clusters
 * exactly those contradictions.
 *
 * Approach (zero-dependency): instead of vendoring fingerprint-suite's multi-MB
 * Bayesian network, we carry a curated table of REAL, mutually-consistent device
 * profiles (UA + platform + screen + webgl + languages + UA-CH + hardware), weighted
 * by real browser/OS market share, and inject a COHERENT bundle so every surface
 * agrees. Sticky per (session,proxy) so an identity doesn't shift mid-run.
 *
 * generate({browser,os,seed}) -> fingerprint
 * applyFingerprint(page, fp)  -> CDP overrides (UA + UA-CH + metrics + webgl + navigator)
 */

// Real, internally-consistent profiles. weight ≈ market share. Each field agrees with the others.
const PROFILES = [
  { weight: 34, browser: 'chrome', os: 'windows', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', platform: 'Win32', vendor: 'Google Inc.', ver: '131', screen: { w: 1920, h: 1080, dpr: 1, depth: 24 }, cores: 8, mem: 8, langs: ['en-US', 'en'], webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' }, uaPlatform: 'Windows', mobile: false },
  { weight: 20, browser: 'chrome', os: 'macos', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', platform: 'MacIntel', vendor: 'Google Inc.', ver: '131', screen: { w: 1512, h: 982, dpr: 2, depth: 30 }, cores: 10, mem: 16, langs: ['en-US', 'en'], webgl: { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' }, uaPlatform: 'macOS', mobile: false },
  { weight: 12, browser: 'chrome', os: 'windows', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', platform: 'Win32', vendor: 'Google Inc.', ver: '130', screen: { w: 2560, h: 1440, dpr: 1, depth: 24 }, cores: 16, mem: 16, langs: ['en-US', 'en'], webgl: { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' }, uaPlatform: 'Windows', mobile: false },
  { weight: 8, browser: 'edge', os: 'windows', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0', platform: 'Win32', vendor: 'Google Inc.', ver: '131', screen: { w: 1920, h: 1080, dpr: 1, depth: 24 }, cores: 8, mem: 8, langs: ['en-US', 'en'], webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' }, uaPlatform: 'Windows', mobile: false },
  { weight: 7, browser: 'firefox', os: 'windows', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0', platform: 'Win32', vendor: '', ver: '133', screen: { w: 1920, h: 1080, dpr: 1, depth: 24 }, cores: 8, mem: 8, langs: ['en-US', 'en'], webgl: { vendor: 'Mozilla', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0, D3D11)' }, uaPlatform: 'Windows', mobile: false, gecko: true },
  { weight: 6, browser: 'safari', os: 'macos', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', platform: 'MacIntel', vendor: 'Apple Computer, Inc.', ver: '18', screen: { w: 1512, h: 982, dpr: 2, depth: 30 }, cores: 8, mem: 8, langs: ['en-US', 'en'], webgl: { vendor: 'Apple Inc.', renderer: 'Apple GPU' }, uaPlatform: 'macOS', mobile: false, webkit: true },
  { weight: 7, browser: 'chrome', os: 'android', ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36', platform: 'Linux armv81', vendor: 'Google Inc.', ver: '131', screen: { w: 412, h: 915, dpr: 2.625, depth: 24 }, cores: 8, mem: 8, langs: ['en-US', 'en'], webgl: { vendor: 'Google Inc. (Qualcomm)', renderer: 'ANGLE (Qualcomm, Adreno (TM) 750, OpenGL ES 3.2)' }, uaPlatform: 'Android', mobile: true },
  { weight: 6, browser: 'safari', os: 'ios', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', platform: 'iPhone', vendor: 'Apple Computer, Inc.', ver: '18', screen: { w: 393, h: 852, dpr: 3, depth: 24 }, cores: 6, mem: 4, langs: ['en-US', 'en'], webgl: { vendor: 'Apple Inc.', renderer: 'Apple GPU' }, uaPlatform: 'iOS', mobile: true, webkit: true },
];

// Deterministic PRNG from a seed string (so a session/proxy gets a stable identity).
function seededRand(seed) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < String(seed).length; i++) { h ^= String(seed).charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return (h % 100000) / 100000;
}

/** Pick a consistent fingerprint. Filter by browser/os; seed → sticky selection. */
function generate({ browser, os, seed } = {}) {
  let pool = PROFILES.filter((p) => (!browser || p.browser === browser) && (!os || p.os === os));
  if (!pool.length) pool = PROFILES;
  const total = pool.reduce((s, p) => s + p.weight, 0);
  const r = (seed != null ? seededRand(seed) : ((PROFILES._i = (PROFILES._i || 0) + 1) % 100) / 100) * total;
  let acc = 0, chosen = pool[0];
  for (const p of pool) { acc += p.weight; if (r <= acc) { chosen = p; break; } }
  const langHeader = chosen.langs.map((l, i) => (i === 0 ? l : `${l};q=${(1 - i * 0.1).toFixed(1)}`)).join(',');
  return {
    browser: chosen.browser, os: chosen.os, userAgent: chosen.ua, platform: chosen.platform,
    vendor: chosen.vendor, version: chosen.ver, screen: chosen.screen, cores: chosen.cores, deviceMemory: chosen.mem,
    languages: chosen.langs, acceptLanguage: langHeader, webgl: chosen.webgl, mobile: chosen.mobile,
    uaPlatform: chosen.uaPlatform, gecko: !!chosen.gecko, webkit: !!chosen.webkit,
  };
}

// UA-CH client-hint headers consistent with the UA (Chromium engines only).
function clientHints(fp) {
  if (fp.gecko || fp.webkit) return {};
  const brands = [`"Chromium";v="${fp.version}"`, `"${fp.browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome'}";v="${fp.version}"`, '"Not_A Brand";v="24"'].join(', ');
  return { 'sec-ch-ua': brands, 'sec-ch-ua-mobile': fp.mobile ? '?1' : '?0', 'sec-ch-ua-platform': `"${fp.uaPlatform}"` };
}

// The in-page override bundle — every surface agrees with the fingerprint.
function injectionScript(fp) {
  const wv = fp.webgl;
  return `(() => {
    const def = (o, k, v) => { try { Object.defineProperty(o, k, { get: () => v, configurable: true }); } catch(e){} };
    def(navigator, 'webdriver', undefined);
    def(navigator, 'platform', ${JSON.stringify(fp.platform)});
    def(navigator, 'hardwareConcurrency', ${fp.cores});
    def(navigator, 'deviceMemory', ${fp.deviceMemory});
    def(navigator, 'vendor', ${JSON.stringify(fp.vendor)});
    def(navigator, 'languages', ${JSON.stringify(fp.languages)});
    def(navigator, 'maxTouchPoints', ${fp.mobile ? 5 : 0});
    try {
      def(screen, 'width', ${fp.screen.w}); def(screen, 'height', ${fp.screen.h});
      def(screen, 'availWidth', ${fp.screen.w}); def(screen, 'availHeight', ${fp.screen.h - (fp.mobile ? 0 : 40)});
      def(screen, 'colorDepth', ${fp.screen.depth}); def(screen, 'pixelDepth', ${fp.screen.depth});
      def(window, 'devicePixelRatio', ${fp.screen.dpr});
    } catch(e){}
    if (!window.chrome && ${!fp.gecko && !fp.webkit}) window.chrome = { runtime: {}, app: {}, csi: () => {}, loadTimes: () => {} };
    const patchGL = (proto) => { if (!proto) return; const gp = proto.getParameter; proto.getParameter = function(p){ if (p === 37445) return ${JSON.stringify(wv.vendor)}; if (p === 37446) return ${JSON.stringify(wv.renderer)}; return gp.call(this, p); }; };
    try { patchGL(WebGLRenderingContext.prototype); } catch(e){}
    try { patchGL(WebGL2RenderingContext.prototype); } catch(e){}
    // permissions.query consistency (headless tell)
    try { const q = navigator.permissions.query.bind(navigator.permissions); navigator.permissions.query = (p) => p && p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : q(p); } catch(e){}
    // hide the override functions themselves
    try { const t = Function.prototype.toString; Function.prototype.toString = function(){ return t.call(this); }; } catch(e){}
  })()`;
}

/** Apply a fingerprint to a live page via CDP (call BEFORE navigating for full effect). */
async function applyFingerprint(page, fp) {
  const script = injectionScript(fp);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: script }).catch(() => {});
  await page.eval(script).catch(() => {});
  // Native UA + UA-CH metadata (so navigator.userAgentData agrees, not just the string).
  const meta = (!fp.gecko && !fp.webkit) ? {
    brands: [{ brand: 'Chromium', version: fp.version }, { brand: fp.browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome', version: fp.version }, { brand: 'Not_A Brand', version: '24' }],
    fullVersion: `${fp.version}.0.0.0`, platform: fp.uaPlatform, platformVersion: '', architecture: fp.mobile ? '' : 'x86', model: '', mobile: fp.mobile,
  } : undefined;
  await page.send('Emulation.setUserAgentOverride', { userAgent: fp.userAgent, acceptLanguage: fp.acceptLanguage, platform: fp.platform, ...(meta ? { userAgentMetadata: meta } : {}) }).catch(() => {});
  await page.send('Emulation.setDeviceMetricsOverride', { width: fp.screen.w, height: fp.screen.h, deviceScaleFactor: fp.screen.dpr, mobile: fp.mobile }).catch(() => {});
  if (fp.mobile) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }).catch(() => {});
  return { applied: true, ua: fp.userAgent, os: fp.os, browser: fp.browser };
}

/**
 * Block WebRTC IP leaks — behind a proxy, RTCPeerConnection can still expose the
 * real local/public IP via ICE candidates. This neutralizes the leak while keeping
 * the API present (returning a stub that yields no host candidates). Call after
 * applyFingerprint, especially when a proxy is active.
 */
async function blockWebRTC(page) {
  const script = `(() => {
    const noop = function(){};
    const Stub = function(){ return { createDataChannel: () => ({}), createOffer: () => Promise.resolve({}), createAnswer: () => Promise.resolve({}), setLocalDescription: () => Promise.resolve(), setRemoteDescription: () => Promise.resolve(), addIceCandidate: () => Promise.resolve(), addEventListener: noop, removeEventListener: noop, close: noop, getStats: () => Promise.resolve(new Map()), onicecandidate: null }; };
    try { Object.defineProperty(window, 'RTCPeerConnection', { get: () => Stub, configurable: true }); } catch(e){}
    try { Object.defineProperty(window, 'webkitRTCPeerConnection', { get: () => Stub, configurable: true }); } catch(e){}
    try { if (navigator.mediaDevices) navigator.mediaDevices.enumerateDevices = () => Promise.resolve([]); } catch(e){}
  })()`;
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: script }).catch(() => {});
  await page.eval(script).catch(() => {});
  return { webrtc: 'blocked' };
}

module.exports = { generate, applyFingerprint, injectionScript, clientHints, blockWebRTC, PROFILES };
