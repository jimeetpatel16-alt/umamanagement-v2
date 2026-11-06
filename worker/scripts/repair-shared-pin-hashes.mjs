import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const backupPath = process.argv[2];

if (!backupPath || !fs.existsSync('wrangler.toml')) {
  console.error('Missing backup or wrangler.toml. Run from worker folder.');
  process.exit(1);
}

const config = fs.readFileSync('wrangler.toml', 'utf8');
const db = config.match(/^database_name\s*=\s*"([^"]+)"/m)?.[1];
const id = config.match(/^database_id\s*=\s*"([^"]+)"/m)?.[1];

if (db !== 'uma-management-v2' ||
    id !== 'ef8987bd-41c5-4a3f-9b66-c5d29ccd8c28') {
  throw new Error('Database verification failed. Stopping.');
}

const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
const staff = backup?.collections?.staff;

if (!Array.isArray(staff) || staff.length !== 4) {
  throw new Error('Expected exactly four staff accounts. Stopping.');
}

const q = value => "'" + String(value).replace(/'/g, "''") + "'";
const normalize = value => {
  let d = String(value || '').replace(/\D/g, '');
  if (d.startsWith('0061')) d = d.slice(4);
  else if (d.startsWith('61')) d = '0' + d.slice(2);
  else if (d.length === 9) d = '0' + d;
  return d;
};

const updates = [];
for (const row of staff) {
  const pin = String(row.data?.pin || '');
  const mobile = normalize(row.data?.mobile);

  if (!row.id || !/^\d{4}$/.test(pin) ||
      mobile.length < 8 || mobile.length > 15) {
    throw new Error('Invalid backup account. No changes made.');
  }

  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(pin, salt, 100000, 32, 'sha256');

  updates.push(
    `UPDATE app_auth_accounts SET ` +
    `mobile_norm=${q(mobile)},` +
    `pin_salt_hex=${q(salt.toString('hex'))},` +
    `pin_hash_hex=${q(hash.toString('hex'))},` +
    `active=${row.data.active === false || row.data.active === 0 ? 0 : 1},` +
    `failed_attempts=0,locked_until=NULL,updated_at=${q(new Date().toISOString())} ` +
    `WHERE staff_id=${q(row.id)};`
  );
}

console.log('\nUMA Management PIN repair');
console.log('Database:', db);
console.log('Accounts to repair:', updates.length);
console.log('PIN hashing: PBKDF2-SHA256, 100000 iterations');
console.log('Only existing authentication rows will be updated.');

const rl = readline.createInterface({ input: stdin, output: stdout });
const answer = (await rl.question('\nType REPAIR to continue: ')).trim();
rl.close();

if (answer !== 'REPAIR') {
  console.log('Cancelled. Nothing changed.');
  process.exit(0);
}

for (let i = 0; i < updates.length; i++) {
  const result = spawnSync('npx', [
    'wrangler', 'd1', 'execute', db, '--remote',
    '--command', updates[i]
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });

  if (result.status !== 0) {
    console.error('Repair stopped at account batch', i + 1);
    process.stderr.write(result.stderr || '');
    process.exit(1);
  }

  console.log(`Completed account repair ${i + 1}/4`);
}

console.log('\nPIN hash repair completed.');
console.log('Deploy the updated Worker before testing login.');
