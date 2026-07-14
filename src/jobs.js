'use strict';

/**
 * jobs.js — Async batch jobs for Logica Pilot (local, 0-dep).
 *
 * Firecrawl-style async ergonomics without the cloud: `batch` starts a job and
 * returns an id immediately; a DETACHED runner process executes it (fanout or
 * crawl) and streams progress into the job file; `status`/`get` read it back.
 *
 * Job files live in ~/.logica-pilot/jobs/<id>.json:
 *   { id, kind, params, status: queued|running|done|failed,
 *     progress: {done,total}, startedAt, finishedAt, error?, result? }
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const JOBS_DIR = path.join(os.homedir(), '.logica-pilot', 'jobs');

function jobPath(id) { return path.join(JOBS_DIR, String(id).replace(/[^a-z0-9_-]/gi, '') + '.json'); }

function readJob(id) {
  try { return JSON.parse(fs.readFileSync(jobPath(id), 'utf8')); } catch { return null; }
}

function writeJob(job) {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.writeFileSync(jobPath(job.id), JSON.stringify(job));
}

/** Create the job file and spawn the detached runner. Returns the job id. */
function start(kind, params) {
  if (kind !== 'fanout' && kind !== 'crawl') throw new Error("batch: kind must be 'fanout' or 'crawl'");
  const id = Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  writeJob({ id, kind, params, status: 'queued', progress: { done: 0, total: null }, startedAt: new Date().toISOString() });
  const child = spawn(process.execPath, [path.join(__dirname, 'job-runner.js'), id], {
    detached: true, stdio: 'ignore', env: process.env,
  });
  child.unref();
  return id;
}

function list(limit = 20) {
  try {
    return fs.readdirSync(JOBS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), 'utf8')); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .slice(0, limit)
      .map((j) => ({ id: j.id, kind: j.kind, status: j.status, progress: j.progress, startedAt: j.startedAt, finishedAt: j.finishedAt || null }));
  } catch { return []; }
}

module.exports = { start, readJob, writeJob, list, JOBS_DIR };
