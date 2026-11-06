#!/usr/bin/env node
/**
 * Additive import of a UMA Management full backup into the already-prepared
 * shared-document tables in remote Cloudflare D1.
 *
 * IMPORTANT: This script DOES NOT run or apply any migrations. It verifies
 * that app_documents, app_auth_accounts and app_auth_sessions already exist.
 * It uses INSERT OR IGNORE so it never replaces existing app documents or
 * authentication rows. It strips plaintext PINs from staff documents and
 * stores PBKDF2-SHA256 PIN hashes in app_auth_accounts.
 *
 * Run from the worker directory:
 *   node scripts/import-backup-to-d1.mjs "$HOME/Downloads/uma-management-backup-2026-11-04.json"
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
  console.error('wrangler.toml must contain the real D1 database_name and database_id.');
  process.exit(2);
}

let backup;
try { backup = JSON.parse(fs.readFileSync(backupPath, 'utf8')); }
catch (error) { console.error(`Could not parse backup JSON: ${error.message}`); process.exit(2); }
if (backup?.format !== 'uma-management-backup' || !backup.collections || typeof backup.collections !== 'object') {
  console.error('Unsupported backup. Expected format: uma-management-backup.');
  process.exit(2);
}

const allowed = new Set([
  'settings', 'staff', 'drivers', 'companies', 'days', 'driverSubmissions',
  'labour', 'labourShifts', 'labourLogs', 'invoices', 'rateCards', 'auditLog',
  'deliveryBlocks', 'driverAssignments'
]);
const sql = (value) => `'${String(value).replace(/'/g, "''")}'`;
const now = new Date().toISOString();
const statements = [];
const report = {};
let totalDocs = 0;
let authReady = 0;
let authSkipped = 0;
let malformed = 0;

function normalizeMobile(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('0061')) digits = digits.slice(2);
  if (digits.startsWith('61')) digits = `0${digits.slice(2)}`;
  else if (digits.length === 9) digits = `0${digits}`;
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
    if (!row || typeof row.id !== 'string' || !row.id || !row.data || typeof row.data !== 'object' || Array.isArray(row.data)) {
      malformed++;
      continue;
    }
    const data = structuredClone(row.data);
    const createdAt = data.createdAt || data.created_at || now;
    const updatedAt = data.updatedAt || data.updated_at || createdAt;

    if (collection === 'staff') {
      const pin = String(data.pin || '');
      const mobile = normalizeMobile(data.mobile);
      delete data.pin;
      if (pin && /^\d{4}$/.test(pin) && mobile.length >= 8 && mobile.length <= 15) {
        const { salt, hash } = hashPin(pin);
        statements.push(`INSERT OR IGNORE INTO app_auth_accounts (staff_id,mobile_norm,pin_salt_hex,pin_hash_hex,active,failed_attempts,locked_until,created_at,updated_at) VALUES (${sql(row.id)},${sql(mobile)},${sql(salt)},${sql(hash)},${data.active === false || data.active === 0 ? 0 : 1},0,NULL,${sql(createdAt)},${sql(updatedAt)});`);
        authReady++;
      } else {
        authSkipped++;
      }
    }

    statements.push(`INSERT OR IGNORE INTO app_documents (collection,doc_id,data_json,created_at,updated_at) VALUES (${sql(collection)},${sql(row.id)},${sql(JSON.stringify(data))},${sql(createdAt)},${sql(updatedAt)});`);
    totalDocs++;
  }
}
if (!totalDocs) {
  console.error('No supported records found. No D1 changes were made.');
  process.exit(2);
}

function runWrangler(args, options = {}) {
  return spawnSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32'
  });
}

console.log('\nUMA Management shared-D1 import preview');
console.log(`Target database: ${dbName}`);
console.log(`Configured D1 database ID: ${dbId}`);
console.log(`Backup exported: ${backup.exportedAt || 'not recorded'}`);
console.log(`Documents to insert if not already present: ${totalDocs}`);
console.log(`Staff PIN hashes to create if not already present: ${authReady}`);
if (authSkipped) console.log(`Staff rows requiring PIN/mobile review: ${authSkipped}`);
if (malformed) console.log(`Malformed rows skipped: ${malformed}`);
for (const [name, count] of Object.entries(report)) console.log(`  ${name}: ${count}`);
console.log('\nSafety: no migrations are run. The import uses INSERT OR IGNORE and does not delete or overwrite existing app_documents or auth rows. Plaintext PINs are not stored.');
console.log('Note: existing legacy relational tables (for example companies/users) remain untouched.');

// Read-only preflight: do not attempt import if the manually-created shared tables are missing.
const preflight = runWrangler(['d1', 'execute', dbName, '--remote', '--command', "SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='app_documents') AS docs, (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='app_auth_accounts') AS auth, (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='app_auth_sessions') AS sessions;"]);
if (preflight.status !== 0) {
  process.stderr.write(preflight.stderr || preflight.stdout || 'D1 preflight failed.');
  console.error('\nImport cancelled. Confirm that the shared-table SQL file was applied.');
  process.exit(2);
}
const preflightText = `${preflight.stdout || ''}\n${preflight.stderr || ''}`;
const missingTables = ['app_documents', 'app_auth_accounts', 'app_auth_sessions'].filter((name) => !preflightText.includes(name));
if (missingTables.length) {
  console.error(`\nMissing shared table(s): ${missingTables.join(', ')}. Import cancelled; no D1 data was written.`);
  console.error(preflightText.trim());
  process.exit(2);
}

const answer = await new Promise((resolve) => {
  process.stdout.write('\nCompare the database ID above with Cloudflare. Type IMPORT to insert the backup into REMOTE D1: ');
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.includes('\n')) resolve(input.trim());
  });
});
if (answer !== 'IMPORT') {
  console.log('Cancelled. No D1 data was written.');
  process.exit(0);
}

const tempSql = path.join(os.tmpdir(), `uma-d1-import-${process.pid}-${Date.now()}.sql`);
fs.writeFileSync(tempSql, statements.join('\n') + '\n', { mode: 0o600 });
try {
  console.log('\nImporting records into remote D1 (no migrations)...');
  const result = spawnSync('npx', ['wrangler', 'd1', 'execute', dbName, '--remote', '--file', tempSql], {
    stdio: 'inherit', shell: process.platform === 'win32'
  });
  if (result.status !== 0) throw new Error(`D1 import failed (exit ${result.status ?? 'unknown'}).`);
  console.log('\nImport command completed. Next, verify record counts and test mobile/PIN login on the deployed Worker.');
} catch (error) {
  console.error(`\nImport stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  try { fs.unlinkSync(tempSql); } catch {}
}
