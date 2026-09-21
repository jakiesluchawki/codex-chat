#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function publishGatewayUrl(url, env = process.env) {
  const repo = env.CHAT_GITHUB_REPO;
  if (!/^[A-Za-z0-9_.-]+\/codex-chat$/.test(repo || '')) throw new Error('Publikacja adresu wymaga CHAT_GITHUB_REPO=twoje-konto/codex-chat.');
  if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(url || '')) throw new Error('Publikacja wymaga publicznego adresu HTTPS bieżącego tunelu.');
  const gh = env.GH_BIN || 'gh';
  const options = { env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 };
  const endpoint = `repos/${repo}/contents/public/config.js`;
  const current = spawnSync(gh, ['api', `${endpoint}?ref=main`, '--method', 'GET'], options);
  if (current.error || current.status !== 0) throw new Error('Nie udało się odczytać public/config.js na GitHubie. Sprawdź istnienie repo i login gh tego użytkownika; tunel nadal działa.');
  let file;
  try { file = JSON.parse(current.stdout); } catch { throw new Error('GitHub nie zwrócił prawidłowej konfiguracji strony; tunel nadal działa.'); }
  if (file.type !== 'file' || file.path !== 'public/config.js' || !/^[a-f0-9]{40,64}$/i.test(file.sha || '')) throw new Error('GitHub nie potwierdził pliku public/config.js; tunel nadal działa.');
  const content = `// Publiczny adres HTTPS bramki. Nie wpisuj tutaj hasła ani tokenów.\nwindow.CHAT_GATEWAY_URL = ${JSON.stringify(url)};\n`;
  if (file.encoding === 'base64' && Buffer.from(file.content || '', 'base64').toString('utf8') === content) return { changed: false };
  const body = { message: 'chore: update gateway address', content: Buffer.from(content).toString('base64'), sha: file.sha, branch: 'main' };
  const updated = spawnSync(gh, ['api', endpoint, '--method', 'PUT', '--input', '-'], { ...options, input: JSON.stringify(body) });
  if (updated.error || updated.status !== 0) throw new Error('Nie udało się opublikować adresu na GitHubie. Sprawdź uprawnienie gh do zapisu repo; tunel nadal działa.');
  let result;
  try { result = JSON.parse(updated.stdout); } catch { throw new Error('GitHub nie potwierdził zapisania adresu; tunel nadal działa.'); }
  if (result.content?.path !== 'public/config.js' || !result.commit?.sha) throw new Error('GitHub nie potwierdził zapisania public/config.js; tunel nadal działa.');
  return { changed: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--help') || process.argv.includes('-h')) console.log('Użycie: CHAT_GITHUB_REPO=twoje-konto/codex-chat GH_BIN=/ścieżka/gh node scripts/publisher.mjs ADRES_HTTPS\nAktualizuje tylko public/config.js w podanym repozytorium codex-chat, przez istniejący login gh.');
    else {
      if (process.argv.length !== 3) throw new Error('Podaj jeden publiczny adres HTTPS tunelu.');
      const result = publishGatewayUrl(process.argv[2]);
      console.log(result.changed ? 'Adres bramki opublikowany na GitHubie.' : 'Adres na GitHubie jest aktualny.');
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
