'use strict';

/**
 * index.js — Public API of Logica Pilot (headless / programmatic mode).
 *
 *   const { LogicaPilot } = require('logica-pilot');
 *   const pilot = await new LogicaPilot({ headless: true }).launch();
 *   const res = await pilot.run('search for the price of iPhone 15 on Google');
 *   console.log(res.result);
 *   await pilot.close();
 */

const { Browser, Page, resolveBrowserBinary } = require('./browser');
const perception = require('./perception');
const actions = require('./actions');
const agent = require('./agent');
const llm = require('./llm');

class LogicaPilot {
  constructor(opts = {}) {
    this.opts = opts;
    this.browser = null;
    this.page = null;
  }

  async launch() {
    this.browser = await Browser.launch({
      headless: this.opts.headless !== false,
      width: this.opts.width,
      height: this.opts.height,
      binary: this.opts.binary,
      extraArgs: this.opts.extraArgs,
    });
    this.page = await this.browser.newPage();
    if (this.opts.url) await this.page.goto(this.opts.url);
    return this;
  }

  goto(url) {
    return this.page.goto(url);
  }

  snapshot(o) {
    return perception.snapshot(this.page, o);
  }

  format(snap) {
    return perception.format(snap);
  }

  /** Runs the autonomous loop on the given objective. */
  run(objective, o = {}) {
    return agent.run(this.page, objective, { ...this.opts, ...o });
  }

  /** Raw actions (without AI), useful for deterministic scripts. */
  get actions() {
    const p = this.page;
    return {
      click: (i) => actions.click(p, i),
      type: (i, t, s) => actions.type(p, i, t, s),
      press: (k) => actions.pressKey(p, k),
      scroll: (d, a) => actions.scroll(p, d, a),
      extract: (q) => actions.extract(p, q),
      screenshot: (o2) => actions.screenshot(p, o2),
    };
  }

  async close() {
    if (this.browser) await this.browser.close();
    this.browser = null;
    this.page = null;
  }
}

module.exports = {
  LogicaPilot,
  Browser,
  Page,
  resolveBrowserBinary,
  perception,
  actions,
  agent,
  llm,
};
