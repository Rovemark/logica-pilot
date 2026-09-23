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
    // Cabeçalho do arquivo (Kind:, Language:, X-TIMESTAMP-MAP...) não é fala: entrava no
    // começo da transcrição como se fosse a primeira frase do vídeo.
    if (/^(Kind|Language|X-TIMESTAMP-MAP|NOTE)\s*:/i.test(l)) continue;
    if (/-->/.test(l)) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(l)) continue;
    const clean = l.replace(/<[^>]+>/g, '').trim();
    if (clean && out[out.length - 1] !== clean) out.push(clean);
  }
  return out.join(' ');
}

// O YouTube não expõe <track> nenhum: o player carrega a legenda por conta própria a partir de
// uma lista que vem embutida em `ytInitialPlayerResponse`. Sem ler essa lista, `analyze` só
// conseguia devolver um aviso dizendo que a legenda existe em outro lugar.
const FAIXAS_YOUTUBE = `(() => {
  try {
    const r = (window.ytInitialPlayerResponse
      || JSON.parse((document.body.innerHTML.match(/ytInitialPlayerResponse\\s*=\\s*(\\{.+?\\})\\s*;/) || [])[1] || 'null'));
    const lista = r && r.captions
      && r.captions.playerCaptionsTracklistRenderer
      && r.captions.playerCaptionsTracklistRenderer.captionTracks;
    if (!lista || !lista.length) return [];
    return lista.map((c) => ({
      url: c.baseUrl,
      lang: c.languageCode || null,
      label: (c.name && (c.name.simpleText || (c.name.runs || []).map((x) => x.text).join(''))) || null,
      automatica: c.kind === 'asr',
    }));
  } catch (e) { return []; }
})()`;

// O timedtext devolve XML, não WebVTT. As entidades vêm dobradas (&amp;#39;), então a
// decodificação roda duas vezes; uma passada só deixa `&#39;` cru no texto.
function parseTimedtext(xml) {
  const partes = [];
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(String(xml)))) {
    const bruto = m[1];
    const limpo = decodificar(decodificar(bruto))
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (limpo && partes[partes.length - 1] !== limpo) partes.push(limpo);
  }
  return partes.join(' ');
}

function decodificar(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// Preferência: legenda escrita por pessoa, no idioma da página; depois a automática. Uma legenda
// automática em outro idioma é pior que a escrita no idioma certo, e o modelo paga o preço.
function escolherFaixa(faixas, idiomaDaPagina) {
  if (!faixas || !faixas.length) return null;
  const base = String(idiomaDaPagina || '').slice(0, 2).toLowerCase();
  const casa = (f) => String(f.lang || '').slice(0, 2).toLowerCase() === base;
  return faixas.find((f) => !f.automatica && casa(f))
      || faixas.find((f) => !f.automatica)
      || faixas.find((f) => casa(f))
      || faixas[0];
}

// ── ROTA PREFERIDA: yt-dlp ─────────────────────────────────────
//
// Medido em 24/08/2026: o `api/timedtext` responde 200 com CORPO VAZIO para toda variante de
// formato (sem fmt, json3, srv3, vtt, ttml), e o painel de transcrição não abre com clique
// programático. O YouTube fechou os dois caminhos diretos.
//
// O yt-dlp continua entregando porque implementa a negociação de token que o player faz. É
// dependência externa, e é a escolha certa: um projeto com 154 mil estrelas persegue as
// mudanças do YouTube em tempo integral, e nós não vamos ganhar essa corrida sozinhos.
// Sem ele instalado, a via nativa abaixo ainda é tentada e o aviso diz o que instalar.
function transcricaoYtdlp(url, { timeout = 45000 } = {}) {
  const { execFile } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  return new Promise((resolve) => {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-leg-'));
    const saida = path.join(pasta, 'leg');
    const limpar = () => { try { fs.rmSync(pasta, { recursive: true, force: true }); } catch {} };
    const args = [
      '--skip-download', '--write-subs', '--write-auto-subs',
      '--sub-langs', 'pt.*,en.*', '--sub-format', 'vtt',
      '--no-warnings', '-o', saida, url,
    ];
    const filho = execFile('yt-dlp', args, { timeout }, (erro) => {
      // Erro parcial é comum (um idioma falha, outro baixa). O que vale é: veio arquivo?
      let arquivos = [];
      try { arquivos = fs.readdirSync(pasta).filter((f) => f.endsWith('.vtt')); } catch {}
      if (!arquivos.length) {
        limpar();
        const semFerramenta = erro && (erro.code === 'ENOENT' || /ENOENT/.test(String(erro.message)));
        return resolve({ ok: false, semFerramenta, erro: semFerramenta ? 'yt-dlp não está instalado' : 'yt-dlp não trouxe legenda' });
      }
      // Escrita por pessoa ganha da automática, e português ganha do resto.
      const nota = (f) => (/\.pt/.test(f) ? 0 : 10) + (/auto/i.test(f) ? 5 : 0);
      arquivos.sort((a, b) => nota(a) - nota(b));
      const escolhido = arquivos[0];
      let vtt = '';
      try { vtt = fs.readFileSync(path.join(pasta, escolhido), 'utf8'); } catch {}
      limpar();
      const texto = parseVtt(vtt);
      if (!texto) return resolve({ ok: false, erro: 'a legenda veio vazia' });
      const lang = (/\.([a-z]{2}(?:-[A-Za-z]{2,4})?)\.vtt$/.exec(escolhido) || [])[1] || null;
      return resolve({ ok: true, texto, lang, automatica: /auto/i.test(escolhido), via: 'yt-dlp' });
    });
    filho.on('error', () => {});
  });
}

async function transcricaoYoutube(page) {
  const faixas = await page.eval(FAIXAS_YOUTUBE).catch(() => []);
  if (!faixas || !faixas.length) return null;
  const idioma = await page.eval('document.documentElement.lang || navigator.language').catch(() => 'pt');
  const faixa = escolherFaixa(faixas, idioma);
  if (!faixa || !faixa.url) return null;
  // Buscar de DENTRO da página: o baseUrl é assinado e o YouTube recusa a chamada de fora.
  const xml = await page.eval(
    `fetch(${JSON.stringify(faixa.url)}).then(r=>r.text()).catch(()=>null)`
  ).catch(() => null);
  if (!xml) return null;
  const texto = parseTimedtext(xml);
  if (!texto) return null;
  return { texto, lang: faixa.lang, label: faixa.label, automatica: !!faixa.automatica };
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
  // Sem <track>, tentar o caminho do próprio YouTube antes de desistir.
  // YouTube: yt-dlp primeiro (é o que entrega hoje), via nativa como alternativa.
  let semYtdlp = false;
  if (!transcript && probe.platform === 'youtube') {
    const viaFerramenta = await transcricaoYtdlp(probe.url).catch(() => null);
    if (viaFerramenta && viaFerramenta.ok) {
      transcript = viaFerramenta.texto;
      result.transcriptLang = viaFerramenta.lang;
      result.transcriptAuto = viaFerramenta.automatica;
      result.transcriptVia = 'yt-dlp';
    } else {
      semYtdlp = !!(viaFerramenta && viaFerramenta.semFerramenta);
      const yt = await transcricaoYoutube(page).catch(() => null);
      if (yt) {
        transcript = yt.texto;
        result.transcriptLang = yt.lang || yt.label || null;
        result.transcriptAuto = yt.automatica;
        result.transcriptVia = 'timedtext';
      }
    }
  }
  if (transcript) result.transcript = transcript;
  else if (probe.platform === 'youtube') {
    // Dizer qual é o remédio vale mais que dizer que falhou.
    result.transcriptHint = semYtdlp
      ? 'sem legenda: o YouTube fechou o acesso direto e o yt-dlp não está instalado (brew install yt-dlp)'
      : 'este vídeo do YouTube não tem legenda publicada (nem automática)';
  }

  // Optional keyframe sampling for a vision model.
  if (frames && Number(frames) > 0) {
    const shots = await sampleFrames(page, { index, n: Math.min(Number(frames), 8) });
    result.frames = shots.map((f) => ({ t: f.t, bytes: f.data.length }));
    result._frameData = shots; // consumed by the caller if it wants a vision call
  }

  // Optional LLM understanding: transcript summary first (cheap), else vision over
  // the sampled keyframes (real multimodal — the frames are actually consumed, not
  // just captured), else a hint.
  if (describe && llm.isConfigured()) {
    if (transcript) {
      const resp = await llm.callClaude({
        model,
        maxTokens: 512,
        system: 'Summarize this video transcript into 4-6 tight bullet points. Portuguese if the transcript is Portuguese, else match its language.',
        messages: [{ role: 'user', content: transcript.slice(0, 12000) }],
      }).catch(() => null);
      if (resp) result.summary = llm.textOf(resp);
    } else if (result._frameData && result._frameData.length) {
      const content = result._frameData.map((f) => ({
        type: 'image', source: { type: 'base64', media_type: 'image/png', data: f.data },
      }));
      content.push({
        type: 'text',
        text: `Estes são ${result._frameData.length} keyframes amostrados ao longo de um vídeo`
          + (result.title ? ` intitulado "${result.title}"` : '')
          + '. Descreva o que acontece no vídeo em 4-6 bullets curtos, em português.',
      });
      const resp = await llm.callClaude({ model, maxTokens: 512, messages: [{ role: 'user', content }] }).catch(() => null);
      if (resp) { result.summary = llm.textOf(resp); result.summarySource = 'vision'; }
    } else {
      result.summaryHint = 'Sem transcript e sem frames. Passe frames:N pra amostrar keyframes pro modelo de visão.';
    }
  } else if (describe && !llm.isConfigured()) {
    result.summaryHint = 'LLM não configurado; retornando só os dados estruturados do vídeo.';
  }

  return result;
}

module.exports = {
  analyze, sampleFrames, parseVtt,
  // Expostos para teste: o parser do timedtext e a escolha de faixa decidem a qualidade da
  // transcrição, e são a parte que dá pra provar sem abrir um navegador.
  __teste: { parseTimedtext, escolherFaixa, decodificar },
};
