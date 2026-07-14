'use strict';

/**
 * cdp-ws.js — Chrome DevTools Protocol client over WEBSOCKET (feature #7: attach).
 *
 * The pipe transport (cdp-pipe.js) drives a browser WE launched. To ATTACH to an
 * already-running Chrome/Edge/Brave (or our own desktop app) — with the user's
 * real profile, logins and extensions — we speak CDP over the debug WebSocket the
 * browser exposes at http://host:port. Still zero-dependency: a minimal RFC-6455
 * client (handshake + masked frames + fragmentation) over a raw TCP socket.
 *
 * Exposes the SAME interface as CDPConnection (send/on/off/close), so Page works
 * unchanged over either transport.
 */

const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

function httpGetJSON(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('bad JSON from ' + url)); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout ' + url)));
    req.on('error', reject);
  });
}

class CDPWebSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.setMaxListeners(0);
    this._sock = socket;
    this._id = 0;
    this._pending = new Map();
    this._closed = false;
    this._buf = Buffer.alloc(0);
    this._fragOp = 0;
    this._fragChunks = [];
    socket.on('data', (d) => this._onData(d));
    socket.on('error', (e) => this._fail(e));
    socket.on('close', () => this._fail(new Error('websocket closed')));
  }

  /** Open a WS connection to a CDP debugger URL (ws://host:port/…). */
  static connect(wsUrl) {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(Number(u.port) || 80, u.hostname);
    return new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.write(
          `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let acc = Buffer.alloc(0);
      const onData = (d) => {
        acc = Buffer.concat([acc, d]);
        const sep = acc.indexOf('\r\n\r\n');
        if (sep === -1) return;
        const head = acc.slice(0, sep).toString('utf8');
        socket.removeListener('data', onData);
        socket.removeListener('error', reject);
        if (!/HTTP\/1\.1 101/i.test(head)) return reject(new Error('WS handshake failed: ' + head.split('\r\n')[0]));
        const conn = new CDPWebSocket(socket);
        const rest = acc.slice(sep + 4);
        if (rest.length) conn._onData(rest); // any frame bytes riding with the handshake
        resolve(conn);
      };
      socket.on('data', onData);
    });
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    for (;;) {
      if (this._buf.length < 2) return;
      const b0 = this._buf[0], b1 = this._buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this._buf.length < off + 2) return; len = this._buf.readUInt16BE(off); off += 2; }
      else if (len === 127) { if (this._buf.length < off + 8) return; len = Number(this._buf.readBigUInt64BE(off)); off += 8; }
      const maskKey = masked ? this._buf.slice(off, off + 4) : null;
      if (masked) off += 4;
      if (this._buf.length < off + len) return;
      let payload = this._buf.slice(off, off + len);
      if (masked) { const out = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3]; payload = out; }
      this._buf = this._buf.slice(off + len);
      this._handleFrame(fin, opcode, payload);
    }
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === 0x8) { this._fail(new Error('websocket close frame')); return; }
    if (opcode === 0x9) { this._sendFrame(0xA, payload); return; }
    if (opcode === 0xA) return;
    if (opcode === 0x0) { this._fragChunks.push(payload); }        // continuation
    else { this._fragOp = opcode; this._fragChunks = [payload]; }  // new message
    if (!fin) return;
    const op = this._fragOp;
    const full = Buffer.concat(this._fragChunks);
    this._fragOp = 0; this._fragChunks = [];
    if (op !== 0x1) return; // only text carries CDP JSON
    let msg; try { msg = JSON.parse(full.toString('utf8')); } catch { return; }
    this._dispatch(msg);
  }

  _dispatch(msg) {
    if (msg.id !== undefined && this._pending.has(msg.id)) {
      const cb = this._pending.get(msg.id); this._pending.delete(msg.id);
      if (msg.error) cb.reject(new Error(`${cb.method} → ${msg.error.message || JSON.stringify(msg.error)}`));
      else cb.resolve(msg.result);
      return;
    }
    if (msg.method) { this.emit('event', msg); this.emit(msg.method, msg.params || {}, msg.sessionId); }
  }

  _sendFrame(opcode, payload) {
    if (this._closed && opcode !== 0x8) return;
    const len = payload.length;
    let header;
    const mask = crypto.randomBytes(4);
    if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
    else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    header[0] = 0x80 | opcode;
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    try { this._sock.write(Buffer.concat([header, mask, masked])); } catch (e) { this._fail(e); }
  }

  send(method, params = {}, sessionId) {
    if (this._closed) return Promise.reject(new Error('CDP ws closed'));
    const id = ++this._id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, method });
      this._sendFrame(0x1, Buffer.from(JSON.stringify(payload), 'utf8'));
    });
  }

  _fail(err) {
    if (this._closed) return;
    this._closed = true;
    for (const cb of this._pending.values()) cb.reject(err);
    this._pending.clear();
    try { this._sock.destroy(); } catch {}
    this.emit('disconnected', err);
  }

  close() { if (!this._closed) { try { this._sendFrame(0x8, Buffer.alloc(0)); } catch {} this._fail(new Error('closed by client')); } }
  get closed() { return this._closed; }
}

module.exports = { CDPWebSocket, httpGetJSON };
