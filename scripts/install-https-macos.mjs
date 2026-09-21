#!/usr/bin/env node
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const label = 'com.codex-chat.tunnel';
const marker = '<!-- Managed by codex-chat scripts/install-https-macos.mjs. -->';
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(args) {
  const options = { dataDir: process.env.CHAT_DATA_DIR || resolve(projectRoot, '.data'), binary: process.env.CLOUDFLARED_BIN, port: process.env.PORT || '8787', dryRun: false };
  const values = { '--data-dir': 'dataDir', '--cloudflared-bin': 'binary', '--port': 'port' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      console.log('Użycie: node scripts/install-https-macos.mjs [--cloudflared-bin ŚCIEŻKA] [--data-dir ŚCIEŻKA] [--port PORT] [--dry-run]\nInstaluje własny LaunchAgent tymczasowego tunelu HTTPS. Nie kopiuje ani nie odczytuje credentiali Cloudflare.');
      process.exit(0);
    } else if (args[i] === '--dry-run') options.dryRun = true;
    else if (values[args[i]] && args[i + 1]) options[values[args[i]]] = args[++i];
    else throw new Error(`Nieznany lub niepełny argument: ${args[i]}`);
  }
  options.dataDir = resolve(options.dataDir);
  if (!/^\d+$/.test(options.port) || Number(options.port) < 1024 || Number(options.port) > 65535) throw new Error('Port musi być liczbą od 1024 do 65535.');
  return options;
}

async function executable(candidate) {
  const candidates = isAbsolute(candidate) || candidate.includes('/') ? [resolve(candidate)] : (process.env.PATH || '').split(delimiter).filter(Boolean).map(path => join(path, candidate));
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return await realpath(path); } catch {}
  }
  return null;
}

async function discoverBinary(explicit) {
  for (const candidate of explicit ? [explicit] : ['cloudflared', resolve(homedir(), '.local/bin/cloudflared'), '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']) {
    const found = await executable(candidate);
    if (found) return found;
  }
  throw new Error('Nie znaleziono cloudflared. Podaj --cloudflared-bin /pełna/ścieżka/cloudflared.');
}

function launchctl(args) { return spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 15000 }); }
function xml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.platform !== 'darwin') throw new Error('Ten instalator działa na macOS.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Wymagany jest Node.js 22 lub nowszy.');
  if (process.getuid() === 0) throw new Error('Uruchom jako użytkownik bramki, bez sudo.');
  let credentials;
  try { credentials = JSON.parse(await readFile(resolve(options.dataDir, 'access.json'), 'utf8')); }
  catch { throw new Error('Najpierw ustaw hasło bramki: npm run password.'); }
  if (!/^[a-f0-9]{64}$/i.test(credentials.salt || '') || !/^[a-f0-9]{128}$/i.test(credentials.hash || '')) throw new Error('Nieprawidłowy access.json. Ustaw ponownie hasło bramki.');
  await access(resolve(projectRoot, 'scripts/tunnel.mjs'), constants.R_OK);
  const binary = await discoverBinary(options.binary);
  const domain = `gui/${process.getuid()}`;
  const target = `${domain}/${label}`;
  const agentsDir = resolve(homedir(), 'Library/LaunchAgents');
  const plistPath = resolve(agentsDir, `${label}.plist`);
  let previous;
  try { previous = await readFile(plistPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous !== undefined && !previous.includes(marker)) throw new Error('Istniejący LaunchAgent nie należy do tej bramki; instalator go nie nadpisze.');
  const loaded = launchctl(['print', target]);
  if (loaded.error) throw new Error('Nie udało się odczytać stanu launchd.');
  if (loaded.status === 0 && previous === undefined) throw new Error('Usługa o tej nazwie działa bez pliku należącego do bramki; instalator jej nie zatrzyma.');
  if (options.dryRun) {
    console.log(`Plan: ${plistPath}\nNode: ${process.execPath}\ncloudflared: ${binary}\nDane: ${options.dataDir}\nNie dokonano zmian.`);
    return;
  }
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
${marker}
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(resolve(projectRoot, 'scripts/tunnel.mjs'))}</string></array>
  <key>WorkingDirectory</key><string>${xml(projectRoot)}</string>
  <key>EnvironmentVariables</key><dict><key>CHAT_DATA_DIR</key><string>${xml(options.dataDir)}</string><key>CLOUDFLARED_BIN</key><string>${xml(binary)}</string><key>PORT</key><string>${xml(options.port)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(resolve(options.dataDir, 'logs/tunnel.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(resolve(options.dataDir, 'logs/tunnel-error.log'))}</string>
</dict></plist>
`;
  await mkdir(resolve(options.dataDir, 'logs'), { recursive: true, mode: 0o700 });
  await chmod(options.dataDir, 0o700);
  await chmod(resolve(options.dataDir, 'logs'), 0o700);
  await mkdir(agentsDir, { recursive: true });
  const temporary = `${plistPath}.codex-chat.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    const validation = spawnSync('/usr/bin/plutil', ['-lint', temporary], { encoding: 'utf8', timeout: 5000 });
    if (validation.error || validation.status !== 0) throw new Error('Nieprawidłowy wygenerowany plist. Usługa nie została zmieniona.');
    if (loaded.status === 0) {
      const stopped = launchctl(['bootout', target]);
      if (stopped.error || stopped.status !== 0) throw new Error('Nie udało się zatrzymać poprzedniej własnej usługi tunelu.');
    }
    await rename(temporary, plistPath);
    await chmod(plistPath, 0o600);
    const started = launchctl(['bootstrap', domain, plistPath]);
    if (started.error || started.status !== 0) throw new Error('LaunchAgent zapisany, ale start tunelu nie powiódł się. Sprawdź stan launchd i logi.');
  } finally { await rm(temporary, { force: true }); }
  console.log(`Tunel HTTPS zainstalowany: ${label}\nBieżący adres po nawiązaniu połączenia: ${resolve(options.dataDir, 'gateway-url.json')}\nKażdy restart procesu tunelu może zmienić adres HTTPS.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
