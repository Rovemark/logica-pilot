'use strict';

/**
 * autoscaling.js — Resource-aware dynamic concurrency (Apify AutoscaledPool). A fixed
 * worker count either underutilizes a big machine or OOMs on heavy browser tabs. This
 * samples memory, CPU, and event-loop lag and raises concurrency while there's headroom
 * and pending work, backing off under pressure.
 *
 *   const a = new Autoscaler({ min: 2, max: 16 });
 *   a.recommend(current, { pending })  // -> next concurrency
 *
 * Pure Node built-ins (os + perf_hooks). recommend() is a pure function of its inputs
 * (deterministically testable); sample() reads live metrics.
 */

const os = require('os');
let monitorEventLoopDelay;
try { ({ monitorEventLoopDelay } = require('perf_hooks')); } catch { monitorEventLoopDelay = null; }

class Autoscaler {
  constructor({ min = 1, max = 16, maxMemRatio = 0.85, maxEventLoopLagMs = 120, stepUp = 1, stepDown = 2 } = {}) {
    this.min = min; this.max = max;
    this.maxMemRatio = maxMemRatio; this.maxEventLoopLagMs = maxEventLoopLagMs;
    this.stepUp = stepUp; this.stepDown = stepDown;
    this._h = monitorEventLoopDelay ? monitorEventLoopDelay({ resolution: 20 }) : null;
    if (this._h) this._h.enable();
    this._lastCpu = process.cpuUsage();
    this._lastTs = Date.now();
  }

  /** Live resource sample. */
  sample() {
    const free = os.freemem(), total = os.totalmem();
    const memRatio = 1 - free / total;
    let lagMs = 0;
    if (this._h) { lagMs = this._h.mean / 1e6; this._h.reset(); }
    const cpu = process.cpuUsage(this._lastCpu);
    const dt = Math.max(1, Date.now() - this._lastTs);
    const cpuBusy = (cpu.user + cpu.system) / 1000 / dt; // ~cores-worth of busy
    this._lastCpu = process.cpuUsage(); this._lastTs = Date.now();
    return { memRatio, lagMs, cpuBusy };
  }

  /**
   * Recommend the next concurrency given the current level and a metrics snapshot.
   * @param {number} current
   * @param {object} m { memRatio, lagMs, pending }
   */
  recommend(current, m = {}) {
    const memRatio = m.memRatio != null ? m.memRatio : this.sample().memRatio;
    const lagMs = m.lagMs != null ? m.lagMs : 0;
    const pending = m.pending != null ? m.pending : 1;
    const underPressure = memRatio > this.maxMemRatio || lagMs > this.maxEventLoopLagMs;
    let next = current;
    if (underPressure) next = current - this.stepDown;
    else if (pending > current) next = current + this.stepUp; // headroom + work waiting
    return Math.max(this.min, Math.min(this.max, next));
  }

  stop() { if (this._h) this._h.disable(); }
}

module.exports = { Autoscaler };
