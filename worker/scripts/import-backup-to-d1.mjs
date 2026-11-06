#!/usr/bin/env node
/**
 * UMA Management remote D1 importer (command-batched edition).
 * Reads the JSON backup locally. Uses INSERT OR IGNORE, keeps legacy relational
 * tables untouched, removes plaintext PINs from staff documents, and stores
 * PBKDF2-SHA256 PIN hashes in app_auth_accounts.
 *
 * Run from worker/: node scripts/import-backup-to-d1.mjs "/path/to/backup.json"
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const backupPath = process.argv[2];
if (!backupPath) {
  console.error('Usage: node scripts/import-backup-to-d1.mjs "/path/to/uma-management-backup.json"');
  process.exit(2);
}
if (!fs.existsSync('wrangler.toml')) {
  console.error('Run this script from the worker directory (the folder containing wrangler.toml).');
  process.exit(2);
}
if (!fs.existsSync(backupPath)) {
  console.error(`Backup file not found: ${backupPath}`);
  process.exit(2);
}

const config = fs.readFileSync('wrangler.toml', 'utf8');
const dbName = config.match(/database_name\s*=\s*["']([^"']+)["']/)?.[1];
const dbId = config.match(/database_id\s*=\s*["']([^"']+)["']/)?.[1];
if (!dbName || !dbId || /REPLACE_WITH|YOUR_DATABASE/i.test(dbId)) {
  console.error('wrangler.toml must contain your real D1 database name and ID.');
  process.exit(2);
}

let backup;
try { backup = JSON.parse(fs.readFileSync(backupPath, 'utf8')); }
catch (e) { console.error(`Could not parse backup JSON: ${e.message}`); process.exit(2); }
if (backup?.format !== 'uma-management-backup' || !backup.collections || typeof backup.collections !== 'object') {
  console.error('Unsupported backup. Expected format: uma-management-backup.');
  process.exit(2);
}

const allowed = new Set([
  'settings', 'staff', 'drivers', 'companies', 'days', 'driverSubmissions',
  'labour', 'labourShifts', 'labourLogs', 'invoices', 'rateCards', 'auditLog',
  'deliveryBlocks', 'driverAssignments'
]);
const quote = (v) => `'${String(v).replace(/'/g, "''")}'`;
const now = new Date().toISOString();
const docRows = [];
const authRows = [];
const report = {};
let malformed = 0;
let authSkipped = 0;

function normalizeMobile(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('0061')) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith('61')) digits = `0${digits.slice(2)}`;
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
      if (/^\d{4}$/.test(pin) && mobile.length >= 8 && mobile.length <= 15) {
        const { salt, hash } = hashPin(pin);
        authRows.push([row.id, mobile, salt, hash, data.active === false || data.active === 0 ? 0 : 1, 0, null, createdAt, updatedAt]);
      } else authSkipped++;
    }

    docRows.push([collection, row.id, JSON.stringify(data), createdAt, updatedAt]);
  }
}
if (!docRows.length) {
  console.error('No supported records found. No D1 changes were made.');
  process.exit(2);
}

function runWrangler(args) {
  return spawnSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 10 * 1024 * 1024
  });
}
function runCommand(sql, label) {
  const result = runWrangler(['d1', 'execute', dbName, '--remote', '--command', sql]);
  if (result.status !== 0) {
    console.error(`\nFailed during ${label}.`);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`Wrangler exited with status ${result.status ?? 'unknown'}.`);
  }
  return result.stdout || '';
}
function makeInsertBatches(table, columns, rows, maxRows = 4, maxChars = 12000) {
  const batches = [];
  let current = [];
  for (const row of rows) {
    const tuple = `(${row.map((v) => v === null ? 'NULL' : typeof v === 'number' ? String(v) : quote(v)).join(',')})`;
    const next = current.concat(tuple);
    const sql = `INSERT OR IGNORE INTO ${table} (${columns.join(',')}) VALUES ${next.join(',')};`;
    if (current.length && (next.length > maxRows || sql.length > maxChars)) {
      batches.push(`INSERT OR IGNORE INTO ${table} (${columns.join(',')}) VALUES ${current.join(',')};`);
      current = [tuple];
    } else current = next;
  }
  if (current.length) batches.push(`INSERT OR IGNORE INTO ${table} (${columns.join(',')}) VALUES ${current.join(',')};`);
  return batches;
}

console.log('\nUMA Management shared-D1 import preview');
console.log(`Target database: ${dbName}`);
console.log(`Configured D1 database ID: ${dbId}`);
console.log(`Backup exported: ${backup.exportedAt || 'not recorded'}`);
console.log(`Documents prepared: ${docRows.length}`);
console.log(`Secure staff PIN hashes prepared: ${authRows.length}`);
if (authSkipped) console.log(`Staff rows needing PIN/mobile review: ${authSkipped}`);
if (malformed) console.log(`Malformed rows skipped: ${malformed}`);
for (const [name, count] of Object.entries(report)) console.log(`  ${name}: ${count}`);
console.log('\nSafety: no migrations are run; existing app_documents/auth rows are never overwritten; legacy relational tables are untouched; plaintext PINs are not stored.');

// Simple read-only table check (avoids compound scalar SELECT and file-upload APIs).
const tableOutput = runCommand(
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('app_documents','app_auth_accounts','app_auth_sessions') ORDER BY name;",
  'read-only shared-table check'
);
const missing = ['app_documents', 'app_auth_accounts', 'app_auth_sessions'].filter((name) => !tableOutput.includes(name));
if (missing.length) {
  console.error(`Missing required shared table(s): ${missing.join(', ')}. No backup rows were written.`);
  process.exit(2);
}

const answer = await new Promise((resolve) => {
  process.stdout.write('\nCompare the database ID above with Cloudflare. Type IMPORT to write this backup to REMOTE D1: ');
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.includes('\n')) resolve(input.trim());
  });
});
if (answer !== 'IMPORT') {
  console.log('Cancelled. No backup rows were written.');
  process.exit(0);
}

try {
  const docBatches = makeInsertBatches('app_documents', ['collection','doc_id','data_json','created_at','updated_at'], docRows);
  const authBatches = makeInsertBatches('app_auth_accounts', ['staff_id','mobile_norm','pin_salt_hex','pin_hash_hex','active','failed_attempts','locked_until','created_at','updated_at'], authRows);
  const batches = [...docBatches, ...authBatches];
  console.log(`\nWriting ${docBatches.length} document batch(es) and ${authBatches.length} PIN-auth batch(es)...`);
  for (let i = 0; i < batches.length; i++) {
    runCommand(batches[i], `batch ${i + 1}/${batches.length}`);
    console.log(`Completed batch ${i + 1}/${batches.length}`);
  }
  console.log('\nImport commands completed. Run the verification counts before deploying the updated Worker/frontend.');
  console.log('If any batch fails, rerunning is safe: INSERT OR IGNORE skips rows already imported.');
} catch (e) {
  console.error(`\nImport stopped: ${e.message}`);
  console.error('Some earlier batches may have completed. Check counts, then rerun this same script if required; INSERT OR IGNORE makes it resumable.');
  process.exitCode = 1;
}
