'use strict';

/**
 * downloads-store.js — Registro de downloads (paridade Chrome).
 *
 * Mantém:
 *  - um Map em memória id → DownloadItem (do Electron) para AÇÕES (cancel/pause/resume),
 *  - uma lista serializável (records) persistida em userData/downloads.json para a UI.
 *
 * O webview-manager liga o session.on('will-download'); este módulo cuida do estado.
 * Recebe `shell` por injeção (init) para abrir/mostrar arquivos sem importar Electron
 * diretamente aqui (mantém o módulo testável).
 */

const fs = require('fs');
const path = require('path');

let filePath = null;
let shellRef = null;

/** id → { record, item }  (item = DownloadItem vivo; pode sumir ao concluir) */
const items = new Map();
/** lista de records persistível (mais recente primeiro) */
let records = [];
let seq = 0;
let writeTimer = null;

/** Inicializa store: diretório do usuário + referência ao `shell` do Electron. */
function init(userDataDir, shell) {
  filePath = path.join(userDataDir, 'downloads.json');
  shellRef = shell || null;
  load();
}

function load() {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) records = arr.filter((r) => r && r.id);
  } catch {
    records = [];
  }
}

/**
 * Registra um novo DownloadItem do Electron e devolve o record + callback de emissão.
 * `emit(eventPayload)` é fornecido pelo caller para mandar 'downloads:event' ao renderer.
 */
function register(item, emit) {
  const id = `dl_${Date.now()}_${++seq}`;
  const record = {
    id,
    filename: item.getFilename(),
    url: item.getURL(),
    savePath: '', // definido em did-set-save-path / no início
    state: 'started',
    receivedBytes: 0,
    totalBytes: item.getTotalBytes(),
    startTime: Date.now(),
  };
  records.unshift(record);
  trimRecords();
  items.set(id, { record, item });
  scheduleWrite();

  const safeEmit = (payload) => {
    try {
      if (typeof emit === 'function') emit(payload);
    } catch {
      // renderer pode ter ido embora — ignorar
    }
  };

  safeEmit({
    id,
    state: 'started',
    filename: record.filename,
    receivedBytes: 0,
    totalBytes: record.totalBytes,
    savePath: record.savePath,
  });

  // caminho de salvamento (Electron define logo após will-download)
  try {
    record.savePath = item.getSavePath() || record.savePath;
  } catch {}

  item.on('updated', (_e, state) => {
    record.receivedBytes = item.getReceivedBytes();
    record.totalBytes = item.getTotalBytes();
    record.savePath = item.getSavePath() || record.savePath;
    record.state = state === 'interrupted' ? 'interrupted' : 'progress';
    scheduleWrite();
    safeEmit({
      id,
      state: record.state,
      filename: record.filename,
      receivedBytes: record.receivedBytes,
      totalBytes: record.totalBytes,
      savePath: record.savePath,
    });
  });

  item.once('done', (_e, state) => {
    record.receivedBytes = item.getReceivedBytes();
    record.savePath = item.getSavePath() || record.savePath;
    // 'completed' | 'cancelled' | 'interrupted'
    record.state = state;
    scheduleWrite();
    safeEmit({
      id,
      state,
      filename: record.filename,
      receivedBytes: record.receivedBytes,
      totalBytes: record.totalBytes,
      savePath: record.savePath,
    });
    // mantém o record na lista; solta só a referência do item vivo
    const slot = items.get(id);
    if (slot) slot.item = null;
  });

  return record;
}

function trimRecords() {
  const MAX = 500;
  if (records.length > MAX) records = records.slice(0, MAX);
}

/** Snapshot da lista (cópia) para 'downloads:list'. */
function list() {
  return records.map((r) => ({ ...r }));
}

/**
 * Executa uma ação num download:
 *  cancel | pause | resume → opera no DownloadItem vivo
 *  open                    → shell.openPath(savePath)
 *  showInFolder            → shell.showItemInFolder(savePath)
 * Retorna bool de sucesso.
 */
function action(id, act) {
  const slot = items.get(id);
  const record = slot ? slot.record : records.find((r) => r.id === id);
  if (!record) return false;

  const item = slot ? slot.item : null;

  try {
    switch (act) {
      case 'cancel':
        if (item) { item.cancel(); return true; }
        return false;
      case 'pause':
        if (item && !item.isPaused()) { item.pause(); return true; }
        return false;
      case 'resume':
        if (item && item.canResume()) { item.resume(); return true; }
        return false;
      case 'open':
        if (shellRef && record.savePath) { shellRef.openPath(record.savePath); return true; }
        return false;
      case 'showInFolder':
        if (shellRef && record.savePath) { shellRef.showItemInFolder(record.savePath); return true; }
        return false;
      default:
        return false;
    }
  } catch {
    return false;
  }
}

function scheduleWrite() {
  if (!filePath) return;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 400);
  if (writeTimer.unref) writeTimer.unref();
}

function flush() {
  if (!filePath) return;
  try {
    fs.writeFileSync(filePath, JSON.stringify(records), 'utf8');
  } catch {
    // ignora falha de disco
  }
}

module.exports = { init, register, list, action, flush };
