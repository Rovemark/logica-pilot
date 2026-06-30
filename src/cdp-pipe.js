'use strict';

/**
 * cdp-pipe.js — Cliente do Chrome DevTools Protocol (CDP) sobre PIPE.
 *
 * Por que pipe e não WebSocket?
 *  - Node 20 não tem WebSocket nativo e a gente NÃO quer depender de `ws`
 *    nem de Playwright/Puppeteer. O transporte `--remote-debugging-pipe`
 *    fala direto com o browser por dois file descriptors (fd 3 = escrita,
 *    fd 4 = leitura), com mensagens JSON terminadas por \0. Zero dependência.
 *
 * Esta é a fundação do Logica Pilot: controlamos o engine, não uma lib de terceiro.
 */

const { EventEmitter } = require('events');

class CDPConnection extends EventEmitter {
  /**
   * @param {import('stream').Writable} writable  pipe que o browser LÊ (fd 3)
   * @param {import('stream').Readable} readable  pipe que o browser ESCREVE (fd 4)
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
    this._r.on('end', () => this._fail(new Error('CDP pipe encerrado (end)')));
    this._r.on('close', () => this._fail(new Error('CDP pipe fechado')));
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
        continue; // mensagem corrompida — ignora
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // Resposta a um comando
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
    // Evento (com ou sem sessionId — modelo flat)
    if (msg.method) {
      this.emit('event', msg);
      this.emit(msg.method, msg.params || {}, msg.sessionId);
    }
  }

  /**
   * Envia um comando CDP. Retorna Promise com o `result`.
   * @param {string} method  ex: "Page.navigate"
   * @param {object} params
   * @param {string} [sessionId]  alvo (página) no modelo flat
   */
  send(method, params = {}, sessionId) {
    if (this._closed) return Promise.reject(new Error('CDP conexão fechada'));
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
    this._fail(new Error('CDP fechado pelo cliente'));
  }

  get closed() {
    return this._closed;
  }
}

module.exports = { CDPConnection };
