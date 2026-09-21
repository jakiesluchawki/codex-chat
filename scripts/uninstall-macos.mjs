#!/usr/bin/env node
import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const services = [
  { label: 'com.codex-chat.tunnel', marker: '<!-- Managed by codex-chat scripts/install-https-macos.mjs. -->' },
  { label: 'com.codex-chat.gateway', marker: '<!-- Managed by codex-chat scripts/install-macos.mjs. -->' },
];

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Użycie: node scripts/uninstall-macos.mjs\nUsuwa tylko własne LaunchAgenty bramki i tunelu. Zachowuje rozmowy, hasło bramki i login Codexa.');
    return;
  }
  if (args.length) throw new Error('Ten skrypt nie przyjmuje argumentów.');
  if (process.platform !== 'darwin') throw new Error('Ten deinstalator działa na macOS.');
  if (process.getuid() === 0) throw new Error('Uruchom jako użytkownik bramki, bez sudo.');
  const owned = [];
  for (const service of services) {
    const plistPath = resolve(homedir(), 'Library/LaunchAgents', `${service.label}.plist`);
    let existing;
    try { existing = await readFile(plistPath, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!existing.includes(service.marker)) throw new Error(`Plik ${service.label} nie należy do tej bramki. Nie dokonano zmian.`);
    owned.push({ ...service, plistPath });
  }
  if (!owned.length) { console.log('Nie znaleziono własnych LaunchAgentów. Nie dokonano zmian.'); return; }
  for (const service of owned) {
    const target = `gui/${process.getuid()}/${service.label}`;
    const current = spawnSync('/bin/launchctl', ['print', target], { encoding: 'utf8', timeout: 10000 });
    if (current.error) throw new Error('Nie udało się odczytać stanu launchd.');
    if (current.status === 0) {
      const stopped = spawnSync('/bin/launchctl', ['bootout', target], { encoding: 'utf8', timeout: 15000 });
      if (stopped.error || stopped.status !== 0) throw new Error(`Nie udało się zatrzymać ${service.label}. Jego plik został zachowany.`);
    }
    await rm(service.plistPath);
    console.log(`Usunięto ${service.label}.`);
  }
  console.log('Dane rozmów i login Codexa zostały zachowane.');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
