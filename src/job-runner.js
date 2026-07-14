#!/usr/bin/env node
'use strict';

/**
 * job-runner.js — Detached executor for batch jobs (spawned by src/jobs.js).
 * Usage (internal): node src/job-runner.js <jobId>
 * Reads the job file, runs fanout/crawl with progress written back (throttled),
 * stores the final result, and exits. Never touches stdout (parent detached).
 */

const { readJob, writeJob } = require('./jobs');

async function main() {
  const id = process.argv[2];
  const job = id && readJob(id);
  if (!job) process.exit(1);

  job.status = 'running';
  writeJob(job);

  let lastFlush = 0;
  const tick = () => {
    const now = Date.now();
    if (now - lastFlush > 700) { lastFlush = now; writeJob(job); }
  };

  try {
    if (job.kind === 'fanout') {
      const { fanout } = require('./fanout');
      const p = job.params || {};
      job.progress.total = Array.isArray(p.urls) ? p.urls.length : null;
      const r = await fanout({ ...p, onEvent: (ev) => { if (ev.type === 'done') { job.progress.done++; tick(); } } });
      job.result = r;
    } else if (job.kind === 'crawl') {
      const crawler = require('./crawl');
      const p = job.params || {};
      job.progress.total = Math.min(Number(p.limit) || 15, 100);
      const r = await crawler.crawl({ ...p, onEvent: (ev) => { if (ev.type === 'done') { job.progress.done++; tick(); } } });
      job.result = r;
    } else {
      throw new Error('unknown kind: ' + job.kind);
    }
    job.status = 'done';
  } catch (e) {
    job.status = 'failed';
    job.error = (e && e.message) || String(e);
  }
  job.finishedAt = new Date().toISOString();
  writeJob(job);
  process.exit(0);
}

main().catch(() => process.exit(1));
