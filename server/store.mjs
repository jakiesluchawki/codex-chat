import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class ChatStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'chats.json');
    this.chats = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : [];
    // A previous process cannot continue a turn after a restart.
    for (const chat of this.chats) {
      chat.active = false;
      for (const message of chat.messages) if (message.status === 'inProgress') message.status = 'interrupted';
    }
  }
  save() {
    const temp = this.path + '.tmp';
    writeFileSync(temp, JSON.stringify(this.chats), { mode: 0o600 });
    renameSync(temp, this.path);
  }
  create(text, model, effort) {
    const chat = { id: randomUUID(), title: text.trim().slice(0, 65), model, effort, updatedAt: Date.now(), messages: [], active: false };
    this.chats.unshift(chat);
    return chat;
  }
  get(id) { return this.chats.find(chat => chat.id === id); }
  public(chat) {
    const { threadId, ...visible } = chat;
    return visible;
  }
  list() { return this.chats.map(chat => this.public(chat)).sort((a, b) => b.updatedAt - a.updatedAt); }
  delete(id) {
    const chat = this.get(id);
    if (!chat) return false;
    if (chat.active) throw Object.assign(new Error('Najpierw zatrzymaj odpowiedź.'), { status: 409 });
    this.chats = this.chats.filter(chat => chat.id !== id);
    this.save();
    return true;
  }
}
