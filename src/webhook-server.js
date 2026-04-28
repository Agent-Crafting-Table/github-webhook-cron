#!/usr/bin/env node
/**
 * webhook-server.js — minimal HTTP wrapper around webhook-handler.js.
 *
 * Listens on PORT (default 7456) for POST /webhook. Reads the GitHub
 * X-GitHub-Event and X-Hub-Signature-256 headers + the raw body, then
 * spawns the handler with those as args + the body on stdin. Returns
 * the handler's stdout as the response.
 *
 * Health check on GET / and GET /healthz. Everything else 404s.
 *
 * Runs in foreground; meant to be wrapped in tmux / a restart-loop /
 * a docker service unit. No stdin/file-state — restart freely.
 *
 * Env:
 *   PORT                  — listen port (default 7456)
 *   GITHUB_WEBHOOK_SECRET — passed through to the handler so signatures
 *                           can be verified
 *   WORKSPACE_DIR         — passed through (controls trigger dir + routes path)
 *   ROUTES_FILE           — override path to routes.json
 *
 * Public exposure (tunnel/reverse-proxy) is the operator's job; this
 * server has no TLS and no auth other than the GitHub HMAC signature.
 */

'use strict';

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '7456', 10);
const HANDLER = path.join(__dirname, 'webhook-handler.js');
const WORKSPACE = process.env.WORKSPACE_DIR || process.cwd();
const ROUTES_FILE = process.env.ROUTES_FILE || '';

const server = http.createServer((req, res) => {
  // Health endpoints — for tunnel probes / monitoring.
  if (req.method === 'GET' && (req.url === '/' || req.url === '/healthz')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok\n');
    return;
  }

  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found\n');
    return;
  }

  const event = req.headers['x-github-event'];
  const signature = req.headers['x-hub-signature-256'];
  if (!event) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ action: 'rejected', reason: 'missing X-GitHub-Event header' }) + '\n');
    return;
  }

  // Buffer the request body so we can pipe it to the handler verbatim.
  // GitHub webhooks are small (well under 1MB); cap at 5MB defensively.
  const MAX_BYTES = 5 * 1024 * 1024;
  const chunks = [];
  let total = 0;
  let aborted = false;

  req.on('data', c => {
    total += c.length;
    if (total > MAX_BYTES) {
      aborted = true;
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ action: 'rejected', reason: 'payload too large' }) + '\n');
      req.destroy();
      return;
    }
    chunks.push(c);
  });

  req.on('end', () => {
    if (aborted) return;
    const body = Buffer.concat(chunks);

    const args = ['--event', event];
    if (signature) args.push('--signature', signature);
    if (ROUTES_FILE) args.push('--routes', ROUTES_FILE);

    const child = spawn('node', [HANDLER, ...args], {
      env: { ...process.env, WORKSPACE_DIR: WORKSPACE },
    });

    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });

    child.stdin.write(body);
    child.stdin.end();

    child.on('close', code => {
      const status = code === 0 ? 200 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(out || JSON.stringify({ action: 'rejected', reason: err.trim() || 'handler failed' }) + '\n');
      if (err.trim()) process.stderr.write(`[handler stderr] ${err.trim()}\n`);
    });

    child.on('error', e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ action: 'rejected', reason: `spawn failed: ${e.message}` }) + '\n');
    });
  });

  req.on('error', e => {
    process.stderr.write(`[req error] ${e.message}\n`);
  });
});

server.on('listening', () => {
  process.stderr.write(`webhook-server: listening on 0.0.0.0:${PORT} (handler: ${HANDLER})\n`);
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    process.stderr.write(`webhook-server: port ${PORT} already in use — exiting\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, '0.0.0.0');
