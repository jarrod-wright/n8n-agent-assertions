#!/usr/bin/env node
// Import-and-run harness for the four ARR workflows.
//
// One command, binary result: exit 0 every check passed, exit 1 something
// failed. No dependencies; the only network access is cloning the
// workflow-hardening repository for its public linter, pinned to a commit.
//
// Three phases:
//   1. Structure - each workflow file is what the README promises: importable
//      JSON, a reachable Check, explicit timezone, bounded network calls.
//   2. Check fixtures - each workflow's Check logic runs against a passing
//      case and a failing case, with the n8n helpers the code uses ($,
//      $input, $workflow) provided by this harness. The passing case must
//      complete; the failing case must stop the run with the error the
//      README documents.
//   3. Linter - the public static linter runs over every workflow. Every
//      finding it reports must be one the README justifies ("Justified
//      findings"). Anything unexplained fails the harness.
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// This file lives in <repo>/harness/, so the repo root is one level up.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const wfDir = join(root, 'workflows');
const LINTER_REPO = 'https://github.com/jarrod-wright/n8n-workflow-hardening.git';
const LINTER_SHA = process.env.LINTER_SHA || 'c9f99b7';

// Findings the README justifies. The harness requires every linter finding to
// be in this set; it does not require every set member to appear.
const JUSTIFIED = new Set(['R1', 'R7', 'R8']);

let failures = 0;
const fail = (msg) => { failures++; console.error('  FAIL', msg); };
const pass = (msg) => console.log('  ok  ', msg);

// ---------------------------------------------------------------- phase 1
function structure(workflows) {
  console.log('phase 1: structure');
  for (const wf of workflows) {
    const label = wf.file;
    if (typeof wf.doc.name === 'string' && wf.doc.name.startsWith('ARR - '))
      pass(`${label}: named "${wf.doc.name}"`);
    else fail(`${label}: workflow name should start with "ARR - "`);
    if (wf.doc.settings && wf.doc.settings.timezone === 'Etc/UTC')
      pass(`${label}: timezone pinned to Etc/UTC`);
    else fail(`${label}: settings.timezone should be "Etc/UTC"`);
    const sticky = wf.doc.nodes.filter((n) => n.type === 'n8n-nodes-base.stickyNote');
    if (sticky.length && sticky.some((n) => String((n.parameters && n.parameters.content) || '').includes('Error Workflow')))
      pass(`${label}: setup sticky note documents the Error Workflow setting`);
    else fail(`${label}: no setup sticky note explaining the Error Workflow setting`);
    const triggers = wf.doc.nodes.filter((n) => n.type === 'n8n-nodes-base.scheduleTrigger' || n.type === 'n8n-nodes-base.manualTrigger');
    if (triggers.length) pass(`${label}: ${triggers.length} trigger node(s)`);
    else fail(`${label}: no trigger node`);
    // every trigger reaches the Check node
    const checkNode = wf.doc.nodes.find((n) => n.type === 'n8n-nodes-base.code' && /^Check/i.test(n.name));
    if (!checkNode) { fail(`${label}: no Check code node`); continue; }
    const conn = wf.doc.connections || {};
    const seen = new Set();
    const walk = (name) => {
      if (seen.has(name)) return;
      seen.add(name);
      const mains = (conn[name] && conn[name].main) || [];
      for (const outputs of mains) for (const edge of outputs || []) walk(edge.node);
    };
    triggers.forEach((t) => walk(t.name));
    if (seen.has(checkNode.name)) pass(`${label}: every trigger reaches "${checkNode.name}"`);
    else fail(`${label}: "${checkNode.name}" is not reachable from every trigger`);
    // bounded network calls
    for (const n of wf.doc.nodes.filter((x) => x.type === 'n8n-nodes-base.httpRequest')) {
      const o = (n.parameters && n.parameters.options) || {};
      const timeout = o.timeout;
      const hasTimeout = typeof timeout === 'number' || (typeof timeout === 'string' && timeout.startsWith('='));
      if (hasTimeout) pass(`${label}: "${n.name}" sets a request timeout`);
      else fail(`${label}: "${n.name}" has no request timeout`);
      if (n.retryOnFail === true && n.maxTries <= 5 && n.waitBetweenTries >= 1000)
        pass(`${label}: "${n.name}" retries bounded (${n.maxTries} tries, ${n.waitBetweenTries} ms apart)`);
      else fail(`${label}: "${n.name}" should retry bounded (maxTries <= 5, waits >= 1000 ms)`);
    }
    // nodes carry ids and typeVersions, so n8n imports them cleanly
    const badNodes = wf.doc.nodes.filter((n) => !n.id || n.typeVersion === undefined);
    if (badNodes.length === 0) pass(`${label}: every node carries id and typeVersion`);
    else fail(`${label}: nodes missing id or typeVersion: ${badNodes.map((n) => n.name).join(', ')}`);
  }
}

// ---------------------------------------------------------------- phase 2
// Runs a Check node's code the way n8n runs it: plain JS with the helpers the
// code is written against. A throw is the alert; a return is the green path.
function runCheckCode(code, env) {
  const fn = new Function('$', '$input', '$workflow', `"use strict";\n${code}`);
  return fn(env.$, env.$input, env.$workflow);
}

function checkFixtures(workflows) {
  console.log('phase 2: check fixtures (pass and fail case per check)');
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const FIXTURES = {
    'arr-credential-liveness.json': {
      env: (probes) => ({
        $: (name) => ({ first: () => probes[name], all: () => [probes[name]] }),
        $input: { all: () => [], first: () => ({ json: {} }) },
        $workflow: { id: 'self' },
      }),
      pass: { probes: { 'Probe 1': { json: { statusCode: 200 } }, 'Probe 2': { json: { statusCode: 200 } } } },
      fail: { probes: { 'Probe 1': { json: { statusCode: 401 } }, 'Probe 2': { json: { statusCode: 200 } } } },
      failMessage: 'ARR - Credential liveness failed, 1 of 2 credentials. Probe 1 credential rejected (HTTP 401)',
    },
    'arr-success-rate.json': {
      env: (runs) => ({
        $: () => ({ first: () => ({ json: {} }) }),
        $input: { all: () => runs, first: () => runs[0] },
        $workflow: { id: 'self-wf' },
      }),
      pass: {
        runs: Array.from({ length: 12 }, (_, i) => ({
          json: { id: `r${i}`, workflowId: 'w1', status: 'success', startedAt: iso(now - (i + 1) * 60000) },
        })),
      },
      fail: {
        runs: [1, 2, 3].map((i) => ({
          json: { id: `x${i}`, workflowId: 'w1', status: 'error', startedAt: iso(now - i * 60000) },
        })).concat(Array.from({ length: 9 }, (_, i) => ({
          json: { id: `r${i}`, workflowId: 'w1', status: 'success', startedAt: iso(now - (i + 10) * 60000) },
        }))),
      },
      failMessage: 'ARR - Success rate failed, 1 workflow(s) over threshold in the last 24 h. workflow w1 had 3 of 12 runs fail (25.0%, limit 5.0%; e.g. executions x1, x2, x3)',
    },
    'arr-cost-and-iteration-ceiling.json': {
      env: (runs) => ({
        $: () => ({ first: () => ({ json: {} }) }),
        $input: { all: () => runs, first: () => runs[0] },
        $workflow: { id: 'self' },
      }),
      pass: {
        runs: [{
          json: {
            id: 'e1', workflowId: 'w1', startedAt: iso(now - 10000), stoppedAt: iso(now),
            data: { resultData: { runData: { 'Node A': [{}, {}, {}] } } },
          },
        }],
      },
      fail: {
        runs: [{
          json: {
            id: 'e2', workflowId: 'w1', startedAt: iso(now - 400000), stoppedAt: iso(now),
            data: { resultData: { runData: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`Node ${i}`, [{}]])) } },
          },
        }],
      },
      failPrefix: 'ARR - Cost and iteration ceiling failed, 1 run(s) over a ceiling.',
    },
    'arr-golden-case.json': {
      env: (reply) => ({
        $: (name) => ({
          first: () => ({
            json: {
              url: 'https://n8n.example.com/webhook/x', body: {},
              expect: { status: 200, keys: ['output'], types: { output: 'string' }, contains: {}, max_seconds: 60 },
            },
          }),
        }),
        $input: { all: () => [reply], first: () => reply },
        $workflow: { id: 'self' },
      }),
      pass: { reply: { json: { statusCode: 200, body: { output: 'order 1001 shipped' } } } },
      fail: { reply: { json: { statusCode: 200, body: { output: 123 } } } },
      failMessage: 'ARR - Golden case failed, the answer changed shape. "output" is number, expected string',
    },
  };
  for (const wf of workflows) {
    const fx = FIXTURES[wf.file];
    if (!fx) { fail(`${wf.file}: no fixture set (harness is incomplete)`); continue; }
    const checkNode = wf.doc.nodes.find((n) => n.type === 'n8n-nodes-base.code' && /^Check/i.test(n.name));
    if (!checkNode) continue; // phase 1 already reported it
    const code = (checkNode.parameters && checkNode.parameters.jsCode) || '';
    // pass case
    try {
      const p = fx.pass;
      const env = fx.env(p.probes || p.runs || p.reply, p);
      runCheckCode(code, env);
      pass(`${wf.file}: passing case completed`);
    } catch (e) {
      fail(`${wf.file}: passing case threw, but should not: ${e.message}`);
    }
    // fail case
    try {
      const p = fx.fail;
      const env = fx.env(p.probes || p.runs || p.reply, p);
      runCheckCode(code, env);
      fail(`${wf.file}: failing case did NOT stop the run - the alert would never fire`);
    } catch (e) {
      const want = fx.failMessage || fx.failPrefix;
      if (!want) fail(`${wf.file}: fixture misconfigured (no expected message)`);
      else if (fx.failPrefix ? e.message.startsWith(fx.failPrefix) : e.message === want)
        pass(`${wf.file}: failing case stops the run with the documented error`);
      else fail(`${wf.file}: failing case threw an unexpected message: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------- phase 3
function lint(workflows) {
  console.log('phase 3: public linter over every workflow (findings must be justified)');
  const tmp = mkdtempSync(join(tmpdir(), 'arr-linter-'));
  try {
    execFileSync('git', ['clone', '--quiet', '--filter=blob:none', LINTER_REPO, tmp], { stdio: 'pipe' });
    execFileSync('git', ['-C', tmp, 'checkout', '--quiet', LINTER_SHA], { stdio: 'pipe' });
    const cli = join(tmp, 'linter', 'cli.js');
    for (const wf of workflows) {
      let out = '';
      let errored = false;
      try {
        out = execFileSync('node', [cli, 'lint', wf.path], { encoding: 'utf8', stdio: 'pipe' });
      } catch (e) {
        out = String(e.stdout || '') + String(e.stderr || '');
        errored = e.status !== 0;
      }
      const found = [...out.matchAll(/^\s*(ERROR|WARN|INFO)\s+(R\d+)/gm)].map((m) => ({ sev: m[1], rule: m[2] }));
      const odd = found.filter((f) => !JUSTIFIED.has(f.rule));
      for (const f of odd) fail(`${wf.file}: linter ${f.sev} ${f.rule} is not justified by the README`);
      if (found.length && odd.length === 0)
        pass(`${wf.file}: ${found.length} finding(s), all justified (${found.map((f) => f.rule).join(', ')})`);
      if (!found.length) pass(`${wf.file}: no linter findings`);
      if (!errored && found.some((f) => f.sev === 'ERROR'))
        fail(`${wf.file}: linter reported ERROR but exited 0`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- run
const files = readdirSync(wfDir).filter((f) => f.endsWith('.json')).sort();
if (!files.length) { console.error('no workflow files found'); process.exit(1); }
const workflows = files.map((f) => {
  const path = join(wfDir, f);
  let doc = null;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { fail(`${f}: not valid JSON (${e.message})`); }
  return { file: f, path, doc };
});
if (workflows.some((w) => w.doc && !w.doc.nodes)) fail('a workflow file has no nodes array');

const runnable = workflows.filter((w) => w.doc && w.doc.nodes);
structure(runnable);
checkFixtures(runnable);
lint(runnable);

console.log(failures ? `\nharness FAILED: ${failures} failure(s)` : '\nharness PASSED');
process.exit(failures ? 1 : 0);
