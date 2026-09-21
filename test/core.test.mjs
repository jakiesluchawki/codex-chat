import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scryptSync } from 'node:crypto';
import { Auth } from '../server/auth.mjs';
import { ChatStore } from '../server/store.mjs';
import { pickerModels } from '../server/codex.mjs';

test('Model picker excludes unofficial, hidden and unrequested models', () => {
  const entry = (model, hidden = false) => ({ model, hidden, supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' });
  assert.deepEqual(pickerModels([entry('quasar-alpha'), entry('gpt-6-astra'), entry('gpt-5.6-sol'), entry('gpt-5.6-terra')]).map(model => model.id), ['gpt-6-astra', 'gpt-5.6-sol']);
  assert.equal(pickerModels([entry('gpt-6-astra', true)]).length, 0);
});

test('Independent password auth creates expiring session and limits guessing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-chat-test-'));
  try {
    let now = 1000;
    const path = join(dir, 'access.json');
    writeFileSync(path, JSON.stringify({ salt: 'salt-for-test', hash: scryptSync('test-password', 'salt-for-test', 64).toString('hex') }));
    const auth = new Auth(path, () => now);
    assert.throws(() => auth.login('bad'), /Nieprawidłowe/);
    const { sessionToken, expiresAt } = auth.login('test-password');
    const request = { headers: { authorization: 'Bearer ' + sessionToken } };
    assert.equal(auth.check(request), true);
    now = expiresAt;
    assert.equal(auth.check(request), false);
    for (let i = 0; i < 10; i++) assert.throws(() => auth.login('bad'), /Nieprawidłowe/);
    assert.throws(() => auth.login('test-password'), /Za dużo prób/);
    now += 60_001;
    const next = auth.login('test-password');
    const nextRequest = { headers: { authorization: 'Bearer ' + next.sessionToken } };
    auth.logout(nextRequest);
    assert.equal(auth.check(nextRequest), false);
  } finally { rmSync(dir, { recursive: true }); }
});

test('Chat history survives restart, marks partial replies, and hides Codex ids', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-chat-test-'));
  try {
    const store = new ChatStore(dir);
    const chat = store.create('Hej', 'gpt-5.6-sol', 'low');
    chat.threadId = 'private-thread-id';
    chat.active = true;
    chat.messages.push({ role: 'assistant', text: 'część', status: 'inProgress' });
    store.save();
    assert.equal(store.public(chat).threadId, undefined);
    assert.throws(() => store.delete(chat.id), /zatrzymaj/);
    const resumed = new ChatStore(dir);
    assert.equal(resumed.get(chat.id).active, false);
    assert.equal(resumed.get(chat.id).messages[0].status, 'interrupted');
    assert.equal(resumed.delete(chat.id), true);
    assert.deepEqual(new ChatStore(dir).list(), []);
  } finally { rmSync(dir, { recursive: true }); }
});
