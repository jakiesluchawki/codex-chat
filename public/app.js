"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const el = Object.fromEntries([
    "app", "sidebar", "sidebar-scrim", "open-sidebar", "close-sidebar", "login-screen", "login-form",
    "login-title", "login-error", "login-submit", "back-to-chat", "gateway-details", "gateway-url",
    "gateway-hint", "password", "new-chat", "chat-list", "chat-title", "model", "effort", "conversation",
    "empty-state", "empty-description", "messages", "composer", "prompt", "composer-hint", "send", "stop",
    "connection-indicator", "connection-text", "rate-limits", "budget-note", "budget-details", "budget-estimate", "budget-method-note", "account-limits-details", "account-rate-limits", "refresh", "connection-settings", "clear-history",
    "logout", "app-error", "announcement", "delete-dialog", "delete-title", "delete-description",
    "delete-error", "delete-cancel", "delete-confirm",
  ].map((id) => [id, $(id)]));
  const allowedModels = new Set(["gpt-6-astra", "gpt-5.6-sol"]);
  const effortLabels = { none: "Bez rozumowania", minimal: "Minimalny", low: "Niski", medium: "Średni", high: "Wysoki", xhigh: "Bardzo wysoki", max: "Maksymalny", ultra: "Ultra" };
  const mobile = window.matchMedia("(max-width: 700px)");
  const runtimeGateway = String(window.CHAT_GATEWAY_URL || "").trim();
  const isGitHubPages = location.hostname === "github.io" || location.hostname.endsWith(".github.io");
  const state = {
    gateway: runtimeGateway || storageRead(localStorage, "codex-chat-gateway") || (isGitHubPages ? "" : location.origin),
    token: "", ready: false, models: [], chats: [], selectedId: null, model: "", effort: "", run: null, budget: null,
    sidebarOpen: false, deleting: false, deleteIds: [], renderScheduled: false, forceScroll: false,
    preferences: parseStored(storageRead(localStorage, "codex-chat-preferences")),
  };

  class ApiError extends Error {
    constructor(message, status = 0) { super(message); this.status = status; }
  }

  function storageRead(storage, key) { try { return storage.getItem(key) || ""; } catch { return ""; } }
  function storageWrite(storage, key, value) { try { storage.setItem(key, value); } catch { /* Czat działa również bez zapisu preferencji. */ } }
  function storageRemove(storage, key) { try { storage.removeItem(key); } catch { /* Brak dostępu do pamięci przeglądarki. */ } }
  function parseStored(value) { try { return JSON.parse(value) || {}; } catch { return {}; } }
  function sessionKey() { return `codex-chat-session:${state.gateway}`; }
  function activeChat() { return state.run?.chat || state.chats.find((chat) => chat.active); }
  function isBusy() { return Boolean(activeChat()); }
  function budgetAllowsSend() { return state.budget?.enabled === true && state.budget.allowed === true; }
  function budgetHint() { return state.budget?.allowed === false ? "Limit bramki wykorzystany. Poczekaj na odnowienie." : "Limit bramki jest sprawdzany."; }
  function selectedChat() { return state.chats.find((chat) => chat.id === state.selectedId); }
  function modelName(id) { return state.models.find((model) => model.id === id)?.name || ({ "gpt-6-astra": "Astra", "gpt-5.6-sol": "Sol" }[id]) || "Codex"; }
  function effortName(id) { return effortLabels[id] || state.models.find((model) => model.id === state.model)?.efforts.find((effort) => effort.id === id)?.label || id || ""; }
  function setError(message) { el["app-error"].textContent = message || ""; el["app-error"].hidden = !message; }
  function announce(message) { el.announcement.textContent = message; }
  function normalizeGateway(value) {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) throw new Error("Podaj sam adres bramki, bez hasła, parametrów ani fragmentu strony.");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(local && url.protocol === "http:") && url.origin !== location.origin) throw new Error("Bramka musi mieć adres HTTPS.");
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("Podaj poprawny adres HTTPS bramki.");
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  }
  function savePreferences() {
    const efforts = { ...(state.preferences.efforts || {}) };
    if (state.model && state.effort) efforts[state.model] = state.effort;
    state.preferences = { model: state.model, efforts };
    storageWrite(localStorage, "codex-chat-preferences", JSON.stringify(state.preferences));
  }

  async function request(path, options = {}) {
    if (!state.gateway) throw new ApiError("Podaj adres HTTPS bramki na Macu Studio.");
    const { auth = true, ...fetchOptions } = options;
    const headers = new Headers(fetchOptions.headers || {});
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (fetchOptions.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (auth && state.token) headers.set("Authorization", `Bearer ${state.token}`);
    let response;
    try {
      response = await fetch(`${state.gateway}${path}`, { ...fetchOptions, headers, credentials: "omit", cache: "no-store" });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new ApiError("Nie udało się połączyć z bramką. Sprawdź jej adres i czy Mac Studio jest dostępny.");
    }
    if (!response.ok) {
      let message = response.status === 401 ? "Sesja wygasła lub hasło jest nieprawidłowe. Zaloguj się ponownie." : `Bramka zwróciła błąd ${response.status}.`;
      try {
        const body = await response.json();
        if (body.budget) applyBudget(body.budget);
        const serverMessage = body.error?.message || body.error || body.message;
        if (typeof serverMessage === "string") message = serverMessage.slice(0, 500);
      } catch { /* Odpowiedź serwera nie zawsze jest JSON-em. */ }
      throw new ApiError(message, response.status);
    }
    return response;
  }
  async function jsonRequest(path, options) {
    const response = await request(path, options);
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { throw new ApiError("Bramka zwróciła nieprawidłową odpowiedź."); }
  }

  function showLogin(message = "") {
    el.app.hidden = true;
    el["login-screen"].hidden = false;
    el["login-error"].textContent = message;
    el["login-error"].hidden = !message;
    el["login-title"].textContent = state.gateway ? "Bramka wymaga hasła" : "Połącz z bramką";
    el["gateway-url"].value = state.gateway;
    el["gateway-url"].readOnly = Boolean(runtimeGateway);
    el["gateway-hint"].textContent = runtimeGateway ? "Adres ustawiony w konfiguracji tej strony." : "Adres HTTPS serwera działającego na Macu Studio.";
    el["gateway-details"].open = !state.gateway;
    el["back-to-chat"].hidden = !state.ready;
    closeSidebar();
    queueMicrotask(() => (state.gateway ? el.password : el["gateway-url"]).focus());
  }
  function showApp() {
    el["login-screen"].hidden = true;
    el.app.hidden = false;
    el.password.value = "";
    render();
  }
  function handleError(error) {
    if (error.status === 401) {
      state.ready = false;
      state.token = "";
      storageRemove(sessionStorage, sessionKey());
      showLogin(error.message);
    } else setError(error.message || "Nie udało się wykonać operacji.");
  }

  function normalizeMessage(message) {
    return { ...message, role: message.role, text: String(message.text ?? "") };
  }
  function normalizeChat(chat) {
    return {
      ...chat, id: String(chat.id), title: String(chat.title || "Nowa rozmowa"),
      messages: Array.isArray(chat.messages) ? chat.messages.filter((message) => ["user", "assistant"].includes(message.role)).map(normalizeMessage) : [],
    };
  }
  async function loadChats() {
    const body = await jsonRequest("/api/chats");
    state.chats = Array.isArray(body?.chats) ? body.chats.map(normalizeChat) : [];
    if (state.selectedId && !selectedChat()) state.selectedId = null;
    render();
  }
  function applyStatus(status) {
    state.models = (Array.isArray(status.models) ? status.models : []).filter((model) => allowedModels.has(model.id)).map((model) => ({
      ...model, name: model.id === "gpt-6-astra" ? "Astra" : "Sol",
      efforts: (Array.isArray(model.efforts) ? model.efforts : []).map((effort) => typeof effort === "string" ? { id: effort, label: effortName(effort) } : { id: effort.id, label: effortLabels[effort.id] || effort.label || effort.id }),
    })).filter((model) => model.efforts.length);
    state.ready = status.connected === true && status.authMode === "chatgpt" && state.models.length > 0;
    if (!state.model && state.preferences.model && state.models.some((model) => model.id === state.preferences.model)) chooseModel(state.preferences.model, false);
    if (state.model && !state.models.some((model) => model.id === state.model)) { state.model = ""; state.effort = ""; }
    if (state.model) chooseModel(state.model, false, state.effort);
    el["connection-indicator"].classList.toggle("connected", state.ready);
    el["connection-text"].textContent = state.ready ? "Połączono z Codex · ChatGPT" : "Codex wymaga połączenia";
    renderRateLimits(status.rateLimits);
    applyBudget(status.budget);
    if (!state.ready) {
      const message = status.connected !== true ? "Codex na Macu Studio jest niedostępny. Uruchom go i odśwież połączenie." : status.authMode !== "chatgpt" ? "Zaloguj Codexa na Macu Studio przez konto ChatGPT, aby korzystać z jego limitów." : "Codex nie udostępnił teraz modeli Astra ani Sol. Odśwież połączenie po sprawdzeniu konfiguracji.";
      setError(message);
    }
  }
  async function bootstrap() {
    el.app.setAttribute("aria-busy", "true");
    if (!state.gateway) { showLogin(); return; }
    try {
      state.gateway = normalizeGateway(state.gateway);
      state.token ||= storageRead(sessionStorage, sessionKey());
      if (!state.token) { showLogin(); return; }
      const status = await jsonRequest("/api/status");
      setError("");
      applyStatus(status || {});
      await loadChats();
      showApp();
    } catch (error) {
      state.ready = false;
      if (error.status === 401) handleError(error);
      else showLogin(error.message || "Nie udało się połączyć z bramką.");
    } finally { el.app.setAttribute("aria-busy", "false"); renderControls(); }
  }

  function chooseModel(id, save = true, requestedEffort = "") {
    const model = state.models.find((item) => item.id === id);
    state.model = model?.id || "";
    const desired = requestedEffort || state.preferences.efforts?.[id] || model?.defaultEffort;
    state.effort = model?.efforts.some((effort) => effort.id === desired) ? desired : model?.efforts[0]?.id || "";
    if (save) savePreferences();
    renderSelectors();
    renderControls();
  }
  function renderSelectors() {
    const placeholder = document.createElement("option");
    placeholder.value = ""; placeholder.textContent = "Wybierz model";
    el.model.replaceChildren(placeholder);
    for (const model of state.models) {
      const option = document.createElement("option"); option.value = model.id; option.textContent = model.name; el.model.append(option);
    }
    el.model.value = state.model;
    el.effort.replaceChildren();
    const model = state.models.find((item) => item.id === state.model);
    if (!model) {
      const option = document.createElement("option"); option.value = ""; option.textContent = "Wybierz model najpierw"; el.effort.append(option);
    } else for (const effort of model.efforts) {
      const option = document.createElement("option"); option.value = effort.id; option.textContent = effort.label; el.effort.append(option);
    }
    el.effort.value = state.effort;
  }
  function renderControls() {
    const busy = isBusy();
    el.model.disabled = !state.ready || busy;
    el.effort.disabled = !state.ready || !state.model || busy;
    el.prompt.disabled = !state.ready;
    el.send.disabled = !state.ready || !state.model || !state.effort || !el.prompt.value.trim() || busy || !budgetAllowsSend();
    el.send.hidden = busy;
    el.stop.hidden = !busy;
    el.stop.disabled = Boolean(state.run?.stopping);
    el.stop.textContent = state.run?.stopping ? "Zatrzymywanie…" : "■ Zatrzymaj";
    el["clear-history"].disabled = !state.chats.length || busy || state.deleting;
    el.refresh.disabled = busy;
    el["connection-settings"].disabled = busy;
    el.logout.disabled = busy;
    el["composer-hint"].textContent = !state.ready ? "Oczekiwanie na połączenie z Codexem." : state.budget?.allowed === false ? budgetHint() : busy ? (activeChat()?.id !== state.selectedId ? "Codex odpowiada w innej rozmowie." : "Codex odpowiada…") : !budgetAllowsSend() ? budgetHint() : !state.model ? "Najpierw wybierz model." : "Enter — wyślij · Shift + Enter — nowa linia";
    el["empty-description"].textContent = !state.ready ? "Łączenie z Codexem…" : !state.model ? "Wybierz model i zacznij rozmowę." : `${modelName(state.model)} · ${effortName(state.effort)}. Napisz pierwszą wiadomość.`;
  }
  function renderChatList() {
    const fragment = document.createDocumentFragment();
    const chats = [...state.chats].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    if (!chats.length) {
      const note = document.createElement("p"); note.className = "chat-list-empty"; note.textContent = "Twoje rozmowy pojawią się tutaj."; fragment.append(note);
    }
    for (const chat of chats) {
      const row = document.createElement("div"); row.className = "chat-list-item"; row.classList.toggle("selected", chat.id === state.selectedId);
      const select = document.createElement("button"); select.type = "button"; select.className = "chat-list-select";
      select.setAttribute("aria-current", chat.id === state.selectedId ? "true" : "false");
      const title = document.createElement("span"); title.className = "chat-list-name"; title.textContent = chat.title; select.append(title);
      const meta = document.createElement("span"); meta.className = "chat-list-meta";
      const date = new Date(chat.updatedAt); const day = Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("pl-PL", { day: "numeric", month: "short" });
      meta.textContent = [modelName(chat.model), chat.active ? "Odpowiada…" : day].filter(Boolean).join(" · "); select.append(meta);
      select.addEventListener("click", () => {
        state.selectedId = chat.id;
        chooseModel(chat.model, false, chat.effort);
        state.forceScroll = true; setError(""); render(); closeSidebar();
      });
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "chat-delete"; remove.textContent = "×"; remove.disabled = isBusy() || state.deleting;
      remove.setAttribute("aria-label", `Usuń rozmowę: ${chat.title}`); remove.title = "Usuń rozmowę";
      remove.addEventListener("click", () => openDelete([chat.id]));
      row.append(select, remove); fragment.append(row);
    }
    el["chat-list"].replaceChildren(fragment);
  }

  // Wszystkie treści modelu trafiają do węzłów tekstowych. HTML nigdy nie jest wykonywany.
  function appendInline(parent, text) {
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
    let position = 0;
    for (const match of text.matchAll(pattern)) {
      parent.append(document.createTextNode(text.slice(position, match.index)));
      const token = match[0];
      if (token.startsWith("`")) { const code = document.createElement("code"); code.textContent = token.slice(1, -1); parent.append(code); }
      else if (token.startsWith("**")) { const strong = document.createElement("strong"); strong.textContent = token.slice(2, -2); parent.append(strong); }
      else {
        const split = token.indexOf("](");
        try {
          const url = new URL(token.slice(split + 2, -1));
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Unsafe link");
          const link = document.createElement("a"); link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = token.slice(1, split); parent.append(link);
        } catch { parent.append(document.createTextNode(token)); }
      }
      position = match.index + token.length;
    }
    parent.append(document.createTextNode(text.slice(position)));
  }
  function appendProse(parent, text) {
    let paragraph = [], list = null;
    function flush() {
      if (!paragraph.length) return;
      const p = document.createElement("p"); appendInline(p, paragraph.join("\n")); parent.append(p); paragraph = [];
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) { flush(); list = null; continue; }
      const heading = line.match(/^(#{1,4})\s+(.+)$/);
      const bullet = line.match(/^\s*(?:([-*])|\d+[.)])\s+(.+)$/);
      if (heading) {
        flush(); list = null; const node = document.createElement(`h${Math.min(heading[1].length + 1, 4)}`); appendInline(node, heading[2]); parent.append(node);
      } else if (bullet) {
        flush(); const tag = bullet[1] ? "UL" : "OL";
        if (!list || list.tagName !== tag) { list = document.createElement(tag.toLowerCase()); parent.append(list); }
        const li = document.createElement("li"); appendInline(li, bullet[2]); list.append(li);
      } else { list = null; paragraph.push(line); }
    }
    flush();
  }
  function renderMarkdown(parent, text) {
    const fence = /```([^\n]*)\n([\s\S]*?)(?:```|$)/g;
    let position = 0;
    for (const match of text.matchAll(fence)) {
      appendProse(parent, text.slice(position, match.index));
      const block = document.createElement("div"); block.className = "code-block";
      const header = document.createElement("div"); header.className = "code-header";
      const language = document.createElement("span"); language.textContent = match[1].trim().slice(0, 50) || "Kod";
      const copy = document.createElement("button"); copy.type = "button"; copy.className = "copy-code"; copy.textContent = "Kopiuj";
      const codeText = match[2].replace(/\n$/, "");
      copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(codeText); copy.textContent = "Skopiowano"; }
        catch { copy.textContent = "Nie udało się skopiować"; }
        setTimeout(() => { copy.textContent = "Kopiuj"; }, 2000);
      });
      header.append(language, copy);
      const pre = document.createElement("pre"); const code = document.createElement("code"); code.textContent = codeText; pre.append(code); block.append(header, pre); parent.append(block);
      position = match.index + match[0].length;
    }
    appendProse(parent, text.slice(position));
  }
  function renderConversation() {
    const chat = selectedChat();
    const nearBottom = el.conversation.scrollHeight - el.conversation.scrollTop - el.conversation.clientHeight < 100;
    el["chat-title"].textContent = chat?.title || "Nowa rozmowa";
    el["empty-state"].hidden = Boolean(chat?.messages.length || chat?.active);
    const fragment = document.createDocumentFragment();
    for (const message of chat?.messages || []) {
      const article = document.createElement("article"); article.className = `message ${message.role}`;
      const avatar = document.createElement("span"); avatar.className = "message-avatar"; avatar.setAttribute("aria-hidden", "true"); avatar.textContent = message.role === "user" ? "Ty" : "C";
      const content = document.createElement("div"); content.className = "message-content";
      const meta = document.createElement("div"); meta.className = "message-meta";
      const name = document.createElement("span"); name.textContent = message.role === "user" ? "Ty" : modelName(message.model || chat.model); meta.append(name);
      if (message.role === "assistant" && (message.effort || chat.effort)) { const detail = document.createElement("span"); detail.className = "message-detail"; detail.textContent = effortName(message.effort || chat.effort); meta.append(detail); }
      const body = document.createElement("div"); body.className = "message-body";
      if (message.role === "user") body.textContent = message.text; else renderMarkdown(body, message.text);
      content.append(meta, body);
      if (["interrupted", "stopped", "cancelled", "failed", "error"].includes(message.status)) {
        const note = document.createElement("p"); note.className = "message-state"; note.textContent = ["failed", "error"].includes(message.status) ? "Odpowiedź zakończona błędem." : "Generowanie przerwane."; content.append(note);
      }
      article.append(avatar, content); fragment.append(article);
    }
    if (chat?.active && !(state.run?.chat.id === chat.id && state.run.assistantItems.size)) {
      const pending = document.createElement("div"); pending.className = "pending";
      const dot = document.createElement("span"); dot.className = "pending-dot"; dot.setAttribute("aria-hidden", "true");
      pending.append(dot, document.createTextNode("Codex odpowiada…")); fragment.append(pending);
    }
    el.messages.replaceChildren(fragment);
    if (nearBottom || state.forceScroll) el.conversation.scrollTop = el.conversation.scrollHeight;
    state.forceScroll = false;
  }
  function applyBudget(budget) {
    state.budget = budget && typeof budget === "object" ? budget : null;
    const fragment = document.createDocumentFragment();
    const windows = Array.isArray(state.budget?.windows) ? state.budget.windows : [];
    for (const window of windows) {
      const row = document.createElement("div");
      const fraction = window.remainingFractionPercent;
      const remaining = typeof fraction === "number" && Number.isFinite(fraction) ? `${Math.max(0, Math.min(100, fraction)).toLocaleString("pl-PL", { maximumFractionDigits: 1 })}% pozostało` : "sprawdzanie limitu";
      row.textContent = `Limit bramki: ${remaining}${window.label ? ` · ${String(window.label)}` : ""}`;
      fragment.append(row);
    }
    if (!windows.length || state.budget?.enabled !== true) {
      fragment.replaceChildren(document.createTextNode("Limit bramki jest sprawdzany."));
    }
    el["rate-limits"].replaceChildren(fragment);
    el["rate-limits"].hidden = false;
    const hasBudget = state.budget?.enabled === true && windows.length > 0;
    el["budget-note"].textContent = hasBudget ? "Zużycie poza bramką nie pomniejsza jej puli." : "";
    el["budget-note"].hidden = !el["budget-note"].textContent;
    el["budget-details"].hidden = !hasBudget;
    el["budget-estimate"].textContent = hasBudget ? "Cel: około 10% limitu konta; pula szacowana i dostrajana na podstawie pomiarów." : "";
    el["budget-method-note"].textContent = hasBudget ? String(state.budget.note || "To orientacyjny limit ustalony przez bramkę. Nie jest osobną pulą przyznaną przez OpenAI.") : "";
    renderControls();
  }
  function renderRateLimits(limits) {
    const windows = [];
    const seen = new Set();
    function visit(value, depth = 0) {
      if (!value || typeof value !== "object" || depth > 5 || windows.length >= 2) return;
      if (typeof value.usedPercent === "number" && Number.isFinite(value.usedPercent)) {
        const key = `${value.windowDurationMins}:${value.resetsAt}:${value.usedPercent}`;
        if (seen.has(key)) return;
        seen.add(key);
        const mins = Number(value.windowDurationMins);
        const period = mins >= 1440 ? `${Math.round(mins / 1440)} dni` : mins >= 60 ? `${Math.round(mins / 60)} h` : mins > 0 ? `${mins} min` : "";
        const left = Math.max(0, Math.min(100, Math.round(100 - value.usedPercent)));
        windows.push(`${period ? `Limit ${period}` : "Limit"}: ${left}% pozostało`); return;
      }
      for (const child of Object.values(value)) visit(child, depth + 1);
    }
    visit(limits);
    el["account-rate-limits"].textContent = windows.join(" · ");
    el["account-limits-details"].hidden = !windows.length;
  }
  function render() { renderSelectors(); renderControls(); renderChatList(); renderConversation(); }
  function scheduleRender(forceScroll = false) {
    state.forceScroll ||= forceScroll;
    if (state.renderScheduled) return;
    state.renderScheduled = true;
    requestAnimationFrame(() => { state.renderScheduled = false; renderControls(); renderChatList(); renderConversation(); });
  }
  function resizePrompt() { el.prompt.style.height = "auto"; el.prompt.style.height = `${Math.min(el.prompt.scrollHeight, mobile.matches ? 160 : 220)}px`; }

  function streamEvent(run, event) {
    if (event.type === "chat" && event.chat) {
      const oldId = run.chat.id;
      Object.assign(run.chat, normalizeChat(event.chat), { active: true });
      if (state.selectedId === oldId) state.selectedId = run.chat.id;
      run.accepted = true;
    } else if (event.type === "delta" || event.type === "message") {
      const itemId = String(event.itemId || "assistant");
      let message = run.assistantItems.get(itemId);
      if (!message) {
        message = { role: "assistant", text: "", model: run.model, effort: run.effort, status: "streaming" };
        run.assistantItems.set(itemId, message); run.chat.messages.push(message);
      }
      if (event.type === "delta") message.text += String(event.delta || "");
      else message.text = String(event.text ?? "");
    } else if (event.type === "usage") {
      run.usage = event.usage;
      if (event.usage?.rateLimits) renderRateLimits(event.usage.rateLimits);
      if (event.usage?.budget) applyBudget(event.usage.budget);
    } else if (event.type === "budget" || (event.type === "heartbeat" && event.budget)) {
      applyBudget(event.budget);
    } else if (event.type === "error") {
      run.error = String(event.message || "Codex zakończył odpowiedź błędem."); setError(run.error);
    } else if (event.type === "done") {
      run.done = true; run.finalStatus = event.status || (event.error || run.error ? "failed" : "completed");
      if (event.budget) applyBudget(event.budget);
      if (event.error) { run.error = String(event.error?.message || event.error); setError(run.error); }
    }
    scheduleRender();
  }
  async function readStream(response, run) {
    if (!response.body) throw new ApiError("Przeglądarka nie udostępniła strumienia odpowiedzi.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    function consume(line) {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { throw new ApiError("Bramka zwróciła nieprawidłowy fragment odpowiedzi."); }
      streamEvent(run, event);
    }
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
        if (done) break;
      }
      if (buffer.trim()) consume(buffer);
      if (!run.done) throw new ApiError("Połączenie zostało przerwane. Częściowa odpowiedź została zachowana.");
    } finally {
      if (!run.done) { try { await reader.cancel(); } catch { /* Połączenie mogło już zostać zamknięte. */ } }
      reader.releaseLock();
    }
  }
  async function sendMessage(event) {
    event.preventDefault();
    const text = el.prompt.value.trim();
    if (!text || !state.ready || !state.model || !state.effort || isBusy() || !budgetAllowsSend()) return;
    let chat = selectedChat();
    const isNew = !chat;
    if (!chat) {
      chat = { id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`, title: text.slice(0, 55), model: state.model, effort: state.effort, updatedAt: new Date().toISOString(), messages: [] };
      state.chats.push(chat); state.selectedId = chat.id;
    }
    const before = { messages: [...chat.messages], model: chat.model, effort: chat.effort, updatedAt: chat.updatedAt };
    const run = { chat, isNew, model: state.model, effort: state.effort, assistantItems: new Map(), controller: new AbortController(), accepted: false, done: false, stopping: false, error: "", finalStatus: "completed" };
    state.run = run;
    chat.messages.push({ role: "user", text }); chat.model = state.model; chat.effort = state.effort; chat.active = true; chat.updatedAt = new Date().toISOString();
    el.prompt.value = ""; resizePrompt(); setError(""); state.forceScroll = true; render(); announce("Codex odpowiada.");
    try {
      const body = { text, model: run.model, effort: run.effort };
      if (!isNew) body.chatId = chat.id;
      const response = await request("/api/chat", { method: "POST", signal: run.controller.signal, headers: { Accept: "application/x-ndjson" }, body: JSON.stringify(body) });
      await readStream(response, run);
    } catch (error) {
      run.finalStatus = run.accepted ? "interrupted" : "failed";
      if (!run.accepted) {
        if (isNew) { state.chats = state.chats.filter((item) => item !== chat); state.selectedId = null; }
        else Object.assign(chat, before);
        el.prompt.value = text; resizePrompt();
      }
      if (error.name !== "AbortError" || !run.stopping) handleError(error);
    } finally {
      chat.active = false;
      for (const message of run.assistantItems.values()) message.status = run.finalStatus;
      const refreshStatus = Boolean((run.accepted || run.stopping) && state.token);
      if (refreshStatus) applyBudget(null);
      state.run = null;
      render(); announce(run.finalStatus === "completed" ? "Odpowiedź jest gotowa." : "Generowanie zakończone.");
      if (refreshStatus) {
        const [chatsResult, statusResult] = await Promise.allSettled([loadChats(), jsonRequest("/api/status")]);
        if (statusResult.status === "fulfilled") applyStatus(statusResult.value || {});
        else { applyBudget(null); handleError(statusResult.reason); }
        if (chatsResult.status === "rejected") handleError(chatsResult.reason);
        render();
      }
      if (!el.app.hidden) el.prompt.focus();
    }
  }
  async function stopGeneration() {
    const chat = activeChat(); if (!chat) return;
    if (state.run) state.run.stopping = true;
    renderControls();
    if (state.run && !state.run.accepted) { state.run.controller.abort(); return; }
    try {
      await jsonRequest("/api/stop", { method: "POST", body: JSON.stringify({ chatId: chat.id.startsWith("pending-") ? undefined : chat.id }) });
      if (!state.run) await loadChats();
    } catch (error) { if (state.run) state.run.stopping = false; handleError(error); renderControls(); }
  }

  function updateSidebar() {
    el.app.classList.toggle("sidebar-open", state.sidebarOpen && mobile.matches);
    el["sidebar-scrim"].hidden = !(state.sidebarOpen && mobile.matches);
    el["open-sidebar"].setAttribute("aria-expanded", String(state.sidebarOpen));
    el.sidebar.inert = mobile.matches && !state.sidebarOpen;
    document.querySelector("main").inert = mobile.matches && state.sidebarOpen;
  }
  function openSidebar() { state.sidebarOpen = true; updateSidebar(); el["close-sidebar"].focus(); }
  function closeSidebar() {
    const wasOpen = state.sidebarOpen; state.sidebarOpen = false; updateSidebar();
    if (wasOpen && !el.app.hidden && mobile.matches) el["open-sidebar"].focus();
  }
  function openDelete(ids) {
    if (isBusy() || !ids.length) return;
    state.deleteIds = ids;
    el["delete-title"].textContent = ids.length === 1 ? "Usunąć tę rozmowę?" : "Usunąć historię rozmów?";
    el["delete-description"].textContent = ids.length === 1 ? "Ta rozmowa zostanie usunięta z bramki. Tej operacji nie można cofnąć." : `Wszystkie zapisane rozmowy (${ids.length}) zostaną usunięte z bramki. Tej operacji nie można cofnąć.`;
    el["delete-error"].hidden = true; el["delete-dialog"].showModal(); el["delete-cancel"].focus();
  }
  async function confirmDelete() {
    if (state.deleting) return;
    state.deleting = true; el["delete-confirm"].disabled = true; el["delete-cancel"].disabled = true; el["delete-confirm"].textContent = "Usuwanie…";
    try {
      for (const id of [...state.deleteIds]) {
        await jsonRequest(`/api/chats/${encodeURIComponent(id)}`, { method: "DELETE" });
        state.chats = state.chats.filter((chat) => chat.id !== id); state.deleteIds = state.deleteIds.filter((item) => item !== id);
        if (state.selectedId === id) state.selectedId = null;
      }
      el["delete-dialog"].close(); announce("Rozmowy zostały usunięte.");
    } catch (error) {
      if (error.status === 401) { el["delete-dialog"].close(); handleError(error); }
      else { el["delete-error"].textContent = error.message; el["delete-error"].hidden = false; }
    } finally {
      state.deleting = false; el["delete-confirm"].disabled = false; el["delete-cancel"].disabled = false; el["delete-confirm"].textContent = "Usuń"; render();
    }
  }

  el["login-form"].addEventListener("submit", async (event) => {
    event.preventDefault(); el["login-error"].hidden = true; el["login-submit"].disabled = true; el["login-submit"].textContent = "Logowanie…";
    try {
      const gateway = normalizeGateway(el["gateway-url"].value.trim() || state.gateway);
      state.gateway = gateway;
      if (!runtimeGateway) storageWrite(localStorage, "codex-chat-gateway", gateway);
      state.token = ""; state.ready = false; applyBudget(null); el["back-to-chat"].hidden = true;
      const body = await jsonRequest("/api/login", { method: "POST", auth: false, body: JSON.stringify({ password: el.password.value }) });
      if (!body?.sessionToken || typeof body.sessionToken !== "string") throw new ApiError("Bramka nie potwierdziła logowania.");
      state.token = body.sessionToken; storageWrite(sessionStorage, sessionKey(), state.token); el.password.value = "";
      await bootstrap();
    } catch (error) { el["login-error"].textContent = error.message || "Logowanie nie powiodło się."; el["login-error"].hidden = false; }
    finally { el["login-submit"].disabled = false; el["login-submit"].textContent = "Zaloguj się"; }
  });
  el["back-to-chat"].addEventListener("click", showApp);
  el.model.addEventListener("change", () => chooseModel(el.model.value));
  el.effort.addEventListener("change", () => { state.effort = el.effort.value; savePreferences(); renderControls(); });
  el.prompt.addEventListener("input", () => { resizePrompt(); renderControls(); });
  el.prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!el.send.disabled) el.composer.requestSubmit(); }
  });
  el.composer.addEventListener("submit", sendMessage);
  el.stop.addEventListener("click", stopGeneration);
  el["new-chat"].addEventListener("click", () => { state.selectedId = null; el.prompt.value = ""; resizePrompt(); setError(""); render(); closeSidebar(); el.prompt.focus(); });
  el["open-sidebar"].addEventListener("click", openSidebar);
  el["close-sidebar"].addEventListener("click", closeSidebar);
  el["sidebar-scrim"].addEventListener("click", closeSidebar);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && state.sidebarOpen) closeSidebar(); });
  mobile.addEventListener("change", () => { state.sidebarOpen = false; updateSidebar(); resizePrompt(); });
  el["connection-settings"].addEventListener("click", () => { showLogin(); el["gateway-details"].open = true; });
  el.refresh.addEventListener("click", async () => {
    el.refresh.disabled = true; el.refresh.textContent = "Łączenie…";
    try { const status = await jsonRequest("/api/status"); setError(""); applyStatus(status || {}); await loadChats(); }
    catch (error) { state.ready = false; el["connection-indicator"].classList.remove("connected"); el["connection-text"].textContent = "Brak połączenia z bramką"; handleError(error); }
    finally { el.refresh.textContent = "Odśwież połączenie"; render(); }
  });
  el.logout.addEventListener("click", async () => {
    try { await jsonRequest("/api/logout", { method: "POST" }); }
    catch (error) { if (error.status !== 401) { handleError(error); return; } }
    storageRemove(sessionStorage, sessionKey()); state.token = ""; state.ready = false; state.chats = []; state.selectedId = null; applyBudget(null); el.prompt.value = ""; showLogin();
  });
  el["clear-history"].addEventListener("click", () => openDelete(state.chats.map((chat) => chat.id)));
  el["delete-cancel"].addEventListener("click", () => { if (!state.deleting) el["delete-dialog"].close(); });
  el["delete-dialog"].addEventListener("cancel", (event) => { if (state.deleting) event.preventDefault(); });
  el["delete-confirm"].addEventListener("click", confirmDelete);
  updateSidebar();
  bootstrap();
})();
