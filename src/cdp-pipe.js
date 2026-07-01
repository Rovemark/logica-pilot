'use strict';

/**
 * cdp-pipe.js — Chrome DevTools Protocol (CDP) client over PIPE.
 *
 * Why pipe and not WebSocket?
 *  - Node 20 has no native WebSocket and we do NOT want to depend on `ws`
 *    or Playwright/Puppeteer. The `--remote-debugging-pipe` transport
 *    talks directly to the browser via two file descriptors (fd 3 = write,
 *    fd 4 = read), with JSON messages terminated by \0. Zero dependencies.
 *
 * This is the foundation of Logica Pilot: we control the engine, not a third-party lib.
 */

const { EventEmitter } = require('events');

class CDPConnection extends EventEmitter {
  /**
   * @param {import('stream').Writable} writable  pipe that the browser READS from (fd 3)
   * @param {import('stream').Readable} readable  pipe that the browser WRITES to (fd 4)
   */
  constructor(writable, readable) {
    super();
    this.setMaxListeners(0);
    this._w = writable;
    this._r = readable;
    this._id = 0;
    this._pending = new Map(); // id -> { resolve, reject, method }
    this._buf = Buffer.alloc(0);
    this._closed = false;

    this._r.on('data', (chunk) => this._onData(chunk));
    this._r.on('end', () => this._fail(new Error('CDP pipe closed (end)')));
    this._r.on('close', () => this._fail(new Error('CDP pipe closed')));
    this._r.on('error', (e) => this._fail(e));
    this._w.on('error', (e) => this._fail(e));
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    let idx;
    while ((idx = this._buf.indexOf(0)) !== -1) {
      const raw = this._buf.subarray(0, idx);
      this._buf = this._buf.subarray(idx + 1);
      if (raw.length === 0) continue;
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        continue; // corrupted message — ignore
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // Response to a command
    if (msg.id !== undefined && this._pending.has(msg.id)) {
      const cb = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) {
        cb.reject(new Error(`${cb.method} → ${msg.error.message || JSON.stringify(msg.error)}`));
      } else {
        cb.resolve(msg.result);
      }
      return;
    }
    // Event (with or without sessionId — flat model)
    if (msg.method) {
      this.emit('event', msg);
      this.emit(msg.method, msg.params || {}, msg.sessionId);
    }
  }

  /**
   * Sends a CDP command. Returns Promise with the `result`.
   * @param {string} method  e.g. "Page.navigate"
   * @param {object} params
   * @param {string} [sessionId]  target (page) in flat model
   */
  send(method, params = {}, sessionId) {
    if (this._closed) return Promise.reject(new Error('CDP connection closed'));
    const id = ++this._id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const data = JSON.stringify(payload) + '\0';
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, method });
      this._w.write(data, (err) => {
        if (err) {
          this._pending.delete(id);
          reject(err);
        }
      });
    });
  }

  _fail(err) {
    if (this._closed) return;
    this._closed = true;
    for (const cb of this._pending.values()) cb.reject(err);
    this._pending.clear();
    this.emit('disconnected', err);
  }

  close() {
    this._fail(new Error('CDP closed by client'));
  }

  get closed() {
    return this._closed;
  }
}

module.exports = { CDPConnection };
