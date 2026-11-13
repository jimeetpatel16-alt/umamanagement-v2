interface Env {
  DB: D1Database;
  EVIDENCE?: R2Bucket;
  ASSETS: Fetcher;
  SESSION_DAYS?: string;
}

type Account = {
  id: string;
  name: string;
  mobile: string;
  role: string;
  active: boolean;
  driverId?: string | null;
  labourId?: string | null;
  companyId?: string | null;
};

type StoredDoc = { collection: string; doc_id: string; data_json: string; created_at: string; updated_at: string };

const COLLECTIONS = new Set([
  'settings', 'staff', 'drivers', 'companies', 'days', 'driverSubmissions',
  'labour', 'labourShifts', 'labourLogs', 'invoices', 'rateCards', 'auditLog',
  'deliveryBlocks', 'driverAssignments'
]);
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const json = (value: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', ...extra } });
const fail = (message: string, status = 400) => json({ error: message }, status);
const jsonBody = async (request: Request): Promise<any> => { try { return await request.json(); } catch { return null; } };

function normalizeMobile(value: unknown): string {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('0061')) digits = digits.slice(2);
  if (digits.startsWith('61')) digits = `0${digits.slice(2)}`;
  else if (digits.length === 9) digits = `0${digits}`;
  return digits;
}
function bytesToHex(value: Uint8Array) { return [...value].map((part) => part.toString(16).padStart(2, '0')).join(''); }
function hexToBytes(value: string) { return new Uint8Array((value.match(/.{1,2}/g) || []).map((part) => parseInt(part, 16))); }
async function digest(value: string) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}
async function verifyPin(pin: string, saltHex: string, expectedHex: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: 100000, hash: 'SHA-256' }, key, 256);
  const actual = new Uint8Array(derived);
  const expected = hexToBytes(expectedHex);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}
async function hashPin(pin: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return { salt: bytesToHex(salt), hash: bytesToHex(new Uint8Array(derived)) };
}
function getCookie(request: Request, name: string) {
  return (request.headers.get('cookie') || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}
function safeAccount(id: string, data: any): Account {
  return { id, name: String(data.name || 'User'), mobile: String(data.mobile || ''), role: String(data.role || 'staff').trim().toLowerCase(), active: data.active !== false && data.active !== 0, driverId: data.driverId || null, labourId: data.labourId || null, companyId: data.companyId || null };
}
async function readDoc(env: Env, collection: string, id: string) {
  const row = await env.DB.prepare('SELECT data_json FROM app_documents WHERE collection=? AND doc_id=?').bind(collection, id).first<{ data_json: string }>();
  if (!row) return null;
  try { return JSON.parse(row.data_json); } catch { return null; }
}
// Labour clock-in/out site check. Mirrors checkLabourSite() in web/app.js:
// allowed when (distance - min(accuracy, 50 m)) <= the company's radius.
function distanceMetres(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000; const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1); const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}
async function labourSiteError(env: Env, companyId: string, location: any, action: string): Promise<string | null> {
  if (!companyId) return null;
  const company = await readDoc(env, 'companies', companyId);
  if (!company) return null;
  const siteLat = Number(company.siteLat); const siteLng = Number(company.siteLng);
  if (company.siteLat == null || company.siteLat === '' || company.siteLng == null || company.siteLng === '' || !Number.isFinite(siteLat) || !Number.isFinite(siteLng)) return null;
  const lat = Number(location?.lat); const lng = Number(location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return `Your location is needed to ${action}. Allow location access and try again.`;
  const radius = Number(company.siteRadius) || 200;
  const accuracy = Math.max(0, Number(location?.accuracy) || 0);
  const distance = distanceMetres(lat, lng, siteLat, siteLng);
  if (distance - Math.min(accuracy, 50) > radius) return `You are ${distance} m from the site. You can only ${action} within ${radius} m of it.`;
  return null;
}
async function currentAccount(request: Request, env: Env): Promise<Account | null> {
  const raw = getCookie(request, 'uma_shared');
  if (!raw) return null;
  let token = raw;
  try { token = decodeURIComponent(raw); } catch {}
  const tokenHash = await digest(token);
  const session = await env.DB.prepare(`SELECT s.staff_id FROM app_auth_sessions s JOIN app_auth_accounts a ON a.staff_id=s.staff_id WHERE s.token_hash=? AND s.expires_at>? AND a.active=1`).bind(tokenHash, now()).first<{ staff_id: string }>();
  if (!session) return null;
  const profile = await readDoc(env, 'staff', session.staff_id);
  if (!profile || profile.active === false || profile.active === 0) return null;
  return safeAccount(session.staff_id, profile);
}
function accountResponse(account: Account) { return { id: account.id, name: account.name, mobile: account.mobile, role: account.role, active: account.active, driverId: account.driverId, labourId: account.labourId, companyId: account.companyId }; }
async function createSession(request: Request, env: Env, account: Account) {
  const token = `${uid()}${uid()}`;
  const days = Math.min(30, Math.max(1, Number(env.SESSION_DAYS) || 7));
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  await env.DB.prepare('INSERT INTO app_auth_sessions(token_hash,staff_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await digest(token), account.id, expires, now()).run();
  return json({ user: accountResponse(account) }, 200, { 'set-cookie': `uma_shared=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${days * 86400}` });
}

async function listDocs(env: Env, collection: string): Promise<Array<{ id: string; data: any }>> {
  const result = await env.DB.prepare('SELECT doc_id,data_json FROM app_documents WHERE collection=? ORDER BY created_at ASC').bind(collection).all<{ doc_id: string; data_json: string }>();
  return (result.results || []).flatMap((row) => {
    try { return [{ id: row.doc_id, data: JSON.parse(row.data_json) }]; } catch { return []; }
  });
}
function visibleToAccount(collection: string, row: { id: string; data: any }, account: Account, ownDriver: any, ownLabour: any) {
  if (['admin', 'manager', 'staff'].includes(account.role)) {
    if (collection === 'staff' && account.role !== 'admin' && row.id !== account.id) return false;
    if (collection === 'auditLog' && account.role !== 'admin') return false;
    if (collection === 'invoices' && account.role === 'staff') return false;
    return true;
  }
  if (collection === 'staff') return row.id === account.id;
  if (account.role === 'driver') {
    const driverId = account.driverId;
    if (collection === 'drivers') return row.id === driverId;
    if (collection === 'companies') return true;
    if (collection === 'driverSubmissions') return row.data.driverId === driverId;
    if (collection === 'driverAssignments') return row.data.driverId === driverId;
    if (collection === 'days') {
      const driverName = String(ownDriver?.name || account.name).trim().toLowerCase();
      const records = Array.isArray(row.data.records) ? row.data.records : [];
      const owned = records.filter((item: any) => String(item.driverName || item.driver_name || '').trim().toLowerCase() === driverName);
      return owned.length > 0;
    }
    if (collection === 'deliveryBlocks') return true;
    return false;
  }
  if (account.role === 'labour') {
    const labourId = account.labourId;
    if (collection === 'labour') return row.id === labourId;
    if (collection === 'companies') return !!ownLabour?.companyId && row.id === ownLabour.companyId;
    if (collection === 'labourShifts') return row.data.labourId === labourId;
    if (collection === 'labourLogs') return row.data.labourId === labourId || String(row.data.mobile || '') === account.mobile;
    return false;
  }
  return false;
}
function canWrite(account: Account, collection: string, method: string) {
  const role = String(account.role || '').trim().toLowerCase();
  const target = String(collection || '').trim().toLowerCase();
  const verb = String(method || '').trim().toUpperCase();

  if (role === 'admin') return true;
  if (role === 'manager') return !['staff', 'auditlog'].includes(target);
  if (role === 'staff') return !['staff', 'auditlog', 'settings'].includes(target);
  // Driver/Labour updates are permitted only for their own records; record
  // ownership is checked in the update route below.
  if (role === 'driver') return target === 'driversubmissions' && ['POST', 'PATCH', 'PUT'].includes(verb);
  if (role === 'labour') return ['labourlogs', 'labourshifts'].includes(target) && ['POST', 'PATCH', 'PUT'].includes(verb);
  return false;
}
async function saveDocument(env: Env, collection: string, id: string, data: any, mode: 'set' | 'update', account?: Account) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Document data must be an object.');
  const existing = mode === 'update' ? await readDoc(env, collection, id) : null;
  const incoming = { ...data };
  const pin = collection === 'staff' && Object.prototype.hasOwnProperty.call(incoming, 'pin') ? String(incoming.pin) : null;
  if (collection === 'staff' && pin !== null && !/^\d{4}$/.test(pin)) throw new Error('PIN must contain exactly 4 digits.');
  if (collection === 'staff' && mode === 'set' && pin === null) throw new Error('A new staff account requires a four-digit PIN.');
  if (collection === 'staff') delete incoming.pin;
  const merged = mode === 'update' ? { ...(existing || {}), ...incoming } : incoming;
  const timestamp = now();
  const createdAt = merged.createdAt || merged.created_at || existing?.createdAt || timestamp;
  const updatedAt = merged.updatedAt || timestamp;
  await env.DB.prepare(`INSERT INTO app_documents(collection,doc_id,data_json,created_at,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(collection,doc_id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at`).bind(collection, id, JSON.stringify(merged), createdAt, updatedAt).run();
  if (collection === 'staff') {
    const mobile = normalizeMobile(merged.mobile);
    const active = merged.active === false ? 0 : 1;
    if (pin !== null) {
      const hashed = await hashPin(pin);
      await env.DB.prepare(`INSERT INTO app_auth_accounts(staff_id,mobile_norm,pin_salt_hex,pin_hash_hex,active,failed_attempts,locked_until,created_at,updated_at) VALUES(?,?,?,?,?,0,NULL,?,?)
        ON CONFLICT(staff_id) DO UPDATE SET mobile_norm=excluded.mobile_norm,pin_salt_hex=excluded.pin_salt_hex,pin_hash_hex=excluded.pin_hash_hex,active=excluded.active,failed_attempts=0,locked_until=NULL,updated_at=excluded.updated_at`)
        .bind(id, mobile, hashed.salt, hashed.hash, active, createdAt, timestamp).run();
    } else {
      await env.DB.prepare('UPDATE app_auth_accounts SET mobile_norm=?,active=?,updated_at=? WHERE staff_id=?').bind(mobile, active, timestamp, id).run();
    }
    if (!active) await env.DB.prepare('DELETE FROM app_auth_sessions WHERE staff_id=?').bind(id).run();
  }
}

async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === '/api/health' && method === 'GET') return json({ ok: true, service: 'UMA Management Shared D1', storage: 'd1' });
  if (path === '/api/auth/status' && method === 'GET') {
    const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM app_auth_accounts WHERE active=1').first<{ count: number }>();
    return json({ hasAccounts: Number(row?.count || 0) > 0 });
  }
  if (path === '/api/auth/lookup' && method === 'POST') {
    const body = await jsonBody(request);
    const mobile = normalizeMobile(body?.mobile);
    if (mobile.length < 8 || mobile.length > 15) return fail('Enter a valid mobile number.');
    const result = await env.DB.prepare(`SELECT a.staff_id,d.data_json FROM app_auth_accounts a JOIN app_documents d ON d.collection='staff' AND d.doc_id=a.staff_id WHERE a.mobile_norm=? AND a.active=1`).bind(mobile).all<{ staff_id: string; data_json: string }>();
    const accounts: Account[] = [];
    for (const row of result.results || []) {
      try {
        const data = JSON.parse(row.data_json);
        if (data.active === false || data.active === 0) continue;
        accounts.push(safeAccount(row.staff_id, data));
      } catch {}
    }
    return json({ accounts });
  }
  if (path === '/api/auth/verify' && method === 'POST') {
    const body = await jsonBody(request);
    const id = String(body?.staffId || '');
    const pin = String(body?.pin || '');
    if (!id || !/^\d{4}$/.test(pin)) return fail('Enter your four-digit PIN.');
    const accountRow = await env.DB.prepare('SELECT pin_salt_hex,pin_hash_hex,active,failed_attempts,locked_until FROM app_auth_accounts WHERE staff_id=?').bind(id).first<{ pin_salt_hex: string; pin_hash_hex: string; active: number; failed_attempts: number; locked_until: string | null }>();
    if (!accountRow || accountRow.active !== 1) return fail('Incorrect PIN or inactive account.', 401);
    if (accountRow.locked_until && accountRow.locked_until > now()) return fail('Too many incorrect PIN attempts. Try again in 15 minutes.', 429);
    if (!await verifyPin(pin, accountRow.pin_salt_hex, accountRow.pin_hash_hex)) {
      const attempts = Number(accountRow.failed_attempts || 0) + 1;
      const lockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : null;
      await env.DB.prepare('UPDATE app_auth_accounts SET failed_attempts=?,locked_until=?,updated_at=? WHERE staff_id=?').bind(lockedUntil ? 0 : attempts, lockedUntil, now(), id).run();
      return fail(lockedUntil ? 'Too many incorrect PIN attempts. Try again in 15 minutes.' : 'Incorrect PIN.', lockedUntil ? 429 : 401);
    }
    await env.DB.prepare('UPDATE app_auth_accounts SET failed_attempts=0,locked_until=NULL,updated_at=? WHERE staff_id=?').bind(now(), id).run();
    const profile = await readDoc(env, 'staff', id);
    if (!profile || profile.active === false) return fail('This account is inactive. Contact your administrator.', 403);
    return createSession(request, env, safeAccount(id, profile));
  }
  if (path === '/api/auth/me' && method === 'GET') {
    const account = await currentAccount(request, env);
    return account ? json({ user: accountResponse(account) }) : fail('Sign in required.', 401);
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    const raw = getCookie(request, 'uma_shared');
    if (raw) {
      let token = raw; try { token = decodeURIComponent(raw); } catch {}
      await env.DB.prepare('DELETE FROM app_auth_sessions WHERE token_hash=?').bind(await digest(token)).run();
    }
    return json({ ok: true }, 200, { 'set-cookie': 'uma_shared=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
  }
  if (path === '/api/auth/signup' && method === 'POST') {
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM app_auth_accounts').first<{ count: number }>();
    if (Number(count?.count || 0) > 0) return fail('Initial account setup is already complete.', 409);
    const body = await jsonBody(request);
    const name = String(body?.name || '').trim();
    const mobile = normalizeMobile(body?.mobile);
    const pin = String(body?.pin || '');
    if (!name || mobile.length < 8 || mobile.length > 15 || !/^\d{4}$/.test(pin)) return fail('Enter a name, valid mobile number and four-digit PIN.');
    const id = uid(), hashed = await hashPin(pin), createdAt = now();
    const profile = { name, mobile, role: 'admin', active: true, createdAt };
    await env.DB.batch([
      env.DB.prepare('INSERT INTO app_documents(collection,doc_id,data_json,created_at,updated_at) VALUES(?,?,?,?,?)').bind('staff', id, JSON.stringify(profile), createdAt, createdAt),
      env.DB.prepare('INSERT INTO app_auth_accounts(staff_id,mobile_norm,pin_salt_hex,pin_hash_hex,active,failed_attempts,locked_until,created_at,updated_at) VALUES(?,?,?,?,1,0,NULL,?,?)').bind(id, mobile, hashed.salt, hashed.hash, createdAt, createdAt)
    ]);
    return createSession(request, env, safeAccount(id, profile));
  }

  const match = path.match(/^\/api\/data\/([A-Za-z0-9_-]+)(?:\/([^/]+))?$/);
  if (!match) return fail('API route not found.', 404);
  const collection = match[1];
  const id = match[2] ? decodeURIComponent(match[2]) : null;
  if (!COLLECTIONS.has(collection)) return fail('Unknown collection.', 404);
  const account = await currentAccount(request, env);
  if (!account) return fail('Sign in required.', 401);
  const ownDriver = account.driverId ? await readDoc(env, 'drivers', account.driverId) : null;
  const ownLabour = account.labourId ? await readDoc(env, 'labour', account.labourId) : null;

  if (method === 'GET' && !id) {
    const rows = await listDocs(env, collection);
    const visible = rows.filter((row) => visibleToAccount(collection, row, account, ownDriver, ownLabour));
    return json({ docs: visible.map((row) => ({ id: row.id, data: row.data })) });
  }
  if (method === 'GET' && id) {
    const data = await readDoc(env, collection, id);
    if (!data || !visibleToAccount(collection, { id, data }, account, ownDriver, ownLabour)) return json({ id, exists: false, data: null });
    return json({ id, exists: true, data });
  }
  if (method === 'POST' && !id) {
    if (!canWrite(account, collection, method)) return fail('You do not have permission to create this record.', 403);
    const body = await jsonBody(request);
    const newId = String(body?.id || uid());
    if (collection === 'staff' && account.role !== 'admin') return fail('Only Admin can create accounts.', 403);
    if (account.role === 'driver' && body?.driverId !== account.driverId) return fail('Submission does not belong to this Driver account.', 403);
    if (account.role === 'labour' && body?.labourId !== account.labourId) return fail('Record does not belong to this Labour account.', 403);
    if (account.role === 'labour' && collection === 'labourLogs' && body?.clockInAt) {
      const siteError = await labourSiteError(env, String(ownLabour?.companyId || body?.companyId || ''), body?.clockInLocation, 'clock in');
      if (siteError) return fail(siteError, 403);
    }
    try { await saveDocument(env, collection, newId, body, 'set', account); }
    catch (error) { return fail(error instanceof Error ? error.message : 'Could not save record.'); }
    return json({ id: newId }, 201);
  }
  if ((method === 'PUT' || method === 'PATCH') && id) {
    if (!canWrite(account, collection, method)) {
      console.warn('UMA write permission denied', {
        staffId: account.id, role: account.role, collection, method, recordId: id
      });
      return fail('You do not have permission to update this record.', 403);
    }
    if (collection === 'staff' && account.role !== 'admin') return fail('Only Admin can update accounts.', 403);
    const body = await jsonBody(request);
    if (String(account.role).trim().toLowerCase() === 'driver' && collection === 'driverSubmissions') {
      const existing = await readDoc(env, collection, id);
      if (!existing || existing.driverId !== account.driverId) return fail('Submission does not belong to this Driver account.', 403);
      if (body?.driverId && body.driverId !== account.driverId) return fail('Submission does not belong to this Driver account.', 403);
    }
    if (String(account.role).trim().toLowerCase() === 'labour') {
      if (!['labourLogs', 'labourShifts'].includes(collection)) return fail('Forbidden.', 403);
      const existing = await readDoc(env, collection, id);
      if (!existing || existing.labourId !== account.labourId) return fail('Record does not belong to this Labour account.', 403);
      if (body?.labourId && body.labourId !== account.labourId) return fail('Record does not belong to this Labour account.', 403);
      if (collection === 'labourLogs' && body?.clockOutAt) {
        const siteError = await labourSiteError(env, String(existing.companyId || ''), body?.clockOutLocation, 'clock out');
        if (siteError) return fail(siteError, 403);
      }
    }
    // PATCH is always partial. Some legacy Driver/Labour clients submit PUT
    // with partial fields too, so merge those safely while preserving PUT/set
    // behaviour for Admin/Manager/Staff document replacement flows.
    const role = String(account.role || '').trim().toLowerCase();
    const writeMode: 'set' | 'update' =
      method === 'PATCH' || (method === 'PUT' && ['driver', 'labour'].includes(role))
        ? 'update'
        : 'set';
    try { await saveDocument(env, collection, id, body, writeMode, account); }
    catch (error) { return fail(error instanceof Error ? error.message : 'Could not save record.'); }
    return json({ ok: true });
  }
  if (method === 'DELETE' && id) {
    if (!canWrite(account, collection, method)) return fail('You do not have permission to delete this record.', 403);

    if (collection === 'staff') {
      if (account.role !== 'admin') return fail('Only Admin can delete login accounts.', 403);
      if (id === account.id) return fail('You cannot delete your own login.', 409);
      const victim = await readDoc(env, 'staff', id);
      if (!victim) return fail('Account not found.', 404);
      if (String(victim.role || '').trim().toLowerCase() === 'admin' && victim.active !== false && victim.active !== 0) {
        const staffRows = await listDocs(env, 'staff');
        const activeAdmins = staffRows.filter((row) =>
          String(row.data?.role || '').trim().toLowerCase() === 'admin' &&
          row.data?.active !== false && row.data?.active !== 0
        );
        if (activeAdmins.length <= 1) return fail('Cannot delete the last active Admin account.', 409);
      }
    }

    if (collection === 'drivers') {
      if (account.role !== 'admin') return fail('Only Admin can delete Driver accounts.', 403);
      const profile = await readDoc(env, 'drivers', id);
      if (!profile) return fail('Driver account not found.', 404);
      const staffRows = await listDocs(env, 'staff');
      const linkedStaff = staffRows.filter((row) => String(row.data?.driverId || '') === id);
      const statements = [
        env.DB.prepare('DELETE FROM app_documents WHERE collection=? AND doc_id=?').bind('drivers', id),
        env.DB.prepare("DELETE FROM app_documents WHERE collection='driverAssignments' AND json_extract(data_json, '$.driverId')=? AND json_extract(data_json, '$.date')>=?").bind(id, now().slice(0, 10))
      ];
      for (const staff of linkedStaff) {
        statements.push(
          env.DB.prepare('DELETE FROM app_documents WHERE collection=? AND doc_id=?').bind('staff', staff.id),
          env.DB.prepare('DELETE FROM app_auth_accounts WHERE staff_id=?').bind(staff.id),
          env.DB.prepare('DELETE FROM app_auth_sessions WHERE staff_id=?').bind(staff.id)
        );
      }
      await env.DB.batch(statements);
      return json({ ok: true, revokedLogins: linkedStaff.length, historicalSubmissionsRetained: true });
    }

    if (collection === 'labour') {
      if (account.role !== 'admin') return fail('Only Admin can delete Labour accounts.', 403);
      const profile = await readDoc(env, 'labour', id);
      if (!profile) return fail('Labour account not found.', 404);
      const staffRows = await listDocs(env, 'staff');
      const linkedStaff = staffRows.filter((row) => String(row.data?.labourId || '') === id);
      const statements = [
        env.DB.prepare('DELETE FROM app_documents WHERE collection=? AND doc_id=?').bind('labour', id),
        env.DB.prepare("DELETE FROM app_documents WHERE collection='labourShifts' AND json_extract(data_json, '$.labourId')=? AND json_extract(data_json, '$.date')>=?").bind(id, now().slice(0, 10))
      ];
      for (const staff of linkedStaff) {
        statements.push(
          env.DB.prepare('DELETE FROM app_documents WHERE collection=? AND doc_id=?').bind('staff', staff.id),
          env.DB.prepare('DELETE FROM app_auth_accounts WHERE staff_id=?').bind(staff.id),
          env.DB.prepare('DELETE FROM app_auth_sessions WHERE staff_id=?').bind(staff.id)
        );
      }
      await env.DB.batch(statements);
      return json({ ok: true, revokedLogins: linkedStaff.length, historicalLogsRetained: true });
    }

    await env.DB.prepare('DELETE FROM app_documents WHERE collection=? AND doc_id=?').bind(collection, id).run();
    if (collection === 'staff') {
      await env.DB.prepare('DELETE FROM app_auth_accounts WHERE staff_id=?').bind(id).run();
      await env.DB.prepare('DELETE FROM app_auth_sessions WHERE staff_id=?').bind(id).run();
    }
    return json({ ok: true });
  }
  return fail('Method not allowed.', 405);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) return await api(request, env);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error('UMA Worker error:', error);
      return fail('Server error. Please try again.', 500);
    }
  }
};
