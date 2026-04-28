#!/usr/bin/env node
/**
 * Smoke test for webhook-handler.js. No external deps; runs on plain node.
 * Each case spawns the handler with a synthetic payload and asserts the
 * decision JSON.
 */

'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HANDLER = path.join(__dirname, '..', 'src', 'webhook-handler.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-test-'));
const triggersDir = path.join(tmpRoot, 'triggers');

const ROUTES = {
  owner_logins: ['octocat'],
  feature_branch_regex: '^refs/heads/feat/',
  rules: {
    'pull_request.opened': 'reviewer',
    'pull_request.ready_for_review': 'reviewer',
    'pull_request.synchronize': 'reviewer',
    'pull_request.reopened': 'reviewer',
    'pull_request.closed.merged': 'merge-watcher',
    'pull_request_review.submitted.by_owner': 'reviewer',
    'push.feature_branch': 'reviewer',
  },
};
const routesFile = path.join(tmpRoot, 'routes.json');
fs.writeFileSync(routesFile, JSON.stringify(ROUTES));

let passed = 0;
let failed = 0;

function run({ event, payload, signature, dryRun = true, env = {} }) {
  const args = [HANDLER, '--event', event, '--triggers-dir', triggersDir, '--routes', routesFile];
  if (dryRun) args.push('--dry-run');
  if (signature) args.push('--signature', signature);
  const r = spawnSync('node', args, {
    input: JSON.stringify(payload),
    env: { ...process.env, ...env },
  });
  const out = r.stdout.toString().trim();
  return { code: r.status, decision: out ? JSON.parse(out) : null, stderr: r.stderr.toString() };
}

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('webhook-handler');

test('ping → ignored, exit 0', () => {
  const r = run({ event: 'ping', payload: { zen: 'hi' } });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.decision.action, 'ignored');
});

test('pull_request.opened → trigger reviewer (dry-run)', () => {
  const r = run({ event: 'pull_request', payload: { action: 'opened', pull_request: { number: 12, draft: false } } });
  assert.strictEqual(r.decision.action, 'dry-run');
  assert.strictEqual(r.decision.trigger, 'reviewer');
});

test('pull_request.opened draft → ignored', () => {
  const r = run({ event: 'pull_request', payload: { action: 'opened', pull_request: { number: 12, draft: true } } });
  assert.strictEqual(r.decision.action, 'ignored');
});

test('pull_request.synchronize non-draft → trigger reviewer', () => {
  const r = run({ event: 'pull_request', payload: { action: 'synchronize', pull_request: { number: 5, draft: false } } });
  assert.strictEqual(r.decision.action, 'dry-run');
  assert.strictEqual(r.decision.trigger, 'reviewer');
});

test('pull_request.closed merged → trigger merge-watcher', () => {
  const r = run({ event: 'pull_request', payload: { action: 'closed', pull_request: { number: 99, merged: true } } });
  assert.strictEqual(r.decision.action, 'dry-run');
  assert.strictEqual(r.decision.trigger, 'merge-watcher');
});

test('pull_request.closed not-merged → ignored', () => {
  const r = run({ event: 'pull_request', payload: { action: 'closed', pull_request: { number: 99, merged: false } } });
  assert.strictEqual(r.decision.action, 'ignored');
});

test('pull_request_review by owner → trigger reviewer', () => {
  const r = run({ event: 'pull_request_review', payload: { action: 'submitted', review: { state: 'changes_requested' }, sender: { login: 'octocat' } } });
  assert.strictEqual(r.decision.action, 'dry-run');
  assert.strictEqual(r.decision.trigger, 'reviewer');
});

test('pull_request_review by non-owner → ignored', () => {
  const r = run({ event: 'pull_request_review', payload: { action: 'submitted', review: { state: 'approved' }, sender: { login: 'random-bot' } } });
  assert.strictEqual(r.decision.action, 'ignored');
});

test('push to feat/* → trigger reviewer', () => {
  const r = run({ event: 'push', payload: { ref: 'refs/heads/feat/abc' } });
  assert.strictEqual(r.decision.action, 'dry-run');
  assert.strictEqual(r.decision.trigger, 'reviewer');
});

test('push to main → ignored', () => {
  const r = run({ event: 'push', payload: { ref: 'refs/heads/main' } });
  assert.strictEqual(r.decision.action, 'ignored');
});

test('issues.opened (no rule) → ignored', () => {
  const r = run({ event: 'issues', payload: { action: 'opened' } });
  assert.strictEqual(r.decision.action, 'ignored');
});

test('signature mismatch → rejected, exit 1', () => {
  const r = run({
    event: 'pull_request',
    payload: { action: 'opened', pull_request: { number: 1 } },
    signature: 'sha256=deadbeef',
    env: { GITHUB_WEBHOOK_SECRET: 'topsecret' },
  });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.decision.action, 'rejected');
});

test('valid signature → accepted', () => {
  const crypto = require('crypto');
  const secret = 'topsecret';
  const body = JSON.stringify({ action: 'opened', pull_request: { number: 7, draft: false } });
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  const r = run({
    event: 'pull_request',
    payload: { action: 'opened', pull_request: { number: 7, draft: false } },
    signature: sig,
    env: { GITHUB_WEBHOOK_SECRET: secret },
  });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.decision.trigger, 'reviewer');
});

test('actually drops a trigger file (no --dry-run)', () => {
  const r = run({
    event: 'pull_request',
    payload: { action: 'opened', pull_request: { number: 33, draft: false } },
    dryRun: false,
  });
  assert.strictEqual(r.decision.action, 'trigger');
  assert.ok(fs.existsSync(path.join(triggersDir, 'reviewer.trigger')));
});

test('malformed JSON → rejected', () => {
  const args = [HANDLER, '--event', 'pull_request', '--routes', routesFile, '--triggers-dir', triggersDir];
  const r = spawnSync('node', args, { input: '{invalid' });
  assert.strictEqual(r.status, 1);
  const decision = JSON.parse(r.stdout.toString().trim());
  assert.strictEqual(decision.action, 'rejected');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
