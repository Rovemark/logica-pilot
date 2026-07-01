'use strict';

/**
 * downloads-store.js — Downloads registry (parity with the browser).
 *
 * Maintains:
 *  - a Map in memory id → DownloadItem (from Electron) for ACTIONS (cancel/pause/resume),
 *  - a serializable list (records) persisted in userData/downloads.json for the UI.
 *
 * The webview-manager binds session.on('will-download'); this module handles the state.
 * Receives `shell` via injection (init) to open/show files without importing Electron
 * directly here (keeps the module testable).
 */

const fs = require('fs');
const path = require('path');

let filePath = null;
let shellRef = null;

/** id → { record, item }  (item = live DownloadItem; may disappear after completion) */
const items = new Map();
/** list of persistable records (most recent first) */
let records = [];
let seq = 0;
let writeTimer = null;

/** Initializes store: user data directory + reference to Electron `shell`. */
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
 * Registers a new Electron DownloadItem and returns the record + emission callback.
 * `emit(eventPayload)` is provided by the caller to send 'downloads:event' to the renderer.
 */
function register(item, emit) {
  const id = `dl_${Date.now()}_${++seq}`;
  const record = {
    id,
    filename: item.getFilename(),
    url: item.getURL(),
    savePath: '', // set in did-set-save-path / on startup
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
      // renderer may have gone away — ignore
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

  // save path (Electron sets it right after will-download)
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
    // keeps the record in the list; releases only the live item reference
    const slot = items.get(id);
    if (slot) slot.item = null;
  });

  return record;
}

function trimRecords() {
  const MAX = 500;
  if (records.length > MAX) records = records.slice(0, MAX);
}

/** Snapshot of the list (copy) for 'downloads:list'. */
function list() {
  return records.map((r) => ({ ...r }));
}

/**
 * Executes an action on a download:
 *  cancel | pause | resume → operates on the live DownloadItem
 *  open                    → shell.openPath(savePath)
 *  showInFolder            → shell.showItemInFolder(savePath)
 * Returns success bool.
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
    // ignore disk failure
  }
}

module.exports = { init, register, list, action, flush };
