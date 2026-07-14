'use strict';

/**
 * page-data.js — DETERMINISTIC page extractors (no LLM, no tokens spent).
 *
 * Pulls structure the page already declares about itself:
 *   meta()    — title/description, canonical, favicon, OpenGraph/Twitter, JSON-LD types
 *   images()  — image URLs with alt text (absolute, deduped, capped)
 *   product() — schema.org Product via JSON-LD → microdata → OpenGraph fallbacks.
 *               Fails CLOSED: {found:false} when the page doesn't declare a product,
 *               instead of guessing (guessing is what `extract` + AI is for).
 */

/* eslint-disable */
function __lp_meta() {
  function m(sel, attr) { var e = document.querySelector(sel); return e ? (e.getAttribute(attr || 'content') || '').trim() : ''; }
  var out = {
    url: location.href,
    title: document.title || m('meta[property="og:title"]'),
    description: m('meta[name="description"]') || m('meta[property="og:description"]'),
    canonical: m('link[rel="canonical"]', 'href'),
    favicon: (function(){ var e = document.querySelector('link[rel~="icon"]'); return e ? e.href : location.origin + '/favicon.ico'; })(),
    lang: document.documentElement.getAttribute('lang') || '',
    og: {}, jsonLdTypes: []
  };
  var props = ['og:title','og:description','og:image','og:type','og:site_name','og:url','article:published_time','article:modified_time','twitter:card','twitter:site'];
  for (var i = 0; i < props.length; i++) {
    var v = m('meta[property="' + props[i] + '"]') || m('meta[name="' + props[i] + '"]');
    if (v) out.og[props[i]] = v.slice(0, 300);
  }
  var scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (var s = 0; s < scripts.length && s < 10; s++) {
    try {
      var j = JSON.parse(scripts[s].textContent);
      var arr = Array.isArray(j) ? j : (j['@graph'] || [j]);
      for (var k = 0; k < arr.length; k++) { var t = arr[k] && arr[k]['@type']; if (t) out.jsonLdTypes.push(String(t)); }
    } catch (e) {}
  }
  return out;
}

function __lp_images(max) {
  var out = []; var seen = {};
  var og = document.querySelector('meta[property="og:image"]');
  if (og && og.content) { out.push({ url: og.content, alt: '(og:image)' }); seen[og.content] = 1; }
  var imgs = document.querySelectorAll('img[src]');
  for (var i = 0; i < imgs.length && out.length < max; i++) {
    var el = imgs[i]; var u = el.currentSrc || el.src;
    if (!u || seen[u] || !/^https?:/.test(u)) continue;
    if ((el.naturalWidth || 0) > 0 && (el.naturalWidth < 48 || el.naturalHeight < 48)) continue; // skip icons/trackers
    seen[u] = 1;
    out.push({ url: u.slice(0, 400), alt: (el.getAttribute('alt') || '').trim().slice(0, 120), w: el.naturalWidth || null, h: el.naturalHeight || null });
  }
  return out;
}

function __lp_product() {
  function num(x) { var n = parseFloat(String(x).replace(/[^\d.,-]/g, '').replace(',', '.')); return isNaN(n) ? null : n; }
  function fromOffer(p, of) {
    if (!of) return;
    var o = Array.isArray(of) ? of[0] : of;
    if (!o) return;
    if (o.price != null) p.price = num(o.price);
    if (o.lowPrice != null) p.price = num(o.lowPrice);
    if (o.priceCurrency) p.currency = o.priceCurrency;
    if (o.availability) p.availability = String(o.availability).replace(/^https?:\/\/schema\.org\//, '');
  }
  // 1) JSON-LD (the strong signal)
  var scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (var s = 0; s < scripts.length && s < 10; s++) {
    try {
      var j = JSON.parse(scripts[s].textContent);
      var arr = Array.isArray(j) ? j : (j['@graph'] || [j]);
      for (var k = 0; k < arr.length; k++) {
        var n = arr[k];
        if (!n || String(n['@type']).toLowerCase().indexOf('product') === -1) continue;
        var p = { found: true, source: 'json-ld', name: (n.name || '').slice(0, 200) };
        if (n.brand) p.brand = String(n.brand.name || n.brand).slice(0, 100);
        if (n.sku) p.sku = String(n.sku).slice(0, 60);
        if (n.image) p.image = String(Array.isArray(n.image) ? n.image[0] : (n.image.url || n.image)).slice(0, 400);
        fromOffer(p, n.offers);
        if (n.aggregateRating) { p.rating = num(n.aggregateRating.ratingValue); p.ratingCount = num(n.aggregateRating.reviewCount || n.aggregateRating.ratingCount); }
        if (p.name) return p;
      }
    } catch (e) {}
  }
  // 2) microdata
  var scope = document.querySelector('[itemtype*="schema.org/Product"]');
  if (scope) {
    function ip(name, attr) { var e = scope.querySelector('[itemprop="' + name + '"]'); return e ? (e.getAttribute(attr || 'content') || e.textContent || '').trim() : ''; }
    var p2 = { found: true, source: 'microdata', name: ip('name').slice(0, 200) };
    var pr = ip('price') || ip('lowPrice'); if (pr) p2.price = num(pr);
    var cu = ip('priceCurrency'); if (cu) p2.currency = cu;
    var av = ip('availability', 'href') || ip('availability'); if (av) p2.availability = av.replace(/^https?:\/\/schema\.org\//, '');
    if (p2.name) return p2;
  }
  // 3) OpenGraph product tags
  function m(sel) { var e = document.querySelector(sel); return e ? (e.getAttribute('content') || '').trim() : ''; }
  var amt = m('meta[property="product:price:amount"]') || m('meta[property="og:price:amount"]');
  if (amt) {
    return {
      found: true, source: 'og',
      name: (m('meta[property="og:title"]') || document.title).slice(0, 200),
      price: num(amt),
      currency: m('meta[property="product:price:currency"]') || m('meta[property="og:price:currency"]') || null,
    };
  }
  return { found: false, reason: 'page declares no Product (JSON-LD / microdata / og:price)' };
}
/* eslint-enable */

async function meta(page) { return page.eval(`(${__lp_meta.toString()})()`); }
async function images(page, { max = 40 } = {}) { return page.eval(`(${__lp_images.toString()})(${Math.max(1, Math.min(Number(max) || 40, 100))})`); }
async function product(page) { return page.eval(`(${__lp_product.toString()})()`); }

module.exports = { meta, images, product };
