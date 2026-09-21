import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export const MODEL_NAMES = new Map([['gpt-6-astra', 'Astra'], ['gpt-5.6-sol', 'Sol']]);
const EFFORT_NAMES = { none: 'Bez rozumowania', minimal: 'Minimalny', low: 'Niski', medium: 'Średni', high: 'Wysoki', xhigh: 'Bardzo wysoki', max: 'Maksymalny', ultra: 'Ultra' };
export function pickerModels(models) {
  return [...MODEL_NAMES].flatMap(([id, name]) => {
    const model = models.find(entry => entry.model === id && !entry.hidden);
    if (!model) return [];
    return [{ id, name, defaultEffort: model.defaultReasoningEffort, efforts: (model.supportedReasoningEfforts || []).map(entry => ({ id: entry.reasoningEffort, label: EFFORT_NAMES[entry.reasoningEffort] || entry.reasoningEffort })) }];
  });
}
export function codexBinary() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  return ['/Applications/ChatGPT.app/Contents/Resources/codex', '/Applications/Codex.app/Contents/Resources/codex'].find(existsSync) || 'codex';
}
const DISABLED_FEATURES = ['apps', 'plugins', 'hooks', 'shell_tool', 'unified_exec', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'view_image', 'memories', 'chronicle', 'skill_search', 'goals', 'workspace_dependencies', 'multi_agent', 'multi_agent_v2', 'code_mode_host', 'code_mode', 'code_mode_only', 'shell_snapshot', 'request_permissions_tool', 'standalone_web_search', 'tool_suggest', 'in_app_browser', 'in_app_dictation', 'realtime_conversation', 'sleep_tool'];
export const CHAT_INSTRUCTIONS = 'Jesteś pomocnym rozmówcą w zwykłym czacie. Odpowiadaj po polsku, chyba że użytkownik wybierze inny język. Pisz jasno i naturalnie. Oddzielaj fakty od przypuszczeń. Nie masz dostępu do komputera, plików, przeglądarki, narzędzi ani aplikacji. Nie uruchamiaj poleceń i nie wykonuj działań poza rozmową. Nie deklaruj, że coś sprawdziłeś w internecie lub na komputerze. Możesz pisać kod i wyjaśniać go jako tekst.';

export class CodexBridge extends EventEmitter {
  constructor(workspace) {
    super();
    this.workspace = workspace;
    this.profile = 'codex_chat_gateway_' + randomBytes(12).toString('hex');
    this.pending = new Map();
    this.sequence = 0;
    this.loaded = new Set();
  }
  async ready() {
    if (!this.boot) this.boot = this.start().catch(error => { this.boot = null; throw error; });
    return this.boot;
  }
  async start() {
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    delete env.OPENAI_BASE_URL;
    const permissions = `permissions.${this.profile}={filesystem={":root"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny",${JSON.stringify(this.workspace)}="read"},network={enabled=false}}`;
    const args = ['app-server', '--listen', 'stdio://', '--strict-config', '-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"', '-c', 'web_search="disabled"', '-c', 'mcp_servers={}', '-c', 'project_doc_max_bytes=0', '-c', 'notify=[]', '-c', `default_permissions="${this.profile}"`, '-c', permissions, '-c', 'apps._default.enabled=false', '-c', 'orchestrator.skills.enabled=false', '-c', 'skills.include_instructions=false', '-c', 'tools.experimental_request_user_input.enabled=false', '-c', 'tools.update_plan.enabled=false', ...DISABLED_FEATURES.flatMap(name => ['-c', `features.${name}=false`])];
    this.child = spawn(codexBinary(), args, { cwd: this.workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', () => {}); // Do not expose credentials or model content in service logs.
    this.child.stdin.on('error', () => {});
    this.child.once('error', error => this.fail(new Error(`Nie można uruchomić Codexa: ${error.message}`)));
    this.child.once('exit', () => this.fail(new Error('Połączenie z Codexem zostało zamknięte.')));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && message.method) {
        // This integration never approves computer operations or delegates tool calls.
        if (message.method === 'item/permissions/requestApproval') this.write({ id: message.id, result: { permissions: {}, scope: 'turn' } });
        else if (/requestApproval$/.test(message.method)) this.write({ id: message.id, result: { decision: 'cancel' } });
        else this.write({ id: message.id, error: { code: -32601, message: 'Narzędzia nie są dostępne w tej bramce.' } });
        if (message.params?.threadId && message.params?.turnId) this.rpc('turn/interrupt', { threadId: message.params.threadId, turnId: message.params.turnId }).catch(() => this.stop());
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else if (message.method) this.emit('notification', message);
    });
    await this.rpc('initialize', { clientInfo: { name: 'codex_chat_gateway', title: 'Codex Chat', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    this.write({ method: 'initialized', params: {} });
    // Empty TOML tables merge with user config; disable inherited entries individually.
    const { config } = await this.rpc('config/read', { includeLayers: false });
    this.threadConfig = { web_search: 'disabled', project_doc_max_bytes: 0,
      ...Object.fromEntries(Object.keys(config.mcp_servers || {}).map(name => [`mcp_servers.${name}.enabled`, false])),
      ...Object.fromEntries(Object.keys(config.plugins || {}).map(name => [`plugins.${name}.enabled`, false])) };
  }
  fail(error) {
    this.boot = null;
    this.loaded.clear();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.emit('disconnected', error);
  }
  write(message) {
    if (!this.child?.stdin.writable) throw new Error('Codex jest niedostępny.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  rpc(method, params, timeout = 45_000) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex nie odpowiedział (${method}).`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async status() {
    await this.ready();
    const { account } = await this.rpc('account/read', { refreshToken: false });
    if (account?.type !== 'chatgpt') throw Object.assign(new Error('Zaloguj Codexa do ChatGPT na komputerze obsługującym bramkę. Bramka wymaga logowania ChatGPT i nie używa klucza API.'), { status: 503 });
    let cursor = null;
    const allModels = [];
    do {
      const result = await this.rpc('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      allModels.push(...result.data);
      cursor = result.nextCursor;
    } while (cursor);
    let rateLimits = null;
    try { rateLimits = await this.limits(); } catch {}
    return { connected: true, authMode: 'chatgpt', models: pickerModels(allModels), rateLimits };
  }
  async limits() {
    await this.ready();
    return this.rpc('account/rateLimits/read', {}, 10_000);
  }
  async thread(chat) {
    const common = { model: chat.model, modelProvider: 'openai', cwd: this.workspace, baseInstructions: CHAT_INSTRUCTIONS, developerInstructions: CHAT_INSTRUCTIONS, approvalPolicy: 'never', permissions: this.profile, config: this.threadConfig };
    if (!chat.threadId) {
      const result = await this.rpc('thread/start', { ...common, environments: [], ephemeral: false, allowProviderModelFallback: false, serviceName: 'codex_chat_gateway' });
      chat.threadId = result.thread.id;
      this.loaded.add(chat.threadId);
    } else if (!this.loaded.has(chat.threadId)) {
      await this.rpc('thread/resume', { ...common, threadId: chat.threadId });
      this.loaded.add(chat.threadId);
    }
    return chat.threadId;
  }
  stop() { this.child?.kill('SIGTERM'); }
}
