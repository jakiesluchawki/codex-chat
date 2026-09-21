#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Budget } from '../server/budget.mjs';

try {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Użycie: npm run budget -- LICZBA [--data-dir ŚCIEŻKA]\nUruchom po zatrzymaniu bramki. Zmienia pulę aktualnego okresu, zachowując zużycie, historię naliczeń i termin odnowienia. Tworzy prywatną kopię poprzedniego licznika.');
  } else {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const [amount, flag, directory, ...extra] = args;
    if (!/^[1-9]\d*$/.test(amount || '') || !Number.isSafeInteger(Number(amount)) || extra.length || (flag !== undefined && (flag !== '--data-dir' || !directory))) throw new Error('Podaj dodatnią całkowitą pulę oraz opcjonalnie --data-dir.');
    const data = resolve(directory || process.env.CHAT_DATA_DIR || resolve(root, '.data'));
    const path = resolve(data, 'budget.json');
    if (!existsSync(path)) throw new Error('Brak istniejącego licznika; nie można odnowić go przez korektę.');
    const before = readFileSync(path);
    const budget = new Budget(path);
    if (budget.inspect().missing) throw new Error('Nieprawidłowy zapis licznika; korekta jest zablokowana.');
    const backup = resolve(data, 'budget.before-resize-' + Date.now() + '-' + randomBytes(4).toString('hex') + '.json');
    writeFileSync(backup, before, { mode: 0o600, flag: 'wx', flush: true });
    const state = budget.resizeAllowance(Number(amount));
    const window = state.windows[0];
    console.log(JSON.stringify({ allowanceUnits: window.allowanceUnits, usedUnits: window.usedUnits, remainingFractionPercent: window.remainingFractionPercent, resetsAt: window.resetsAt, backup }));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
