'use strict';

/*
  reader.js — Modo leitor (window.Reader).

  Aciona via dispatchMenu('reader'). Injeta na aba ativa (<webview>) o
  @mozilla/readability (vendorizado em readability.js, exposto como STRING em
  window.__READABILITY_SOURCE__ por readability-source.js), extrai o artigo com
  `new Readability(doc.cloneNode(true)).parse()` e substitui a página por uma
  versão limpa (tipografia confortável, claro/escuro via prefers-color-scheme).

  Toggle: acionar de novo na MESMA página restaura o conteúdo original. O estado
  "ligado" vive DENTRO da página (window.__lpReaderActive), pois um reload/nav
  descarta tudo — então o toggle reflete o estado real do documento.

  Tudo roda no contexto da página via wv.executeJavaScript (sem preload lá).
*/

(function () {
  // Estilo do modo leitor (injetado dentro da página). Tokens próprios — a página
  // do site NÃO tem o tema do host. Claro/escuro acompanham o SO.
  var READER_CSS = [
    ':root{color-scheme:light dark;}',
    'html,body{margin:0!important;padding:0!important;background:#faf9f7!important;}',
    '@media (prefers-color-scheme: dark){html,body{background:#15171c!important;}}',
    '#lp-reader{box-sizing:border-box;max-width:720px;margin:0 auto;padding:64px 24px 120px;',
    'font-family:Georgia,Cambria,"Times New Roman",serif;font-size:20px;line-height:1.7;',
    'color:#23262b;}',
    '@media (prefers-color-scheme: dark){#lp-reader{color:#d7dae0;}}',
    '#lp-reader .lp-rd-head{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;',
    'margin-bottom:36px;padding-bottom:20px;border-bottom:1px solid rgba(124,92,255,.2);}',
    '#lp-reader h1.lp-rd-title{font-size:34px;line-height:1.2;letter-spacing:-.5px;margin:0 0 12px;',
    'font-weight:700;color:#16181d;}',
    '@media (prefers-color-scheme: dark){#lp-reader h1.lp-rd-title{color:#f2f4fa;}}',
    '#lp-reader .lp-rd-meta{font-size:14.5px;color:#7c5cff;font-weight:600;}',
    '#lp-reader .lp-rd-meta a{color:inherit;}',
    '#lp-reader .lp-rd-body{}',
    '#lp-reader .lp-rd-body img,#lp-reader .lp-rd-body figure,#lp-reader .lp-rd-body video{',
    'max-width:100%!important;height:auto!important;border-radius:10px;display:block;margin:28px auto;}',
    '#lp-reader .lp-rd-body p{margin:0 0 1.1em;}',
    '#lp-reader .lp-rd-body a{color:#5b3ff0;text-decoration:underline;text-underline-offset:2px;}',
    '@media (prefers-color-scheme: dark){#lp-reader .lp-rd-body a{color:#9d86ff;}}',
    '#lp-reader .lp-rd-body h1,#lp-reader .lp-rd-body h2,#lp-reader .lp-rd-body h3{',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;',
    'line-height:1.3;margin:1.6em 0 .5em;font-weight:700;}',
    '#lp-reader .lp-rd-body h2{font-size:26px;}#lp-reader .lp-rd-body h3{font-size:22px;}',
    '#lp-reader .lp-rd-body blockquote{margin:1.4em 0;padding:.4em 0 .4em 22px;',
    'border-left:3px solid #7c5cff;color:inherit;opacity:.85;font-style:italic;}',
    '#lp-reader .lp-rd-body pre{background:rgba(124,92,255,.08);padding:16px;border-radius:10px;',
    'overflow:auto;font-size:15px;line-height:1.5;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}',
    '#lp-reader .lp-rd-body code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;}',
    '#lp-reader .lp-rd-body ul,#lp-reader .lp-rd-body ol{padding-left:1.4em;margin:0 0 1.1em;}',
    '#lp-reader .lp-rd-body li{margin:.3em 0;}',
    '#lp-reader .lp-rd-body hr{border:none;border-top:1px solid rgba(128,128,128,.25);margin:2em 0;}',
    '#lp-reader .lp-rd-fail{font-family:-apple-system,system-ui,sans-serif;font-size:16px;color:#888;}'
  ].join('');

  /**
   * Script executado DENTRO da página. Recebe (css):
   *  - se o leitor já está ativo → restaura o documento salvo e retorna {restored:true}
   *  - senão → extrai o artigo com Readability e troca o <body> pela versão limpa
   * Retorna um objeto serializável (sem DOM) para o host saber o resultado.
   *
   * O FONTE do Readability é CONCATENADO no corpo do script (não via eval) — assim
   * a `function Readability` é declarada no mesmo escopo executado e fica visível
   * para a IIFE abaixo. Evita `eval`, contornando CSP de site (sem 'unsafe-eval').
   * `wv.executeJavaScript` roda num mundo que não sofre a CSP do site p/ o próprio
   * script, então a declaração de função passa mesmo em páginas com CSP estrita.
   */
  function buildPageScript(readabilitySrc, css) {
    // [readabilitySrc] declara `function Readability(){…}` + `Readability.prototype`.
    // Em seguida, a IIFE (recebendo só o css) usa `Readability` diretamente.
    return readabilitySrc + '\n;(' + function (RD_CSS) {
      try {
        // ── toggle OFF: pede reload ao host ─────────────────────────
        // Restaurar via innerHTML "congela" a página (scripts não re-executam).
        // Em vez disso, sinalizamos {restored:true} e o HOST dá wv.reload() —
        // recarrega a página original limpa, com os scripts rodando de novo.
        if (window.__lpReaderActive) {
          window.__lpReaderActive = false;
          return { ok: true, restored: true };
        }

        // ── toggle ON: extrai e troca ───────────────────────────────
        var savedTitle = document.title;

        if (typeof Readability !== 'function') {
          return { ok: false, error: 'extrator indisponível' };
        }

        // Clona o documento (Readability MUTA o doc que recebe).
        var docClone = document.cloneNode(true);
        var article = null;
        try {
          article = new Readability(docClone).parse();
        } catch (e) {
          return { ok: false, error: 'falha na extração: ' + (e && e.message) };
        }
        if (!article || !article.content) {
          return { ok: false, error: 'sem-artigo' };
        }

        // Marca ativo SÓ depois de uma extração bem-sucedida. NÃO guardamos o HTML
        // original: ao sair, o host recarrega a página (reload), evitando o
        // "congelamento" de scripts que o innerHTML restaurado causava.
        window.__lpReaderActive = true;

        // Monta a página de leitura limpa.
        function esc(s) {
          return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
          });
        }
        var byline = article.byline ? esc(article.byline) : '';
        var siteName = article.siteName ? esc(article.siteName) : '';
        var metaBits = [];
        if (byline) metaBits.push(byline);
        if (siteName && siteName !== byline) metaBits.push(siteName);
        var metaHtml = metaBits.length
          ? '<div class="lp-rd-meta">' + metaBits.join(' · ') + '</div>' : '';

        var titleText = article.title || savedTitle || document.location.hostname;

        // Reescreve o documento inteiro (head limpo + body com o artigo).
        // article.content é HTML sanitizado pelo Readability.
        var head = document.head;
        // remove estilos/links do site p/ não brigar com o leitor
        try {
          var olds = document.querySelectorAll('link[rel="stylesheet"],style');
          for (var i = 0; i < olds.length; i++) olds[i].parentNode && olds[i].parentNode.removeChild(olds[i]);
        } catch (e) {}
        var styleEl = document.createElement('style');
        styleEl.id = 'lp-reader-style';
        styleEl.textContent = RD_CSS;
        (head || document.documentElement).appendChild(styleEl);

        document.body.innerHTML =
          '<article id="lp-reader">' +
          '<header class="lp-rd-head">' +
          '<h1 class="lp-rd-title">' + esc(titleText) + '</h1>' +
          metaHtml +
          '</header>' +
          '<div class="lp-rd-body">' + article.content + '</div>' +
          '</article>';
        document.title = titleText;
        window.scrollTo(0, 0);

        return { ok: true, restored: false, title: titleText, length: article.length || 0 };
      } catch (e) {
        return { ok: false, error: (e && e.message) || 'erro desconhecido no leitor' };
      }
    }.toString() + ')(' + JSON.stringify(css) + ');';
  }

  var Reader = {
    /**
     * Alterna o modo leitor na webview informada.
     * @param {Electron.WebviewTag} wv  webview da aba ativa
     * @returns {Promise<{ok:boolean, restored?:boolean, error?:string, title?:string}>}
     */
    async toggle(wv) {
      if (!wv) return { ok: false, error: 'sem aba ativa' };
      var src = window.__READABILITY_SOURCE__;
      if (typeof src !== 'string' || !src.length) {
        return { ok: false, error: 'extrator não carregado (readability-source.js)' };
      }
      var script = buildPageScript(src, READER_CSS);
      try {
        // userGesture=true: alguns sites exigem gesto p/ scroll/foco.
        var res = await wv.executeJavaScript(script, true);
        // SAIR do modo leitor: recarrega a página original (limpa, scripts rodando)
        // em vez de restaurar innerHTML — o restore "congelava" a página.
        if (res && res.ok && res.restored) {
          try { wv.reload(); } catch (e) {}
        }
        return res || { ok: false, error: 'sem resposta da página' };
      } catch (e) {
        return { ok: false, error: (e && e.message) || 'falha ao executar na página' };
      }
    },
  };

  window.Reader = Reader;
})();
