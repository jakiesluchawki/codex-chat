#!/usr/bin/env node
import { randomBytes, scryptSync } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(args) {
  const options = { stdin: false, dataDir: process.env.CHAT_DATA_DIR || resolve(projectRoot, '.data') };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      console.log('Użycie: node scripts/set-password.mjs [--data-dir ŚCIEŻKA] [--stdin]\nDomyślnie pyta o hasło bez wyświetlania znaków. --stdin czyta hasło ze standardowego wejścia.');
      process.exit(0);
    } else if (args[i] === '--stdin') options.stdin = true;
    else if (args[i] === '--data-dir' && args[i + 1]) options.dataDir = args[++i];
    else throw new Error(`Nieznany lub niepełny argument: ${args[i]}`);
  }
  options.dataDir = resolve(options.dataDir);
  return options;
}

function readHidden(prompt) {
  return new Promise((resolvePassword, reject) => {
    let value = '';
    const previousRaw = process.stdin.isRaw;
    const finish = (error) => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.setRawMode(previousRaw);
      process.stdin.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolvePassword(value);
    };
    const onEnd = () => finish(new Error('Przerwano odczyt hasła.'));
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003' || character === '\u0004') {
          finish(new Error('Anulowano.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (character >= ' ') value += character;
      }
    };
    process.stderr.write(prompt);
    process.stdin.setEncoding('utf8');
    process.stdin.setRawMode(true);
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.resume();
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let password;
  if (options.stdin) {
    const chunks = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > 4096) throw new Error('Hasło jest zbyt długie.');
      chunks.push(chunk);
    }
    password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
    if (password.includes('\n') || password.includes('\r')) throw new Error('Podaj jedno hasło w jednym wierszu.');
  } else {
    if (!process.stdin.isTTY) throw new Error('Brak terminala. Użyj jawnego --stdin do bezpiecznego odczytu z potoku.');
    password = await readHidden('Nowe hasło bramki: ');
    const confirmation = await readHidden('Powtórz hasło: ');
    if (password !== confirmation) throw new Error('Hasła nie są identyczne.');
  }
  if (password.length < 8 || password.length > 1024 || Buffer.byteLength(password) > 4096) throw new Error('Hasło musi mieć od 8 do 1024 znaków i najwyżej 4096 bajtów.');
  if (password.includes('\0')) throw new Error('Hasło zawiera niedozwolony znak.');
  const salt = randomBytes(32).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  password = undefined;
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  await chmod(options.dataDir, 0o700);
  const temporary = resolve(options.dataDir, `.access-${randomBytes(8).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({ salt, hash }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, resolve(options.dataDir, 'access.json'));
    await chmod(resolve(options.dataDir, 'access.json'), 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
  console.log('Hasło bramki zapisane jako skrót. Hasło nie zostało wyświetlone.');
  console.log('Nowe logowania użyją nowego hasła. Restart serwera dodatkowo zakończy aktywne sesje.');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
