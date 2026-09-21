import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scryptSync } from 'node:crypto';

const fixture = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const note = value => appendFileSync(process.env.LIFECYCLE_LOG, JSON.stringify({ pid: process.pid, ...value }) + '\\n');
let sequence = 0, active = null, accountUsed = 0;
const threadId = 'fixture-thread';
const emit = (method, params) => send({ method, params: { threadId, ...params } });
note({ type: 'boot' });
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line), { id, method, params } = message;
  if (id === undefined) return;
  const reply = result => send({ id, result });
  if (method === 'initialize') return reply({ userAgent: 'fixture' });
  if (method === 'config/read') return reply({ config: { mcp_servers: {}, plugins: {} } });
  if (method === 'account/read') return reply({ account: { type: 'chatgpt' } });
  if (method === 'account/rateLimits/read') return reply({ rateLimits: { limitId: 'codex', primary: { usedPercent: accountUsed, windowDurationMins: 10080, resetsAt: 9999999999 }, secondary: null } });
  if (method === 'model/list') return reply({ data: [{ model: 'gpt-5.6-sol', hidden: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null });
  if (method === 'thread/start' || method === 'thread/resume') return reply({ thread: { id: threadId }, model: params.model, modelProvider: 'openai' });
  if (method === 'turn/start') {
    if (active) { note({ type: 'steered' }); return send({ id, error: { message: 'Accidentally steered an existing turn' } }); }
    const turnId = 'fixture-turn-' + ++sequence;
    const text = params.input[0].text;
    active = { turnId, text };
    note({ type: 'turn', turnId, text });
    const started = () => emit('turn/started', { turn: { id: turnId, status: 'inProgress' } });
    if (text === 'pending') setTimeout(started, 100); else started();
    setTimeout(() => reply({ turn: { id: turnId, status: 'inProgress' } }), text === 'pending' ? 1000 : 0);
    if (text === 'quota-cap') setTimeout(() => {
      const usage = { inputTokens: 500001, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 500002 };
      emit('thread/tokenUsage/updated', { turnId, tokenUsage: { total: usage, last: usage, modelContextWindow: 1000000 } });
    }, 50);
    if (text === 'late-usage') {
      setTimeout(() => {
        active = null;
        emit('turn/completed', { turn: { id: turnId, status: 'completed' } });
      }, 20);
      setTimeout(() => {
        const usage = { inputTokens: 10000, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 10002 };
        emit('thread/tokenUsage/updated', { turnId, tokenUsage: { total: usage, last: usage, modelContextWindow: 1000000 } });
        accountUsed = 75;
        emit('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: accountUsed, windowDurationMins: 10080, resetsAt: 9999999999 }, secondary: null } });
      }, 100);
    }
    if (text === 'fresh') {
      setTimeout(() => {
        emit('item/agentMessage/delta', { turnId: 'old-turn', itemId: 'stale', delta: 'STALE' });
        emit('turn/completed', { turn: { id: 'old-turn', status: 'completed' } });
      }, 20);
      setTimeout(() => {
        emit('item/agentMessage/delta', { turnId, itemId: 'answer-' + turnId, delta: 'Fresh answer' });
        emit('item/completed', { turnId, item: { id: 'answer-' + turnId, type: 'agentMessage', text: 'Fresh answer' } });
        active = null;
        emit('turn/completed', { turn: { id: turnId, status: 'completed' } });
      }, 150);
    }
    return;
  }
  if (method === 'turn/interrupt') {
    note({ type: 'interrupt', turnId: params.turnId });
    reply({});
    if (active?.text !== 'hang') setTimeout(() => {
      if (active?.turnId === params.turnId) active = null;
      note({ type: 'completed', turnId: params.turnId });
      emit('turn/completed', { turn: { id: params.turnId, status: 'interrupted' } });
    }, 250);
    return;
  }
  send({ id, error: { message: 'Unexpected fixture method: ' + method } });
});
`;

async function harness(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'codex-chat-lifecycle-'));
  const binary = join(scratch, 'fake-codex.mjs');
  const log = join(scratch, 'calls.jsonl');
  writeFileSync(binary, fixture, { mode: 0o700 });
  writeFileSync(join(scratch, 'access.json'), JSON.stringify({ salt: 'test-salt', hash: scryptSync('test-password', 'test-salt', 64).toString('hex') }));
  const server = spawn(process.execPath, [new URL('../server/index.mjs', import.meta.url).pathname], { env: { ...process.env, PORT: '0', CHAT_DATA_DIR: scratch, CHAT_WEEKLY_BUDGET_UNITS: '500000', CODEX_BIN: binary, LIFECYCLE_LOG: log }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', output = '';
  server.stderr.on('data', data => { stderr += data; });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      const force = setTimeout(() => server.kill('SIGKILL'), 2500);
      await exited;
      clearTimeout(force);
    }
    rmSync(scratch, { recursive: true, force: true });
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out: ' + stderr)), 3000);
    server.stdout.on('data', data => {
      output += data;
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    server.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited: ' + stderr)); });
  });
  const login = await fetch(url + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
  const { sessionToken } = await login.json();
  const headers = { Authorization: 'Bearer ' + sessionToken, 'Content-Type': 'application/json' };
  const post = (path, value, options = {}) => fetch(url + path, { method: 'POST', headers, body: JSON.stringify(value), ...options });
  const chat = (text, chatId, options) => post('/api/chat', { text, chatId, model: 'gpt-5.6-sol', effort: 'low' }, options);
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const status = async () => (await fetch(url + '/api/status', { headers })).json();
  return { post, chat, calls, status };
}

async function stream(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/x-ndjson/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function next() {
    while (!buffer.includes('\n')) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
    }
    const pos = buffer.indexOf('\n'), line = buffer.slice(0, pos);
    buffer = buffer.slice(pos + 1);
    return JSON.parse(line);
  }
  const first = await next();
  assert.equal(first.type, 'chat');
  return { chatId: first.chat.id, async remaining() { const events = []; let event; while ((event = await next()) !== null) events.push(event); return events; } };
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function afterCancellation(h, chatId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await h.chat('fresh', chatId);
    if (response.status !== 409) return response;
    await response.arrayBuffer();
    await pause(10);
  }
  throw new Error('Cancellation did not release the lock');
}

test('reaching the independent gateway quota interrupts generation and blocks new model turns', { timeout: 10000 }, async t => {
  const h = await harness(t);
  const first = await stream(await h.chat('quota-cap'));
  const events = await first.remaining();
  const done = events.find(event => event.type === 'done');
  assert.equal(done.status, 'interrupted');
  assert.match(done.error, /tygodniowy limit bramki/);
  assert.equal(done.budget.allowed, false);
  assert.equal(done.budget.windows[0].remainingFractionPercent, 0);
  const blocked = await h.chat('fresh', first.chatId);
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).budget.allowed, false);
  assert.equal(h.calls().filter(call => call.type === 'turn').length, 1);
});

test('usage arriving after completion is counted while outside account use leaves the allowance intact', { timeout: 10000 }, async t => {
  const h = await harness(t);
  const first = await stream(await h.chat('late-usage'));
  assert.equal((await first.remaining()).at(-1).status, 'completed');
  await pause(150);
  const status = await h.status();
  assert.equal(status.rateLimits.rateLimits.primary.usedPercent, 75);
  assert.equal(status.budget.windows[0].usedUnits, 10008);
  assert.equal(status.budget.windows[0].remainingFractionPercent, 97.9984);
  assert.equal(status.budget.allowed, true);
});

test('cancellation holds the turn lock, ignores stale events and handles a pending start', { timeout: 10000 }, async t => {
  const h = await harness(t);
  const first = await stream(await h.chat('cancel-race'));
  assert.equal((await h.post('/api/stop', { chatId: first.chatId })).status, 200);
  const blocked = await h.chat('fresh', first.chatId);
  assert.equal(blocked.status, 409);
  await blocked.arrayBuffer();
  assert.equal((await first.remaining()).at(-1).status, 'interrupted');
  const second = await stream(await h.chat('fresh', first.chatId));
  const events = await second.remaining();
  assert.equal(events.at(-1).status, 'completed');
  assert.deepEqual(events.filter(event => event.type === 'delta').map(event => event.delta), ['Fresh answer']);
  const controller = new AbortController();
  const pending = await stream(await h.chat('pending', first.chatId, { signal: controller.signal }));
  controller.abort();
  const stillBlocked = await h.chat('fresh', first.chatId);
  assert.equal(stillBlocked.status, 409);
  await stillBlocked.arrayBuffer();
  const resumed = await stream(await afterCancellation(h, pending.chatId));
  assert.equal((await resumed.remaining()).at(-1).status, 'completed');
  assert.equal(h.calls().filter(call => call.type === 'steered').length, 0);
  assert.ok(h.calls().some(call => call.type === 'interrupt' && call.turnId === 'fixture-turn-3'));
});

test('an unresponsive cancellation stops the own Codex process before admitting a new turn', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const first = await stream(await h.chat('hang'));
  await h.post('/api/stop', { chatId: first.chatId });
  const blocked = await h.chat('fresh', first.chatId);
  assert.equal(blocked.status, 409);
  await blocked.arrayBuffer();
  assert.equal((await first.remaining()).at(-1).status, 'interrupted');
  const next = await stream(await h.chat('fresh', first.chatId));
  assert.equal((await next.remaining()).at(-1).status, 'completed');
  assert.equal(new Set(h.calls().filter(call => call.type === 'boot').map(call => call.pid)).size, 2);
  assert.equal(h.calls().filter(call => call.type === 'steered').length, 0);
});
