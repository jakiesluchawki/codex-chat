#!/usr/bin/env node
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishGatewayUrl } from './publisher.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = resolve(process.env.CHAT_DATA_DIR || resolve(projectRoot, '.data'));
const urlPath = resolve(dataDir, 'gateway-url.json');

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Użycie: CLOUDFLARED_BIN=/pełna/ścieżka/cloudflared npm run tunnel\nUtrzymuje tymczasowy tunel HTTPS. Bieżący adres zapisuje w .data/gateway-url.json.');
    return;
  }
  if (process.argv.length > 2) throw new Error('Ten skrypt przyjmuje konfigurację przez zmienne środowiskowe, bez argumentów.');
  const binary = process.env.CLOUDFLARED_BIN || 'cloudflared';
  const port = process.env.PORT || '8787';
  if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error('PORT musi być liczbą od 1024 do 65535.');
  // Nie wystawiaj bramki bez osobnego hasła.
  const credentials = JSON.parse(await readFile(resolve(dataDir, 'access.json'), 'utf8'));
  if (!/^[a-f0-9]{64}$/i.test(credentials.salt || '') || !/^[a-f0-9]{128}$/i.test(credentials.hash || '')) throw new Error('Najpierw ustaw hasło bramki: npm run password.');
  if (binary.includes('/')) await access(binary, constants.X_OK);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  await rm(urlPath, { force: true });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('TUNNEL_')) delete env[key];
  // Jawna pusta konfiguracja zapobiega wczytywaniu innych tuneli użytkownika.
  const child = spawn(binary, ['tunnel', '--config', '/dev/null', '--no-autoupdate', '--url', `http://127.0.0.1:${Number(port)}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let outputTail = '';
  let currentUrl;
  let stopped = false;
  let retry;
  let publicationAttempts = 0;
  let updates = Promise.resolve();
  const publish = (url) => {
    if (!process.env.CHAT_GITHUB_REPO || stopped || currentUrl !== url) return;
    clearTimeout(retry);
    try {
      const result = publishGatewayUrl(url);
      publicationAttempts = 0;
      console.log(result.changed ? 'Zaktualizowano adres bramki na GitHubie. Publikacja Pages może potrwać chwilę.' : 'Adres bramki na GitHubie jest aktualny.');
    } catch (error) {
      publicationAttempts++;
      console.error(error.message);
      if (publicationAttempts < 4) retry = setTimeout(() => publish(url), [30_000, 120_000, 300_000][publicationAttempts - 1]).unref();
      else console.error('Automatyczna publikacja adresu nie powiodła się po kilku próbach. Bieżący adres pozostaje w gateway-url.json.');
    }
  };
  const consume = (chunk) => {
    outputTail = (outputTail + chunk.toString('utf8')).slice(-8192);
    const candidate = outputTail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i)?.[0];
    if (!candidate || candidate === currentUrl) return;
    currentUrl = candidate;
    updates = updates.then(async () => {
      const temporary = resolve(dataDir, `.gateway-url-${randomBytes(8).toString('hex')}.tmp`);
      try {
        await writeFile(temporary, `${JSON.stringify({ url: candidate }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        await rename(temporary, urlPath);
        await chmod(urlPath, 0o600);
      } finally {
        await rm(temporary, { force: true });
      }
      console.log(`Tunel HTTPS: ${candidate}`);
      publicationAttempts = 0;
      publish(candidate);
    }).catch(() => {
      console.error('Nie udało się zapisać bieżącego adresu HTTPS.');
      child.kill('SIGTERM');
    });
  };
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);
  child.once('error', (error) => {
    console.error(`Nie udało się uruchomić cloudflared (${error.code || 'błąd procesu'}).`);
  });
  const stop = () => {
    stopped = true;
    clearTimeout(retry);
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  child.once('close', async (code) => {
    const requestedStop = stopped;
    stopped = true;
    clearTimeout(retry);
    await updates;
    await rm(urlPath, { force: true }).catch(() => {});
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (!requestedStop) console.error(`Tunel został zakończony (kod ${code ?? 'brak'}). LaunchAgent ponowi próbę, jeśli jest zainstalowany.`);
    process.exitCode = requestedStop ? 0 : (code > 0 ? code : 1);
  });
}

main().catch((error) => {
  console.error(error.code === 'ENOENT' ? 'Brak konfiguracji lub pliku cloudflared. Ustaw hasło i CLOUDFLARED_BIN.' : error.message);
  process.exitCode = 1;
});
