import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Budget, DEFAULT_WEEKLY_BUDGET_UNITS } from '../server/budget.mjs';

const WEEK = 604800;
const SOL = 'gpt-5.6-sol';
const ASTRA = 'gpt-6-astra';
const tokens = (inputTokens, cachedInputTokens = 0, outputTokens = 0, reasoningOutputTokens = 0) => ({
  inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens,
});
const account = (usedPercent = 0, resetsAt = WEEK, ordinaryUsageAllowed = true) => ({
  ordinaryUsageAllowed,
  rateLimits: { limitId: 'codex', primary: { usedPercent, windowDurationMins: 10080, resetsAt }, secondary: null },
});
function fixture(t, initial) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-chat-budget-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'budget.json');
  if (initial !== undefined) writeFileSync(path, typeof initial === 'string' ? initial : JSON.stringify(initial));
  let seconds = 0;
  const now = () => seconds * 1000;
  return { path, now, budget: new Budget(path, now), setTime(value) { seconds = value; } };
}
function record(budget, threadId, turnId, model, total, last) {
  return budget.recordUsage({ threadId, turnId, model, tokenUsage: { total, ...(last ? { last } : {}) } });
}
function window(state) { return state.windows[0]; }

test('only own weighted token usage consumes the pool; other account activity has no effect', t => {
  const { budget } = fixture(t);
  const initial = budget.inspect(account(30));
  assert.equal(initial.estimated, true);
  assert.equal(initial.allowed, true);
  assert.equal(window(initial).allowanceUnits, DEFAULT_WEEKLY_BUDGET_UNITS);
  assert.equal(window(initial).usedUnits, 0);
  assert.equal(window(budget.inspect(account(99))).usedUnits, 0);
  assert.equal(window(budget.inspect(account(0))).allowanceUnits, DEFAULT_WEEKLY_BUDGET_UNITS);
  const own = record(budget, 'sol', 'one', SOL, tokens(1000, 200, 100, 80));
  assert.equal(window(own).usedUnits, 1220); // 800 + 200 * .1 + 100 * 4; reasoning is included in output.
  assert.equal(window(budget.inspect(account(50))).usedUnits, 1220);
  const astra = record(budget, 'astra', 'one', ASTRA, tokens(1000, 200, 100, 80));
  assert.equal(window(astra).usedUnits, 3660); // The same new usage is weighted twice for Astra.
});

test('cumulative per-thread snapshots are idempotent across model changes and process restarts', t => {
  const { budget, path, now } = fixture(t);
  budget.inspect(account());
  record(budget, 'thread', 'first', SOL, tokens(1000, 200, 100));
  record(budget, 'thread', 'first', SOL, tokens(1000, 200, 100));
  assert.equal(window(budget.inspect()).usedUnits, 1220);
  record(budget, 'thread', 'second', ASTRA, tokens(1500, 300, 150));
  assert.equal(window(budget.inspect()).usedUnits, 2440);
  const restarted = new Budget(path, now);
  record(restarted, 'thread', 'second', ASTRA, tokens(1500, 300, 150));
  assert.equal(window(restarted.inspect()).usedUnits, 2440);
  // A stale event cannot lower a baseline and rebill the next snapshot.
  record(restarted, 'thread', 'first', SOL, tokens(1000, 200, 100));
  record(restarted, 'thread', 'second', ASTRA, tokens(1500, 300, 150));
  assert.equal(window(restarted.inspect()).usedUnits, 2440);
});

test('beginTurn seeds history without cost; an unknown thread uses last usage instead of old history', t => {
  const { budget } = fixture(t);
  budget.beginTurn({ threadId: 'known', tokenUsage: { total: tokens(10000, 0, 1000) }, accountLimits: account() });
  assert.equal(window(budget.inspect()).usedUnits, 0);
  record(budget, 'known', 'new', SOL, tokens(10100, 0, 1010));
  assert.equal(window(budget.inspect()).usedUnits, 140);
  record(budget, 'unseeded', 'new', SOL, tokens(10100, 0, 1010), tokens(100, 0, 10));
  assert.equal(window(budget.inspect()).usedUnits, 280);
  // A repeated beginTurn may not discard already charged usage.
  budget.beginTurn({ threadId: 'known', tokenUsage: { total: tokens(12000, 0, 1300) } });
  record(budget, 'known', 'newer', SOL, tokens(10200, 0, 1020));
  assert.equal(window(budget.inspect()).usedUnits, 420);
});

test('last-only snapshots are idempotent within a turn and independent across turns', t => {
  const { budget } = fixture(t);
  const value = { key: 'turn-one', model: SOL, tokenUsage: { last: tokens(100, 20, 10) } };
  budget.recordUsage(value);
  budget.recordUsage(value);
  assert.equal(window(budget.inspect()).usedUnits, 122);
  budget.recordUsage({ ...value, key: 'turn-two' });
  assert.equal(window(budget.inspect()).usedUnits, 244);
});

test('new weekly epochs reset only own spending and do not rebill cumulative histories', t => {
  const { budget, setTime } = fixture(t);
  budget.inspect(account(10, 10000));
  record(budget, 'thread', 'one', SOL, tokens(100, 0, 10));
  assert.equal(window(budget.inspect()).resetsAt, 10000);
  setTime(10000);
  const fresh = budget.inspect(account(99, 10000 + WEEK));
  assert.equal(window(fresh).usedUnits, 0);
  assert.equal(window(fresh).allowanceUnits, DEFAULT_WEEKLY_BUDGET_UNITS);
  record(budget, 'thread', 'one', SOL, tokens(100, 0, 10));
  assert.equal(window(budget.inspect()).usedUnits, 0);
  record(budget, 'thread', 'two', SOL, tokens(150, 0, 20));
  assert.equal(window(budget.inspect()).usedUnits, 90);
});

test('missing account statistics allow a known own pool; unused pool may align once with weekly reset', t => {
  const { budget, path } = fixture(t);
  const standalone = budget.inspect(null);
  assert.equal(standalone.allowed, true);
  assert.equal(standalone.missing, false);
  assert.equal(window(standalone).resetsAt, WEEK);
  budget.inspect(account(90, 10000));
  assert.equal(window(budget.inspect(null)).resetsAt, 10000);
  assert.equal(JSON.parse(readFileSync(path)).epoch.source, 'account-weekly');
  budget.inspect(account(0, 20000));
  assert.equal(window(budget.inspect(null)).resetsAt, 10000);
  const blocked = budget.inspect(account(100, 10000, false));
  assert.equal(blocked.providerBlocked, true);
  assert.equal(blocked.allowed, true);
  assert.equal(window(blocked).usedUnits, 0);
});

test('pool size override is read only at a new epoch, and invalid overrides use the default', t => {
  const previous = process.env.CHAT_WEEKLY_BUDGET_UNITS;
  t.after(() => {
    if (previous === undefined) delete process.env.CHAT_WEEKLY_BUDGET_UNITS;
    else process.env.CHAT_WEEKLY_BUDGET_UNITS = previous;
  });
  process.env.CHAT_WEEKLY_BUDGET_UNITS = '1000';
  const { budget, setTime } = fixture(t);
  assert.equal(window(budget.inspect(account())).allowanceUnits, 1000);
  process.env.CHAT_WEEKLY_BUDGET_UNITS = '2000';
  assert.equal(window(budget.inspect(account(99))).allowanceUnits, 1000);
  setTime(WEEK);
  assert.equal(window(budget.inspect(account(0, WEEK * 2))).allowanceUnits, 2000);
  process.env.CHAT_WEEKLY_BUDGET_UNITS = '0';
  setTime(WEEK * 2);
  assert.equal(window(budget.inspect()).allowanceUnits, DEFAULT_WEEKLY_BUDGET_UNITS);
  process.env.CHAT_WEEKLY_BUDGET_UNITS = '100.5';
  const another = fixture(t);
  assert.equal(window(another.budget.inspect()).allowanceUnits, DEFAULT_WEEKLY_BUDGET_UNITS);
});

test('the cap blocks own generations and records overshoot without a negative remaining fraction', t => {
  const { budget } = fixture(t);
  const spent = record(budget, 'thread', 'one', SOL, tokens(DEFAULT_WEEKLY_BUDGET_UNITS));
  assert.equal(spent.allowed, false);
  assert.equal(window(spent).remainingFractionPercent, 0);
  assert.equal(window(spent).usedPercent, 10);
  const late = record(budget, 'thread', 'one', SOL, tokens(DEFAULT_WEEKLY_BUDGET_UNITS + 100));
  assert.equal(late.allowed, false);
  assert.equal(window(late).usedUnits, DEFAULT_WEEKLY_BUDGET_UNITS + 100);
  assert.equal(window(late).remainingFractionPercent, 0);
});

test('recalibration restores capacity without clearing spending, baselines or the renewal date', t => {
  const { budget, path, now } = fixture(t);
  budget.inspect(account(1));
  budget.resizeAllowance(500000);
  record(budget, 'thread', 'one', SOL, tokens(503000));
  const before = JSON.parse(readFileSync(path));
  assert.equal(budget.inspect().allowed, false);
  const resized = budget.resizeAllowance(5000000);
  assert.equal(resized.allowed, true);
  assert.equal(window(resized).usedUnits, 503000);
  assert.equal(window(resized).remainingFractionPercent, 89.94);
  const after = JSON.parse(readFileSync(path));
  assert.equal(after.epoch.startedAt, before.epoch.startedAt);
  assert.equal(after.epoch.resetsAt, before.epoch.resetsAt);
  assert.deepEqual(after.threads, before.threads);
  assert.deepEqual(after.turns, before.turns);
  const restarted = new Budget(path, now);
  record(restarted, 'thread', 'one', SOL, tokens(503000));
  assert.equal(window(restarted.inspect(account(99))).usedUnits, 503000);
  record(restarted, 'thread', 'two', SOL, tokens(503100));
  assert.equal(window(restarted.inspect()).usedUnits, 503100);
});

test('invalid recalibration cannot change an established budget', t => {
  const { budget, path } = fixture(t);
  budget.inspect();
  const before = readFileSync(path, 'utf8');
  for (const amount of [0, -1, 1.5, NaN, '5000000']) assert.throws(() => budget.resizeAllowance(amount));
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('a valid v1 account-delta state explicitly migrates without transferring global consumption', t => {
  const v1 = { version: 1, sharePercent: 10, baselines: { [JSON.stringify(['codex', 'primary', WEEK])]: 30 } };
  const { budget, path } = fixture(t, v1);
  const state = budget.inspect(account(99));
  assert.equal(state.allowed, true);
  assert.equal(window(state).usedUnits, 0);
  assert.equal(window(state).allowanceUnits, DEFAULT_WEEKLY_BUDGET_UNITS);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.migration.fromVersion, 1);
  assert.equal(saved.migration.mechanism, 'independent-chatbot-units');
  assert.equal(Object.hasOwn(saved, 'baselines'), false);
});

test('corrupt JSON, corrupt v1 and corrupt v2 fail closed without silently resetting', t => {
  for (const initial of [
    '{broken',
    { version: 1, sharePercent: 10, baselines: { bad: 30 } },
    { version: 1, sharePercent: 10, baselines: { [JSON.stringify(['codex', 'primary', WEEK])]: null } },
    { version: 2, sharePercent: 10, epoch: null, threads: {}, turns: {}, meteringError: 'false' },
  ]) {
    const { budget, path } = fixture(t, initial);
    const contents = readFileSync(path, 'utf8');
    const state = budget.inspect(account());
    assert.equal(state.allowed, false);
    assert.equal(state.missing, true);
    assert.equal(readFileSync(path, 'utf8'), contents);
  }
});

test('invalid own token snapshots block further usage instead of guessing a zero cost', t => {
  const { budget } = fixture(t);
  const broken = record(budget, 'thread', 'one', SOL, tokens(100, 101, 0));
  assert.equal(broken.allowed, false);
  assert.equal(broken.missing, true);
  assert.equal(window(broken).usedUnits, 0);
});
