import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export class Auth {
  constructor(path, now = Date.now) {
    this.path = path;
    this.now = now;
    this.sessions = new Map();
    this.failures = [];
  }
  login(password) {
    const now = this.now();
    this.failures = this.failures.filter(time => now - time < 60_000);
    if (this.failures.length >= 10) throw Object.assign(new Error('Za dużo prób. Spróbuj za minutę.'), { status: 429 });
    if (typeof password !== 'string' || password.length > 1024) password = '';
    const { salt, hash } = JSON.parse(readFileSync(this.path, 'utf8'));
    const actual = scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
      this.failures.push(now);
      throw Object.assign(new Error('Nieprawidłowe hasło.'), { status: 401 });
    }
    const sessionToken = randomBytes(32).toString('base64url');
    const expiresAt = now + 12 * 60 * 60 * 1000;
    this.prune();
    if (this.sessions.size >= 100) this.sessions.delete(this.sessions.keys().next().value);
    this.sessions.set(sessionToken, expiresAt);
    return { sessionToken, expiresAt };
  }
  prune() {
    for (const [token, expiresAt] of this.sessions) if (expiresAt <= this.now()) this.sessions.delete(token);
  }
  token(request) {
    return /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization || '')?.[1];
  }
  check(request) {
    this.prune();
    return this.sessions.has(this.token(request));
  }
  logout(request) { this.sessions.delete(this.token(request)); }
}
