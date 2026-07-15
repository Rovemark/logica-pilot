'use strict';

/**
 * proxy-server.js — Local forwarding proxy (Apify proxy-chain). Fixes Chromium's
 * hard limitation: --proxy-server can't carry credentials and can't rotate without
 * relaunching. We run a tiny local proxy that Chromium points at (no creds), and it
 * forwards each connection to an upstream proxy — injecting Proxy-Authorization and
 * (optionally) picking a DIFFERENT upstream per connection from a proxypool, so ONE
 * long-lived browser gets per-request exit-IP rotation.
 *
 *   const { url } = await startProxy({ pool: 'webshare', strategy: 'round-robin' });
 *   // launch the browser with proxy = url  (http://127.0.0.1:PORT)
 *
 * Handles both plain HTTP (absolute-URI) and HTTPS (CONNECT tunnel). Zero-dependency
 * (net only). Auth to the LOCAL proxy is not required (loopback).
 */

const net = require('net');
const proxyPool = require('./proxy-pool');

function parseUpstream(p) {
  if (!p) return null;
  let s = String(p).replace(/^https?:\/\//, '');
  let auth = null;
  const at = s.lastIndexOf('@');
  if (at >= 0) { auth = s.slice(0, at); s = s.slice(at + 1); }
  const [host, port] = s.split(':');
  return { host, port: Number(port) || 8080, auth };
}

function authHeader(up) {
  return up && up.auth ? 'Proxy-Authorization: Basic ' + Buffer.from(up.auth).toString('base64') + '\r\n' : '';
}

// Relay a CONNECT (HTTPS) tunnel: client → [upstream proxy →] target.
function relayConnect(client, target, up) {
  const [host, port] = target.split(':');
  if (up) {
    const usock = net.connect({ host: up.host, port: up.port }, () => {
      usock.write(`CONNECT ${host}:${port || 443} HTTP/1.1\r\nHost: ${host}:${port || 443}\r\n${authHeader(up)}\r\n`);
    });
    let established = false;
    usock.once('data', (d) => {
      if (/^HTTP\/1\.[01] 200/.test(d.toString('utf8', 0, 20))) {
        established = true;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        usock.pipe(client); client.pipe(usock);
      } else { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); usock.destroy(); }
    });
    usock.on('error', () => { if (!established) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
    client.on('error', () => usock.destroy());
  } else {
    const tsock = net.connect({ host, port: Number(port) || 443 }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      tsock.pipe(client); client.pipe(tsock);
    });
    tsock.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    client.on('error', () => tsock.destroy());
  }
}

// Relay a plain HTTP request (absolute-URI from the browser).
function relayHttp(client, firstChunk, requestLine, up) {
  const m = requestLine.match(/^(\S+)\s+(\S+)\s+(HTTP\/\d\.\d)/);
  if (!m) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
  const [, method, absUrl, ver] = m;
  let u; try { u = new URL(absUrl); } catch { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
  const port = Number(u.port) || 80;
  if (up) {
    // Forward to upstream proxy as absolute-URI + Proxy-Authorization.
    const usock = net.connect({ host: up.host, port: up.port }, () => {
      // Inject Proxy-Authorization right after the request line (keep absolute-URI).
      const head = firstChunk.toString('binary').replace(/(\r\n)/, `$1${authHeader(up)}`);
      usock.write(Buffer.from(head, 'binary'));
      usock.pipe(client); client.pipe(usock);
    });
    usock.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    client.on('error', () => usock.destroy());
  } else {
    // Direct: rewrite absolute-URI → origin-form (path only); Host header already present.
    const tsock = net.connect({ host: u.hostname, port }, () => {
      const rewritten = firstChunk.toString('binary').replace(requestLine, `${method} ${u.pathname}${u.search} ${ver}`);
      tsock.write(Buffer.from(rewritten, 'binary'));
      tsock.pipe(client); client.pipe(tsock);
    });
    tsock.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    client.on('error', () => tsock.destroy());
  }
}

/**
 * Start a local forwarding proxy.
 * @param {object} opts { port, upstream (fixed proxy str), pool (proxypool name),
 *                        strategy, session (sticky) }
 * @returns {{server, port, url, pick()}}
 */
function startProxy({ port = 0, upstream = null, pool = null, strategy, session } = {}) {
  let counter = 0;
  const pick = () => {
    if (pool) { const p = proxyPool.pick(pool, { session, strategy }); return p ? parseUpstream(p) : null; }
    return parseUpstream(upstream);
  };
  const server = net.createServer((client) => {
    client.once('data', (chunk) => {
      const idx = chunk.indexOf(0x0a); // first \n
      const firstLine = chunk.toString('utf8', 0, idx > 0 ? idx : Math.min(chunk.length, 256)).trim();
      const up = pick();
      counter++;
      if (/^CONNECT\s/i.test(firstLine)) {
        const target = firstLine.split(/\s+/)[1];
        relayConnect(client, target, up);
      } else {
        relayHttp(client, chunk, firstLine, up);
      }
    });
    client.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port, url: `http://127.0.0.1:${addr.port}`, connections: () => counter });
    });
  });
}

module.exports = { startProxy, parseUpstream };
