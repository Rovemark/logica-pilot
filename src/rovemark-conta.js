'use strict';
// CONTA ROVEMARK — o login do navegador é o login da Rovemark.
//
// Por que passa pelo motor e não direto da página: uma página `chrome://` não
// pode `fetch('http://…')` (o Chromium mata o renderer), e mesmo em https o
// cookie de sessão não deve morar num WebUI. Quem fala com a plataforma é o
// motor; a página só pergunta a ele.
//
// Onde fica a API: `ROVEMARK_API` manda. O padrão é a plataforma local, que é
// onde `/api/auth/*` vive hoje — o site em rovemark.co ainda é institucional.
// No dia em que a API subir lá, é trocar a env, sem mexer em código.

const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = (process.env.ROVEMARK_API || 'http://127.0.0.1:5181').replace(/\/+$/, '');
const ARQUIVO = path.join(os.homedir(), '.logica-pilot', 'conta.json');

function guardar(dados) {
  fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
  // O cookie de sessão é credencial: 0600, como o env das chaves.
  fs.writeFileSync(ARQUIVO, JSON.stringify(dados, null, 2), { mode: 0o600 });
  try { fs.chmodSync(ARQUIVO, 0o600); } catch {}
}

function ler() {
  try { return JSON.parse(fs.readFileSync(ARQUIVO, 'utf8')); } catch { return null; }
}

function esquecer() {
  try { fs.unlinkSync(ARQUIVO); } catch {}
}

async function chamar(rota, { metodo = 'GET', corpo = null, cookie = null } = {}) {
  const cabecalhos = { 'content-type': 'application/json' };
  if (cookie) cabecalhos.cookie = cookie;
  const r = await fetch(BASE + rota, {
    method: metodo,
    headers: cabecalhos,
    body: corpo ? JSON.stringify(corpo) : undefined,
    redirect: 'manual',
  });
  let dados = null;
  try { dados = await r.json(); } catch {}
  return { status: r.status, dados, setCookie: r.headers.get('set-cookie') };
}

async function entrar({ email, senha }) {
  if (!email || !senha) return { ok: false, erro: 'Informe e-mail e senha.' };
  let r;
  try {
    r = await chamar('/api/auth/login', { metodo: 'POST', corpo: { email, senha } });
  } catch (e) {
    // Distinguir "plataforma fora do ar" de "senha errada" evita o usuário
    // ficar tentando a senha certa contra um servidor que nem respondeu.
    return { ok: false, erro: `Não alcancei a Rovemark em ${BASE} (${e.message}).` };
  }
  if (r.status !== 200 || !r.dados || !r.dados.ok) {
    return { ok: false, erro: (r.dados && r.dados.error) || `Falha no login (HTTP ${r.status}).` };
  }
  // Só o par nome=valor interessa; Path/HttpOnly/Max-Age são instruções pro
  // navegador, e quem guarda a sessão aqui é o motor.
  const cookie = String(r.setCookie || '').split(';')[0] || null;
  guardar({ base: BASE, cookie, usuario: r.dados.usuario, em: new Date().toISOString() });
  return { ok: true, usuario: r.dados.usuario };
}

async function status() {
  const s = ler();
  if (!s || !s.cookie) return { autenticado: false, base: BASE };
  try {
    const r = await chamar('/api/auth/eu', { cookie: s.cookie });
    if (r.status === 200 && r.dados && (r.dados.usuario || r.dados.autenticado)) {
      const usuario = r.dados.usuario || s.usuario;
      guardar({ ...s, usuario });
      return { autenticado: true, usuario, base: s.base || BASE };
    }
    // Sessão expirada ou revogada do outro lado: some daqui também.
    esquecer();
    return { autenticado: false, base: BASE };
  } catch (e) {
    // Sem rede não invalidamos a sessão — devolvemos o perfil guardado e
    // avisamos que está offline, senão um wi-fi ruim desloga o usuário.
    return { autenticado: true, offline: true, usuario: s.usuario, base: s.base || BASE };
  }
}

async function sair() {
  const s = ler();
  if (s && s.cookie) {
    try { await chamar('/api/auth/logout', { metodo: 'POST', cookie: s.cookie }); } catch {}
  }
  esquecer();
  return { ok: true };
}

module.exports = { entrar, sair, status, BASE };
