#!/usr/bin/env node
/**
 * Import a UMA Management full JSON backup into the configured remote D1 database.
 * - Reads the backup locally; never uploads it to this chat or a third-party endpoint.
 * - Uses INSERT OR IGNORE so existing D1 documents are never overwritten.
 * - Stores staff PINs only as PBKDF2-SHA256 hashes in app_auth_accounts.
 * - Removes PIN values from staff profile JSON before importing.
 *
 * Run from the worker directory:
 *   node scripts/import-backup-to-d1.mjs "/full/path/to/uma-management-backup.json"
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const backupPath = process.argv[2];
if (!backupPath) {
  console.error('Usage: node scripts/import-backup-to-d1.mjs "/path/to/uma-management-backup.json"');
  process.exit(2);
}
const configPath = path.resolve('wrangler.toml');
if (!fs.existsSync(configPath)) {
  console.error('Run this script from the worker directory (the folder containing wrangler.toml).');
  process.exit(2);
}
if (!fs.existsSync(backupPath)) {
  console.error(`Backup file not found: ${backupPath}`);
  process.exit(2);
}

const config = fs.readFileSync(configPath, 'utf8');
const dbName = config.match(/database_name\s*=\s*["']([^"']+)["']/)?.[1];
const dbId = config.match(/database_id\s*=\s*["']([^"']+)["']/)?.[1];
if (!dbName || !dbId || /REPLACE_WITH|YOUR_DATABASE/i.test(dbId)) {
  console.error('wrangler.toml must contain your real D1 database_name and database_id before importing.');
  process.exit(2);
}

let backup;
try { backup = JSON.parse(fs.readFileSync(backupPath, 'utf8')); }
catch (error) { console.error(`Could not parse backup JSON: ${error.message}`); process.exit(2); }
if (backup?.format !== 'uma-management-backup' || !backup.collections || typeof backup.collections !== 'object') {
  console.error('This is not a supported UMA Management full backup (expected format: uma-management-backup).');
  process.exit(2);
}

const allowed = new Set([
  'settings', 'staff', 'drivers', 'companies', 'days', 'driverSubmissions',
  'labour', 'labourShifts', 'labourLogs', 'invoices', 'rateCards', 'auditLog',
  'deliveryBlocks', 'driverAssignments'
]);
const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;
const now = new Date().toISOString();
const statements = [];
let totalDocs = 0, authReady = 0, authSkipped = 0;
const report = {};

function normalizeMobile(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('0061')) digits = digits.slice(2);
  if (digits.startsWith('61')) digits = '0' + digits.slice(2);
  else if (digits.length === 9) digits = '0' + digits;
  return digits;
}
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.pbkdf2Sync(String(pin), salt, 310000, 32, 'sha256');
  return { salt: salt.toString('hex'), hash: derived.toString('hex') };
}

for (const [collection, rows] of Object.entries(backup.collections)) {
  if (!allowed.has(collection) || !Array.isArray(rows)) continue;
  report[collection] = rows.length;
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id || !row.data || typeof row.data !== 'object' || Array.isArray(row.data)) continue;
    const data = structuredClone(row.data);
    const createdAt = data.createdAt || data.created_at || now;
    const updatedAt = data.updatedAt || data.updated_at || createdAt;
    if (collection === 'staff') {
      const pin = String(data.pin || '');
      const mobile = normalizeMobile(data.mobile);
      delete data.pin;
      if (pin && /^\d{4}$/.test(pin) && mobile.length >= 8 && mobile.length <= 15) {
        const { salt, hash } = hashPin(pin);
        statements.push(`INSERT OR IGNORE INTO app_auth_accounts (staff_id,mobile_norm,pin_salt_hex,pin_hash_hex,active,created_at,updated_at) VALUES (${sqlString(row.id)},${sqlString(mobile)},${sqlString(salt)},${sqlString(hash)},${data.active === false || data.active === 0 ? 0 : 1},${sqlString(createdAt)},${sqlString(updatedAt)});`);
        authReady++;
      } else {
        authSkipped++;
      }
    }
    const json = JSON.stringify(data);
    statements.push(`INSERT OR IGNORE INTO app_documents (collection,doc_id,data_json,created_at,updated_at) VALUES (${sqlString(collection)},${sqlString(row.id)},${sqlString(json)},${sqlString(createdAt)},${sqlString(updatedAt)});`);
    totalDocs++;
  }
}
if (!totalDocs) {
  console.error('No supported records were found in the backup. No D1 changes were made.');
  process.exit(2);
}

console.log('\nUMA Management D1 import preview');
console.log(`Target database: ${dbName}`);
console.log(`Configured D1 database ID: ${dbId}`);
console.log('Before proceeding, compare this ID with the Database ID shown in Cloudflare Dashboard → D1 → your existing database.');
console.log(`Backup exported: ${backup.exportedAt || 'not recorded'}`);
console.log(`Documents to insert if not already present: ${totalDocs}`);
console.log(`Staff PIN hashes to create if not already present: ${authReady}`);
if (authSkipped) console.log(`Staff accounts needing PIN review: ${authSkipped}`);
for (const [name, count] of Object.entries(report)) console.log(`  ${name}: ${count}`);
console.log('\nSafety: this script uses INSERT OR IGNORE; it does not delete or overwrite existing D1 records.');

const answer = await new Promise((resolve) => {
  process.stdout.write('\nType IMPORT to apply the additive migration and import these records into REMOTE D1: ');
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.includes('\n')) resolve(input.trim());
  });
});
if (answer !== 'IMPORT') {
  console.log('Cancelled. No D1 changes were made.');
  process.exit(0);
}

const tempSql = path.join(os.tmpdir(), `uma-d1-import-${process.pid}-${Date.now()}.sql`);
fs.writeFileSync(tempSql, statements.join('\n') + '\n', { mode: 0o600 });
try {
  console.log('\nApplying D1 migrations (additive only)...');
  const migrate = spawnSync('npx', ['wrangler', 'd1', 'migrations', 'apply', dbName, '--remote'], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (migrate.status !== 0) throw new Error(`D1 migration command failed (${migrate.status ?? 'unknown status'}).`);
  console.log('\nImporting records...');
  const run = spawnSync('npx', ['wrangler', 'd1', 'execute', dbName, '--remote', '--file', tempSql], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (run.status !== 0) throw new Error(`D1 import command failed (${run.status ?? 'unknown status'}).`);
  console.log('\nImport command completed. Verify the record counts in D1 before switching the live application.');
} catch (error) {
  console.error(`\nImport stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  try { fs.unlinkSync(tempSql); } catch {}
}
