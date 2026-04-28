#!/usr/bin/env node
/**
 * webhook-handler.js — route GitHub webhook events to cron-framework triggers.
 *
 * Replaces poll-based scheduling with event-driven wakes. The cron-runner
 * already supports trigger files (drop `crons/triggers/<jobId>.trigger`
 * and the agent fires on the next tick, within ~60s). This handler reads
 * a GitHub webhook payload from stdin (or a file via --payload), inspects
 * the event type + action, and writes the appropriate trigger file.
 *
 * Designed to live behind webhook-server.js, which buffers POST bodies
 * from GitHub and pipes them in.
 *
 * Usage (CLI / testing):
 *   webhook-handler.js --event <name> [--payload file] [--signature SIG] [--dry-run]
 *   cat payload.json | webhook-handler.js --event pull_request
 *
 * Flags:
 *   --event <name>    GitHub X-GitHub-Event header value (required)
 *   --payload <file>  Path to JSON payload. Default: stdin.
 *   --signature SIG   X-Hub-Signature-256 header value. If provided,
 *                     GITHUB_WEBHOOK_SECRET env var must also be set.
 *   --dry-run         Compute the routing decision without writing the
 *                     trigger file. Prints the JSON decision to stdout.
 *   --triggers-dir D  Override target trigger directory.
 *                     Default: $WORKSPACE_DIR/crons/triggers.
 *   --routes <file>   Override path to routes.json (see routes shape).
 *
 * Routing config — `routes.json`:
 *
 *   Specify the trigger file to drop for each (event, action) pair plus a
 *   small set of higher-level rules. All keys are optional; missing rules
 *   produce an "ignored" decision.
 *
 *   {
 *     "owner_logins": ["yourname"],
 *     "feature_branch_regex": "^refs/heads/feat/",
 *     "rules": {
 *       "pull_request.opened":          "reviewer",
 *       "pull_request.ready_for_review": "reviewer",
 *       "pull_request.synchronize":      "reviewer",
 *       "pull_request.reopened":         "reviewer",
 *       "pull_request.closed.merged":    "merge-watcher",
 *       "pull_request_review.submitted.by_owner": "reviewer",
 *       "push.feature_branch":           "reviewer"
 *     }
 *   }
 *
 *   - "owner_logins" — pull_request_review events from these users trigger
 *     the .by_owner rule. Reviews from anyone else are ignored. (Use this
 *     to avoid triggering on bot reviews you produce yourself.)
 *   - "feature_branch_regex" — push events whose ref matches this regex
 *     trigger the push.feature_branch rule. Push to other refs ignored.
 *   - "rules" — keys are dotted event paths; values are trigger names
 *     (without the .trigger suffix). The handler writes
 *     `<triggers-dir>/<value>.trigger`.
 *
 * Output (single JSON line on stdout):
 *
 *   {action: "trigger" | "dry-run" | "ignored" | "rejected",
 *    reason: "...",
 *    trigger?: "...",
 *    droppedFile?: "..."}
 *
 * Exit codes: 0 routed (or correctly ignored), 1 rejected, 2 bad args.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.WORKSPACE_DIR || process.cwd();

// ── arg parsing ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let eventName = null;
let payloadFile = null;
let signature = null;
let dryRun = false;
let triggersDir = path.join(WORKSPACE, 'crons', 'triggers');
let routesFile = path.join(WORKSPACE, 'crons', 'routes.json');

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--event')              eventName    = args[++i];
  else if (a === '--payload')       payloadFile  = args[++i];
  else if (a === '--signature')     signature    = args[++i];
  else if (a === '--dry-run')       dryRun       = true;
  else if (a === '--triggers-dir')  triggersDir  = args[++i];
  else if (a === '--routes')        routesFile   = args[++i];
  else if (a === '--help' || a === '-h') {
    process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 70).join('\n') + '\n');
    process.exit(0);
  } else {
    process.stderr.write(`unknown arg: ${a}\n`);
    process.exit(2);
  }
}

if (!eventName) {
  process.stderr.write('--event <name> is required\n');
  process.exit(2);
}

// ── load routes config ──────────────────────────────────────────────────────
const routes = loadRoutes(routesFile);

// ── read payload ────────────────────────────────────────────────────────────
let rawPayload;
try {
  rawPayload = payloadFile ? fs.readFileSync(payloadFile) : fs.readFileSync(0); // 0 = stdin
} catch (e) {
  emit({ action: 'rejected', reason: `failed to read payload: ${e.message}` });
  process.exit(1);
}

// ── signature check ─────────────────────────────────────────────────────────
if (signature) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    emit({ action: 'rejected', reason: 'GITHUB_WEBHOOK_SECRET not set but --signature provided' });
    process.exit(1);
  }
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawPayload).digest('hex');
  const provided = Buffer.from(signature, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (provided.length !== expectedBuf.length || !crypto.timingSafeEqual(provided, expectedBuf)) {
    emit({ action: 'rejected', reason: 'signature mismatch' });
    process.exit(1);
  }
}

// ── parse payload ───────────────────────────────────────────────────────────
let payload;
try {
  payload = JSON.parse(rawPayload.toString('utf8'));
} catch (e) {
  emit({ action: 'rejected', reason: `payload is not valid JSON: ${e.message}` });
  process.exit(1);
}

// ── routing decision ────────────────────────────────────────────────────────
const decision = route(eventName, payload, routes);

if (decision.action === 'trigger') {
  if (dryRun) {
    decision.action = 'dry-run';
  } else {
    try {
      fs.mkdirSync(triggersDir, { recursive: true });
      const file = path.join(triggersDir, `${decision.trigger}.trigger`);
      fs.writeFileSync(file, '');
      decision.droppedFile = file;
    } catch (e) {
      emit({ action: 'rejected', reason: `failed to write trigger: ${e.message}` });
      process.exit(1);
    }
  }
}

emit(decision);
process.exit(0);

// ────────────────────────────────────────────────────────────────────────────

function loadRoutes(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    // Default: route nothing. Operator must provide a routes.json.
    return { owner_logins: [], feature_branch_regex: null, rules: {} };
  }
}

function route(event, p, cfg) {
  // Ping — GitHub sends this on webhook setup. Ack and ignore.
  if (event === 'ping') {
    return { action: 'ignored', reason: 'ping acknowledged' };
  }

  const rules = cfg.rules || {};

  // pull_request events
  if (event === 'pull_request') {
    const action = p.action;
    const pr = p.pull_request || {};
    const draft = !!pr.draft;
    const merged = !!pr.merged;

    // Closed + merged → check for explicit .closed.merged rule
    if (action === 'closed' && merged) {
      const trigger = rules['pull_request.closed.merged'];
      if (trigger) {
        return { action: 'trigger', reason: `pr.closed.merged #${pr.number}`, trigger };
      }
      return { action: 'ignored', reason: `pr.closed.merged #${pr.number} not routed` };
    }

    // Closed + not merged → ignore (PR was just dropped)
    if (action === 'closed') {
      return { action: 'ignored', reason: `pr.closed not-merged #${pr.number}` };
    }

    // Skip drafts entirely
    if (draft) {
      return { action: 'ignored', reason: `pr.${action} is draft #${pr.number}` };
    }

    const key = `pull_request.${action}`;
    const trigger = rules[key];
    if (trigger) {
      return { action: 'trigger', reason: `pr.${action} #${pr.number}`, trigger };
    }
    return { action: 'ignored', reason: `pr.${action} not routed` };
  }

  // pull_request_review — wake reviewer when an owner leaves owner feedback
  if (event === 'pull_request_review') {
    const action = p.action;
    const review = p.review || {};
    const sender = (p.sender && p.sender.login) || '';

    if (action !== 'submitted') {
      return { action: 'ignored', reason: `review.${action} not routed` };
    }

    const owners = Array.isArray(cfg.owner_logins) ? cfg.owner_logins : [];
    if (!owners.includes(sender)) {
      return { action: 'ignored', reason: `review by ${sender || '(unknown)'} not in owner_logins` };
    }

    const trigger = rules['pull_request_review.submitted.by_owner'];
    if (trigger) {
      return {
        action: 'trigger',
        reason: `review.submitted by ${sender}, state=${review.state || '?'}`,
        trigger,
      };
    }
    return { action: 'ignored', reason: `pull_request_review.submitted.by_owner not routed` };
  }

  // push — check feature-branch regex
  if (event === 'push') {
    const ref = p.ref || '';
    const re = cfg.feature_branch_regex;
    if (!re) {
      return { action: 'ignored', reason: `feature_branch_regex not configured` };
    }
    let matches;
    try {
      matches = new RegExp(re).test(ref);
    } catch (e) {
      return { action: 'rejected', reason: `invalid feature_branch_regex: ${e.message}` };
    }
    if (!matches) {
      return { action: 'ignored', reason: `push to ${ref || '(no ref)'} does not match feature_branch_regex` };
    }

    const trigger = rules['push.feature_branch'];
    if (trigger) {
      return { action: 'trigger', reason: `push to ${ref}`, trigger };
    }
    return { action: 'ignored', reason: `push.feature_branch not routed` };
  }

  // Anything else — ignore
  return { action: 'ignored', reason: `event ${event} not routed` };
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
