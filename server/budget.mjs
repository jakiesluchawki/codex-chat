import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const SHARE_PERCENT = 10;
export const DEFAULT_WEEKLY_BUDGET_UNITS = 5_000_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const MODELS = new Map([['gpt-6-astra', 2], ['gpt-5.6-sol', 1]]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const counter = value => Number.isSafeInteger(value) && value >= 0;
const units = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const rounded = value => Number(value.toFixed(6));
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function configuredAllowance() {
  const configured = process.env.CHAT_WEEKLY_BUDGET_UNITS;
  if (!/^[1-9]\d*$/.test(configured || '')) return DEFAULT_WEEKLY_BUDGET_UNITS;
  const value = Number(configured);
  return positiveInteger(value) ? value : DEFAULT_WEEKLY_BUDGET_UNITS;
}

function weeklyReset(data, nowSeconds) {
  if (!object(data)) return null;
  const buckets = object(data.rateLimitsByLimitId) ? Object.values(data.rateLimitsByLimitId) : object(data.rateLimits) ? [data.rateLimits] : [];
  for (const bucket of buckets) {
    if (!object(bucket)) continue;
    for (const name of ['primary', 'secondary']) {
      const window = bucket[name];
      if (object(window) && window.windowDurationMins === 10080 && positiveInteger(window.resetsAt) && window.resetsAt > nowSeconds && window.resetsAt <= nowSeconds + WEEK_SECONDS) return window.resetsAt;
    }
  }
  return null;
}

function counts(value) {
  if (!object(value) || !counter(value.inputTokens) || !counter(value.outputTokens)) return null;
  const cachedInputTokens = value.cachedInputTokens === undefined ? 0 : value.cachedInputTokens;
  if (!counter(cachedInputTokens) || cachedInputTokens > value.inputTokens) return null;
  return { inputTokens: value.inputTokens, cachedInputTokens, outputTokens: value.outputTokens };
}

function difference(current, previous) {
  if (!previous) return current;
  if (Object.keys(current).some(name => current[name] < previous[name])) return null;
  return Object.fromEntries(Object.keys(current).map(name => [name, current[name] - previous[name]]));
}

function weighted(value, model) {
  const multiplier = MODELS.get(model);
  if (!multiplier || !value || value.cachedInputTokens > value.inputTokens) return null;
  // Cached input is a subset of input; reasoning is already included in output.
  const amount = (value.inputTokens - value.cachedInputTokens + value.cachedInputTokens * 0.1 + value.outputTokens * 4) * multiplier;
  return units(amount) ? rounded(amount) : null;
}

const emptyState = () => ({ version: 2, sharePercent: SHARE_PERCENT, epoch: null, threads: {}, turns: {}, meteringError: false });

function validState(state) {
  if (!object(state) || state.version !== 2 || state.sharePercent !== SHARE_PERCENT || !object(state.threads) || !object(state.turns) || typeof state.meteringError !== 'boolean') return false;
  if (state.epoch !== null && (!object(state.epoch) || !Number.isSafeInteger(state.epoch.startedAt) || !positiveInteger(state.epoch.resetsAt) || state.epoch.startedAt >= state.epoch.resetsAt || !positiveInteger(state.epoch.allowanceUnits) || !units(state.epoch.usedUnits) || !['account-weekly', 'own-weekly'].includes(state.epoch.source))) return false;
  return [state.threads, state.turns].every(map => Object.entries(map).every(([key, value]) => key && counts(value) !== null));
}

function previousAccountBudget(state) {
  if (!object(state) || state.version !== 1 || state.sharePercent !== SHARE_PERCENT || !object(state.baselines)) return false;
  return Object.entries(state.baselines).every(([key, baseline]) => {
    try {
      const identity = JSON.parse(key);
      return Array.isArray(identity) && identity.length === 3 && typeof identity[0] === 'string' && identity[0] && ['primary', 'secondary'].includes(identity[1]) && positiveInteger(identity[2]) && typeof baseline === 'number' && Number.isFinite(baseline) && baseline >= 0 && baseline <= 100;
    } catch { return false; }
  });
}

/** Independent chatbot allowance. Token and model weights are not Codex pricing. */
export class Budget {
  constructor(path, now = Date.now) {
    this.path = path;
    this.now = now;
    this.state = emptyState();
    this.invalidState = false;
    this.storageError = false;
    if (!existsSync(path)) return;
    try {
      const state = JSON.parse(readFileSync(path, 'utf8'));
      if (validState(state)) this.state = state;
      else if (previousAccountBudget(state)) this.state.migration = { fromVersion: 1, mechanism: 'independent-chatbot-units', migratedAt: Math.floor(this.now() / 1000) };
      else this.invalidState = true;
      // Old account percentages cannot identify chatbot spending and are discarded
      // only when migrating the valid old mechanism the user explicitly replaced.
    } catch { this.invalidState = true; }
  }

  persist(next) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(this.path), basename(this.path) + '.tmp-' + process.pid + '-' + randomBytes(6).toString('hex'));
    try {
      writeFileSync(temporary, JSON.stringify(next) + '\n', { flag: 'wx', mode: 0o600, flush: true });
      renameSync(temporary, this.path);
    } finally { try { unlinkSync(temporary); } catch {} }
  }

  commit(next) {
    try { this.persist(next); this.state = next; this.storageError = false; return true; }
    catch { this.storageError = true; return false; }
  }

  view(accountLimits) {
    const epoch = this.state.epoch;
    const missing = this.invalidState || this.storageError || this.state.meteringError || !epoch;
    const remainingFraction = epoch ? clamp((epoch.allowanceUnits - epoch.usedUnits) / epoch.allowanceUnits * 100, 0, 100) : 0;
    const number = new Intl.NumberFormat('pl-PL').format(epoch?.allowanceUnits || DEFAULT_WEEKLY_BUDGET_UNITS);
    const note = 'Niezależny limit naliczamy wyłącznie z tokenów tego chatbota. Pula ' + number + ' umownych jednostek na 7 dni jest szacowana i dostrajana na podstawie pomiarów. Celem jest około 10% limitu konta; wielkość puli konta w tokenach nie jest znana. Wagi tokenów i modeli są umowne. Codex może zgłosić zużycie dopiero po odpowiedzi, więc ostatnia odpowiedź może przekroczyć pozostałą pulę.';
    return {
      enabled: true, sharePercent: SHARE_PERCENT, estimated: true,
      allowed: !missing && epoch.usedUnits < epoch.allowanceUnits,
      missing,
      providerBlocked: accountLimits?.ordinaryUsageAllowed === false,
      windows: epoch ? [{ label: '7 dni', allowancePercent: SHARE_PERCENT, usedPercent: rounded(epoch.usedUnits / epoch.allowanceUnits * SHARE_PERCENT), remainingFractionPercent: rounded(remainingFraction), resetsAt: epoch.resetsAt, allowanceUnits: epoch.allowanceUnits, usedUnits: epoch.usedUnits }] : [],
      note: (missing ? 'Nie można bezpiecznie odczytać lub zapisać własnego licznika bramki. Wysyłanie jest zablokowane. ' : '') + note,
    };
  }

  inspect(accountLimits) {
    if (this.invalidState) return this.view(accountLimits);
    const nowSeconds = Math.floor(this.now() / 1000);
    const weekly = weeklyReset(accountLimits, nowSeconds);
    if (!this.state.epoch || nowSeconds >= this.state.epoch.resetsAt) {
      const next = structuredClone(this.state);
      const oldEnd = next.epoch?.resetsAt;
      const anchorEnd = oldEnd ? oldEnd + (Math.floor((nowSeconds - oldEnd) / WEEK_SECONDS) + 1) * WEEK_SECONDS : nowSeconds + WEEK_SECONDS;
      const resetsAt = weekly || anchorEnd;
      next.epoch = { startedAt: resetsAt - WEEK_SECONDS, resetsAt, allowanceUnits: configuredAllowance(), usedUnits: 0, source: weekly ? 'account-weekly' : 'own-weekly' };
      next.meteringError = false;
      this.commit(next);
    } else if (weekly && this.state.epoch.source === 'own-weekly' && this.state.epoch.usedUnits === 0) {
      // Startup may inspect(null) before account stats arrive; align that unused pool
      // once, preserving its allowance even if configuration changed meanwhile.
      const next = structuredClone(this.state);
      next.epoch.startedAt = weekly - WEEK_SECONDS;
      next.epoch.resetsAt = weekly;
      next.epoch.source = 'account-weekly';
      this.commit(next);
    }
    return this.view(accountLimits);
  }

  beginTurn({ threadId, tokenUsage, usage, accountLimits } = {}) {
    const result = this.inspect(accountLimits);
    if (result.missing) return result;
    const total = counts((tokenUsage || usage)?.total);
    if (typeof threadId === 'string' && threadId && total && !Object.hasOwn(this.state.threads, threadId)) {
      const next = structuredClone(this.state);
      next.threads[threadId] = total;
      this.commit(next);
    }
    return this.view(accountLimits);
  }

  resizeAllowance(allowanceUnits) {
    if (!positiveInteger(allowanceUnits)) throw new Error('Pula musi być dodatnią liczbą całkowitą.');
    if (this.inspect().missing) throw new Error('Nie można zmienić nieprawidłowego lub niezapisywalnego licznika.');
    const next = structuredClone(this.state);
    next.epoch.allowanceUnits = allowanceUnits;
    if (!this.commit(next)) throw new Error('Nie można zapisać zmienionej puli.');
    return this.view();
  }

  recordUsage({ threadId, turnId, key, model, tokenUsage, usage } = {}) {
    this.inspect();
    if (this.invalidState || this.storageError || !this.state.epoch) return this.view();
    const payload = tokenUsage || usage;
    const total = counts(payload?.total);
    const last = counts(payload?.last);
    const turnKey = typeof key === 'string' && key ? key : typeof threadId === 'string' && threadId && typeof turnId === 'string' && turnId ? JSON.stringify([threadId, turnId]) : null;
    const validThread = typeof threadId === 'string' && threadId;
    const next = structuredClone(this.state);
    let increment = null;
    if (total && validThread) {
      const previous = next.threads[threadId];
      if (previous) increment = difference(total, previous);
      else if (last && last.inputTokens <= total.inputTokens && last.cachedInputTokens <= total.cachedInputTokens && last.outputTokens <= total.outputTokens) increment = difference(last, turnKey ? next.turns[turnKey] : null);
      else increment = total;
      if (increment === null) return this.view();
      next.threads[threadId] = total;
    } else if (last && turnKey) {
      increment = difference(last, next.turns[turnKey]);
      if (increment === null) return this.view();
    }
    const amount = weighted(increment, model);
    if (amount === null || !units(next.epoch.usedUnits + amount)) {
      next.meteringError = true;
      this.commit(next);
      return this.view();
    }
    if (last && turnKey) next.turns[turnKey] = last;
    next.epoch.usedUnits = rounded(next.epoch.usedUnits + amount);
    if (amount !== 0 || JSON.stringify(next.threads) !== JSON.stringify(this.state.threads) || JSON.stringify(next.turns) !== JSON.stringify(this.state.turns)) this.commit(next);
    return this.view();
  }
}
