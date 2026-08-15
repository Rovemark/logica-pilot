'use strict';

/**
 * ws-bridge.js — A ponte do Copiloto (páginas chrome:// do Logica Pilot) com o motor.
 *
 * POR QUE EXISTE: uma página `chrome://` NÃO pode fazer `fetch('http://…')` — o
 * `web_ui_url_loader_factory` responde "Bad scheme: http" e o Chromium MATA o
 * renderer (RESULT_CODE_KILLED_BAD_MESSAGE). WebSocket, porém, passa. Então o
 * painel fala `ws://127.0.0.1:PORT` e este servidor roteia pras mesmas 82 tools.
 *
 * Protocolo (JSON por frame de texto):
 *   →  { id, op: 'health' }
 *   →  { id, op: 'tool', name: 'ask', args: {...} }
 *   →  { id, op: 'agent', goal: '...', url?, match? }     (stream: eventos 'step')
 *   ←  { id, ok: true, data }  |  { id, ok:false, error } |  { id, event:'step', ... }
 *
 * Zero dependência: handshake + frames implementados aqui (server-side; o
 * cdp-ws.js é o lado cliente).
 */

const crypto = require('crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ── frames ────────────────────────────────────────────────────────────────────
function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x81; // FIN + texto
  return Buffer.concat([header, payload]);
}

/** Consome frames completos do buffer; devolve as mensagens de texto. */
function drainFrames(state) {
  const out = [];
  for (;;) {
    const buf = state.buf;
    if (buf.length < 2) break;
    const b0 = buf[0];
    const b1 = buf[1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) { if (buf.length < off + 2) break; len = buf.readUInt16BE(off); off += 2; }
    else if (len === 127) { if (buf.length < off + 8) break; len = Number(buf.readBigUInt64BE(off)); off += 8; }
    const maskKey = masked ? buf.slice(off, off + 4) : null;
    if (masked) off += 4;
    if (buf.length < off + len) break;
    let payload = buf.slice(off, off + len);
    if (masked) {
      const dec = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) dec[i] = payload[i] ^ maskKey[i & 3];
      payload = dec;
    }
    state.buf = buf.slice(off + len);
    if (opcode === 0x8) { out.push({ close: true }); break; }
    if (opcode === 0x9) { out.push({ ping: payload }); continue; }
    if (opcode === 0x1 || opcode === 0x0) out.push({ text: payload.toString('utf8') });
  }
  return out;
}

// ── servidor ──────────────────────────────────────────────────────────────────
/**
 * Liga o upgrade de WebSocket num http.Server existente.
 * @param {http.Server} server
 * @param {{runTool: Function, runAgent?: Function, model?: string}} deps
 */
function attachWsBridge(server, deps = {}) {
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);

    const state = { buf: Buffer.alloc(0) };
    const send = (obj) => { try { socket.write(encodeFrame(JSON.stringify(obj))); } catch {} };

    socket.on('data', async (chunk) => {
      state.buf = Buffer.concat([state.buf, chunk]);
      for (const msg of drainFrames(state)) {
        if (msg.close) { try { socket.end(); } catch {} return; }
        if (msg.ping) { try { socket.write(Buffer.concat([Buffer.from([0x8a, msg.ping.length]), msg.ping])); } catch {} continue; }
        if (!msg.text) continue;
        let req_ = null;
        try { req_ = JSON.parse(msg.text); } catch { continue; }
        const id = req_.id;
        try {
          if (req_.op === 'health') {
            send({ id, ok: true, data: { ok: true, tools: deps.toolCount || 0, bridge: 'ws' } });
          } else if (req_.op === 'tool') {
            const r = await deps.runTool(req_.name, req_.args || {}, { model: deps.model });
            if (r && r.error) send({ id, ok: false, error: r.error });
            else send({ id, ok: true, data: r && r.out !== undefined ? r.out : r });
          } else if (req_.op === 'agent' && deps.runAgent) {
            const r = await deps.runAgent({
              goal: req_.goal, url: req_.url, match: req_.match, model: deps.model,
              onStep: (s) => send({ id, event: 'step', step: s }),
            });
            if (r && r.error) send({ id, ok: false, error: r.error });
            else send({ id, ok: true, data: r && r.out ? r.out.json : r });
          } else {
            send({ id, ok: false, error: 'op desconhecida: ' + req_.op });
          }
        } catch (e) {
          send({ id, ok: false, error: e.message });
        }
      }
    });
    socket.on('error', () => { try { socket.destroy(); } catch {} });
  });
  return server;
}

module.exports = { attachWsBridge, encodeFrame, drainFrames };
