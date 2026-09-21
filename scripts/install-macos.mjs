#!/usr/bin/env node
import { constants } from 'node:fs';
import { access, chmod, cp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const label = 'com.codex-chat.gateway';
const marker = '<!-- Managed by codex-chat scripts/install-macos.mjs. -->';
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(args) {
  const options = {
    dataDir: process.env.CHAT_DATA_DIR || resolve(projectRoot, '.data'),
    codexBin: process.env.CODEX_BIN,
    port: process.env.PORT || '8787',
    origins: process.env.ALLOWED_ORIGINS,
    runtimeDir: projectRoot,
    dryRun: false,
  };
  const values = { '--data-dir': 'dataDir', '--runtime-dir': 'runtimeDir', '--codex-bin': 'codexBin', '--port': 'port', '--allowed-origins': 'origins' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      console.log('Użycie: node scripts/install-macos.mjs [--data-dir ŚCIEŻKA] [--runtime-dir ŚCIEŻKA] [--codex-bin ŚCIEŻKA] [--port PORT] [--allowed-origins URL,URL] [--dry-run]\nInstaluje tylko własny LaunchAgent bieżącego użytkownika. --runtime-dir kopiuje kod aplikacji poza repo, bez danych i loginu Codexa.');
      process.exit(0);
    } else if (args[i] === '--dry-run') options.dryRun = true;
    else if (values[args[i]] && args[i + 1]) options[values[args[i]]] = args[++i];
    else throw new Error(`Nieznany lub niepełny argument: ${args[i]}`);
  }
  options.dataDir = resolve(options.dataDir);
  options.runtimeDir = resolve(options.runtimeDir);
  if (!/^\d+$/.test(options.port) || Number(options.port) < 1024 || Number(options.port) > 65535) throw new Error('Port musi być liczbą od 1024 do 65535.');
  if (options.origins !== undefined) {
    for (const origin of options.origins.split(',').filter(Boolean)) {
      const parsed = new URL(origin.trim());
      if (parsed.origin !== origin.trim() || !['http:', 'https:'].includes(parsed.protocol)) throw new Error('ALLOWED_ORIGINS przyjmuje adresy origin bez ścieżki.');
    }
  }
  return options;
}

async function findExecutable(candidate) {
  const candidates = isAbsolute(candidate) || candidate.includes('/')
    ? [resolve(candidate)]
    : (process.env.PATH || '').split(delimiter).filter(Boolean).map((directory) => join(directory, candidate));
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK);
      return await realpath(path);
    } catch {}
  }
  return null;
}

async function discoverCodex(explicit) {
  if (explicit) {
    const found = await findExecutable(explicit);
    if (!found) throw new Error('Nie znaleziono wykonywalnego CODEX_BIN.');
    return found;
  }
  for (const candidate of ['codex', '/Applications/Codex.app/Contents/Resources/codex', '/Applications/ChatGPT.app/Contents/Resources/codex']) {
    const found = await findExecutable(candidate);
    if (found) return found;
  }
  throw new Error('Nie znaleziono Codexa. Podaj --codex-bin /pełna/ścieżka/do/codex.');
}

function launchctl(args) {
  return spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 15000 });
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function plist(options, codexBin) {
  const env = {
    PATH: `${dirname(process.execPath)}:${dirname(codexBin)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    CODEX_BIN: codexBin,
    CHAT_DATA_DIR: options.dataDir,
    PORT: options.port,
  };
  if (process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME;
  if (options.origins !== undefined) env.ALLOWED_ORIGINS = options.origins;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
${marker}
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(resolve(options.runtimeDir, 'server/index.mjs'))}</string></array>
  <key>WorkingDirectory</key><string>${xml(options.runtimeDir)}</string>
  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join('')}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(resolve(options.dataDir, 'logs/gateway.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(resolve(options.dataDir, 'logs/gateway-error.log'))}</string>
</dict></plist>
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.platform !== 'darwin') throw new Error('Ten instalator działa na macOS.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Wymagany jest Node.js 22 lub nowszy.');
  if (process.getuid() === 0) throw new Error('Uruchom jako użytkownik zalogowany w Codexie, bez sudo.');
  let credentials;
  try { credentials = JSON.parse(await readFile(resolve(options.dataDir, 'access.json'), 'utf8')); }
  catch { throw new Error('Najpierw ustaw hasło: npm run password (lub CHAT_DATA_DIR=... npm run password).'); }
  if (!/^[a-f0-9]{64}$/i.test(credentials.salt || '') || !/^[a-f0-9]{128}$/i.test(credentials.hash || '')) throw new Error('Nieprawidłowy access.json. Ustaw ponownie hasło: npm run password.');
  await access(resolve(projectRoot, 'server/index.mjs'), constants.R_OK);
  const codexBin = await discoverCodex(options.codexBin);
  const login = spawnSync(codexBin, ['login', 'status'], { encoding: 'utf8', timeout: 15000, env: process.env });
  if (login.error || login.status !== 0) throw new Error('Codex nie potwierdził zalogowania. Zaloguj go przez ChatGPT na tym użytkowniku, a następnie ponów instalację.');
  if (!/ChatGPT/i.test(`${login.stdout}\n${login.stderr}`)) throw new Error('Bramka wymaga loginu Codexa przez ChatGPT. Login kluczem API nie jest obsługiwany.');
  const domain = `gui/${process.getuid()}`;
  const target = `${domain}/${label}`;
  const agentsDir = resolve(homedir(), 'Library/LaunchAgents');
  const plistPath = resolve(agentsDir, `${label}.plist`);
  let previous;
  try { previous = await readFile(plistPath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous !== undefined && !previous.includes(marker)) throw new Error('Istniejący LaunchAgent nie należy do tej bramki; instalator go nie nadpisze.');
  const currentlyLoaded = launchctl(['print', target]);
  if (currentlyLoaded.error) throw new Error('Nie udało się odczytać stanu launchd.');
  if (currentlyLoaded.status === 0 && previous === undefined) throw new Error('Usługa o tej nazwie już działa bez pliku należącego do bramki; instalator jej nie zatrzyma.');
  const content = plist(options, codexBin);
  if (options.dryRun) {
    console.log(`Plan: ${plistPath}\nNode: ${process.execPath}\nCodex: ${codexBin}\nKod uruchamiany: ${options.runtimeDir}\nDane: ${options.dataDir}\nAdres lokalny: http://127.0.0.1:${options.port}\nNie dokonano zmian.`);
    return;
  }
  await mkdir(resolve(options.dataDir, 'logs'), { recursive: true, mode: 0o700 });
  await chmod(options.dataDir, 0o700);
  await chmod(resolve(options.dataDir, 'logs'), 0o700);
  await chmod(resolve(options.dataDir, 'access.json'), 0o600);
  await mkdir(agentsDir, { recursive: true });
  const temporary = `${plistPath}.codex-chat.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    const validation = spawnSync('/usr/bin/plutil', ['-lint', temporary], { encoding: 'utf8', timeout: 5000 });
    if (validation.error || validation.status !== 0) throw new Error('Nieprawidłowy wygenerowany plist. Usługa nie została zmieniona.');
    if (currentlyLoaded.status === 0) {
      const stopped = launchctl(['bootout', target]);
      if (stopped.error || stopped.status !== 0) throw new Error('Nie udało się zatrzymać poprzedniej własnej usługi.');
    }
    if (options.runtimeDir !== projectRoot) {
      await mkdir(options.runtimeDir, { recursive: true, mode: 0o700 });
      for (const name of ['server', 'public', 'scripts', 'package.json']) await cp(resolve(projectRoot, name), resolve(options.runtimeDir, name), { recursive: true, force: true });
    }
    await rename(temporary, plistPath);
    await chmod(plistPath, 0o600);
    const started = launchctl(['bootstrap', domain, plistPath]);
    if (started.error || started.status !== 0) throw new Error(`LaunchAgent zapisany, ale start nie powiódł się. Sprawdź: launchctl bootstrap ${domain} "${plistPath}"`);
  } finally {
    await rm(temporary, { force: true });
  }
  console.log(`Bramka zainstalowana: ${label}\nAdres lokalny: http://127.0.0.1:${options.port}\nLogi: ${resolve(options.dataDir, 'logs')}\nHTTPS uruchom oddzielnie: npm run https`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
