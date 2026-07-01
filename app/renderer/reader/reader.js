'use strict';

/*
  reader.js — Reader mode (window.Reader).

  Triggered via dispatchMenu('reader'). Injects into the active tab (<webview>) the
  @mozilla/readability (vendorized in readability.js, exposed as STRING in
  window.__READABILITY_SOURCE__ by readability-source.js), extracts the article with
  `new Readability(doc.cloneNode(true)).parse()` and replaces the page with a
  clean version (comfortable typography, light/dark via prefers-color-scheme).

  Toggle: triggering again on the SAME page restores the original content. The
  "active" state lives INSIDE the page (window.__lpReaderActive), since a reload/nav
  discards everything — so the toggle reflects the true state of the document.

  Everything runs in the page context via wv.executeJavaScript (no preload there).
*/

(function () {
  // Reader mode styling (injected into the page). Own tokens — the website page
  // does NOT have the host theme. Light/dark follow the OS.
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
   * Script executed INSIDE the page. Receives (css):
   *  - if the reader is already active → restores the saved document and returns {restored:true}
   *  - otherwise → extracts the article with Readability and replaces the <body> with the clean version
   * Returns a serializable object (no DOM) so the host knows the result.
   *
   * The Readability SOURCE is CONCATENATED into the script body (not via eval) — so
   * the `function Readability` is declared in the same executed scope and is visible
   * to the IIFE below. Avoids `eval`, bypassing site CSP (no 'unsafe-eval').
   * `wv.executeJavaScript` runs in a world that doesn't suffer the site's CSP for its own
   * script, so the function declaration passes even on pages with strict CSP.
   */
  function buildPageScript(readabilitySrc, css) {
    // [readabilitySrc] declares `function Readability(){…}` + `Readability.prototype`.
    // Next, the IIFE (receiving only css) uses `Readability` directly.
    return readabilitySrc + '\n;(' + function (RD_CSS) {
      try {
        // ── toggle OFF: requests reload to host ─────────────────────────
        // Restoring via innerHTML "freezes" the page (scripts don't re-execute).
        // Instead, we signal {restored:true} and the HOST calls wv.reload() —
        // reloads the original page clean, with scripts running again.
        if (window.__lpReaderActive) {
          window.__lpReaderActive = false;
          return { ok: true, restored: true };
        }

        // ── toggle ON: extract and replace ───────────────────────────────
        var savedTitle = document.title;

        if (typeof Readability !== 'function') {
          return { ok: false, error: 'extractor unavailable' };
        }

        // Clone the document (Readability MUTATES the doc it receives).
        var docClone = document.cloneNode(true);
        var article = null;
        try {
          article = new Readability(docClone).parse();
        } catch (e) {
          return { ok: false, error: 'extraction failed: ' + (e && e.message) };
        }
        if (!article || !article.content) {
          return { ok: false, error: 'no-article' };
        }

        // Mark active ONLY after successful extraction. We do NOT save the original HTML:
        // when exiting, the host reloads the page (reload), avoiding the
        // "freezing" of scripts that restored innerHTML would cause.
        window.__lpReaderActive = true;

        // Build the clean reading page.
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

        // Rewrites the entire document (clean head + body with article).
        // article.content is HTML sanitized by Readability.
        var head = document.head;
        // remove site styles/links to avoid conflicting with the reader
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
        return { ok: false, error: (e && e.message) || 'unknown reader error' };
      }
    }.toString() + ')(' + JSON.stringify(css) + ');';
  }

  var Reader = {
    /**
     * Toggles reader mode in the given webview.
     * @param {Electron.WebviewTag} wv  webview of the active tab
     * @returns {Promise<{ok:boolean, restored?:boolean, error?:string, title?:string}>}
     */
    async toggle(wv) {
      if (!wv) return { ok: false, error: 'no active tab' };
      var src = window.__READABILITY_SOURCE__;
      if (typeof src !== 'string' || !src.length) {
        return { ok: false, error: 'extractor not loaded (readability-source.js)' };
      }
      var script = buildPageScript(src, READER_CSS);
      try {
        // userGesture=true: some sites require a gesture for scroll/focus.
        var res = await wv.executeJavaScript(script, true);
        // EXIT reader mode: reloads the original page (clean, scripts running)
        // instead of restoring innerHTML — restoring "froze" the page.
        if (res && res.ok && res.restored) {
          try { wv.reload(); } catch (e) {}
        }
        return res || { ok: false, error: 'no response from page' };
      } catch (e) {
        return { ok: false, error: (e && e.message) || 'failed to execute on page' };
      }
    },
  };

  window.Reader = Reader;
})();
