'use strict';

/**
 * browser-pool.js — Managed pool of browser instances (Apify browser-pool). A single
 * long-lived Chromium accumulates memory/handle leaks across a big crawl; this rotates
 * across N browsers, caps open pages per browser, and RETIRES a browser after it has
 * served `retireAfterPageCount` pages (drain, then close) — the core defense against
 * the leak that kills long crawls.
 *
 *   const pool = new BrowserPool({ maxBrowsers: 4, retireAfterPageCount: 100 });
 *   const { page, release } = await pool.acquirePage();
 *   try { … } finally { await release(); }
 *   await pool.close();
 *
 * Zero-dependency (wraps Browser.launch).
 */

const { Browser } = require('./browser');

class BrowserPool {
  constructor({ maxBrowsers = 4, maxOpenPagesPerBrowser = 8, retireAfterPageCount = 100, launchOpts = {} } = {}) {
    this.maxBrowsers = maxBrowsers;
    this.maxOpenPagesPerBrowser = maxOpenPagesPerBrowser;
    this.retireAfterPageCount = retireAfterPageCount;
    this.launchOpts = { headless: true, ...launchOpts };
    this.slots = []; // { browser, open, opened, state }
    this._spawned = 0;
  }

  async _spawn() {
    const browser = await Browser.launch(this.launchOpts);
    const slot = { browser, open: 0, opened: 0, state: 'active' };
    this.slots.push(slot);
    this._spawned++;
    return slot;
  }

  async _reap() {
    for (const slot of [...this.slots]) {
      if (slot.state === 'retiring' && slot.open === 0) {
        try { await slot.browser.close(); } catch {}
        this.slots.splice(this.slots.indexOf(slot), 1);
      }
    }
  }

  /** Acquire a page from the pool; call release() when done. */
  async acquirePage() {
    await this._reap();
    // Prefer an active browser with capacity.
    let slot = this.slots.find((s) => s.state === 'active' && s.open < this.maxOpenPagesPerBrowser && s.opened < this.retireAfterPageCount);
    if (!slot && this.slots.filter((s) => s.state === 'active').length < this.maxBrowsers) slot = await this._spawn();
    if (!slot) slot = this.slots.filter((s) => s.state === 'active').sort((a, b) => a.open - b.open)[0] || await this._spawn();

    const page = await slot.browser.newPage();
    slot.open++; slot.opened++;
    if (slot.opened >= this.retireAfterPageCount) slot.state = 'retiring';

    const release = async () => {
      slot.open = Math.max(0, slot.open - 1);
      try { await page.close(); } catch {}
      if (slot.state === 'retiring' && slot.open === 0) await this._reap();
    };
    return { page, release, browser: slot.browser };
  }

  stats() {
    return { browsers: this.slots.length, spawnedTotal: this._spawned, active: this.slots.filter((s) => s.state === 'active').length, retiring: this.slots.filter((s) => s.state === 'retiring').length, openPages: this.slots.reduce((a, s) => a + s.open, 0), pagesServed: this.slots.reduce((a, s) => a + s.opened, 0) };
  }

  async close() {
    for (const slot of this.slots) { try { await slot.browser.close(); } catch {} }
    this.slots = [];
  }
}

module.exports = { BrowserPool };
