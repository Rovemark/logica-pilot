'use strict';

/**
 * video.js — Token-first video understanding.
 *
 * Playwright/Firecrawl treat <video> as opaque. Here we extract what a model can
 * actually reason over cheaply:
 *   - the video sources, poster, duration, dimensions, platform (YouTube/Vimeo/…)
 *   - caption/subtitle tracks (<track>) fetched + parsed to plain text (the transcript)
 *   - optional: sample N keyframes for a vision model (opt-in, heavier)
 *   - optional: an LLM summary of the transcript
 *
 * Zero-dependency (global fetch + CDP screenshots).
 */

const llm = require('./llm');

const PROBE = `(() => {
  const vids = [...document.querySelectorAll('video')].map((v, i) => {
    const sources = [...v.querySelectorAll('source')].map((s) => ({ src: s.src, type: s.type }));
    const tracks = [...v.querySelectorAll('track')]
      .filter((t) => /captions|subtitles/i.test(t.kind || ''))
      .map((t) => ({ src: t.src, lang: t.srclang, label: t.label, kind: t.kind }));
    return {
      index: i, currentSrc: v.currentSrc || null, sources,
      duration: isFinite(v.duration) ? Math.round(v.duration) : null,
      poster: v.poster || null, width: v.videoWidth || v.clientWidth, height: v.videoHeight || v.clientHeight,
      paused: v.paused, tracks,
    };
  });
  const u = location.href;
  let platform = null, id = null;
  const yt = u.match(/[?&]v=([\\w-]{11})/) || u.match(/youtu\\.be\\/([\\w-]{11})/) || u.match(/youtube\\.com\\/(?:embed|shorts)\\/([\\w-]{11})/);
  if (yt) { platform = 'youtube'; id = yt[1]; }
  const vm = u.match(/vimeo\\.com\\/(\\d+)/);
  if (vm) { platform = 'vimeo'; id = vm[1]; }
  const title = document.title || null;
  return { videos: vids, platform, id, title, url: u };
})()`;

function parseVtt(text) {
  // Strip WEBVTT header, cue timings, and dedupe consecutive lines → plain transcript.
  const lines = String(text).split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l || l === 'WEBVTT' || /^\d+$/.test(l)) continue;
    if (/-->/.test(l)) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(l)) continue;
    const clean = l.replace(/<[^>]+>/g, '').trim();
    if (clean && out[out.length - 1] !== clean) out.push(clean);
  }
  return out.join(' ');
}

async function fetchTranscript(page, trackSrc) {
  if (!trackSrc) return null;
  // Try in-page fetch first (keeps cookies/CORS same-origin), then a plain fetch.
  let text = await page.eval(`fetch(${JSON.stringify(trackSrc)}).then(r=>r.text()).catch(()=>null)`).catch(() => null);
  if (!text) text = await fetch(trackSrc).then((r) => r.text()).catch(() => null);
  if (!text) return null;
  return parseVtt(text);
}

/** Sample up to `n` keyframes as base64 PNGs (for a vision model). Opt-in / heavier. */
async function sampleFrames(page, { index = 0, n = 4 } = {}) {
  const frames = [];
  const dur = await page.eval(`(() => { const v = document.querySelectorAll('video')[${index}]; return v && isFinite(v.duration) ? v.duration : 0; })()`).catch(() => 0);
  if (!dur) return frames;
  for (let i = 1; i <= n; i++) {
    const t = (dur * i) / (n + 1);
    await page.eval(`(() => { const v = document.querySelectorAll('video')[${index}]; if (v) { v.pause(); v.currentTime = ${t}; } })()`).catch(() => {});
    await new Promise((r) => setTimeout(r, 350));
    const shot = await page.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
    if (shot && shot.data) frames.push({ t: Math.round(t), data: shot.data });
  }
  return frames;
}

/**
 * Analyze the video(s) on the page.
 * @param {object} opts { describe, model, frames (int), index }
 */
async function analyze(page, { describe = false, model, frames = 0, index = 0 } = {}) {
  const probe = await page.eval(PROBE).catch(() => ({ videos: [], platform: null }));
  const result = { platform: probe.platform, id: probe.id, title: probe.title, url: probe.url, videos: probe.videos };

  // Transcript from the first caption track we can fetch.
  let transcript = null;
  for (const v of probe.videos || []) {
    for (const t of v.tracks || []) {
      transcript = await fetchTranscript(page, t.src);
      if (transcript) { result.transcriptLang = t.lang || t.label || null; break; }
    }
    if (transcript) break;
  }
  if (transcript) result.transcript = transcript;
  else if (probe.platform === 'youtube') result.transcriptHint = 'YouTube transcript needs the timedtext API or the watch page captions; none exposed inline.';

  // Optional keyframe sampling for a vision model.
  if (frames && Number(frames) > 0) {
    const shots = await sampleFrames(page, { index, n: Math.min(Number(frames), 8) });
    result.frames = shots.map((f) => ({ t: f.t, bytes: f.data.length }));
    result._frameData = shots; // consumed by the caller if it wants a vision call
  }

  // Optional LLM summary of the transcript.
  if (describe && transcript && llm.isConfigured()) {
    const resp = await llm.callClaude({
      model,
      maxTokens: 512,
      system: 'Summarize this video transcript into 4-6 tight bullet points. Portuguese if the transcript is Portuguese, else match its language.',
      messages: [{ role: 'user', content: transcript.slice(0, 12000) }],
    }).catch(() => null);
    if (resp) result.summary = llm.textOf(resp);
  } else if (describe && !transcript) {
    result.summaryHint = 'No transcript to summarize. Pass frames:N to sample keyframes for a vision model.';
  }

  return result;
}

module.exports = { analyze, sampleFrames, parseVtt };
