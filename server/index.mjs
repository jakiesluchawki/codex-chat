import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Auth } from './auth.mjs';
import { ChatStore } from './store.mjs';
import { CodexBridge, MODEL_NAMES } from './codex.mjs';
import { Budget } from './budget.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(process.env.CHAT_DATA_DIR || join(root, '.data'));
mkdirSync(data, { recursive: true, mode: 0o700 });
const workspace = join(data, 'workspace');
mkdirSync(workspace, { recursive: true, mode: 0o700 });
if (!existsSync(join(data, 'access.json'))) {
  console.error('Ustaw hasło bramki: npm run password');
  process.exit(1);
}
const auth = new Auth(join(data, 'access.json'));
const store = new ChatStore(data);
const codex = new CodexBridge(workspace);
const budget = new Budget(join(data, 'budget.json'));
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || 'https://jakiesluchawki.github.io').split(',').map(value => value.trim()).filter(Boolean));
let active = null;
let lastBudget = budget.inspect(null);
const usageTurns = new Map();
function trackUsageTurn(chat, turnId) {
  usageTurns.set(JSON.stringify([chat.threadId, turnId]), { chat, model: chat.model });
  if (usageTurns.size > 1000) usageTurns.delete(usageTurns.keys().next().value);
}
// Usage can arrive after turn/completed. Keep accounting separate from the stream.
codex.on('notification', ({ method, params }) => {
  if (method !== 'thread/tokenUsage/updated') return;
  const tracked = usageTurns.get(JSON.stringify([params?.threadId, params?.turnId]));
  if (!tracked) return;
  tracked.chat.usage = params.tokenUsage;
  lastBudget = budget.recordUsage({ threadId: params.threadId, turnId: params.turnId, model: tracked.model, tokenUsage: params.tokenUsage });
  store.save();
});

async function gatewayStatus() {
  const status = await codex.status();
  lastBudget = budget.inspect(status.rateLimits);
  const windowsOnly = snapshot => snapshot ? { primary: snapshot.primary, secondary: snapshot.secondary } : null;
  const raw = status.rateLimits;
  const rateLimits = raw ? { rateLimits: windowsOnly(raw.rateLimits), rateLimitsByLimitId: raw.rateLimitsByLimitId ? Object.fromEntries(Object.entries(raw.rateLimitsByLimitId).map(([id, snapshot]) => [id, windowsOnly(snapshot)])) : null } : null;
  return { ...status, rateLimits, budget: lastBudget };
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
async function body(request) {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (Buffer.byteLength(text) > 100_000) throw Object.assign(new Error('Wiadomość jest za długa.'), { status: 413 });
  }
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('Nieprawidłowe dane.'), { status: 400 }); }
}
async function chatTurn(request, response, input) {
  if (active) throw Object.assign(new Error('Bramka już odpowiada. Zaczekaj albo zatrzymaj odpowiedź.'), { status: 409 });
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 50_000) throw Object.assign(new Error('Wpisz wiadomość (maksymalnie 50 000 znaków).'), { status: 400 });
  if (!MODEL_NAMES.has(input.model)) throw Object.assign(new Error('Wybierz model Astra albo Sol.'), { status: 400 });
  const lock = { chat: null, requestedChatId: input.chatId || null, turnId: null, cancelled: false, cancel: null };
  active = lock;
  const onResponseClose = () => { lock.cancelled = true; lock.cancel?.(); };
  response.once('close', onResponseClose);
  const cancelledBeforeStart = () => {
    if (!lock.cancelled) return false;
    if (!response.destroyed && !response.writableEnded) json(response, 409, { error: 'Odpowiedź została zatrzymana przed rozpoczęciem.' });
    return true;
  };
  try {
    const status = await gatewayStatus();
    if (cancelledBeforeStart()) return;
    if (!status.budget.allowed) throw Object.assign(new Error(status.budget.missing ? 'Nie można sprawdzić limitu bramki. Wysyłanie jest zablokowane.' : 'Limit bramki wykorzystany. Poczekaj na odnowienie jej tygodniowej puli.'), { status: status.budget.missing ? 503 : 429, budget: status.budget });
    if (status.budget.providerBlocked) throw Object.assign(new Error('Codex zgłasza wyczerpanie limitu konta. Własna pula bramki pozostaje bez zmian.'), { status: 429, budget: status.budget });
    const model = status.models.find(model => model.id === input.model);
    if (!model?.efforts.some(effort => effort.id === input.effort)) throw Object.assign(new Error('Ten model lub poziom rozumowania jest niedostępny w Codexie.'), { status: 400 });
    const chat = input.chatId ? store.get(input.chatId) : store.create(input.text, input.model, input.effort);
    if (!chat) throw Object.assign(new Error('Nie znaleziono rozmowy.'), { status: 404 });
    lock.chat = chat;
    chat.model = input.model;
    chat.effort = input.effort;
    await codex.thread(chat);
    if (cancelledBeforeStart()) return;
    lastBudget = budget.beginTurn({ key: chat.id, model: chat.model, accountLimits: status.rateLimits, threadId: chat.threadId, tokenUsage: chat.usage });
    if (!lastBudget.allowed) throw Object.assign(new Error('Nie można uruchomić rozmowy w ramach limitu bramki.'), { status: lastBudget.missing ? 503 : 429, budget: lastBudget });
    chat.messages.push({ role: 'user', text: input.text, model: chat.model, effort: chat.effort });
    chat.active = true;
    chat.updatedAt = Date.now();
    store.save();
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
    response.flushHeaders();
    const send = event => { if (!response.destroyed && !response.writableEnded) response.write(JSON.stringify(event) + '\n'); };
    send({ type: 'chat', chat: store.public(chat) });
    send({ type: 'budget', budget: lastBudget });
    const messages = new Map();
    let finished = false;
    let startSent = false;
    let interruptSentFor = null;
    let cancellationTimer = null;
    let killTimer = null;
    let stoppingBridge = false;
    let cancellationError;
    let finishTurn;
    const complete = new Promise(resolve => { finishTurn = resolve; });
    const finish = (status, error) => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      clearTimeout(deadline);
      clearTimeout(cancellationTimer);
      clearTimeout(killTimer);
      codex.off('notification', onNotification);
      codex.off('disconnected', onDisconnect);
      chat.active = false;
      chat.updatedAt = Date.now();
      for (const message of messages.values()) message.status = status;
      store.save();
      send({ type: 'done', status, budget: lastBudget, ...(error ? { error } : {}) });
      if (!response.destroyed && !response.writableEnded) response.end();
      finishTurn();
    };
    const stopBridge = () => {
      if (finished || stoppingBridge) return;
      stoppingBridge = true;
      const child = codex.child;
      codex.stop();
      // Keep the lock until this process exits; a new turn must not steer the old one.
      killTimer = setTimeout(() => { if (!finished) child?.kill('SIGKILL'); }, 1000);
    };
    const interrupt = () => {
      if (finished || !lock.turnId || interruptSentFor === lock.turnId) return;
      interruptSentFor = lock.turnId;
      codex.rpc('turn/interrupt', { threadId: chat.threadId, turnId: lock.turnId }, 5000).catch(() => {});
    };
    lock.cancel = error => {
      if (finished) return;
      lock.cancelled = true;
      if (error) cancellationError = error;
      if (!startSent) return;
      if (!cancellationTimer) cancellationTimer = setTimeout(stopBridge, 5000);
      interrupt();
    };
    const onNotification = ({ method, params }) => {
      if (finished || params?.threadId !== chat.threadId || !startSent) return;
      if (method === 'turn/started') {
        if (lock.turnId && lock.turnId !== params.turn.id) return;
        lock.turnId = params.turn.id;
        trackUsageTurn(chat, lock.turnId);
        if (lock.cancelled) interrupt();
        return;
      }
      const turnId = params.turnId || params.turn?.id;
      if (!lock.turnId || turnId !== lock.turnId) return;
      if (method === 'item/agentMessage/delta' || (method === 'item/completed' && params.item.type === 'agentMessage')) {
        const itemId = params.itemId || params.item.id;
        let message = messages.get(itemId);
        if (!message) {
          message = { role: 'assistant', text: '', model: chat.model, effort: chat.effort, status: 'inProgress' };
          chat.messages.push(message);
          messages.set(itemId, message);
        }
        if (method === 'item/agentMessage/delta') { message.text += params.delta; send({ type: 'delta', itemId, delta: params.delta }); }
        else { message.text = params.item.text; send({ type: 'message', itemId, text: message.text }); }
      }
      if (method === 'thread/tokenUsage/updated') {
        send({ type: 'usage', usage: params.tokenUsage, budget: lastBudget });
        send({ type: 'budget', budget: lastBudget });
        if (!lastBudget.allowed) lock.cancel(lastBudget.missing ? 'Nie można zapisać zużycia bramki. Odpowiedź została zatrzymana.' : 'Wykorzystano tygodniowy limit bramki.');
      }
      if (method === 'turn/completed') finish(params.turn.status, cancellationError || params.turn.error?.message);
    };
    const onDisconnect = error => finish(lock.cancelled ? 'interrupted' : 'failed', cancellationError || (lock.cancelled ? undefined : error.message));
    const heartbeat = setInterval(() => { send({ type: 'heartbeat', budget: lastBudget }); store.save(); }, 15_000);
    const deadline = setTimeout(() => {
      lock.cancel('Upłynął limit czasu odpowiedzi.');
    }, 20 * 60_000);
    codex.on('notification', onNotification);
    codex.on('disconnected', onDisconnect);
    startSent = true;
    codex.rpc('turn/start', { threadId: chat.threadId, model: chat.model, effort: chat.effort, input: [{ type: 'text', text: input.text, text_elements: [] }], environments: [], approvalPolicy: 'never', permissions: codex.profile }).then(result => {
      if (finished) return;
      if (lock.turnId && lock.turnId !== result.turn.id) {
        cancellationError = 'Codex zwrócił inną turę rozmowy. Połączenie zostało zatrzymane.';
        lock.cancelled = true;
        stopBridge();
        return;
      }
      lock.turnId = result.turn.id;
      trackUsageTurn(chat, lock.turnId);
      if (['completed', 'interrupted', 'failed'].includes(result.turn.status)) finish(result.turn.status, cancellationError || result.turn.error?.message);
      else if (lock.cancelled) lock.cancel();
    }).catch(error => { if (!finished) lock.cancel(error.message); });
    await complete;
  } finally {
    response.off('close', onResponseClose);
    if (active === lock) active = null;
  }
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  const origin = request.headers.origin;
  const sameOrigin = origin === `http://${request.headers.host}` || origin === `https://${request.headers.host}`;
  if (origin && !sameOrigin && !allowedOrigins.has(origin)) return json(response, 403, { error: 'Ten adres strony nie ma dostępu do bramki.' });
  if (origin) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  }
  if (request.method === 'OPTIONS') { response.writeHead(204); return response.end(); }
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'GET' && path === '/health') return json(response, 200, { ok: true });
    if (path.startsWith('/api/')) {
      if (request.method === 'POST' && path === '/api/login') return json(response, 200, auth.login((await body(request)).password));
      if (!auth.check(request)) return json(response, 401, { error: 'Zaloguj się do bramki.' });
      if (request.method === 'POST' && path === '/api/logout') { auth.logout(request); return json(response, 200, { ok: true }); }
      if (request.method === 'GET' && path === '/api/status') return json(response, 200, await gatewayStatus());
      if (request.method === 'GET' && path === '/api/chats') return json(response, 200, { chats: store.list() });
      if (request.method === 'DELETE' && path.startsWith('/api/chats/')) return json(response, 200, { deleted: store.delete(path.slice('/api/chats/'.length)) });
      if (request.method === 'POST' && path === '/api/chat') return await chatTurn(request, response, await body(request));
      if (request.method === 'POST' && path === '/api/stop') {
        const { chatId } = await body(request);
        if (typeof chatId !== 'string' || !chatId) return json(response, 400, { error: 'Podaj rozmowę do zatrzymania.' });
        if (active && (active.chat?.id === chatId || active.requestedChatId === chatId)) {
          active.cancelled = true;
          active.cancel?.();
        }
        return json(response, 200, { ok: true });
      }
      return json(response, 404, { error: 'Nie znaleziono funkcji.' });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Metoda niedostępna.' });
    const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/config.js': ['config.js', 'text/javascript'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
    const file = files[path];
    if (!file) return json(response, 404, { error: 'Nie znaleziono strony.' });
    response.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : readFileSync(join(root, 'public', file[0])));
  } catch (error) {
    if (response.headersSent) {
      if (!response.destroyed) response.end(JSON.stringify({ type: 'error', message: error.message }) + '\n');
    } else json(response, error.status || 503, { error: error.message, ...(error.budget ? { budget: error.budget } : {}) });
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(Number(process.env.PORT || 8787), '127.0.0.1', () => console.log(`Codex Chat: http://127.0.0.1:${server.address().port}`));
function shutdown() { codex.stop(); server.close(); setTimeout(() => process.exit(), 1000).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
