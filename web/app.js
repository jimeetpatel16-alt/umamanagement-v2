/* ============================================================
   Driver Payments — application logic
   Single-page app: hash-routed views over a shared `state` object,
   backed by the `db` capability (falls back to a localStorage shim
   when previewed outside claude.ai so the app never breaks).
   ============================================================ */
(function () {
  'use strict';

  // ---------------------------------------------------------------
  // Local-fallback DB shim (same call surface as the real db capability,
  // used only when claude.use('db') is unavailable — e.g. a local preview)
  // ---------------------------------------------------------------
  function makeLocalDbShim() {
    const KEY = 'driverpay_local_db_v1';
    function loadStore() {
      try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; }
    }
    function saveStore(s) {
      try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {}
    }
    function getColl(store, path) {
      if (!store[path]) store[path] = {};
      return store[path];
    }
    function makeDocRef(path) {
      const parts = path.split('/');
      const collPath = parts.slice(0, -1).join('/');
      const id = parts[parts.length - 1];
      return {
        id, path,
        async get() {
          const store = loadStore();
          const coll = getColl(store, collPath);
          const data = coll[id];
          return { id, exists: data !== undefined, data: () => data };
        },
        async set(data) {
          const store = loadStore();
          const coll = getColl(store, collPath);
          coll[id] = JSON.parse(JSON.stringify(data));
          saveStore(store);
        },
        async update(data) {
          const store = loadStore();
          const coll = getColl(store, collPath);
          coll[id] = Object.assign({}, coll[id] || {}, JSON.parse(JSON.stringify(data)));
          saveStore(store);
        },
        async delete() {
          const store = loadStore();
          const coll = getColl(store, collPath);
          delete coll[id];
          saveStore(store);
        },
        collection(sub) { return makeCollRef(path + '/' + sub); },
      };
    }
    function makeCollRef(path) {
      return {
        path,
        doc(id) { return makeDocRef(path + '/' + (id || ('id' + Date.now() + Math.random().toString(36).slice(2)))); },
        async add(data) { const ref = this.doc(); await ref.set(data); return ref; },
        async get() {
          const store = loadStore();
          const coll = getColl(store, path);
          return { docs: Object.entries(coll).map(([id, data]) => ({ id, exists: true, data: () => data })) };
        },
        where() { return this; }, orderBy() { return this; }, limit() { return this; },
      };
    }
    return { doc: makeDocRef, collection: makeCollRef };
  }

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  const DEFAULT_SETTINGS = {
    businessName: 'UMA Management',
    prefixFormat: 'PAY-{NUMBER}',
    nextPaymentNumber: 1,
    labourPrefixFormat: 'LAB-{NUMBER}',
    nextLabourNumber: 1,
    invoicePrefixFormat: 'INV-{NUMBER}',
    nextInvoiceNumber: 1,
    // Used to resolve which rate-card tier applies to a set of hours worked:
    // hours beyond this on an otherwise-standard weekday go to the Overtime
    // tier; a shift starting inside the night window uses the Night tier;
    // a date in publicHolidays uses the Public Holiday tier regardless of
    // day-of-week. See computeHourBreakdown().
    overtimeThresholdHours: 8,
    nightShiftStart: '18:00',
    nightShiftEnd: '06:00',
    publicHolidays: [], // ['2026-12-25', ...] — managed on the Settings page
    // Delivery Performance — Start Work/Finish Work submission settings.
    submissionPrefixFormat: 'SUB-{NUMBER}',
    nextSubmissionNumber: 1,
    screenshotRequired: false,
    failureReasons: ['Customer unavailable', 'Wrong address', 'Access issue (gate/building)', 'Parcel damaged', 'Vehicle breakdown', 'Weather/traffic delay', 'Other'],
    blockPrefixFormat: 'BLK-{NUMBER}',
    nextBlockNumber: 1,
  };
  const VEHICLES = ['Car', 'Van', 'Other'];
  const STATUSES = ['Pending', 'Approved', 'Paid', 'Cancelled'];
  const RATE_TYPES = [{ value: 'fixed', label: 'Fixed rate per block' }, { value: 'per_parcel', label: 'Rate per parcel' }];

  const state = {
    db: null,
    downloads: null,
    sample: null,
    usingFallback: true,
    remoteDb: false,
    accountSetupRequired: false,
    staff: [],
    drivers: [],
    companies: [],
    settings: Object.assign({}, DEFAULT_SETTINGS),
    days: [], // [{date, records:[...]}] sorted asc
    session: null,
    route: 'dashboard',
    recordsFilter: null, // optional preset filter when navigating from another page
    entryRows: [], // working rows for the Daily Entry screen
    entryDate: todayStr(),
    entryMode: 'single', // 'single' | 'bulk' — which Daily Entry tab is showing
    bulkText: '',
    bulkRows: null, // null until parsed once; then an array of editable rows
    bulkBusy: false,
    bulkError: '',
    driverSubmissions: [],
    // Labour roster — simple name/mobile/type/company roster with its own
    // mobile-number login, kept deliberately separate from Drivers (which
    // stays parcel/block-based, untouched).
    labour: [],
    labourShifts: [],
    labourLogs: [],
    invoices: [],
    // Versioned, effective-dated rate tiers per company + labour category
    // (see resolveRateCard()) — each doc is one immutable "version"; adding
    // a new one is how a rate change is recorded, which doubles as the rate
    // history/audit trail the Rate Cards page shows.
    rateCards: [],
    // Append-only record of manual pay/bill overrides (see 'labour-log-override').
    auditLog: [],
    // Delivery Performance — named routes/zones a driver can be assigned to,
    // and the day-by-day assignment linking a driver to one for a given date.
    deliveryBlocks: [],
    driverAssignments: [],
    // Route planner: one doc per uploaded run sheet (see viewDriverRoute()).
    routes: [],
  };

  const SESSION_KEY = 'driverpay_session';
  const VALID_ROLES = new Set(['admin', 'manager', 'staff', 'driver', 'labour']);

  function sessionFromStaff(staffMember) {
    return {
      staffId: staffMember.id,
      name: staffMember.name || 'User',
      role: VALID_ROLES.has(String(staffMember.role || '').trim().toLowerCase()) ? String(staffMember.role).trim().toLowerCase() : 'staff',
      driverId: staffMember.driverId || null,
      labourId: staffMember.labourId || null,
    };
  }

  function persistSession(session) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) {
      console.warn('UMA could not persist the current session in this browser.', e);
    }
  }

  function clearPersistedSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {
      console.warn('UMA could not clear the saved session in this browser.', e);
    }
  }

  // ---------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function fmtMoney(n) {
    n = Number(n) || 0;
    const neg = n < 0;
    const s = '$' + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return neg ? '-' + s : s;
  }
  function fmtDateHuman(dateStr) {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  }
  function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function companyByName(name) { return state.companies.find((c) => c.name === name); }
  const VEHICLE_RATE_FIELD = { Car: 'carRate', Van: 'vanRate', Other: 'otherRate' };
  function companyVehicleRate(company, vehicle) {
    if (!company) return 0;
    const field = VEHICLE_RATE_FIELD[vehicle] || 'otherRate';
    return Number(company[field]) || 0;
  }
  function computeBaseRate(companyName, vehicle, parcels) {
    const c = companyByName(companyName);
    if (!c) return 0;
    const rate = companyVehicleRate(c, vehicle || 'Car');
    if (c.rateType === 'per_parcel') return rate * (Number(parcels) || 0);
    return rate;
  }
  function rateTypeLabel(rateType) { return (RATE_TYPES.find((r) => r.value === rateType) || RATE_TYPES[0]).label; }
  function finalPay(rec) { return (Number(rec.baseRate) || 0) + (Number(rec.bonus) || 0) + (Number(rec.adjustment) || 0); }
  function formatPrefix(fmt, number, dateStr) {
    const padded = String(number).padStart(4, '0');
    return (fmt || 'PAY-{NUMBER}').replace('{NUMBER}', padded).replace('{DATE}', (dateStr || '').replace(/-/g, ''));
  }
  function startOfWeek(d) { const dt = new Date(d); const day = (dt.getDay() + 6) % 7; dt.setDate(dt.getDate() - day); dt.setHours(0, 0, 0, 0); return dt; }
  function toDateStr(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

  function getDay(date) { return state.days.find((d) => d.date === date); }
  function allRecordsFlat() {
    const out = [];
    state.days.forEach((day) => day.records.forEach((rec) => out.push(Object.assign({ date: day.date }, rec))));
    return out;
  }
  // Rendering thousands of table rows on every keystroke/checkbox click (each
  // re-renders the whole view) is the main thing that makes this app feel
  // slow once a business has months of history — capRows() caps what actually
  // gets built into HTML while still reporting the true total, so a page with
  // no narrowing filter applied stays fast; adding a date/status/driver filter
  // (which is what these pages already have) narrows below the cap.
  const ROW_RENDER_CAP = 200;
  function capRows(rows, limit) {
    limit = limit || ROW_RENDER_CAP;
    if (rows.length <= limit) return { shown: rows, total: rows.length, capped: false };
    return { shown: rows.slice(0, limit), total: rows.length, capped: true };
  }
  function capNoticeHtml(cap) {
    if (!cap.capped) return '';
    return `<p class="helptext" style="margin-bottom:10px;">Showing the latest ${cap.shown.length} of ${cap.total} — narrow with the filters above to see the rest.</p>`;
  }
  function activeDrivers() { return state.drivers.filter((d) => d.active !== false); }
  function activeStaff() { return state.staff.filter((s) => s.active !== false); }
  function activeCompanies() { return state.companies.filter((c) => c.active !== false); }
  // Daily Entry / Bulk Add / Driver Submissions only ever deal with delivery
  // work, so their company pickers are scoped to "Delivery Contract" type
  // companies — a "Labour" type company never shows up there.
  function activeDeliveryCompanies() { return state.companies.filter((c) => c.active !== false && (c.type || 'delivery') === 'delivery'); }
  function driverByName(name) { return state.drivers.find((d) => d.name === name); }
  // Case/whitespace-insensitive lookup — used when a driver's name is typed freehand
  // (Daily Entry, Record edit) so "john" matches an existing "John" instead of
  // quietly creating a duplicate driver.
  function driverByNameLoose(name) {
    const n = (name || '').trim().toLowerCase();
    if (!n) return null;
    return state.drivers.find((d) => d.name.trim().toLowerCase() === n) || null;
  }

  // Remote Cloudflare D1 adapter. It preserves the Firestore-like db surface
  // used by the existing application, while storing documents centrally.
  function makeRemoteDbShim() {
    async function request(path, options) {
      const response = await fetch(path, Object.assign({
        credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' }
      }, options || {}));
      let body = {};
      try { body = await response.json(); } catch (e) {}
      if (!response.ok) throw new Error(body.error || `Cloud database request failed (${response.status}).`);
      return body;
    }
    function makeDocRef(path) {
      const parts = path.split('/');
      const collection = parts[0], id = parts.slice(1).join('/');
      const url = `/api/data/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`;
      return {
        id, path,
        async get() {
          const result = await request(url);
          return { id, exists: !!result.exists, data: () => result.data };
        },
        async set(data) { await request(url, { method: 'PUT', body: JSON.stringify(data) }); },
        async update(data) { await request(url, { method: 'PATCH', body: JSON.stringify(data) }); },
        async delete() { await request(url, { method: 'DELETE' }); },
        collection(sub) { return makeCollRef(`${path}/${sub}`); }
      };
    }
    function makeCollRef(path) {
      const collection = path.split('/')[0];
      const url = `/api/data/${encodeURIComponent(collection)}`;
      return {
        path,
        doc(id) { return makeDocRef(`${collection}/${id || genId()}`); },
        async add(data) {
          const result = await request(url, { method: 'POST', body: JSON.stringify(data) });
          return makeDocRef(`${collection}/${result.id}`);
        },
        async get() {
          const result = await request(url);
          return { docs: (result.docs || []).map((row) => ({ id: row.id, exists: true, data: () => row.data })) };
        },
        where() { return this; }, orderBy() { return this; }, limit() { return this; }
      };
    }
    return {
      doc: makeDocRef,
      collection: makeCollRef,
      async authStatus() { return request('/api/auth/status'); },
      async lookupStaff(mobile) { return (await request('/api/auth/lookup', { method: 'POST', body: JSON.stringify({ mobile }) })).accounts || []; },
      async verifyPin(staffId, pin) { return request('/api/auth/verify', { method: 'POST', body: JSON.stringify({ staffId, pin }) }); },
      async authMe() { return request('/api/auth/me'); },
      async authLogout() { return request('/api/auth/logout', { method: 'POST', body: '{}' }); },
      async authSignup(name, mobile, pin) { return request('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name, mobile, pin }) }); }
    };
  }

  // ---------------------------------------------------------------
  // DB access
  // ---------------------------------------------------------------
  async function initDb() {
    let db = null, dl = null, sm = null;
    // Prefer the shared Cloudflare Worker whenever it is available. Never
    // silently fall back if its health check advertises D1 but subsequently fails.
    try {
      const response = await fetch('/api/health', { credentials: 'same-origin', cache: 'no-store' });
      if (response.ok) {
        const health = await response.json();
        if (health && health.storage === 'd1' && health.service === 'UMA Management Shared D1') {
          db = makeRemoteDbShim();
          state.remoteDb = true;
          state.usingFallback = false;
        }
      }
    } catch (e) { /* local preview / offline */ }
    if (!db) {
      try { db = window.claude && window.claude.use ? await window.claude.use('db') : null; } catch (e) { db = null; }
      if (!db) { db = makeLocalDbShim(); state.usingFallback = true; state.remoteDb = false; }
      else { state.usingFallback = false; state.remoteDb = false; }
    }
    try { dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null; } catch (e) { dl = null; }
    try { sm = window.claude && window.claude.use ? await window.claude.use('sample') : null; } catch (e) { sm = null; }
    state.db = db;
    state.downloads = dl;
    state.sample = sm;
  }
  async function loadSettings() {
    const snap = await state.db.doc('settings/config').get();
    state.settings = snap.exists ? Object.assign({}, DEFAULT_SETTINGS, snap.data()) : Object.assign({}, DEFAULT_SETTINGS);
    if (!snap.exists && (!state.remoteDb || (state.session && state.session.role === 'admin'))) await state.db.doc('settings/config').set(state.settings);
  }
  async function loadStaff() {
    const q = await state.db.collection('staff').get();
    state.staff = q.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  }
  async function loadDrivers() {
    const q = await state.db.collection('drivers').get();
    state.drivers = q.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    state.drivers.sort((a, b) => a.name.localeCompare(b.name));
  }
  async function loadCompanies() {
    const q = await state.db.collection('companies').get();
    state.companies = q.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    state.companies.sort((a, b) => a.name.localeCompare(b.name));
  }
  async function loadDays() {
    const q = await state.db.collection('days').get();
    const days = q.docs.map((d) => d.data());
    days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    state.days = days;
  }
  async function loadDriverSubmissions() { const q = await state.db.collection('driverSubmissions').get(); state.driverSubmissions = q.docs.map((d) => Object.assign({ id: d.id }, d.data())); }
  async function loadLabour() { const q = await state.db.collection('labour').get(); state.labour = q.docs.map((d) => Object.assign({ id: d.id }, d.data())); state.labour.sort((a, b) => (a.name || '').localeCompare(b.name || '')); }
  async function loadLabourShifts() { const q = await state.db.collection('labourShifts').get(); state.labourShifts = q.docs.map((d) => Object.assign({ id: d.id }, d.data())); state.labourShifts.sort((a, b) => (a.date || '').localeCompare(b.date || '')); }
  async function loadLabourLogs() { const q = await state.db.collection('labourLogs').get(); state.labourLogs = q.docs.map((d) => Object.assign({ id: d.id }, d.data())); }
  async function loadInvoices() { const q = await state.db.collection('invoices').get(); state.invoices = q.docs.map((d) => Object.assign({ id: d.id }, d.data())); }
  async function loadRateCards() {
    const q = await state.db.collection('rateCards').get();
    state.rateCards = q.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    state.rateCards.sort((a, b) => (a.effectiveDate || '').localeCompare(b.effectiveDate || ''));
  }
  async function loadAuditLog() {
    const q = await state.db.collection('auditLog').get();
    state.auditLog = q.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    state.auditLog.sort((a, b) => (b.changedAt || '').localeCompare(a.changedAt || ''));
  }
  async function loadDeliveryBlocks() {
    const q = await state.db.collection('deliveryBlocks').get();
    state.deliveryBlocks = q.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    state.deliveryBlocks.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }
  async function loadDriverAssignments() {
    const q = await state.db.collection('driverAssignments').get();
    state.driverAssignments = q.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    state.driverAssignments.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }
  async function loadAll() {
    await Promise.all([
      loadSettings(), loadStaff(), loadDrivers(), loadCompanies(), loadDays(),
      loadDriverSubmissions(), loadLabour(), loadLabourShifts(), loadLabourLogs(), loadInvoices(),
      loadRateCards(), loadAuditLog(), loadDeliveryBlocks(), loadDriverAssignments(), loadRoutes(),
    ]);
  }

  async function saveDay(date, records) {
    records.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    await state.db.doc('days/' + date).set({ date, records, updatedAt: new Date().toISOString() });
    await loadDays();
  }
  async function saveSettings(patch) {
    state.settings = Object.assign({}, state.settings, patch);
    await state.db.doc('settings/config').set(state.settings);
  }
  async function claimPaymentRef(dateStr) {
    const num = state.settings.nextPaymentNumber || 1;
    const ref = formatPrefix(state.settings.prefixFormat, num, dateStr);
    await saveSettings({ nextPaymentNumber: num + 1 });
    return ref;
  }
  async function claimLabourRef() {
    const num = state.settings.nextLabourNumber || 1;
    const ref = formatPrefix(state.settings.labourPrefixFormat, num, '');
    await saveSettings({ nextLabourNumber: num + 1 });
    return ref;
  }
  async function claimInvoiceRef(dateStr) {
    const num = state.settings.nextInvoiceNumber || 1;
    const ref = formatPrefix(state.settings.invoicePrefixFormat, num, dateStr);
    await saveSettings({ nextInvoiceNumber: num + 1 });
    return ref;
  }
  // Driver submission references must not update shared Admin settings.
  // Use the already-created submission document ID to make a stable unique
  // reference, while still respecting the Admin-configured prefix/date tokens.
  async function claimSubmissionRef(submissionId, dateStr) {
    const token = String(submissionId || genId())
      .replace(/[^a-z0-9]/gi, '')
      .slice(-8)
      .toUpperCase();
    const format = state.settings.submissionPrefixFormat || 'SUB-{NUMBER}';
    return String(format)
      .replace('{NUMBER}', token)
      .replace('{DATE}', String(dateStr || '').replace(/-/g, ''));
  }
  async function claimBlockRef() {
    const num = state.settings.nextBlockNumber || 1;
    const ref = formatPrefix(state.settings.blockPrefixFormat, num, '');
    await saveSettings({ nextBlockNumber: num + 1 });
    return ref;
  }
  // ---------------------------------------------------------------
  // Mobile-number login helpers — every account (admin/staff/manager/driver/
  // labour) lives in the `staff` collection and logs in with its mobile
  // number + PIN, so a mobile number must be unique across every role.
  // ---------------------------------------------------------------
  // Canonicalise Australian mobile numbers so the same account is found
  // whether a user types 04xx xxx xxx, +61 4xx xxx xxx, or 4xx xxx xxx.
  // Existing stored values are not rewritten; comparison happens on the fly.
  function normalizeMobile(m) {
    let digits = String(m == null ? '' : m).replace(/\D/g, '');
    // Accept common Australian input forms: 04..., 4..., +614..., 6104...
    if (digits.startsWith('0011')) digits = digits.slice(4);
    if (digits.startsWith('0061')) digits = digits.slice(2);
    if (digits.startsWith('6104') && digits.length === 12) digits = '04' + digits.slice(4);
    else if (digits.startsWith('61') && digits.length === 11) digits = '0' + digits.slice(2);
    if (digits.length === 9 && digits.startsWith('4')) digits = '0' + digits;
    return digits;
  }
  function mobileTaken(mobile, excludeStaffId) {
    const norm = normalizeMobile(mobile);
    if (!norm) return false;
    return state.staff.some((s) => s.id !== excludeStaffId && normalizeMobile(s.mobile) === norm);
  }

  // ---------------------------------------------------------------
  // Toasts & modal
  // ---------------------------------------------------------------
  function toast(msg, type) {
    const box = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }
  function closeModal() { document.getElementById('modal-root').innerHTML = ''; }
  function openModal(innerHtml, opts) {
    opts = opts || {};
    const root = document.getElementById('modal-root');
    root.innerHTML = `<div class="modal-backdrop" data-action="modal-backdrop"><div class="modal ${opts.wide ? 'wide' : ''}" role="dialog" aria-modal="true">${innerHtml}</div></div>`;
  }
  function confirmDialog(message, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      openModal(`
        <div class="modal-head"><h3>${esc(opts.title || 'Please confirm')}</h3></div>
        <p style="margin-bottom:18px;color:var(--ink-muted);">${message}</p>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button class="btn" data-action="confirm-no">Cancel</button>
          <button class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" data-action="confirm-yes">${esc(opts.okLabel || 'Confirm')}</button>
        </div>
      `);
      window.__confirmResolve = (v) => {
        if (!window.__confirmResolve) return;
        window.__confirmResolve = null;
        closeModal();
        resolve(Boolean(v));
      };
    });
  }

  // ---------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------
  // `roles` is an explicit allowlist of session roles that may see/use this
  // route — replaces the old `adminOnly` boolean so both the sidebar link
  // AND direct hash navigation (see renderView below) are governed by the
  // same data, for every role including 'driver' and 'labour'.
  const NAV = [
    { id: 'dashboard', label: 'Dashboard', mono: 'DB', roles: ['admin', 'manager', 'staff'] },
    { id: 'entry', label: 'Daily Entry', mono: 'EN', roles: ['admin', 'manager', 'staff'] },
    { id: 'records', label: 'Records', mono: 'RC', roles: ['admin', 'manager', 'staff'] },
    { id: 'drivers', label: 'Drivers', mono: 'DR', roles: ['admin', 'manager'] },
    { id: 'companies', label: 'Companies', mono: 'CO', roles: ['admin', 'manager'] },
    { id: 'labour', label: 'Labour', mono: 'LB', roles: ['admin', 'manager'] },
    { id: 'rate-cards', label: 'Rate Cards', mono: 'RT', roles: ['admin', 'manager'] },
    { id: 'labour-shifts', label: 'Labour Shifts', mono: 'SH', roles: ['admin', 'manager'] },
    { id: 'summary', label: 'Driver Summary', mono: 'SU', roles: ['admin', 'manager', 'staff'] },
    { id: 'payments', label: 'Payments', mono: 'PA', roles: ['admin', 'manager', 'staff'] },
    { id: 'driver-submissions', label: 'Driver Submissions', mono: 'DS', roles: ['admin', 'manager'] },
    { id: 'delivery-blocks', label: 'Delivery Blocks', mono: 'BK', roles: ['admin', 'manager'] },
    { id: 'driver-assignments', label: 'Driver Assignments', mono: 'AS', roles: ['admin', 'manager'] },
    { id: 'driver-performance', label: 'Driver Performance', mono: 'DP', roles: ['admin', 'manager'] },
    { id: 'routes', label: 'Routes', mono: 'RO', roles: ['admin', 'manager'] },
    { id: 'labour-logs', label: 'Labour Logs', mono: 'LL', roles: ['admin', 'manager'] },
    { id: 'invoices', label: 'Invoices', mono: 'IV', roles: ['admin', 'manager'] },
    { id: 'export', label: 'Excel Export', mono: 'XL', roles: ['admin', 'manager', 'staff'] },
    { id: 'settings', label: 'Settings', mono: 'ST', roles: ['admin'] },
    { id: 'driver-route', label: 'Route', mono: 'RT', roles: ['driver'] },
    { id: 'driver-submit', label: "Today's Deliveries", mono: 'DD', roles: ['driver'] },
    { id: 'driver-my-history', label: 'My Submissions', mono: 'MS', roles: ['driver'] },
    { id: 'labour-log', label: 'Today', mono: 'LW', roles: ['labour'] },
    { id: 'labour-my-shifts', label: 'My Shifts', mono: 'US', roles: ['labour'] },
    { id: 'labour-my-history', label: 'My Logs', mono: 'ML', roles: ['labour'] },
  ];

  function isAdmin() { return state.session && state.session.role === 'admin'; }
  function isManager() { return state.session && state.session.role === 'manager'; }
  function isDriverRole() { return state.session && state.session.role === 'driver'; }
  function isLabourRole() { return state.session && state.session.role === 'labour'; }
  function isAdminOrManager() { return isAdmin() || isManager(); }
  function currentDriverId() { return state.session ? state.session.driverId || null : null; }
  function currentLabourId() { return state.session ? state.session.labourId || null : null; }
  // Data-driven route guard — used by both the sidebar (navHtml) and direct
  // hash navigation (renderView), so a role can never reach a page by typing
  // a hash even though the link was hidden for them. This is still UI-level
  // only (no server-side rule enforcement is possible on this platform).
  function roleAllowed(route, role) {
    const nav = NAV.find((n) => n.id === route);
    if (!nav || !nav.roles) return true;
    return nav.roles.includes(role);
  }

  function navHtml() {
    const role = state.session ? state.session.role : null;
    return NAV.filter((n) => roleAllowed(n.id, role)).map((n) => `
      <button class="nav-link ${state.route === n.id ? 'active' : ''}" data-action="nav" data-route="${n.id}">
        <span class="ic tnum" style="font-size:.62rem;font-weight:800;">${n.mono}</span>${esc(n.label)}
      </button>
    `).join('');
  }

  function renderSidebar() {
    const sb = document.getElementById('sidebar');
    sb.innerHTML = `
      <div class="brand"><div class="brand-mark">UM</div><div class="brand-text">${esc(state.settings.businessName || 'UMA Management')}<small>Operations</small></div></div>
      ${navHtml()}
      <div id="staffbox">
        <div class="avatar">${esc((state.session && state.session.name || '?').slice(0, 2).toUpperCase())}</div>
        <div class="who">
          <div class="name">${esc(state.session ? state.session.name : '')}</div>
          <div class="role">${esc(state.session ? state.session.role : '')}</div>
        </div>
        <button data-action="switch-user" title="Switch user" aria-label="Switch user">⇄</button>
      </div>
    `;
    const mn = document.getElementById('mobilenav');
    mn.innerHTML = sb.innerHTML;
  }

  function setRoute(route) {
    state.route = route;
    location.hash = route;
    renderSidebar();
    renderView();
    document.getElementById('mobilenav').classList.add('hidden');
    document.getElementById('drawer-backdrop').classList.add('hidden');
  }

  // ---------------------------------------------------------------
  // View: Dashboard
  // ---------------------------------------------------------------
  function rangeStats(fromStr, toStr) {
    let jobs = 0, car = 0, van = 0, other = 0, pay = 0, driversSet = new Set();
    state.days.forEach((day) => {
      if (day.date < fromStr || day.date > toStr) return;
      day.records.forEach((rec) => {
        jobs++;
        if (rec.vehicle === 'Car') car++; else if (rec.vehicle === 'Van') van++; else other++;
        pay += finalPay(rec);
        driversSet.add(rec.driverName);
      });
    });
    return { jobs, car, van, other, pay, drivers: driversSet.size };
  }

  function companyRangeStats(fromStr, toStr) {
    const byCompany = {};
    state.days.forEach((day) => {
      if (day.date < fromStr || day.date > toStr) return;
      day.records.forEach((rec) => {
        const key = rec.companyName || '(No company)';
        const s = byCompany[key] || { name: key, jobs: 0, car: 0, van: 0, pay: 0 };
        s.jobs++; if (rec.vehicle === 'Car') s.car++; else if (rec.vehicle === 'Van') s.van++;
        s.pay += finalPay(rec);
        byCompany[key] = s;
      });
    });
    return Object.values(byCompany).sort((a, b) => b.pay - a.pay);
  }

  const dashboardUi = { range: 'today', from: '', to: '' };
  function dashboardRange() {
    const today = todayStr();
    if (dashboardUi.range === 'today') return { from: today, to: today };
    if (dashboardUi.range === 'week') return { from: toDateStr(startOfWeek(new Date())), to: today };
    if (dashboardUi.range === 'month') { const n = new Date(); return { from: n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-01', to: today }; }
    return { from: dashboardUi.from || today, to: dashboardUi.to || today };
  }

  // Cost visibility (Employment Hero-style): rostered/estimated labour cost
  // vs the actual cost of approved hours, plus the resulting margin (bill
  // rate charged to the company vs pay rate paid to the worker).
  function labourCostStats(from, to) {
    const shiftsInRange = state.labourShifts.filter((s) => s.date >= from && s.date <= to);
    const estBillCost = shiftsInRange.reduce((sum, s) => sum + (Number(s.estBillCost) || 0), 0);
    const estPayCost = shiftsInRange.reduce((sum, s) => sum + (Number(s.estPayCost) || 0), 0);
    const logsInRange = state.labourLogs.filter((g) => g.date >= from && g.date <= to && g.status === 'Approved');
    const actualBillCost = logsInRange.reduce((sum, g) => sum + (Number(g.amount) || 0), 0);
    const actualPayCost = logsInRange.reduce((sum, g) => sum + (Number(g.payAmount) || 0), 0);
    return { estBillCost, estPayCost, actualBillCost, actualPayCost };
  }
  function labourCostCard(from, to) {
    const st = labourCostStats(from, to);
    if (!st.estBillCost && !st.actualBillCost) return '';
    return `
      <div class="section-title"><h2>Labour cost visibility</h2></div>
      <div class="grid-stats" style="margin-bottom:16px;">
        <div class="stat-tile"><div class="stat-label">Rostered bill (estimated)</div><div class="stat-value">${fmtMoney(st.estBillCost)}</div></div>
        <div class="stat-tile"><div class="stat-label">Rostered worker pay (estimated)</div><div class="stat-value">${fmtMoney(st.estPayCost)}</div></div>
        <div class="stat-tile accent"><div class="stat-label">Actual bill (approved hours)</div><div class="stat-value">${fmtMoney(st.actualBillCost)}</div></div>
        <div class="stat-tile"><div class="stat-label">Actual margin (approved hours)</div><div class="stat-value">${fmtMoney(st.actualBillCost - st.actualPayCost)}</div></div>
      </div>
    `;
  }
  // Success rate is always delivered / attempted (delivered+failed), never
  // delivered / (delivered+failed+pending) — an in-progress shift has no
  // attempted count yet, so it's excluded from these stats entirely.
  function successRatePct(delivered, attempted) {
    const a = Number(attempted) || 0;
    if (!a) return 0;
    return Math.round(((Number(delivered) || 0) / a) * 1000) / 10;
  }
  function submissionAttempted(s) {
    return s.attempted != null ? Number(s.attempted) || 0 : (Number(s.delivered) || 0) + (Number(s.failed) || 0);
  }
  function deliveryOpsStats(from, to) {
    const subs = state.driverSubmissions.filter((s) => s.date >= from && s.date <= to);
    const delivered = subs.reduce((sum, s) => sum + (Number(s.delivered) || 0), 0);
    const failed = subs.reduce((sum, s) => sum + (Number(s.failed) || 0), 0);
    const attempted = subs.reduce((sum, s) => sum + submissionAttempted(s), 0);
    const started = subs.length;
    const finished = subs.filter((s) => s.status === 'Pending' || s.status === 'Approved').length;
    const pendingReview = subs.filter((s) => s.status === 'Pending').length;
    return { delivered, failed, attempted, started, finished, pendingReview };
  }
  function deliveryOpsCard(from, to) {
    const st = deliveryOpsStats(from, to);
    if (!st.started) return '';
    return `
      <div class="section-title"><h2>Delivery operations</h2></div>
      <div class="grid-stats" style="margin-bottom:16px;">
        <div class="stat-tile accent"><div class="stat-label">Drivers started</div><div class="stat-value">${st.started}</div></div>
        <div class="stat-tile"><div class="stat-label">Drivers finished</div><div class="stat-value">${st.finished}</div></div>
        <div class="stat-tile"><div class="stat-label">Delivered / Failed</div><div class="stat-value">${st.delivered} / ${st.failed}</div></div>
        <div class="stat-tile"><div class="stat-label">Success rate</div><div class="stat-value">${successRatePct(st.delivered, st.attempted)}%</div></div>
        ${st.pendingReview ? `<div class="stat-tile"><div class="stat-label">Awaiting review</div><div class="stat-value">${st.pendingReview}</div></div>` : ''}
      </div>
    `;
  }
  function viewDashboard() {
    const { from, to } = dashboardRange();
    const s = rangeStats(from, to);
    const companyRows = companyRangeStats(from, to);

    // last 7 days bar data (always the trailing week, independent of the range picker above)
    const bars = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const ds = toDateStr(d);
      const bs = rangeStats(ds, ds);
      bars.push({ label: d.toLocaleDateString(undefined, { weekday: 'short' }), pay: bs.pay, isToday: i === 0 });
    }
    const maxPay = Math.max(1, ...bars.map((b) => b.pay));
    const fmtMoneyShort = (n) => { n = Number(n) || 0; return Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `$${Math.round(n)}`; };
    const barsAria = 'Pay for the last 7 days: ' + bars.map((b) => `${b.label} ${fmtMoney(b.pay)}`).join(', ');

    const companyBody = companyRows.length ? companyRows.map((c) => `
      <tr><td>${esc(c.name)}</td><td class="tnum">${c.jobs}</td><td class="tnum col-opt">${c.car}</td><td class="tnum col-opt">${c.van}</td><td class="tnum" style="font-weight:700;">${fmtMoney(c.pay)}</td><td class="tnum col-opt">${fmtMoney(c.jobs ? c.pay / c.jobs : 0)}</td></tr>
    `).join('') : `<tr><td colspan="6"><div class="empty-state">No activity in this range.</div></td></tr>`;
    const rangeText = from === to ? fmtDateHuman(from) : `${fmtDateHuman(from)} – ${fmtDateHuman(to)}`;
    const attentionRows = isAdminOrManager() ? driverSubmissionsBanner() + labourLogsBanner() : '';
    const companyTotals = companyRows.reduce((acc, c) => ({ jobs: acc.jobs + c.jobs, car: acc.car + c.car, van: acc.van + c.van, pay: acc.pay + c.pay }), { jobs: 0, car: 0, van: 0, pay: 0 });

    return `
      <div class="view-header">
        <div><h1>Dashboard</h1><div class="sub">${rangeText}</div></div>
        <button class="btn btn-primary" data-action="nav" data-route="entry"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style="vertical-align:-3px;margin-right:6px;"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>Add a record</button>
      </div>

      ${attentionRows ? `<ul class="attention" aria-label="Needs attention">${attentionRows}</ul>` : ''}

      <div class="dash-range">
        <div class="seg" role="group" aria-label="Date range">
          ${[['today', 'Today'], ['week', 'Week'], ['month', 'Month'], ['custom', 'Custom']].map(([key, label]) => `<button type="button" aria-pressed="${dashboardUi.range === key}" data-action="dash-range" data-range="${key}">${label}</button>`).join('')}
        </div>
        ${dashboardUi.range === 'custom' ? `<div class="dash-custom-dates"><label class="field">From <input type="date" value="${dashboardUi.from}" data-onchange="dash-custom" data-field="from"></label><label class="field">To <input type="date" value="${dashboardUi.to}" data-onchange="dash-custom" data-field="to"></label></div>` : ''}
      </div>

      <section class="kpi">
        <div class="eyebrow">Total pay</div>
        <div class="kpi-value tnum">${fmtMoney(s.pay)}</div>
        <div class="kpi-meta tnum">${s.jobs} block${s.jobs === 1 ? '' : 's'} · ${s.car} car · ${s.van} van · ${s.drivers} driver${s.drivers === 1 ? '' : 's'}</div>
      </section>

      <div class="section-title"><h2>By company</h2></div>
      <div class="table-wrap dash-company">
        <table class="data">
          <thead><tr><th>Company</th><th class="num">Blocks</th><th class="num col-opt">Car</th><th class="num col-opt">Van</th><th class="num">Total pay</th><th class="num col-opt">Avg per block</th></tr></thead>
          <tbody>${companyBody}</tbody>
          <tfoot><tr><td>Total</td><td class="tnum">${companyTotals.jobs}</td><td class="tnum col-opt">${companyTotals.car}</td><td class="tnum col-opt">${companyTotals.van}</td><td class="tnum">${fmtMoney(companyTotals.pay)}</td><td class="tnum col-opt">${fmtMoney(companyTotals.jobs ? companyTotals.pay / companyTotals.jobs : 0)}</td></tr></tfoot>
        </table>
      </div>

      ${isAdminOrManager() ? deliveryOpsCard(from, to) : ''}
      ${isAdminOrManager() ? labourCostCard(from, to) : ''}

      <div class="section-title"><h2>Pay, last 7 days</h2></div>
      <div class="card">
        <div class="bars dash-bars" role="img" aria-label="${esc(barsAria)}">
          ${bars.map((b) => `<div class="bar-col" aria-hidden="true"><div class="bar-val tnum">${fmtMoneyShort(b.pay)}</div><div class="bar${b.isToday ? ' is-today' : ''}" style="height:${Math.max(3, Math.round((b.pay / maxPay) * 100))}%"></div><div class="bar-label">${esc(b.label)}</div></div>`).join('')}
        </div>
      </div>
      ${state.usingFallback ? `<p class="helptext" style="margin-top:16px;">Local preview mode — this browser isn't connected to the shared database, so data here is only stored on this device.</p>` : ''}
    `;
  }

  // ---------------------------------------------------------------
  // View: Daily Entry
  // ---------------------------------------------------------------
  function blankEntryRow() {
    const firstCompany = activeDeliveryCompanies()[0];
    return { id: genId(), _new: true, block: '', driverName: '', vehicle: 'Car', companyName: firstCompany ? firstCompany.name : '', parcels: 0, bonus: 0, adjustment: 0, notes: '' };
  }
  function loadEntryRowsForDate() {
    // Daily Entry is always a single fresh row for adding ONE new record — it
    // never reloads what's already saved for the date (that cluttered the
    // screen with every existing record as an editable row). To view, edit or
    // remove existing records, use the Records page instead.
    state.entryRows = [blankEntryRow()];
  }
  // <datalist> options for the free-text driver-name field — offers existing
  // drivers as type-ahead suggestions without forcing an exact dropdown pick,
  // so a name that isn't in the list yet is simply created on save.
  function driverDatalistOptions() {
    return activeDrivers().map((d) => `<option value="${esc(d.name)}">`).join('');
  }
  function vehicleOptions(selected) {
    return VEHICLES.map((v) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${v}</option>`).join('');
  }
  function companyOptions(selected) {
    const list = activeDeliveryCompanies();
    if (!list.length) return '<option value="">No companies set up yet</option>';
    let opts = '<option value="">Select company…</option>';
    opts += list.map((c) => `<option value="${esc(c.name)}" ${c.name === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    return opts;
  }

  function findDuplicates(dateStr, rows) {
    const dups = [];
    rows.forEach((row) => {
      if (!row.driverName || !row.block) return;
      state.days.forEach((day) => {
        if (day.date !== dateStr) return;
        day.records.forEach((rec) => {
          if (rec.id === row.id) return;
          if (rec.driverName === row.driverName && String(rec.block).trim().toLowerCase() === String(row.block).trim().toLowerCase()) {
            dups.push({ driverName: row.driverName, block: row.block });
          }
        });
      });
      // also check duplicates within the batch itself
      rows.forEach((other) => {
        if (other === row) return;
        if (other.driverName === row.driverName && other.block && row.block && String(other.block).trim().toLowerCase() === String(row.block).trim().toLowerCase()) {
          if (!dups.find((d) => d.driverName === row.driverName && d.block === row.block)) dups.push({ driverName: row.driverName, block: row.block });
        }
      });
    });
    const seen = new Set();
    return dups.filter((d) => {
      const key = d.driverName + '|' + d.block;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Shared save path for both Single Entry and Bulk Add — resolves each row's
  // freehand driver name (reusing an existing driver regardless of case, or
  // quietly creating a new one), warns about likely duplicates, then commits
  // every row into the day's records. Returns the number of rows saved, or
  // -1 if the save was cancelled/declined (e.g. no rows, or the duplicate
  // warning was declined).
  async function commitEntryRows(dateStr, inputRows) {
    const resolvedRows = [];
    let createdAnyDriver = false;
    for (const r of inputRows) {
      const typedName = (r.driverName || '').trim();
      if (!typedName) continue;
      const existing = driverByNameLoose(typedName);
      if (existing) {
        resolvedRows.push(Object.assign({}, r, { driverName: existing.name }));
      } else {
        await state.db.collection('drivers').add({ name: typedName, vehicleType: r.vehicle || 'Car', active: true, createdAt: new Date().toISOString() });
        // Remember it right away so a second row in the same batch with the
        // same new name reuses this driver instead of creating a duplicate.
        state.drivers.push({ name: typedName, vehicleType: r.vehicle || 'Car', active: true });
        createdAnyDriver = true;
        resolvedRows.push(Object.assign({}, r, { driverName: typedName }));
      }
    }
    if (createdAnyDriver) await loadDrivers();
    const rows = resolvedRows;
    if (!rows.length) { toast('Add at least one driver row.', 'err'); return -1; }
    const dups = findDuplicates(dateStr, rows);
    if (dups.length) {
      const ok = await confirmDialog(`Similar record${dups.length > 1 ? 's' : ''} already exist for: ${dups.map((d) => `${esc(d.driverName)} / ${esc(d.block)}`).join(', ')}. Continue anyway?`, { okLabel: 'Save anyway', danger: true });
      if (!ok) return -1;
    }
    const existingDay = getDay(dateStr);
    const finalRecords = existingDay ? existingDay.records.slice() : [];
    for (const row of rows) {
      const idx = finalRecords.findIndex((r) => r.id === row.id);
      const vehicle = row.vehicle || 'Car';
      const baseRate = computeBaseRate(row.companyName, vehicle, row.parcels);
      if (idx >= 0) {
        finalRecords[idx] = Object.assign({}, finalRecords[idx], { block: row.block, driverName: row.driverName, vehicle, companyName: row.companyName || '', parcels: Number(row.parcels) || 0, baseRate, bonus: Number(row.bonus) || 0, adjustment: Number(row.adjustment) || 0, notes: row.notes, updatedAt: new Date().toISOString() });
      } else {
        const ref = await claimPaymentRef(dateStr);
        finalRecords.push({
          id: row.id, block: row.block, driverName: row.driverName, vehicle, companyName: row.companyName || '', parcels: Number(row.parcels) || 0, baseRate,
          bonus: Number(row.bonus) || 0, adjustment: Number(row.adjustment) || 0, notes: row.notes || '',
          paymentRef: ref, status: 'Pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          createdBy: state.session ? state.session.name : '',
        });
      }
    }
    await saveDay(dateStr, finalRecords);
    return rows.length;
  }

  function renderSingleEntryCard() {
    const row = state.entryRows[0];
    const company = companyByName(row.companyName);
    const perParcel = company && company.rateType === 'per_parcel';
    const base = computeBaseRate(row.companyName, row.vehicle, row.parcels);
    const total = base + (Number(row.bonus) || 0) + (Number(row.adjustment) || 0);
    const rowHtml = `
      <div class="entry-row" data-row-id="${row.id}">
        <div data-label="Block"><input type="text" placeholder="Block 1" value="${esc(row.block)}" data-onchange="entry-field" data-field="block" data-row="${row.id}"></div>
        <div data-label="Driver">
          <input type="text" list="driverNamesList" autocomplete="off" placeholder="Type driver's name…" value="${esc(row.driverName)}" data-onchange="entry-field" data-field="driverName" data-row="${row.id}">
        </div>
        <div data-label="Vehicle"><select data-onchange="entry-field" data-field="vehicle" data-row="${row.id}">${vehicleOptions(row.vehicle)}</select></div>
        <div data-label="Company"><select data-onchange="entry-field" data-field="companyName" data-row="${row.id}">${companyOptions(row.companyName)}</select></div>
        <div data-label="Parcels"><input type="number" min="0" step="1" value="${row.parcels || 0}" ${perParcel ? '' : 'disabled placeholder="—"'} data-onchange="entry-field" data-field="parcels" data-row="${row.id}"></div>
        <div data-label="Bonus"><input type="number" step="0.01" value="${row.bonus || 0}" data-onchange="entry-field" data-field="bonus" data-row="${row.id}"></div>
        <div data-label="Adjust" title="Adjustment"><input type="number" step="0.01" value="${row.adjustment || 0}" data-onchange="entry-field" data-field="adjustment" data-row="${row.id}"></div>
        <div data-label="Pay" class="tnum" style="font-weight:700;">${fmtMoney(total)}</div>
        <div data-label="Notes"><input type="text" placeholder="Optional" value="${esc(row.notes || '')}" data-onchange="entry-field" data-field="notes" data-row="${row.id}"></div>
      </div>`;

    return `
      <div class="card" style="overflow-x:auto;">
        <div class="entry-grid">
          <div class="eh">Block</div><div class="eh">Driver</div><div class="eh">Vehicle</div><div class="eh">Company</div><div class="eh">Parcels</div><div class="eh">Bonus</div><div class="eh">Adjust.</div><div class="eh">Pay</div><div class="eh">Notes</div>
        </div>
        <div class="entry-rows">${rowHtml}</div>
        <datalist id="driverNamesList">${driverDatalistOptions()}</datalist>
        <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;">
          <button class="btn btn-primary" data-action="entry-save-all" style="margin-left:auto;">Save Entry</button>
        </div>
      </div>
      <p class="helptext" style="margin-top:10px;">Pay is calculated automatically from the Company and Vehicle you pick (every company can set a different rate per vehicle) — a Fixed-rate company pays per block, a Per-Parcel company multiplies its rate by the Parcels you enter. Just type the driver's name — pick a suggestion if they've worked before, or type a new name and they're added automatically when you save. Override pay with Bonus or Adjustment; a payment reference is added automatically when you save.</p>
    `;
  }

  function renderBulkReviewGrid() {
    const rows = state.bulkRows;
    const rowsHtml = rows.map((row) => {
      const company = companyByName(row.companyName);
      const perParcel = company && company.rateType === 'per_parcel';
      const base = computeBaseRate(row.companyName, row.vehicle, row.parcels);
      const total = base + (Number(row.bonus) || 0) + (Number(row.adjustment) || 0);
      return `
        <div class="bulk-row-wrap">
          <div class="entry-row" data-row-id="${row.id}" style="flex:1;">
            <div data-label="Block"><input type="text" placeholder="Block 1" value="${esc(row.block)}" data-onchange="bulk-field" data-field="block" data-row="${row.id}"></div>
            <div data-label="Driver"><input type="text" list="driverNamesList" autocomplete="off" placeholder="Driver name" value="${esc(row.driverName)}" data-onchange="bulk-field" data-field="driverName" data-row="${row.id}"></div>
            <div data-label="Vehicle"><select data-onchange="bulk-field" data-field="vehicle" data-row="${row.id}">${vehicleOptions(row.vehicle)}</select></div>
            <div data-label="Company"><select data-onchange="bulk-field" data-field="companyName" data-row="${row.id}">${companyOptions(row.companyName)}</select></div>
            <div data-label="Parcels"><input type="number" min="0" step="1" value="${row.parcels || 0}" ${perParcel ? '' : 'disabled placeholder="—"'} data-onchange="bulk-field" data-field="parcels" data-row="${row.id}"></div>
            <div data-label="Bonus"><input type="number" step="0.01" value="${row.bonus || 0}" data-onchange="bulk-field" data-field="bonus" data-row="${row.id}"></div>
            <div data-label="Adjust" title="Adjustment"><input type="number" step="0.01" value="${row.adjustment || 0}" data-onchange="bulk-field" data-field="adjustment" data-row="${row.id}"></div>
            <div data-label="Pay" class="tnum" style="font-weight:700;">${fmtMoney(total)}</div>
            <div data-label="Notes"><input type="text" placeholder="Optional" value="${esc(row.notes || '')}" data-onchange="bulk-field" data-field="notes" data-row="${row.id}"></div>
          </div>
          <button type="button" class="btn btn-sm btn-icon btn-danger" data-action="bulk-remove-row" data-row="${row.id}" title="Remove row" aria-label="Remove row">✕</button>
        </div>`;
    }).join('');

    return `
      <div class="card" style="overflow-x:auto;margin-top:16px;">
        <div style="display:flex;gap:8px;align-items:center;">
          <div class="entry-grid" style="flex:1;">
            <div class="eh">Block</div><div class="eh">Driver</div><div class="eh">Vehicle</div><div class="eh">Company</div><div class="eh">Parcels</div><div class="eh">Bonus</div><div class="eh">Adjust.</div><div class="eh">Pay</div><div class="eh">Notes</div>
          </div>
          <div style="width:34px;flex-shrink:0;"></div>
        </div>
        ${rows.length ? `<div class="entry-rows">${rowsHtml}</div>` : `<div class="empty-state"><p>No rows parsed yet — add one manually or try parsing again.</p></div>`}
        <datalist id="driverNamesList">${driverDatalistOptions()}</datalist>
        <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;">
          <button class="btn btn-sm" data-action="bulk-add-row">+ Add a row</button>
          <button class="btn btn-primary" data-action="bulk-save-all" style="margin-left:auto;" ${rows.length ? '' : 'disabled'}>Save All (${rows.length})</button>
        </div>
      </div>
    `;
  }

  function renderBulkEntryCard() {
    const rows = state.bulkRows;
    return `
      <div class="card">
        <label class="field-label" for="bulkTextArea">Paste daily notes or copy rows directly from Excel</label>
        <textarea id="bulkTextArea" rows="5" placeholder="e.g. Ravi block 1 Amazon Car 5 parcels bonus 10&#10;Honey block 2 Amazon Van&#10;&#10;Or paste a table with columns: Driver, Block, Vehicle, Company, Parcels, Bonus, Adjustment, Notes" data-onchange="bulk-text-change" style="width:100%;margin-top:6px;resize:vertical;">${esc(state.bulkText)}</textarea>
        <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;align-items:center;">
          <button class="btn btn-primary" data-action="bulk-parse" ${state.bulkBusy || !state.bulkText.trim() ? 'disabled' : ''}>${state.bulkBusy ? 'Processing…' : '✨ Smart Parse'}</button>
          ${state.bulkRows !== null ? `<button class="btn btn-sm" data-action="bulk-discard">Discard</button>` : ''}
          ${state.bulkError ? `<span style="color:var(--danger);font-size:0.85rem;">${esc(state.bulkError)}</span>` : ''}
        </div>
        <p class="helptext" style="margin-top:10px;">Paste one driver per line, or paste a tab-separated table copied from Excel. Smart Parse works on this local website without an API key; if an AI provider is available in the host environment, it will be used first. Review every row and confirm the company, block, vehicle and amounts before saving. The selected date above applies to every row in this batch.</p>
      </div>
      ${rows !== null ? renderBulkReviewGrid() : ''}
    `;
  }

  function viewEntry() {
    if (!activeDeliveryCompanies().length) {
      return `
        <div class="view-header"><div><h1>Daily Entry</h1><div class="sub">Add one record for a date</div></div></div>
        <div class="card empty-state">
          <div class="ic">🏢</div>
          <p>No Delivery Contract companies have been set up yet — pay is calculated from each row's Company.</p>
          ${isAdmin() ? `<button class="btn btn-primary" style="margin-top:12px;" data-action="nav" data-route="companies">+ Add a company</button>` : `<p class="helptext">Ask an admin to add a company in Settings first.</p>`}
        </div>
      `;
    }
    if (!state.entryRows.length) loadEntryRowsForDate();
    const isToday = state.entryDate === todayStr();
    return `
      <div class="view-header">
        <div><h1>Daily Entry</h1><div class="sub">Add one record at a time — saved instantly, then ready for the next</div></div>
      </div>

      <div class="card date-section" style="margin-bottom:16px;">
        <div class="date-section-inner">
          <div>
            <label class="field-label" for="entryDateInput">Date for this entry</label>
            <div class="date-display">${fmtDateHuman(state.entryDate)}</div>
          </div>
          <div class="date-section-controls">
            <input id="entryDateInput" type="date" value="${state.entryDate}" data-onchange="entry-date-change">
            ${isToday ? '' : `<button class="btn btn-sm" data-action="entry-date-today">Today</button>`}
          </div>
        </div>
      </div>

      <div class="toolbar" style="margin-bottom:16px;">
        <button class="btn btn-sm ${state.entryMode === 'single' ? 'btn-primary' : ''}" data-action="entry-mode" data-mode="single">Single Entry</button>
        <button class="btn btn-sm ${state.entryMode === 'bulk' ? 'btn-primary' : ''}" data-action="entry-mode" data-mode="bulk">✨ Bulk Add</button>
      </div>

      ${state.entryMode === 'bulk' ? renderBulkEntryCard() : renderSingleEntryCard()}
    `;
  }

  // ---------------------------------------------------------------
  // View: Records
  // ---------------------------------------------------------------
  const recordsUi = { search: '', from: '', to: '', driver: '', vehicle: '', company: '', block: '', sort: 'date_desc', selected: new Set() };

  function applyRecordsPreset() {
    if (state.recordsFilter) {
      Object.assign(recordsUi, state.recordsFilter);
      state.recordsFilter = null;
    }
  }

  function filteredRecords() {
    let rows = allRecordsFlat();
    const q = recordsUi.search.trim().toLowerCase();
    if (q) rows = rows.filter((r) => [r.driverName, r.block, r.paymentRef, r.notes, r.date].some((v) => String(v || '').toLowerCase().includes(q)));
    if (recordsUi.from) rows = rows.filter((r) => r.date >= recordsUi.from);
    if (recordsUi.to) rows = rows.filter((r) => r.date <= recordsUi.to);
    if (recordsUi.driver) rows = rows.filter((r) => r.driverName === recordsUi.driver);
    if (recordsUi.vehicle) rows = rows.filter((r) => r.vehicle === recordsUi.vehicle);
    if (recordsUi.company) rows = rows.filter((r) => r.companyName === recordsUi.company);
    if (recordsUi.block) rows = rows.filter((r) => String(r.block || '').toLowerCase().includes(recordsUi.block.toLowerCase()));
    const sorters = {
      date_desc: (a, b) => b.date.localeCompare(a.date),
      date_asc: (a, b) => a.date.localeCompare(b.date),
      driver_az: (a, b) => a.driverName.localeCompare(b.driverName),
      pay_desc: (a, b) => finalPay(b) - finalPay(a),
    };
    rows.sort(sorters[recordsUi.sort] || sorters.date_desc);
    return rows;
  }

  function statusPillHtml(status) {
    const cls = { Pending: 'pill-pending', Approved: 'pill-approved', Paid: 'pill-paid', Cancelled: 'pill-cancelled' }[status] || 'pill-pending';
    return `<span class="pill ${cls}">${esc(status)}</span>`;
  }
  function vehiclePillHtml(v) {
    const cls = { Car: 'pill-car', Van: 'pill-van' }[v] || 'pill-other';
    return `<span class="pill ${cls}">${esc(v)}</span>`;
  }

  function viewRecords() {
    applyRecordsPreset();
    const allRows = filteredRecords();
    const cap = capRows(allRows);
    const rows = cap.shown;
    const driverOpts = state.drivers.map((d) => `<option value="${esc(d.name)}" ${recordsUi.driver === d.name ? 'selected' : ''}>${esc(d.name)}</option>`).join('');

    const body = rows.length ? rows.map((r) => `
      <tr>
        <td><input type="checkbox" data-action="rec-select" data-date="${r.date}" data-id="${r.id}" ${recordsUi.selected.has(r.date + '|' + r.id) ? 'checked' : ''}></td>
        <td class="tnum">${r.date}</td>
        <td class="tnum">${esc(r.paymentRef || '—')}</td>
        <td>${esc(r.block || '—')}</td>
        <td>${esc(r.driverName)}</td>
        <td>${vehiclePillHtml(r.vehicle)}</td>
        <td>${esc(r.companyName || '—')}</td>
        <td class="tnum">${r.parcels ? r.parcels : '—'}</td>
        <td class="tnum">${fmtMoney(r.baseRate)}</td>
        <td class="tnum">${fmtMoney(r.bonus)}</td>
        <td class="tnum">${fmtMoney(r.adjustment)}</td>
        <td class="tnum" style="font-weight:700;">${fmtMoney(finalPay(r))}</td>
        <td>${statusPillHtml(r.status || 'Pending')}</td>
        <td class="wrap">${esc(r.notes || '')}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-sm btn-icon" title="Edit" aria-label="Edit" data-action="rec-edit" data-date="${r.date}" data-id="${r.id}">✎</button>
          <button class="btn btn-sm btn-icon" title="Duplicate" aria-label="Duplicate" data-action="rec-dup" data-date="${r.date}" data-id="${r.id}">⧉</button>
          <button class="btn btn-sm btn-icon btn-danger" title="Delete" aria-label="Delete" data-action="rec-del" data-date="${r.date}" data-id="${r.id}">🗑</button>
        </td>
      </tr>
    `).join('') : `<tr><td colspan="15"><div class="empty-state">No records match these filters.</div></td></tr>`;

    return `
      <div class="view-header">
        <div><h1>Records</h1><div class="sub">${allRows.length} record${allRows.length === 1 ? '' : 's'}</div></div>
      </div>
      <div class="toolbar">
        <div class="search-input grow"><span class="ic">⌕</span><input type="text" placeholder="Search driver, block, payment ref…" value="${esc(recordsUi.search)}" data-onchange="rec-filter" data-field="search"></div>
        <input type="date" value="${recordsUi.from}" data-onchange="rec-filter" data-field="from" title="From date">
        <input type="date" value="${recordsUi.to}" data-onchange="rec-filter" data-field="to" title="To date">
        <select data-onchange="rec-filter" data-field="driver"><option value="">All drivers</option>${driverOpts}</select>
        <select data-onchange="rec-filter" data-field="vehicle"><option value="">All vehicles</option>${VEHICLES.map((v) => `<option ${recordsUi.vehicle === v ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <select data-onchange="rec-filter" data-field="company"><option value="">All companies</option>${state.companies.map((c) => `<option value="${esc(c.name)}" ${recordsUi.company === c.name ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        <input type="text" placeholder="Block" style="width:100px;" value="${esc(recordsUi.block)}" data-onchange="rec-filter" data-field="block">
        <select data-onchange="rec-filter" data-field="sort">
          <option value="date_desc" ${recordsUi.sort === 'date_desc' ? 'selected' : ''}>Newest first</option>
          <option value="date_asc" ${recordsUi.sort === 'date_asc' ? 'selected' : ''}>Oldest first</option>
          <option value="driver_az" ${recordsUi.sort === 'driver_az' ? 'selected' : ''}>Driver A–Z</option>
          <option value="pay_desc" ${recordsUi.sort === 'pay_desc' ? 'selected' : ''}>Highest pay</option>
        </select>
        ${recordsUi.selected.size ? `
          <select id="bulkStatusSelect">${STATUSES.map((s) => `<option>${s}</option>`).join('')}</select>
          <button class="btn btn-primary btn-sm" data-action="rec-bulk-status">Set status (${recordsUi.selected.size})</button>
          <button class="btn btn-danger btn-sm" data-action="rec-bulk-delete">🗑 Delete selected (${recordsUi.selected.size})</button>
          <button class="btn btn-sm" data-action="rec-clear-selection">Clear</button>
        ` : ''}
      </div>
      ${capNoticeHtml(cap)}
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th><input type="checkbox" title="Select all shown" aria-label="Select all shown records" data-action="rec-select-all" ${rows.length && rows.every((r) => recordsUi.selected.has(r.date + '|' + r.id)) ? 'checked' : ''}></th><th>Date</th><th>Ref</th><th>Block</th><th>Driver</th><th>Vehicle</th><th>Company</th><th>Parcels</th><th>Base</th><th>Bonus</th><th>Adj.</th><th>Final</th><th>Status</th><th>Notes</th><th>Actions</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    `;
  }

  function recordEditModal(dateStr, id) {
    const day = getDay(dateStr);
    const rec = day ? day.records.find((r) => r.id === id) : null;
    if (!rec) return;
    openModal(`
      <div class="modal-head"><h3>Edit record</h3><button data-action="modal-close" aria-label="Close">✕</button></div>
      <form data-onsubmit="rec-save-edit" data-date="${dateStr}" data-id="${id}">
        <div class="field-row">
          <div class="field"><label class="field-label">Date</label><input type="date" name="date" value="${dateStr}" required></div>
          <div class="field"><label class="field-label">Block</label><input type="text" name="block" value="${esc(rec.block || '')}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label class="field-label">Driver</label><input type="text" name="driverName" list="driverNamesListEdit" autocomplete="off" required value="${esc(rec.driverName || '')}"><datalist id="driverNamesListEdit">${driverDatalistOptions()}</datalist></div>
          <div class="field"><label class="field-label">Vehicle</label><select name="vehicle" data-onchange="edit-modal-recalc">${vehicleOptions(rec.vehicle)}</select></div>
        </div>
        <div class="field-row">
          <div class="field"><label class="field-label">Company</label><select name="companyName" data-onchange="edit-modal-recalc">${companyOptions(rec.companyName)}</select></div>
          <div class="field"><label class="field-label">Parcels</label><input type="number" min="0" step="1" name="parcels" value="${rec.parcels || 0}" ${(companyByName(rec.companyName) || {}).rateType === 'per_parcel' ? '' : 'disabled'} data-onchange="edit-modal-recalc"></div>
        </div>
        <div class="field-row">
          <div class="field"><label class="field-label">Base pay</label><input type="number" step="0.01" name="baseRate" value="${rec.baseRate}"></div>
          <div class="field"><label class="field-label">Bonus</label><input type="number" step="0.01" name="bonus" value="${rec.bonus || 0}"></div>
          <div class="field"><label class="field-label">Adjustment</label><input type="number" step="0.01" name="adjustment" value="${rec.adjustment || 0}"></div>
        </div>
        <p class="helptext" style="margin:-8px 0 12px;">Base pay auto-fills from the selected Company and Vehicle, but you can still type over it here for a one-off manual override.</p>
        <div class="field-row">
          <div class="field"><label class="field-label">Payment status</label><select name="status">${STATUSES.map((s) => `<option ${s === (rec.status || 'Pending') ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
          <div class="field"><label class="field-label">Payment ref</label><input type="text" name="paymentRef" value="${esc(rec.paymentRef || '')}" readonly></div>
        </div>
        <div class="field"><label class="field-label">Notes</label><textarea name="notes" rows="2">${esc(rec.notes || '')}</textarea></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
          <button type="button" class="btn" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn-primary">Save changes</button>
        </div>
      </form>
    `);
  }

  // ---------------------------------------------------------------
  // View: Drivers
  // ---------------------------------------------------------------
  const driversUi = { search: '', tab: 'active' };
  function viewDrivers() {
    let rows = state.drivers.filter((d) => (driversUi.tab === 'active' ? d.active !== false : d.active === false));
    if (driversUi.search.trim()) {
      const q = driversUi.search.toLowerCase();
      rows = rows.filter((d) => d.name.toLowerCase().includes(q));
    }
    const body = rows.length ? rows.map((d) => {
      const recCount = allRecordsFlat().filter((r) => r.driverName === d.name).length;
      const hasLogin = state.staff.some((s) => s.driverId === d.id && s.active !== false);
      return `
      <tr>
        <td><div class="avatar" style="width:26px;height:26px;font-size:.68rem;">${esc(d.name.slice(0, 2).toUpperCase())}</div></td>
        <td>${esc(d.name)}</td>
        <td>${vehiclePillHtml(d.vehicleType || 'Car')}</td>
        <td class="tnum">${recCount}</td>
        <td>${d.active !== false ? '<span class="pill pill-paid">Active</span>' : '<span class="pill pill-cancelled">Inactive</span>'}</td>
        <td>${hasLogin ? '<span class="pill pill-paid">Yes</span>' : '<span class="pill pill-cancelled">No</span>'}</td>
        <td>
          <button class="btn btn-sm" data-action="driver-history" data-name="${esc(d.name)}">History</button>
          <button class="btn btn-sm" data-action="driver-edit" data-id="${d.id}">Edit</button>
          ${!hasLogin ? `<button class="btn btn-sm" data-action="driver-grant-login" data-id="${d.id}">Grant login</button>` : ''}
          ${d.active !== false
            ? `<button class="btn btn-sm btn-danger" data-action="driver-deactivate" data-id="${d.id}">Deactivate</button>`
            : `<button class="btn btn-sm" data-action="driver-reactivate" data-id="${d.id}">Reactivate</button>`}
          ${isAdmin() ? `<button class="btn btn-sm btn-danger" data-action="driver-delete-account" data-id="${d.id}">Delete account</button>` : ''}
        </td>
      </tr>`;
    }).join('') : `<tr><td colspan="7"><div class="empty-state">No ${driversUi.tab} drivers found.</div></td></tr>`;

    return `
      <div class="view-header">
        <div><h1>Drivers</h1><div class="sub">${state.drivers.length} total</div></div>
        <button class="btn btn-primary" data-action="driver-add">+ Add driver</button>
      </div>
      <div class="toolbar">
        <button class="btn btn-sm ${driversUi.tab === 'active' ? 'btn-primary' : ''}" data-action="driver-tab" data-tab="active">Active</button>
        <button class="btn btn-sm ${driversUi.tab === 'inactive' ? 'btn-primary' : ''}" data-action="driver-tab" data-tab="inactive">Inactive</button>
        <div class="search-input grow"><span class="ic">⌕</span><input type="text" placeholder="Search drivers…" value="${esc(driversUi.search)}" data-onchange="driver-search"></div>
      </div>
      <p class="helptext" style="margin-bottom:10px;">"Portal login" lets a driver sign in on their own phone to submit their daily delivery count — separate from the admin/manager Daily Entry above.</p>
      <div class="table-wrap">
        <table class="data"><thead><tr><th></th><th>Name</th><th>Default vehicle</th><th>Records</th><th>Status</th><th>Portal login</th><th>Actions</th></tr></thead><tbody>${body}</tbody></table>
      </div>
    `;
  }

  function driverModal(driver) {
    const isEdit = !!driver;
    openModal(`
      <div class="modal-head"><h3>${isEdit ? 'Edit driver' : 'Add driver'}</h3><button data-action="modal-close" aria-label="Close">✕</button></div>
      <form data-onsubmit="driver-save" data-id="${isEdit ? driver.id : ''}">
        <div class="field" style="margin-bottom:12px;"><label class="field-label">Name</label><input type="text" name="name" value="${isEdit ? esc(driver.name) : ''}" required></div>
        <div class="field"><label class="field-label">Default vehicle</label><select name="vehicleType">${vehicleOptions(isEdit ? driver.vehicleType : 'Car')}</select></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
          <button type="button" class="btn" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Add driver'}</button>
        </div>
      </form>
    `);
  }

  // ---------------------------------------------------------------
  // View: Companies
  // ---------------------------------------------------------------
  const companiesUi = { search: '', tab: 'active' };
  function viewCompanies() {
    let rows = state.companies.filter((c) => (companiesUi.tab === 'active' ? c.active !== false : c.active === false));
    if (companiesUi.search.trim()) {
      const q = companiesUi.search.toLowerCase();
      rows = rows.filter((c) => c.name.toLowerCase().includes(q));
    }
    const body = rows.length ? rows.map((c) => {
      const type = c.type || 'delivery';
      const recCount = type === 'delivery' ? allRecordsFlat().filter((r) => r.companyName === c.name).length : state.labour.filter((l) => l.companyId === c.id).length;
      let rateDisplay;
      if (type === 'labour') {
        rateDisplay = `Bill: ${fmtMoney(companyBillRate(c))}/hr`;
      } else {
        const unit = c.rateType === 'per_parcel' ? '/parcel' : '/block';
        rateDisplay = `Car ${fmtMoney(c.carRate)}${unit} · Van ${fmtMoney(c.vanRate)}${unit} · Other ${fmtMoney(c.otherRate)}${unit}`;
      }
      return `
      <tr>
        <td>${esc(c.name)}</td>
        <td><span class="pill ${type === 'labour' ? 'pill-other' : 'pill-paid'}">${type === 'labour' ? 'Labour' : 'Delivery Contract'}</span></td>
        <td class="tnum" style="white-space:nowrap;">${rateDisplay}</td>
        <td class="tnum">${recCount}</td>
        <td>${c.active !== false ? '<span class="pill pill-paid">Active</span>' : '<span class="pill pill-cancelled">Inactive</span>'}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-sm" data-action="company-edit" data-id="${c.id}">Edit</button>
          ${type === 'labour' ? `<button class="btn btn-sm" data-action="company-manage-rates" data-id="${c.id}">Rate cards</button>` : ''}
          ${c.active !== false
            ? `<button class="btn btn-sm btn-danger" data-action="company-deactivate" data-id="${c.id}">Deactivate</button>`
            : `<button class="btn btn-sm" data-action="company-reactivate" data-id="${c.id}">Reactivate</button>`}
        </td>
      </tr>`;
    }).join('') : `<tr><td colspan="6"><div class="empty-state">No ${companiesUi.tab} companies found.</div></td></tr>`;

    return `
      <div class="view-header">
        <div><h1>Companies</h1><div class="sub">${state.companies.length} total — a Delivery Contract company pays drivers by block/parcel, a Labour company pays by the hour</div></div>
        <button class="btn btn-primary" data-action="company-add">+ Add company</button>
      </div>
      <div class="toolbar">
        <button class="btn btn-sm ${companiesUi.tab === 'active' ? 'btn-primary' : ''}" data-action="company-tab" data-tab="active">Active</button>
        <button class="btn btn-sm ${companiesUi.tab === 'inactive' ? 'btn-primary' : ''}" data-action="company-tab" data-tab="inactive">Inactive</button>
        <div class="search-input grow"><span class="ic">⌕</span><input type="text" placeholder="Search companies…" value="${esc(companiesUi.search)}" data-onchange="company-search"></div>
      </div>
      <div class="table-wrap">
        <table class="data"><thead><tr><th>Company</th><th>Type</th><th>Rate</th><th>Records</th><th>Status</th><th>Actions</th></tr></thead><tbody>${body}</tbody></table>
      </div>
      <p class="helptext" style="margin-top:12px;">Deactivating a company hides it from new Daily Entry rows / Labour but keeps every historical record and Excel export intact.</p>
    `;
  }

  // ---- Labour clock-in site location ----------------------------------
  // A Labour company can have a site pin (siteLat/siteLng) and an allowed
  // radius in metres. When set, Labour can only clock in/out from within
  // that radius. The Worker repeats the same check server-side.
  const SITE_ACCURACY_ALLOWANCE_M = 50;
  function hasSitePin(company) {
    return !!company && company.siteLat !== '' && company.siteLat != null && company.siteLng !== '' && company.siteLng != null &&
      Number.isFinite(Number(company.siteLat)) && Number.isFinite(Number(company.siteLng));
  }
  function parseSiteCoords(text) {
    const m = String(text || '').match(/(-?\d{1,3}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)/);
    if (!m) return null;
    const lat = Number(m[1]); const lng = Number(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
  }
  function distanceMetres(lat1, lng1, lat2, lng2) {
    const R = 6371000; const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1); const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(a)));
  }
  function getCurrentPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error('This browser cannot share your location. Try Chrome or Safari on your phone.')); return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy || 0) }),
        (err) => reject(new Error(err && err.code === 1
          ? 'Location is turned off for this site. Allow location in your browser settings, then try again.'
          : 'Could not get your location. Move outside or near a window, then try again.')),
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
      );
    });
  }
  // Returns { ok, location, message }. location is saved on the log.
  async function checkLabourSite(company, action) {
    if (!hasSitePin(company)) return { ok: true, location: null };
    let pos;
    try { pos = await getCurrentPosition(); }
    catch (e) { return { ok: false, message: e.message }; }
    const radius = Number(company.siteRadius) || 200;
    const distance = distanceMetres(pos.lat, pos.lng, Number(company.siteLat), Number(company.siteLng));
    const location = { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, distance, at: new Date().toISOString() };
    if (distance - Math.min(pos.accuracy, SITE_ACCURACY_ALLOWANCE_M) > radius) {
      const away = distance >= 1000 ? (distance / 1000).toFixed(1) + ' km' : distance + ' m';
      return { ok: false, location, message: `You're ${away} from ${company.name}. You can only ${action} at the site (within ${radius} m).` };
    }
    return { ok: true, location };
  }

  function companyModal(company) {
    const isEdit = !!company;
    const type = isEdit ? (company.type || 'delivery') : 'delivery';
    const rateType = isEdit ? (company.rateType || 'fixed') : 'fixed';
    const unit = rateType === 'per_parcel' ? '/parcel' : '/block';
    openModal(`
      <div class="modal-head"><h3>${isEdit ? 'Edit company' : 'Add company'}</h3><button data-action="modal-close" aria-label="Close">✕</button></div>
      <form data-onsubmit="company-save" data-id="${isEdit ? company.id : ''}">
        <div class="field" style="margin-bottom:12px;"><label class="field-label">Company name</label><input type="text" name="name" value="${isEdit ? esc(company.name) : ''}" required></div>
        <div class="field" style="margin-bottom:12px;">
          <label class="field-label">Company type</label>
          <select name="type" data-onchange="company-type-change">
            <option value="delivery" ${type === 'delivery' ? 'selected' : ''}>Delivery Contract</option>
            <option value="labour" ${type === 'labour' ? 'selected' : ''}>Labour</option>
          </select>
        </div>
        <div id="companyDeliveryFields" style="${type === 'labour' ? 'display:none;' : ''}">
          <div class="field" style="margin-bottom:12px;">
            <label class="field-label">Rate type</label>
            <select name="rateType" data-onchange="company-rate-type-change">${RATE_TYPES.map((r) => `<option value="${r.value}" ${r.value === rateType ? 'selected' : ''}>${r.label}</option>`).join('')}</select>
          </div>
          <p class="helptext" style="margin:0 0 10px;">Rates can differ by vehicle — set a rate for each vehicle type this company uses.</p>
          <div class="field-row">
            <div class="field"><label class="field-label">Car rate ($<span class="rate-unit">${unit}</span>)</label><input type="number" step="0.01" min="0" name="carRate" value="${isEdit ? (company.carRate || 0) : ''}"></div>
            <div class="field"><label class="field-label">Van rate ($<span class="rate-unit">${unit}</span>)</label><input type="number" step="0.01" min="0" name="vanRate" value="${isEdit ? (company.vanRate || 0) : ''}"></div>
            <div class="field"><label class="field-label">Other rate ($<span class="rate-unit">${unit}</span>)</label><input type="number" step="0.01" min="0" name="otherRate" value="${isEdit ? (company.otherRate || 0) : ''}"></div>
          </div>
          <p class="helptext" style="margin:10px 0 12px;">Fixed rate pays that amount per block. Per-parcel rate multiplies the vehicle's rate by the Parcels entered on each Daily Entry row.</p>
        </div>
        <div id="companyLabourFields" style="${type === 'delivery' ? 'display:none;' : ''}">
          <p class="helptext" style="margin:0 0 10px;">Fallback hourly rate — used only until you set up a dated <strong>Rate Card</strong> for this company (Companies list → "Rate cards"), which supports Standard/Overtime/Saturday/Sunday/Public Holiday/Night/Casual tiers per labour category. This is a <strong>bill rate</strong> (what you charge this company) — not what the labour person is paid (that's set on the Labour page, per person).</p>
          <div class="field" style="margin-bottom:14px;"><label class="field-label">Hourly bill rate ($/hr)</label><input type="number" step="0.01" min="0" name="rate" value="${isEdit ? (companyBillRate(company) || 0) : ''}"></div>
          <p class="eyebrow" style="margin:14px 0 8px;">Contract &amp; site details (optional)</p>
          <div class="field-row" style="margin-bottom:12px;">
            <div class="field"><label class="field-label">ABN</label><input type="text" name="abn" value="${isEdit ? esc(company.abn || '') : ''}"></div>
            <div class="field"><label class="field-label">Contact person</label><input type="text" name="contactPerson" value="${isEdit ? esc(company.contactPerson || '') : ''}"></div>
          </div>
          <div class="field-row" style="margin-bottom:12px;">
            <div class="field"><label class="field-label">Email</label><input type="email" name="email" value="${isEdit ? esc(company.email || '') : ''}"></div>
            <div class="field"><label class="field-label">Phone</label><input type="tel" name="phone" value="${isEdit ? esc(company.phone || '') : ''}"></div>
          </div>
          <div class="field" style="margin-bottom:12px;"><label class="field-label">Warehouse / site address</label><input type="text" name="siteAddress" value="${isEdit ? esc(company.siteAddress || '') : ''}"></div>
          <p class="eyebrow" style="margin:14px 0 8px;">Clock-in location</p>
          <p class="helptext" style="margin:0 0 10px;">Labour can only clock in and out when their phone is within this distance of the site pin. Leave the pin empty to allow clocking in from anywhere. To get a pin: stand at the site and tap "Use my current location", or right-click the site in Google Maps and click the numbers to copy them.</p>
          <div class="field-row" style="margin-bottom:12px;align-items:flex-end;">
            <div class="field" style="flex:2;"><label class="field-label">Site pin (latitude, longitude)</label><input type="text" name="siteCoords" inputmode="decimal" placeholder="-33.86882, 151.20929" value="${isEdit && hasSitePin(company) ? esc(company.siteLat + ', ' + company.siteLng) : ''}"></div>
            <div class="field"><label class="field-label">Allowed distance (metres)</label><input type="number" name="siteRadius" min="25" max="5000" step="5" value="${isEdit && company.siteRadius ? company.siteRadius : 200}"></div>
          </div>
          <div style="margin-bottom:12px;"><button type="button" class="btn btn-sm" data-action="company-use-my-location">Use my current location</button></div>
          <div class="field-row" style="margin-bottom:12px;">
            <div class="field"><label class="field-label">Contract start</label><input type="date" name="contractStartDate" value="${isEdit ? (company.contractStartDate || '') : ''}"></div>
            <div class="field"><label class="field-label">Contract end</label><input type="date" name="contractEndDate" value="${isEdit ? (company.contractEndDate || '') : ''}"></div>
            <div class="field"><label class="field-label">Contract status</label><select name="contractStatus"><option value="Active" ${isEdit && (company.contractStatus || 'Active') === 'Active' ? 'selected' : ''}>Active</option><option value="Pending" ${isEdit && company.contractStatus === 'Pending' ? 'selected' : ''}>Pending</option><option value="Expired" ${isEdit && company.contractStatus === 'Expired' ? 'selected' : ''}>Expired</option></select></div>
          </div>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:6px;">
          <button type="button" class="btn" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Add company'}</button>
        </div>
      </form>
    `);
  }

  // ---------------------------------------------------------------
  // View: Driver Summary
  // ---------------------------------------------------------------
  const summaryUi = { range: 'month', from: '', to: '', onlyActive: false };
  function summaryRange() {
    const today = todayStr();
    if (summaryUi.range === 'today') return { from: today, to: today };
    if (summaryUi.range === 'week') return { from: toDateStr(startOfWeek(new Date())), to: today };
    if (summaryUi.range === 'month') { const n = new Date(); return { from: n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-01', to: today }; }
    return { from: summaryUi.from || '0000-01-01', to: summaryUi.to || '9999-12-31' };
  }
  function viewSummary() {
    const { from, to } = summaryRange();
    const byDriver = {};
    state.days.forEach((day) => {
      if (day.date < from || day.date > to) return;
      day.records.forEach((rec) => {
        const s = byDriver[rec.driverName] || { name: rec.driverName, jobs: 0, car: 0, van: 0, basePay: 0, bonus: 0, adjustment: 0 };
        s.jobs++; if (rec.vehicle === 'Car') s.car++; else if (rec.vehicle === 'Van') s.van++;
        s.basePay += Number(rec.baseRate) || 0; s.bonus += Number(rec.bonus) || 0; s.adjustment += Number(rec.adjustment) || 0;
        byDriver[rec.driverName] = s;
      });
    });
    if (!summaryUi.onlyActive) {
      state.drivers.forEach((d) => { if (!(d.name in byDriver)) { byDriver[d.name] = { name: d.name, jobs: 0, car: 0, van: 0, basePay: 0, bonus: 0, adjustment: 0 }; } });
    }
    const names = Object.keys(byDriver);
    const rows = names.map((n) => byDriver[n]).sort((a, b) => (b.basePay + b.bonus + b.adjustment) - (a.basePay + a.bonus + a.adjustment));
    const totals = rows.reduce((acc, r) => ({ jobs: acc.jobs + r.jobs, car: acc.car + r.car, van: acc.van + r.van, basePay: acc.basePay + r.basePay, bonus: acc.bonus + r.bonus, adjustment: acc.adjustment + r.adjustment }), { jobs: 0, car: 0, van: 0, basePay: 0, bonus: 0, adjustment: 0 });

    const body = rows.length ? rows.map((r) => {
      const final = r.basePay + r.bonus + r.adjustment;
      const avg = r.jobs ? final / r.jobs : 0;
      return `<tr><td>${esc(r.name)}</td><td class="tnum">${r.jobs}</td><td class="tnum">${r.car}</td><td class="tnum">${r.van}</td><td class="tnum">${fmtMoney(r.basePay)}</td><td class="tnum">${fmtMoney(r.bonus)}</td><td class="tnum">${fmtMoney(r.adjustment)}</td><td class="tnum" style="font-weight:700;">${fmtMoney(final)}</td><td class="tnum">${fmtMoney(avg)}</td></tr>`;
    }).join('') : `<tr><td colspan="9"><div class="empty-state">No activity in this range.</div></td></tr>`;
    const totalFinal = totals.basePay + totals.bonus + totals.adjustment;

    return `
      <div class="view-header"><div><h1>Driver Summary</h1><div class="sub">Totals and pay for each driver over a date range</div></div></div>

      <div class="card date-section" style="margin-bottom:16px;">
        <div class="date-section-inner">
          <div>
            <label class="field-label">Date range</label>
            <div class="date-display">${fmtDateHuman(from)} – ${fmtDateHuman(to)}</div>
          </div>
          <div class="date-section-controls">
            <button class="btn btn-sm ${summaryUi.range === 'today' ? 'btn-primary' : ''}" data-action="summary-range" data-range="today">Today</button>
            <button class="btn btn-sm ${summaryUi.range === 'week' ? 'btn-primary' : ''}" data-action="summary-range" data-range="week">This Week</button>
            <button class="btn btn-sm ${summaryUi.range === 'month' ? 'btn-primary' : ''}" data-action="summary-range" data-range="month">This Month</button>
            <button class="btn btn-sm ${summaryUi.range === 'custom' ? 'btn-primary' : ''}" data-action="summary-range" data-range="custom">Custom</button>
            ${summaryUi.range === 'custom' ? `<input type="date" value="${summaryUi.from}" data-onchange="summary-custom" data-field="from"><input type="date" value="${summaryUi.to}" data-onchange="summary-custom" data-field="to">` : ''}
          </div>
        </div>
      </div>

      <div class="toolbar">
        <label class="checkbox-row" style="margin-left:auto;"><input type="checkbox" ${summaryUi.onlyActive ? 'checked' : ''} data-onchange="summary-only-active"> Only drivers with activity</label>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Driver</th><th>Total Jobs</th><th>Car Jobs</th><th>Van Jobs</th><th>Total Pay</th><th>Bonus</th><th>Adjustment</th><th>Final Payment</th><th>Avg / Job</th></tr></thead>
          <tbody>${body}</tbody>
          <tfoot><tr><td>TOTAL</td><td class="tnum">${totals.jobs}</td><td class="tnum">${totals.car}</td><td class="tnum">${totals.van}</td><td class="tnum">${fmtMoney(totals.basePay)}</td><td class="tnum">${fmtMoney(totals.bonus)}</td><td class="tnum">${fmtMoney(totals.adjustment)}</td><td class="tnum">${fmtMoney(totalFinal)}</td><td class="tnum">${fmtMoney(totals.jobs ? totalFinal / totals.jobs : 0)}</td></tr></tfoot>
        </table>
      </div>
    `;
  }

  // ---------------------------------------------------------------
  // View: Payments
  // ---------------------------------------------------------------
  const paymentsUi = { search: '', status: '', driver: '', from: '', to: '' };
  function filteredPayments() {
    let rows = allRecordsFlat();
    const q = paymentsUi.search.trim().toLowerCase();
    if (q) rows = rows.filter((r) => (r.paymentRef || '').toLowerCase().includes(q) || r.driverName.toLowerCase().includes(q));
    if (paymentsUi.status) rows = rows.filter((r) => (r.status || 'Pending') === paymentsUi.status);
    if (paymentsUi.driver) rows = rows.filter((r) => r.driverName === paymentsUi.driver);
    if (paymentsUi.from) rows = rows.filter((r) => r.date >= paymentsUi.from);
    if (paymentsUi.to) rows = rows.filter((r) => r.date <= paymentsUi.to);
    rows.sort((a, b) => b.date.localeCompare(a.date));
    return rows;
  }
  function viewPayments() {
    const all = allRecordsFlat();
    const totalPay = all.reduce((s, r) => s + finalPay(r), 0);
    const pending = all.filter((r) => (r.status || 'Pending') === 'Pending');
    const approved = all.filter((r) => r.status === 'Approved');
    const paid = all.filter((r) => r.status === 'Paid');
    const totalBonus = all.reduce((s, r) => s + (Number(r.bonus) || 0), 0);
    const totalAdj = all.reduce((s, r) => s + (Number(r.adjustment) || 0), 0);

    const allFiltered = filteredPayments();
    const cap = capRows(allFiltered);
    const rows = cap.shown;
    const driverOpts = state.drivers.map((d) => `<option value="${esc(d.name)}" ${paymentsUi.driver === d.name ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
    const body = rows.length ? rows.map((r) => `
      <tr>
        <td class="tnum">${esc(r.paymentRef || '—')}</td>
        <td class="tnum">${r.date}</td>
        <td>${esc(r.driverName)}</td>
        <td>${esc(r.block || '—')}</td>
        <td>${vehiclePillHtml(r.vehicle)}</td>
        <td>${esc(r.companyName || '—')}</td>
        <td class="tnum" style="font-weight:700;">${fmtMoney(finalPay(r))}</td>
        <td>
          <select data-onchange="payment-status" data-date="${r.date}" data-id="${r.id}">
            ${STATUSES.map((s) => `<option ${s === (r.status || 'Pending') ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </td>
        <td class="wrap">${esc(r.notes || '')}</td>
      </tr>
    `).join('') : `<tr><td colspan="9"><div class="empty-state">No payments match these filters.</div></td></tr>`;

    return `
      <div class="view-header"><div><h1>Payments</h1><div class="sub">Every record's payment reference and status</div></div></div>
      <div class="grid-stats">
        <div class="stat-tile accent"><div class="stat-label">Total payments</div><div class="stat-value">${fmtMoney(totalPay)}</div><div class="stat-sub">${all.length} records</div></div>
        <div class="stat-tile"><div class="stat-label">Pending</div><div class="stat-value">${fmtMoney(pending.reduce((s, r) => s + finalPay(r), 0))}</div><div class="stat-sub">${pending.length} records</div></div>
        <div class="stat-tile"><div class="stat-label">Approved</div><div class="stat-value">${fmtMoney(approved.reduce((s, r) => s + finalPay(r), 0))}</div><div class="stat-sub">${approved.length} records</div></div>
        <div class="stat-tile"><div class="stat-label">Paid</div><div class="stat-value">${fmtMoney(paid.reduce((s, r) => s + finalPay(r), 0))}</div><div class="stat-sub">${paid.length} records</div></div>
        <div class="stat-tile"><div class="stat-label">Total bonuses</div><div class="stat-value">${fmtMoney(totalBonus)}</div></div>
        <div class="stat-tile"><div class="stat-label">Total adjustments</div><div class="stat-value">${fmtMoney(totalAdj)}</div></div>
      </div>
      <div class="section-title"><h2>Payment history</h2></div>
      <div class="toolbar">
        <div class="search-input grow"><span class="ic">⌕</span><input type="text" placeholder="Search PAY-0001, driver name…" value="${esc(paymentsUi.search)}" data-onchange="payment-filter" data-field="search"></div>
        <select data-onchange="payment-filter" data-field="status"><option value="">All statuses</option>${STATUSES.map((s) => `<option ${paymentsUi.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <select data-onchange="payment-filter" data-field="driver"><option value="">All drivers</option>${driverOpts}</select>
        <input type="date" value="${paymentsUi.from}" data-onchange="payment-filter" data-field="from">
        <input type="date" value="${paymentsUi.to}" data-onchange="payment-filter" data-field="to">
      </div>
      ${capNoticeHtml(cap)}
      <div class="table-wrap">
        <table class="data"><thead><tr><th>Ref</th><th>Date</th><th>Driver</th><th>Block</th><th>Vehicle</th><th>Company</th><th>Final Pay</th><th>Status</th><th>Notes</th></tr></thead><tbody>${body}</tbody></table>
      </div>
    `;
  }

  // ---------------------------------------------------------------
  // View: Excel Export / Import
  // ---------------------------------------------------------------
  const exportUi = { mode: 'all', from: '', to: '', driver: '', company: '' };
  function viewExport() {
    const driverOpts = state.drivers.map((d) => `<option value="${esc(d.name)}">${esc(d.name)}</option>`).join('');
    const companyOpts = state.companies.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
    return `
      <div class="view-header"><div><h1>Excel Export</h1><div class="sub">One workbook, same layout as your original template</div></div></div>
      <div class="card">
        <h3 style="margin-bottom:14px;">Choose what to export</h3>
        <div class="toolbar" style="margin-bottom:14px;">
          <button class="btn btn-sm ${exportUi.mode === 'all' ? 'btn-primary' : ''}" data-action="export-mode" data-mode="all">Export All</button>
          <button class="btn btn-sm ${exportUi.mode === 'today' ? 'btn-primary' : ''}" data-action="export-mode" data-mode="today">Export Today</button>
          <button class="btn btn-sm ${exportUi.mode === 'range' ? 'btn-primary' : ''}" data-action="export-mode" data-mode="range">Export Date Range</button>
          <button class="btn btn-sm ${exportUi.mode === 'driver' ? 'btn-primary' : ''}" data-action="export-mode" data-mode="driver">Export by Driver</button>
          <button class="btn btn-sm ${exportUi.mode === 'company' ? 'btn-primary' : ''}" data-action="export-mode" data-mode="company">Export by Company</button>
        </div>
        ${exportUi.mode === 'range' ? `<div class="field-row" style="margin-bottom:14px;"><div class="field"><label class="field-label">From</label><input type="date" value="${exportUi.from}" data-onchange="export-field" data-field="from"></div><div class="field"><label class="field-label">To</label><input type="date" value="${exportUi.to}" data-onchange="export-field" data-field="to"></div></div>` : ''}
        ${exportUi.mode === 'driver' ? `<div class="field" style="max-width:280px;margin-bottom:14px;"><label class="field-label">Driver</label><select data-onchange="export-field" data-field="driver"><option value="">Select driver…</option>${driverOpts}</select></div>` : ''}
        ${exportUi.mode === 'company' ? `<div class="field" style="max-width:280px;margin-bottom:14px;"><label class="field-label">Company</label><select data-onchange="export-field" data-field="company"><option value="">Select company…</option>${companyOpts}</select></div>` : ''}
        <button class="btn btn-primary" data-action="export-run">⬇ Generate & download workbook</button>
        <p class="helptext" style="margin-top:12px;">Includes Instructions, Companies, Driver Payments, Driver Summary, Company Summary, Sheet1 and Daily Summary — matching your original template's sheets, columns and formulas, with payment tracking and company columns appended.</p>
      </div>

      ${isAdmin() ? `
      <div class="section-title"><h2>Import historical Excel data</h2></div>
      <div class="card">
        <p class="helptext" style="margin-bottom:12px;">Upload a workbook shaped like the Driver Payments template. You'll see a preview before anything is imported.</p>
        <input type="file" id="importFileInput" accept=".xlsx">
        <button class="btn" data-action="import-run" style="margin-left:8px;">Preview import</button>
      </div>` : ''}
    `;
  }

  function exportPayload() {
    let days = state.days.filter((d) => d.records && d.records.length);
    if (exportUi.mode === 'today') { const t = todayStr(); days = days.filter((d) => d.date === t); }
    else if (exportUi.mode === 'range') { days = days.filter((d) => (!exportUi.from || d.date >= exportUi.from) && (!exportUi.to || d.date <= exportUi.to)); }
    else if (exportUi.mode === 'driver' && exportUi.driver) { days = days.map((d) => ({ date: d.date, records: d.records.filter((r) => r.driverName === exportUi.driver) })).filter((d) => d.records.length); }
    else if (exportUi.mode === 'company' && exportUi.company) { days = days.map((d) => ({ date: d.date, records: d.records.filter((r) => r.companyName === exportUi.company) })).filter((d) => d.records.length); }
    const driverNames = exportUi.mode === 'driver' && exportUi.driver ? [exportUi.driver] : state.drivers.map((d) => d.name);
    // Labour roster / logs / invoices aren't affected by the driver-payment
    // export mode filters above — they're always exported in full alongside
    // whatever driver-payment slice was requested.
    return {
      days, drivers: driverNames, companies: state.companies, settings: state.settings,
      labour: state.labour, labourShifts: state.labourShifts, labourLogs: state.labourLogs, invoices: state.invoices,
      rateCards: state.rateCards, auditLog: state.auditLog,
      driverSubmissions: state.driverSubmissions, deliveryBlocks: state.deliveryBlocks,
    };
  }

  async function downloadBlobInBrowser(blob, filename) {
    if (!(blob instanceof Blob)) throw new Error('The export did not produce a downloadable file.');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function runExport() {
    try {
      const payload = exportPayload();
      if (!payload.days.length) { toast('No records match this export selection.', 'err'); return; }
      if (!window.ExcelJS && !window.UMA_EXCELJS_LOAD_ERROR) throw new Error('ExcelJS library is not available yet. Refresh the page and try again.');
      const wb = await XL.buildWorkbook(payload);
      const blob = await XL.workbookToBlob(wb);
      const stamp = todayStr();
      const label = exportUi.mode === 'all' ? 'All' : exportUi.mode === 'today' ? 'Today' : exportUi.mode === 'range' ? 'Range' : exportUi.mode === 'company' ? (exportUi.company || 'Company') : (exportUi.driver || 'Driver');
      await downloadBlobInBrowser(blob, `UMA-Management-${label}-${stamp}.xlsx`);
      toast('Workbook generated. Check your browser Downloads folder.', 'ok');
    } catch (e) {
      if (e && e.code === 'declined') return;
      console.error(e);
      toast('Could not build the workbook: ' + (e && e.message ? e.message : e) + (window.UMA_EXCELJS_LOAD_ERROR ? ' ExcelJS could not load from available CDNs; check internet/content blockers.' : ''), 'err');
    }
  }

  let importPreviewRows = null;
  async function runImportPreview() {
    const input = document.getElementById('importFileInput');
    if (!input || !input.files || !input.files[0]) { toast('Choose a file first.', 'err'); return; }
    try {
      const buf = await input.files[0].arrayBuffer();
      const parsed = await XL.parseImportWorkbook(buf);
      importPreviewRows = parsed.rows;
      const existingKeys = new Set(allRecordsFlat().map((r) => [r.date, r.driverName, String(r.block || '').toLowerCase()].join('|')));
      const rowsHtml = parsed.rows.slice(0, 300).map((r, i) => {
        const dup = existingKeys.has([r.date, r.driverName, String(r.block || '').toLowerCase()].join('|'));
        return `<tr class="${dup ? 'dup' : ''}"><td><input type="checkbox" class="import-row-check" data-idx="${i}" ${dup ? '' : 'checked'}></td><td>${esc(r.date || '—')}</td><td>${esc(r.block)}</td><td>${esc(r.driverName)}</td><td>${esc(r.vehicle)}</td><td>${esc(r.companyName || '—')}</td><td class="tnum">${r.basePay == null ? '—' : fmtMoney(r.basePay)}</td><td>${dup ? '<span class="pill pill-cancelled">Possible duplicate</span>' : '<span class="pill pill-paid">New</span>'}</td></tr>`;
      }).join('');
      openModal(`
        <div class="modal-head"><h3>Import preview — ${parsed.rows.length} rows found</h3><button data-action="modal-close" aria-label="Close">✕</button></div>
        <p class="helptext" style="margin-bottom:10px;">Rows flagged as possible duplicates (same date + driver + block as an existing record) are unchecked by default. A Company name not already in your Companies list will be added automatically as a Fixed-rate company.</p>
        <div class="table-wrap" style="max-height:360px;overflow-y:auto;">
          <table class="data"><thead><tr><th></th><th>Date</th><th>Block</th><th>Driver</th><th>Vehicle</th><th>Company</th><th>Base Pay</th><th></th></tr></thead><tbody>${rowsHtml}</tbody></table>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
          <button class="btn" data-action="modal-close">Cancel</button>
          <button class="btn btn-primary" data-action="import-commit">Import selected rows</button>
        </div>
      `, { wide: true });
    } catch (e) {
      console.error(e);
      toast('Import failed: ' + (e && e.message ? e.message : e), 'err');
    }
  }
  async function commitImport() {
    const checks = Array.from(document.querySelectorAll('.import-row-check'));
    const selectedIdx = checks.filter((c) => c.checked).map((c) => Number(c.dataset.idx));
    if (!selectedIdx.length) { toast('No rows selected.', 'err'); closeModal(); return; }
    const byDate = {};
    for (const idx of selectedIdx) {
      const r = importPreviewRows[idx];
      if (!r.date || !r.driverName) continue;
      if (!driverByName(r.driverName)) {
        await state.db.collection('drivers').add({ name: r.driverName, vehicleType: r.vehicle || 'Car', active: true, createdAt: new Date().toISOString() });
      }
      const vehicle = r.vehicle || 'Car';
      const companyName = r.companyName || '';
      const parcels = Number(r.parcels) || 0;
      if (companyName && !companyByName(companyName)) {
        const fallbackRate = r.basePay != null ? Number(r.basePay) || 0 : 0;
        await state.db.collection('companies').add({ name: companyName, type: 'delivery', rateType: 'fixed', carRate: fallbackRate, vanRate: fallbackRate, otherRate: fallbackRate, active: true, createdAt: new Date().toISOString() });
        await loadCompanies();
      }
      const computed = companyName ? computeBaseRate(companyName, vehicle, parcels) : 0;
      const baseRate = r.basePay != null ? Number(r.basePay) || 0 : computed;
      const ref = r.paymentRef || (await claimPaymentRef(r.date));
      const rec = {
        id: genId(), block: r.block || '', driverName: r.driverName, vehicle, companyName, parcels,
        baseRate, bonus: r.bonus || 0, adjustment: r.adjustment || 0,
        notes: r.notes || '', paymentRef: ref, status: r.status || 'Pending',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), createdBy: state.session ? state.session.name : 'import',
      };
      if (!byDate[r.date]) byDate[r.date] = (getDay(r.date) ? getDay(r.date).records.slice() : []);
      byDate[r.date].push(rec);
    }
    await loadDrivers();
    for (const date of Object.keys(byDate)) await saveDay(date, byDate[date]);
    closeModal();
    toast(`Imported ${Object.values(byDate).reduce((s, a) => s + a.length, 0)} records.`, 'ok');
    renderView();
  }

  // ---------------------------------------------------------------
  // View: Settings
  // ---------------------------------------------------------------
  function viewSettings() {
    const s = state.settings;
    const staffRows = state.staff.map((st) => `
      <tr>
        <td>${esc(st.name)}</td>
        <td>${esc(st.mobile || '—')}</td>
        <td>${esc(st.role)}</td>
        <td>${st.active !== false ? '<span class="pill pill-paid">Active</span>' : '<span class="pill pill-cancelled">Inactive</span>'}</td>
        <td>
          <button class="btn btn-sm" data-action="staff-reset-pin" data-id="${st.id}">Reset PIN</button>
          ${st.role === 'labour' || st.role === 'driver' ? '' : `<button class="btn btn-sm" data-action="staff-toggle-role" data-id="${st.id}">Cycle role</button>`}
          ${st.active !== false ? `<button class="btn btn-sm btn-danger" data-action="staff-deactivate" data-id="${st.id}">Deactivate</button>` : `<button class="btn btn-sm" data-action="staff-reactivate" data-id="${st.id}">Reactivate</button>`}
          ${isAdmin() && (!state.session || st.id !== state.session.staffId) ? `<button class="btn btn-sm btn-danger" data-action="staff-delete-account" data-id="${st.id}">Delete login</button>` : ''}
        </td>
      </tr>
    `).join('');

    return `
      <div class="view-header"><div><h1>Settings</h1><div class="sub">Rates, staff, prefixes and export preferences</div></div></div>

      <div class="card" style="margin-bottom:18px;">
        <h3 style="margin-bottom:14px;">Business name</h3>
        <form data-onsubmit="settings-save-rates">
          <div class="field-row">
            <div class="field"><label class="field-label">Business name</label><input type="text" name="businessName" value="${esc(s.businessName)}"></div>
          </div>
          <button class="btn btn-primary" type="submit">Save name</button>
        </form>
        <p class="helptext" style="margin:14px 0 0;">Rates are no longer set per vehicle — each company now has its own Fixed or Per-Parcel rate. Manage them on the <a href="#companies" data-action="nav" data-route="companies" style="color:var(--accent);text-decoration:underline;cursor:pointer;">Companies</a> page.</p>
      </div>

      <div class="card" style="margin-bottom:18px;">
        <h3 style="margin-bottom:4px;">Route planner</h3>
        <p class="helptext" style="margin:0 0 14px;">Drivers can start their route from here instead of their current location. Addresses are looked up free on OpenStreetMap and saved, so repeat addresses are instant.</p>
        <form data-onsubmit="settings-save-route" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;">
          <div class="field" style="flex:1;min-width:240px;"><label class="field-label">Depot address</label><input type="text" name="routeDepotAddress" value="${esc(s.routeDepotAddress || '')}" placeholder="Street, Suburb STATE Postcode"></div>
          <button class="btn btn-primary" type="submit">Save</button>
        </form>
      </div>

      <div class="card" style="margin-bottom:18px;">
        <h3 style="margin-bottom:4px;">Invoice details</h3>
        <p class="helptext" style="margin:0 0 14px;">Printed on every invoice PDF. Workers' pay and your margin are never shown on invoices.</p>
        <form data-onsubmit="settings-save-invoice">
          <div class="field-row" style="margin-bottom:12px;">
            <div class="field"><label class="field-label">ABN</label><input type="text" name="invoiceAbn" value="${esc(s.invoiceAbn || '')}" placeholder="12 345 678 901"></div>
            <div class="field"><label class="field-label">Phone</label><input type="tel" name="invoicePhone" value="${esc(s.invoicePhone || '')}"></div>
            <div class="field"><label class="field-label">Email</label><input type="email" name="invoiceEmail" value="${esc(s.invoiceEmail || '')}"></div>
          </div>
          <div class="field" style="margin-bottom:12px;"><label class="field-label">Business address</label><input type="text" name="invoiceAddress" value="${esc(s.invoiceAddress || '')}" placeholder="Street, Suburb STATE Postcode"></div>
          <div class="field-row" style="margin-bottom:12px;">
            <div class="field"><label class="field-label">GST</label><select name="invoiceGst"><option value="none" ${s.invoiceGst !== 'add10' ? 'selected' : ''}>Not registered — no GST</option><option value="add10" ${s.invoiceGst === 'add10' ? 'selected' : ''}>Registered — add 10% GST</option></select></div>
            <div class="field"><label class="field-label">Payment due (days)</label><input type="number" name="invoiceTermsDays" min="0" max="120" value="${s.invoiceTermsDays != null ? s.invoiceTermsDays : 14}"></div>
          </div>
          <p class="eyebrow" style="margin:14px 0 8px;">Bank details for payment</p>
          <div class="field-row" style="margin-bottom:12px;">
            <div class="field"><label class="field-label">Account name</label><input type="text" name="invoiceBankName" value="${esc(s.invoiceBankName || '')}"></div>
            <div class="field"><label class="field-label">BSB</label><input type="text" name="invoiceBsb" inputmode="numeric" value="${esc(s.invoiceBsb || '')}" placeholder="062-000"></div>
            <div class="field"><label class="field-label">Account number</label><input type="text" name="invoiceAccount" inputmode="numeric" value="${esc(s.invoiceAccount || '')}"></div>
          </div>
          <div class="field" style="margin-bottom:14px;"><label class="field-label">Note at the bottom of invoices (optional)</label><input type="text" name="invoiceNote" value="${esc(s.invoiceNote || '')}" placeholder="Thank you for your business."></div>
          <button class="btn btn-primary" type="submit">Save invoice details</button>
        </form>
      </div>

      <div class="card" style="margin-bottom:18px;">
        <h3 style="margin-bottom:14px;">Payment reference format</h3>
        <form data-onsubmit="settings-save-prefix">
          <div class="field-row">
            <div class="field"><label class="field-label">Format</label><input type="text" name="prefixFormat" value="${esc(s.prefixFormat)}"></div>
            <div class="field"><label class="field-label">Next number</label><input type="number" name="nextPaymentNumber" value="${s.nextPaymentNumber}"></div>
          </div>
          <p class="helptext" style="margin:10px 0;">Use <code>{NUMBER}</code> for the sequence (e.g. PAY-0001) and optionally <code>{DATE}</code> for the record's date. Changing this only affects new records.</p>
          <button class="btn btn-primary" type="submit">Save format</button>
        </form>
      </div>

      <div class="card" style="margin-bottom:18px;">
        <h3 style="margin-bottom:14px;">Rate tier rules</h3>
        <form data-onsubmit="settings-save-tiers">
          <div class="field-row" style="margin-bottom:12px;">
            <div class="field"><label class="field-label">Overtime after (hours/day)</label><input type="number" step="0.5" min="0" name="overtimeThresholdHours" value="${s.overtimeThresholdHours}"></div>
            <div class="field"><label class="field-label">Night shift start</label><input type="time" name="nightShiftStart" value="${s.nightShiftStart}"></div>
            <div class="field"><label class="field-label">Night shift end</label><input type="time" name="nightShiftEnd" value="${s.nightShiftEnd}"></div>
          </div>
          <p class="helptext" style="margin:0 0 12px;">Used to resolve which Rate Card tier applies: hours beyond the threshold on an otherwise-standard weekday become Overtime; a shift starting inside the night window uses the Night tier instead (Saturday/Sunday/Public Holiday always take priority over both).</p>
          <button class="btn btn-primary" type="submit">Save tier rules</button>
        </form>
        <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--border);">
          <label class="field-label">Public holidays</label>
          <div class="field-row" style="margin:8px 0 12px;">
            <div class="field"><input type="date" id="newPublicHoliday"></div>
            <button type="button" class="btn" data-action="settings-add-holiday">+ Add date</button>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;">
            ${(s.publicHolidays || []).length ? s.publicHolidays.slice().sort().map((d) => `<span class="pill pill-other">${d} <button data-action="settings-remove-holiday" data-date="${d}" style="border:none;background:none;cursor:pointer;color:inherit;margin-left:4px;">✕</button></span>`).join('') : '<p class="helptext" style="margin:0;">No public holidays configured yet.</p>'}
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:18px;">
        <h3 style="margin-bottom:14px;">Delivery Performance settings</h3>
        <form data-onsubmit="settings-save-delivery">
          <div class="field-row" style="margin-bottom:12px;">
            <div class="field"><label class="field-label">Submission reference format</label><input type="text" name="submissionPrefixFormat" value="${esc(s.submissionPrefixFormat || 'SUB-{NUMBER}')}"></div>
            <div class="field"><label class="field-label">Next number</label><input type="number" name="nextSubmissionNumber" value="${s.nextSubmissionNumber || 1}"></div>
          </div>
          <div class="field" style="margin-bottom:12px;"><label><input type="checkbox" name="screenshotRequired" ${s.screenshotRequired ? 'checked' : ''}> Require a screenshot before a driver can finish work</label></div>
          <button class="btn btn-primary" type="submit">Save delivery settings</button>
        </form>
        <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--border);">
          <label class="field-label">Failure reasons (shown to drivers when they report a failed delivery)</label>
          <div class="field-row" style="margin:8px 0 12px;">
            <div class="field"><input type="text" id="newFailureReason" placeholder="e.g. Site closed"></div>
            <button type="button" class="btn" data-action="settings-add-failure-reason">+ Add reason</button>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;">
            ${(s.failureReasons || []).length ? s.failureReasons.map((r) => `<span class="pill pill-other">${esc(r)} <button data-action="settings-remove-failure-reason" data-reason="${esc(r)}" style="border:none;background:none;cursor:pointer;color:inherit;margin-left:4px;">✕</button></span>`).join('') : '<p class="helptext" style="margin:0;">No failure reasons configured yet.</p>'}
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:18px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <h3>Staff & permissions</h3>
          <button class="btn btn-sm" data-action="staff-add">+ Add staff</button>
        </div>
        <div class="table-wrap"><table class="data"><thead><tr><th>Name</th><th>Mobile</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>${staffRows}</tbody></table></div>
        <p class="helptext" style="margin-top:10px;">Every login (admin, staff, manager, driver or labour) signs in with its mobile number + PIN. This is not a secure login — anyone who knows the mobile number and PIN can sign in as that account.</p>
      </div>

      <div class="card" style="margin-bottom:18px;">
        <h3 style="margin-bottom:8px;">Data backup & restore</h3>
        <p class="helptext" style="margin:0 0 12px;">Download a full JSON backup of your local UMA Management data, or restore a previous backup. Store backup files somewhere private because they may contain staff details, payment records and PINs.</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          <button class="btn btn-primary" type="button" data-action="backup-export">⬇ Download full backup</button>
          <button class="btn" type="button" data-action="backup-import-open">Restore from backup</button>
          <input type="file" id="backupFileInput" accept=".json,application/json" hidden>
        </div>
        <p class="helptext" style="margin:12px 0 0;color:var(--danger,#a33);">Local browser mode: data stays in this browser on this device. Clearing browser data or using another device will not transfer your records. Publishing this site does not create shared multi-user storage or secure server-side permissions.</p>
      </div>

      <div class="card">
        <h3 style="margin-bottom:14px;">Website field → Excel column mapping</h3>
        <div class="table-wrap">
          <table class="data mapping-table">
            <thead><tr><th>Website field</th><th>Excel column (Driver Payments)</th><th>Calculation</th></tr></thead>
            <tbody>
              <tr><td>Date</td><td>A</td><td>Direct value</td></tr>
              <tr><td>Block</td><td>B</td><td>Direct value</td></tr>
              <tr><td>Driver Name</td><td>C</td><td>Direct value</td></tr>
              <tr><td>Vehicle</td><td>D</td><td>Direct value — picks which of the Company's Car/Van/Other rates applies</td></tr>
              <tr><td>Company</td><td>E</td><td>Direct value — looked up against the Companies sheet</td></tr>
              <tr><td>Parcels</td><td>F</td><td>Direct value (only used by Per-Parcel companies)</td></tr>
              <tr><td>Base pay</td><td>G — That Day Pay</td><td>Formula: VLOOKUP(Company + Vehicle, Companies sheet) → that vehicle's Fixed rate, or Per-Parcel rate × Parcels — unless manually overridden</td></tr>
              <tr><td>Bonus</td><td>H</td><td>Direct value (added by this app)</td></tr>
              <tr><td>Adjustment</td><td>I</td><td>Direct value (added by this app)</td></tr>
              <tr><td>Final Payment</td><td>J</td><td>Formula: G+H+I</td></tr>
              <tr><td>Payment Ref</td><td>K</td><td>Auto-generated on save</td></tr>
              <tr><td>Payment Status</td><td>L</td><td>Direct value</td></tr>
              <tr><td>Notes</td><td>M</td><td>Direct value</td></tr>
              <tr><td>Company rates</td><td>Companies sheet</td><td>One row per company: Name / Company Type / Rate Type / Car Rate / Van Rate / Other Rate / Hourly Rate</td></tr>
              <tr><td>Driver totals</td><td>Driver Summary sheet</td><td>COUNTIF / COUNTIFS / SUMIF against Driver Payments</td></tr>
              <tr><td>Company totals</td><td>Company Summary sheet</td><td>COUNTIF / SUMIF against Driver Payments</td></tr>
              <tr><td>Daily totals</td><td>Daily Summary sheet</td><td>COUNTIF / COUNTIFS / SUMIF against Driver Payments</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------
  // Gate (staff select + PIN)
  // ---------------------------------------------------------------
  // ---------------------------------------------------------------
  // Every account (admin/staff/manager/driver/labour) lives in `staff` and
  // logs in with mobile number + PIN. `gateStage` walks: 'mobile' (enter
  // mobile number) -> 'pin' (keypad, once a matching account is found).
  // The very first account ever created (no staff docs yet) instead sees a
  // one-time Sign Up screen that bootstraps the first Admin account.
  // ---------------------------------------------------------------
  let pinBuffer = '';
  let pinTargetStaffId = null;
  let gateCandidateStaffIds = [];
  let gateStage = 'mobile';
  let gateMobileDraft = '';
  let gateSubmitting = false;
  let switchingUser = false;

  // Return to the login gate without a full page reload. This avoids stale
  // admin hashes, browser reload races, and leftover PIN/session state when
  // switching between Admin, Manager, Staff, Driver, and Labour accounts.
  function showLoginGate(options) {
    options = options || {};
    state.session = null;
    state.route = 'dashboard';
    state.recordsFilter = null;
    pinBuffer = '';
    pinTargetStaffId = null;
    gateCandidateStaffIds = [];
    gateStage = 'mobile';
    gateSubmitting = false;
    if (options.clearMobile !== false) gateMobileDraft = '';
    clearPersistedSession();
    if (state.remoteDb && state.db && state.db.authLogout) state.db.authLogout().catch((error) => console.warn('UMA remote logout:', error));

    // Clear the previous role's URL hash so it is never restored for the
    // next person signing in on this device.
    try {
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    } catch (e) {
      location.hash = '';
    }

    closeModal();
    window.__confirmResolve = null;
    document.getElementById('mobilenav').classList.add('hidden');
    document.getElementById('drawer-backdrop').classList.add('hidden');
    document.getElementById('shell').classList.add('hidden');
    const gate = document.getElementById('gate');
    gate.classList.remove('hidden');
    renderGate();
    const mobileInput = gate.querySelector('input[name="mobile"]');
    if (mobileInput) {
      try { mobileInput.focus({ preventScroll: true }); } catch (e) { mobileInput.focus(); }
    }
  }

  function gateStorageNotice() {
    if (!state.usingFallback) return '';
    return `<div class="gate-storage-notice" role="status"><strong>Offline copy</strong><span>This phone is using its own saved data. Changes won't show on other devices.</span></div>`;
  }

  function showGateError(message) {
    const error = document.getElementById('gate-mobile-error');
    if (error) {
      error.textContent = String(message || 'Unable to continue. Please try again.');
      error.hidden = false;
      error.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      toast(message || 'Unable to continue. Please try again.', 'err');
    }
  }

  function clearGateError() {
    const error = document.getElementById('gate-mobile-error');
    if (error) { error.textContent = ''; error.hidden = true; }
  }

  function renderGate() {
    const gate = document.getElementById('gate');
    if (state.staff.length === 0 && (!state.remoteDb || state.accountSetupRequired)) {
      gate.innerHTML = `
        <div class="gate-card card">
          <div class="brand" style="padding:0 0 10px;"><div class="brand-mark">UM</div><div class="brand-text">${esc(state.settings.businessName || 'UMA Management')}<small>Sign up — first admin account</small></div></div>
          <h2 style="margin-bottom:6px;">Create the first admin account</h2>
          <p class="helptext" style="margin-bottom:16px;">Your mobile number becomes your login ID, with a 4-digit PIN.</p>
          ${gateStorageNotice()}
          <form data-onsubmit="gate-signup-admin" novalidate>
            <div class="field" style="margin-bottom:12px;"><label class="field-label" for="gate-name">Your name</label><input id="gate-name" type="text" name="name" autocomplete="name" required></div>
            <div class="field" style="margin-bottom:12px;"><label class="field-label" for="gate-signup-mobile">Mobile number</label><input id="gate-signup-mobile" type="tel" inputmode="tel" autocomplete="tel" name="mobile" required></div>
            <div class="field" style="margin-bottom:12px;"><label class="field-label" for="gate-signup-pin">Choose a 4-digit PIN</label><input id="gate-signup-pin" type="password" inputmode="numeric" pattern="[0-9]{4}" minlength="4" maxlength="4" name="pin" autocomplete="new-password" required></div>
            <button class="btn btn-primary gate-submit" type="submit" style="width:100%;">Sign up & continue</button>
          </form>
        </div>`;
      return;
    }
    if (gateStage === 'account' && gateCandidateStaffIds.length) {
      const candidates = gateCandidateStaffIds
        .map((id) => state.staff.find((s) => s.id === id && s.active !== false))
        .filter(Boolean);
      if (!candidates.length) { gateStage = 'mobile'; gateCandidateStaffIds = []; }
      else {
        gate.innerHTML = `
          <div class="gate-card card">
            <div class="brand" style="padding:0 0 10px;"><div class="brand-mark">UM</div><div class="brand-text">${esc(state.settings.businessName || 'UMA Management')}<small>Select account</small></div></div>
            <h2 style="margin-bottom:6px;">Choose your account</h2>
            <p class="helptext" style="margin-bottom:16px;">More than one active account uses this mobile number. Select the correct role before entering your PIN.</p>
            ${gateStorageNotice()}
            <div class="gate-account-list">${candidates.map((account) => `
              <button type="button" class="gate-account-option" data-action="gate-select-account" data-staff-id="${esc(account.id)}">
                <span class="gate-account-avatar">${esc(String(account.name || 'U').slice(0, 2).toUpperCase())}</span>
                <span class="gate-account-copy"><strong>${esc(account.name || 'User')}</strong><small>${esc(String(account.role || 'staff').toUpperCase())} account</small></span>
                <span class="gate-account-arrow">›</span>
              </button>`).join('')}</div>
            <button type="button" class="btn gate-back-account" data-action="gate-back">Back</button>
          </div>`;
        return;
      }
    }
    if (gateStage === 'pin' && pinTargetStaffId) {
      const staffMember = state.staff.find((s) => s.id === pinTargetStaffId && s.active !== false);
      if (!staffMember) { gateStage = 'mobile'; pinTargetStaffId = null; }
      else {
        const dots = [0, 1, 2, 3].map((i) => `<div class="pin-dot ${i < pinBuffer.length ? 'filled' : ''}"></div>`).join('');
        gate.innerHTML = `
          <div class="gate-card card">
            <div style="text-align:center;margin-bottom:6px;"><div class="avatar" style="margin:0 auto 10px;">${esc(staffMember.name.slice(0, 2).toUpperCase())}</div><h3>${esc(staffMember.name)}</h3><p class="helptext">${esc(String(staffMember.role || 'staff').charAt(0).toUpperCase() + String(staffMember.role || 'staff').slice(1))} </p><p class="helptext" style="margin-top:10px;color:var(--ink);">Enter your 4-digit PIN</p>${state.usingFallback ? '<p class="gate-account-warning">Using this phone\'s saved data. If your role looks wrong, ask your manager.</p>' : ''}</div>
            <div class="pin-dots" aria-label="${pinBuffer.length} of 4 PIN digits entered">${dots}</div>
            <div class="keypad" aria-label="PIN keypad">
              ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-action="gate-key" data-key="${n}" aria-label="${n}">${n}</button>`).join('')}
              <button type="button" data-action="gate-back">Back</button>
              <button type="button" data-action="gate-key" data-key="0" aria-label="0">0</button>
              <button type="button" data-action="gate-backspace" aria-label="Delete last digit">⌫</button>
            </div>
          </div>`;
        return;
      }
    }
    gate.innerHTML = `
      <div class="gate-card card">
        <div class="brand" style="padding:0 0 10px;"><div class="brand-mark">UM</div><div class="brand-text">${esc(state.settings.businessName || 'UMA Management')}</div></div>
        <h2 style="margin-bottom:16px;">Sign in with your mobile number</h2>
        ${gateStorageNotice()}
        <form id="gate-mobile-form" data-onsubmit="gate-mobile-continue" novalidate>
          <div class="field" style="margin-bottom:12px;"><label class="field-label" for="gate-mobile-input">Mobile number</label><input id="gate-mobile-input" type="tel" inputmode="tel" autocomplete="tel" enterkeyhint="go" autocapitalize="off" spellcheck="false" name="mobile" placeholder="0412 345 678" value="${esc(gateMobileDraft)}" aria-describedby="gate-mobile-help gate-mobile-error" required></div>
          <p id="gate-mobile-help" class="helptext" style="margin:-4px 0 12px;">04xx xxx xxx or +61 4xx xxx xxx</p>
          <p id="gate-mobile-error" class="gate-inline-error" role="alert" aria-live="polite" hidden></p>
          <button class="btn btn-primary gate-submit" type="button" data-action="gate-mobile-continue" style="width:100%;">Continue</button>
        </form>
      </div>`;
  }

  async function checkPin() {
    if (gateSubmitting) return;
    const staffMember = state.staff.find((s) => s.id === pinTargetStaffId && s.active !== false);
    if (!staffMember || pinBuffer.length !== 4) return;
    gateSubmitting = true;
    try {
      let authenticated = null;
      if (state.remoteDb) {
        const result = await state.db.verifyPin(staffMember.id, pinBuffer);
        authenticated = result.user;
      } else if (pinBuffer === String(staffMember.pin)) {
        authenticated = staffMember;
      }
      if (authenticated) {
        state.session = sessionFromStaff(authenticated);
        if (!state.remoteDb) persistSession(state.session);
        pinBuffer = ''; pinTargetStaffId = null; gateCandidateStaffIds = []; gateStage = 'mobile'; gateMobileDraft = '';
        await loadAll();
        document.getElementById('gate').innerHTML = ''; document.getElementById('gate').classList.add('hidden');
        gateSubmitting = false;
        state.route = 'dashboard';
        try { history.replaceState(null, '', location.pathname + location.search + '#dashboard'); } catch (e) { location.hash = 'dashboard'; }
        boot2();
      } else {
        toast('Incorrect PIN', 'err');
        pinBuffer = '';
        gateSubmitting = false;
        renderGate();
      }
    } catch (error) {
      console.error('UMA PIN verification failed:', error);
      toast(error && error.message ? error.message : 'PIN verification failed. Please try again.', 'err');
      pinBuffer = '';
      gateSubmitting = false;
      renderGate();
    }
  }

  // ---------------------------------------------------------------
  // View router
  // ---------------------------------------------------------------
  const VIEWS = {
    dashboard: viewDashboard, entry: viewEntry, records: viewRecords, drivers: viewDrivers, companies: viewCompanies,
    summary: viewSummary, payments: viewPayments, export: viewExport, settings: viewSettings,
    labour: () => viewLabour(),
    'rate-cards': () => viewRateCards(),
    'labour-shifts': () => viewLabourShifts(),
    'labour-log': () => viewLabourLog(), 'labour-my-shifts': () => viewLabourMyShifts(), 'labour-my-history': () => viewLabourMyHistory(), 'labour-logs': () => viewLabourLogs(),
    invoices: () => viewInvoices(),
    'driver-submissions': () => viewDriverSubmissions(), 'driver-submit': () => viewDriverSubmit(), 'driver-my-history': () => viewDriverMyHistory(),
    'driver-route': () => viewDriverRoute(), routes: () => viewRoutesAdmin(),
    'delivery-blocks': () => viewDeliveryBlocks(), 'driver-assignments': () => viewDriverAssignments(), 'driver-performance': () => viewDriverPerformance(),
  };
  // ---------------------------------------------------------------
  // Route planner (Spoke-style)
  // ---------------------------------------------------------------
  // A driver uploads the day's run sheet (.xlsx or .csv). Rows are grouped by
  // address into stops, looked up with Google via /api/route/geocode (cached
  // server-side), put into a short driving order in the browser (nearest
  // neighbour + 2-opt on straight-line distance), and saved as a 'routes' doc.
  // The driver works through the stops and ticks Delivered / Failed; the
  // counts pre-fill their daily submission. Admin/Manager see every route.
  const routeUi = { draft: null, busy: '', adminDate: '', viewId: null, showAll: false, reorder: false };
  const ROUTE_FIELDS = [
    ['address', 'Street address', /^(delivery |receiver |consignee |customer |recipient )?(street )?(address|addr)( ?line ?1)?$|^street$|address 1|address line 1|delivery address/],
    ['suburb', 'Suburb / city', /suburb|city|town|locality/],
    ['state', 'State', /^state$|^st$|province|region/],
    ['postcode', 'Postcode', /post ?code|zip|^pc$|pcode/],
    ['name', 'Recipient name', /recipient|consignee|receiver|customer|^name$|full name|contact name/],
    ['phone', 'Phone', /phone|mobile|^tel|contact (no|number)/],
    ['ref', 'Parcel / tracking no.', /tracking|consignment|connote|con note|parcel ?(id|no|number)|barcode|article|reference|^ref|order (no|id|number)|label/],
    ['parcels', 'Number of parcels', /^(qty|quantity|pieces|pcs|parcels|items|item count|count)$/],
    ['notes', 'Delivery notes', /note|instruction|comment|remark|special/],
    ['email', 'Email', /e-?mail/],
    ['earliest', 'Earliest arrival', /earliest|window ?(start|from)|time ?from|from time|ready ?time|open(ing)? time/],
    ['latest', 'Latest arrival', /latest|window ?(end|to)|time ?to|to time|deadline|clos(e|ing) time/],
    ['timeAtStop', 'Time at stop (min)', /time at stop|service ?time|stop duration|^duration$/],
    ['stopType', 'Stop type', /stop ?type|^type$|delivery ?\/ ?pick ?up|job ?type/],
  ];
  const PKG_SIZES = ['Small', 'Medium', 'Large'];
  const PKG_TYPES = ['Box', 'Bag', 'Letter'];
  const PKG_POSITIONS = ['Front', 'Middle', 'Back'];
  const PKG_SIDES = ['Left', 'Right'];
  const PKG_SURFACES = ['Floor', 'Shelf'];
  const STOP_COLOURS = [['', 'Auto'], ['#2f6fd6', 'Blue'], ['#1f7a52', 'Green'], ['#d97a1e', 'Orange'], ['#c0392b', 'Red'], ['#7b4bc4', 'Purple'], ['#14919b', 'Teal'], ['#c2417f', 'Pink']];
  // Run-sheet times come as "9:00", "09:00", "9am", "0900" or Excel time values.
  function parseClock(v) {
    const t = String(v || '').trim().toLowerCase();
    if (!t) return '';
    const m = t.match(/^(\d{1,2})(?::|\.)?(\d{2})?\s*(am|pm)?$/);
    if (!m) return '';
    let h = Number(m[1]); const min = Number(m[2] || 0);
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    if (!m[2] && !m[3] && t.length === 4) { h = Number(t.slice(0, 2)); }
    if (h > 23 || min > 59) return '';
    return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
  }
  const clockSec = (hhmm) => { if (!hhmm) return null; const [h, m] = String(hhmm).split(':').map(Number); return Number.isFinite(h) ? h * 3600 + (m || 0) * 60 : null; };
  const stopServiceSec = (s) => (s && s.serviceMin != null && s.serviceMin !== '' ? Math.max(0, Number(s.serviceMin)) * 60 : STOP_SERVICE_SEC);
  const fmtWindow = (s) => (s.windowStart || s.windowEnd ? `${s.windowStart ? fmtClock(new Date(2000, 0, 1, ...s.windowStart.split(':').map(Number))) : 'Anytime'}–${s.windowEnd ? fmtClock(new Date(2000, 0, 1, ...s.windowEnd.split(':').map(Number))) : 'Anytime'}` : '');
  const FAIL_REASONS = ['Nobody home', 'Address not found', 'No safe place', 'Access issue', 'Refused', 'Damaged', 'Other'];

  async function loadRoutes() {
    const q = await state.db.collection('routes').get();
    state.routes = q.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    state.routes.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }
  function todaysRoute(driverId) {
    const today = todayStr();
    return (state.routes || []).find((r) => r.driverId === driverId && r.date === today && r.status !== 'archived') || null;
  }
  function routeCounts(route) {
    const stops = (route && route.stops) || [];
    const parcels = (s) => Number(s.parcels) || 1;
    return {
      stops: stops.length,
      done: stops.filter((s) => s.status !== 'pending').length,
      delivered: stops.filter((s) => s.status === 'delivered' && s.stopType !== 'pickup').reduce((n, s) => n + parcels(s), 0),
      pickedUp: stops.filter((s) => s.status === 'delivered' && s.stopType === 'pickup').reduce((n, s) => n + parcels(s), 0),
      failed: stops.filter((s) => s.status === 'failed').reduce((n, s) => n + parcels(s), 0),
      parcels: stops.reduce((n, s) => n + parcels(s), 0),
    };
  }

  // ---- Reading the run sheet ----
  function parseCsv(text) {
    const rows = []; let row = []; let cell = ''; let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',' || ch === '\t' || ch === ';') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  function cellText(v) {
    if (v == null) return '';
    if (typeof v === 'object') {
      if (v.richText) return v.richText.map((t) => t.text).join('');
      if (v.text != null) return String(v.text);
      if (v.result != null) return String(v.result);
    }
    if (v instanceof Date) {
      // Excel stores times-of-day as dates on 30 Dec 1899.
      if (v.getUTCFullYear() < 1901) return String(v.getUTCHours()).padStart(2, '0') + ':' + String(v.getUTCMinutes()).padStart(2, '0');
      return v.toISOString().slice(0, 10);
    }
    return String(v);
  }
  async function readRunSheet(file) {
    const name = file.name || 'run sheet';
    let rows;
    if (/\.csv$|\.txt$/i.test(name)) {
      rows = parseCsv(await file.text());
    } else if (/\.xlsx$/i.test(name)) {
      if (!window.ExcelJS) throw new Error('The Excel reader is still loading. Wait a moment and try again.');
      const wb = new window.ExcelJS.Workbook();
      await wb.xlsx.load(await file.arrayBuffer());
      const ws = wb.worksheets.find((w) => w.actualRowCount > 1) || wb.worksheets[0];
      if (!ws) throw new Error('This Excel file has no sheets.');
      rows = [];
      ws.eachRow({ includeEmpty: false }, (r) => {
        const vals = []; for (let c = 1; c <= r.cellCount; c++) vals.push(cellText(r.getCell(c).value));
        rows.push(vals);
      });
    } else if (/\.xls$/i.test(name)) {
      throw new Error('This is an old .xls file. Open it in Excel and "Save As" .xlsx (or CSV), then upload that.');
    } else {
      throw new Error('Upload an Excel (.xlsx) or CSV file.');
    }
    rows = rows.map((r) => r.map((c) => String(c || '').trim())).filter((r) => r.some(Boolean));
    if (rows.length < 2) throw new Error('No delivery rows found in this file.');
    // Header row: the first row (within the top 10) that looks like column names.
    let headerIdx = 0, best = -1;
    rows.slice(0, 10).forEach((r, i) => {
      const score = r.filter((c) => ROUTE_FIELDS.some(([, , re]) => re.test(c.toLowerCase()))).length;
      if (score > best) { best = score; headerIdx = i; }
    });
    const headers = rows[headerIdx].map((h, i) => h || `Column ${i + 1}`);
    const body = rows.slice(headerIdx + 1).filter((r) => r.some(Boolean));
    const map = {};
    ROUTE_FIELDS.forEach(([key, , re]) => {
      const idx = headers.findIndex((h, i) => re.test(h.toLowerCase()) && !Object.values(map).includes(i));
      map[key] = idx;
    });
    if (map.address < 0) {
      // Fall back to the column that most often looks like a street address.
      let bestCol = -1, bestHits = 0;
      headers.forEach((_, i) => {
        const hits = body.slice(0, 30).filter((r) => /\d+[a-z]?\s+\w+.*\b(st|street|rd|road|ave|avenue|dr|drive|cres|ct|court|pl|place|pde|hwy|way|ln|lane|cl|close|blvd|tce|terrace)\b/i.test(r[i] || '')).length;
        if (hits > bestHits) { bestHits = hits; bestCol = i; }
      });
      map.address = bestCol;
    }
    return { fileName: name, headers, rows: body, map };
  }
  function draftStops(draft) {
    const m = draft.map; const get = (r, k) => (m[k] >= 0 ? String(r[m[k]] || '').trim() : '');
    const byAddr = new Map();
    draft.rows.forEach((r) => {
      const street = get(r, 'address');
      if (!street) return;
      const parts = [street];
      ['suburb', 'state', 'postcode'].forEach((k) => { const v = get(r, k); if (v && !street.toLowerCase().includes(v.toLowerCase())) parts.push(v); });
      const full = parts.join(', ');
      const key = full.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const qty = Math.max(1, parseInt(get(r, 'parcels'), 10) || 1);
      const existing = byAddr.get(key);
      if (existing) {
        existing.parcels += qty;
        const ref = get(r, 'ref'); if (ref && !existing.refs.includes(ref)) existing.refs.push(ref);
        const note = get(r, 'notes'); if (note && !existing.notes.includes(note)) existing.notes = existing.notes ? existing.notes + ' · ' + note : note;
        const nm = get(r, 'name'); if (nm && !existing.name.toLowerCase().includes(nm.toLowerCase())) existing.name = existing.name ? existing.name + ', ' + nm : nm;
      } else {
        const svc = parseInt(get(r, 'timeAtStop'), 10);
        byAddr.set(key, { address: full, name: get(r, 'name'), phone: get(r, 'phone'), email: get(r, 'email'), refs: get(r, 'ref') ? [get(r, 'ref')] : [], parcels: qty, notes: get(r, 'notes'),
          windowStart: parseClock(get(r, 'earliest')), windowEnd: parseClock(get(r, 'latest')), serviceMin: Number.isFinite(svc) ? svc : null,
          stopType: /pick/i.test(get(r, 'stopType')) ? 'pickup' : 'delivery', placement: 'auto',
          parts: { street, suburb: get(r, 'suburb'), state: get(r, 'state'), postcode: get(r, 'postcode') } });
      }
    });
    return [...byAddr.values()];
  }

  // ---- Ordering the stops ----
  // Costs come from real driving times (free OSRM routing service, called
  // from the phone) when available, otherwise from straight-line distance.
  // The solver builds several starting orders (nearest-neighbour, then
  // randomised variants) and improves each with 2-opt (reverse a stretch) and
  // Or-opt (move a run of 1–3 stops elsewhere), keeping the best.
  const OSRM_URL = 'https://router.project-osrm.org';
  const OSRM_MAX_POINTS = 100;          // public server limit per request
  const STOP_SERVICE_SEC = 120;         // time at each door, used for arrival times
  function kmBetween(a, b) {
    const R = 6371, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const straightMetres = (a, b) => kmBetween(a, b) * 1300;       // ×1.3 ≈ road distance
  const straightSeconds = (a, b) => (straightMetres(a, b) / 1000 / 35) * 3600; // ≈35 km/h suburban
  async function fetchJsonWithTimeout(url, ms) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), ms) : null;
    try {
      const res = await fetch(url, ctl ? { signal: ctl.signal } : {});
      if (!res.ok) return null;
      return await res.json();
    } catch (e) { return null; } finally { if (timer) clearTimeout(timer); }
  }
  const osrmCoords = (pts) => pts.map((p) => `${Number(p.lng).toFixed(6)},${Number(p.lat).toFixed(6)}`).join(';');
  async function costMatrix(points) {
    if (points.length >= 2 && points.length <= OSRM_MAX_POINTS) {
      const j = await fetchJsonWithTimeout(`${OSRM_URL}/table/v1/driving/${osrmCoords(points)}?annotations=duration,distance`, 20000);
      const sized = (m) => Array.isArray(m) && m.length === points.length && m.every((row) => Array.isArray(row) && row.length === points.length);
      if (j && j.code === 'Ok' && sized(j.durations)) {
        const dur = j.durations.map((row, i) => row.map((v, k) => (v == null ? straightSeconds(points[i], points[k]) : v)));
        const dist = sized(j.distances)
          ? j.distances.map((row, i) => row.map((v, k) => (v == null ? straightMetres(points[i], points[k]) : v)))
          : points.map((a) => points.map((b) => straightMetres(a, b)));
        return { dur, dist, source: 'roads' };
      }
    }
    return { dur: points.map((a) => points.map((b) => straightSeconds(a, b))), dist: points.map((a) => points.map((b) => straightMetres(a, b))), source: 'straight' };
  }
  function seededRandom(seed) {
    return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function tourCost(C, tour, ret) {
    let c = 0;
    for (let i = 1; i < tour.length; i++) c += C[tour[i - 1]][tour[i]];
    if (ret && tour.length > 1) c += C[tour[tour.length - 1]][tour[0]];
    return c;
  }
  // tour = [0, stop nodes…]; node 0 (the start) never moves.
  function improveTour(C, tour, ret) {
    const n = tour.length;
    const S = (a, b) => (a < 0 || b < 0 ? 0 : (C[a][b] + C[b][a]) / 2);
    const after = (i) => (i < n ? tour[i] : ret ? tour[0] : -1);
    let improved = true, guard = 0;
    while (improved && guard++ < 100) {
      improved = false;
      for (let i = 1; i < n - 1; i++) {
        for (let k = i + 1; k < n; k++) {
          const a = tour[i - 1], b = tour[i], c = tour[k], e = after(k + 1);
          if (S(a, c) + S(b, e) - S(a, b) - S(c, e) < -1e-6) {
            for (let x = i, y = k; x < y; x++, y--) { const t = tour[x]; tour[x] = tour[y]; tour[y] = t; }
            improved = true;
          }
        }
      }
      for (let L = 1; L <= 3; L++) {
        for (let i = 1; i + L - 1 < n; i++) {
          const segEnd = i + L - 1;
          const p = tour[i - 1], f = tour[i], l = tour[segEnd], q = after(segEnd + 1);
          const gain = S(p, f) + S(l, q) - S(p, q);
          let best = null;
          for (let j = 0; j < n; j++) {
            if (j >= i - 1 && j <= segEnd) continue;
            const x = tour[j], y = after(j + 1);
            const fwd = S(x, f) + S(l, y) - S(x, y), rev = S(x, l) + S(f, y) - S(x, y);
            const delta = Math.min(fwd, rev) - gain;
            if (delta < -1e-6 && (!best || delta < best.delta)) best = { j, delta, rev: rev < fwd };
          }
          if (best) {
            const seg = tour.splice(i, L);
            if (best.rev) seg.reverse();
            const at = best.j > segEnd ? best.j - L : best.j;
            tour.splice(at + 1, 0, ...seg);
            improved = true;
          }
        }
      }
    }
    return tour;
  }
  // Returns the visiting order as indices into the n stops (matrix nodes 1..n).
  function solveOrder(C, n, ret) {
    if (n <= 1) return n ? [0] : [];
    const rand = seededRandom(n * 7919 + 17);
    const attempts = n > 150 ? 3 : n > 60 ? 6 : 10;
    let best = null;
    for (let r = 0; r < attempts; r++) {
      const used = new Array(n + 1).fill(false); used[0] = true;
      const tour = [0];
      for (let k = 0; k < n; k++) {
        const last = tour[tour.length - 1];
        const cand = [];
        for (let j = 1; j <= n; j++) if (!used[j]) cand.push(j);
        cand.sort((a, b) => C[last][a] - C[last][b]);
        const pick = r === 0 ? cand[0] : cand[Math.floor(rand() * Math.min(3, cand.length))];
        tour.push(pick); used[pick] = true;
      }
      improveTour(C, tour, ret);
      const cost = tourCost(C, tour, ret);
      if (!best || cost < best.cost) best = { tour: tour.slice(), cost };
    }
    return best.tour.slice(1).map((v) => v - 1);
  }
  // Orders stops honouring "First / Auto / Last" and arrival time windows.
  // First stops are solved from the start, Auto stops from where the First
  // stops finish, Last stops after that. Stops with a time window are then
  // nudged earlier/later if that reduces lateness and waiting.
  const PLACEMENT_RANK = { first: 0, auto: 1, last: 2 };
  function solveSubset(C, anchor, idxs, ret) {
    if (!idxs.length) return [];
    const nodes = [anchor].concat(idxs);
    const sub = nodes.map((x) => nodes.map((y) => C[x][y]));
    return solveOrder(sub, idxs.length, ret).map((k) => idxs[k]);
  }
  function scheduleCost(C, seq, stops, startSec, anchor) {
    let t = startSec, prev = anchor, cost = 0;
    for (const node of seq) {
      const s = stops[node - 1];
      t += C[prev][node];
      const ws = clockSec(s.windowStart), we = clockSec(s.windowEnd);
      if (ws != null && t < ws) { cost += ws - t; t = ws; }
      if (we != null && t > we) cost += (t - we) * 25;
      t += stopServiceSec(s); prev = node;
    }
    return cost + (t - startSec);
  }
  function refineForWindows(C, seq, stops, anchor) {
    const now = new Date(); const startSec = now.getHours() * 3600 + now.getMinutes() * 60;
    const rank = (node) => PLACEMENT_RANK[stops[node - 1].placement] ?? 1;
    const ordered = (cand) => cand.every((n, i) => i === 0 || rank(cand[i - 1]) <= rank(n));
    let best = scheduleCost(C, seq, stops, startSec, anchor), improved = true, guard = 0;
    while (improved && guard++ < 25) {
      improved = false;
      for (let i = 0; i < seq.length && !improved; i++) {
        const node = seq[i]; const st = stops[node - 1];
        if (!st.windowStart && !st.windowEnd) continue;
        for (let j = 0; j < seq.length; j++) {
          if (j === i) continue;
          const cand = seq.slice(); cand.splice(i, 1); cand.splice(j, 0, node);
          if (!ordered(cand)) continue;
          const c = scheduleCost(C, cand, stops, startSec, anchor);
          if (c < best - 1) { best = c; seq = cand; improved = true; break; }
        }
      }
    }
    return seq;
  }
  async function planStopOrder(start, stops, ret) {
    const M = await costMatrix([start].concat(stops));
    const groups = { first: [], auto: [], last: [] };
    stops.forEach((s, i) => groups[PLACEMENT_RANK[s.placement] === 0 ? 'first' : PLACEMENT_RANK[s.placement] === 2 ? 'last' : 'auto'].push(i + 1));
    const used = ['first', 'auto', 'last'].filter((g) => groups[g].length);
    let anchor = 0, seq = [];
    used.forEach((g) => {
      const part = solveSubset(M.dur, anchor, groups[g], ret && used.length === 1);
      seq = seq.concat(part); if (part.length) anchor = part[part.length - 1];
    });
    if (stops.some((s) => s.windowStart || s.windowEnd)) seq = refineForWindows(M.dur, seq, stops, 0);
    return { order: seq.map((v) => v - 1), source: M.source };
  }
  // Real road line + leg times for an ordered list of points (OSRM /route).
  async function roadRoute(points) {
    if (points.length < 2) return null;
    const legs = [], geometry = [];
    for (let i = 0; i < points.length - 1; i += OSRM_MAX_POINTS - 1) {
      const chunk = points.slice(i, i + OSRM_MAX_POINTS);
      if (chunk.length < 2) break;
      const j = await fetchJsonWithTimeout(`${OSRM_URL}/route/v1/driving/${osrmCoords(chunk)}?overview=simplified&geometries=polyline&steps=false`, 20000);
      if (!j || j.code !== 'Ok' || !j.routes || !j.routes[0] || !Array.isArray(j.routes[0].legs) || j.routes[0].legs.length !== chunk.length - 1) return null;
      j.routes[0].legs.forEach((l) => legs.push({ sec: l.duration, m: l.distance }));
      geometry.push(j.routes[0].geometry);
    }
    return { legs, geometry };
  }
  function decodePolyline(str) {
    const out = []; let i = 0, lat = 0, lng = 0;
    while (i < str.length) {
      let b, shift = 0, result = 0;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += result & 1 ? ~(result >> 1) : result >> 1;
      shift = 0; result = 0;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += result & 1 ? ~(result >> 1) : result >> 1;
      out.push([lat / 1e5, lng / 1e5]);
    }
    return out;
  }
  // Recomputes leg times, distance, drive time and the road line for the
  // stops still to do, starting from `anchor` (start point, last finished
  // stop or the driver's current location). Finished stops keep their legs.
  async function routeMetrics(route, anchor) {
    const stops = route.stops.map((s) => Object.assign({}, s));
    const pendingIdx = stops.map((s, i) => (s.status === 'pending' ? i : -1)).filter((i) => i >= 0);
    const pts = [anchor].concat(pendingIdx.map((i) => stops[i]));
    if (route.returnToStart && route.start && pendingIdx.length) pts.push(route.start);
    const road = anchor ? await roadRoute(pts) : null;
    pendingIdx.forEach((si, k) => {
      const leg = road ? road.legs[k] : null;
      const prev = pts[k];
      stops[si].legSec = Math.round(leg ? leg.sec : prev ? straightSeconds(prev, stops[si]) : 0);
      stops[si].legM = Math.round(leg ? leg.m : prev ? straightMetres(prev, stops[si]) : 0);
    });
    const backLeg = route.returnToStart && pendingIdx.length
      ? (road ? road.legs[pendingIdx.length] : { sec: straightSeconds(pts[pts.length - 2], route.start), m: straightMetres(pts[pts.length - 2], route.start) })
      : null;
    const totalM = stops.reduce((m, s) => m + (Number(s.legM) || 0), 0) + (backLeg ? backLeg.m : 0);
    const totalSec = stops.reduce((t, s) => t + (Number(s.legSec) || 0), 0) + (backLeg ? backLeg.sec : 0);
    return {
      stops, returnLegSec: backLeg ? Math.round(backLeg.sec) : 0,
      distanceKm: Math.round(totalM / 100) / 10, driveMin: Math.round(totalSec / 60),
      geometry: road ? road.geometry : [], metricsSource: road ? 'roads' : 'straight',
    };
  }
  function fmtDuration(min) {
    min = Math.max(0, Math.round(min));
    if (min < 60) return min + ' min';
    return Math.floor(min / 60) + ' h' + (min % 60 ? ' ' + (min % 60) + ' min' : '');
  }
  // Arrival time for each pending stop, counted from now.
  function routeEtas(route) {
    const etas = {}, late = {}; let t = Date.now();
    // Routes planned before arrival times existed have no leg times.
    if (!(route.stops || []).some((s) => s.status === 'pending' && s.legSec != null)) return { etas, late, finish: new Date(t), any: false };
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    (route.stops || []).forEach((s) => {
      if (s.status !== 'pending') return;
      t += (Number(s.legSec) || 0) * 1000;
      const ws = clockSec(s.windowStart), we = clockSec(s.windowEnd);
      if (ws != null && t < midnight.getTime() + ws * 1000) t = midnight.getTime() + ws * 1000;
      etas[s.id] = new Date(t);
      if (we != null && t > midnight.getTime() + we * 1000) late[s.id] = true;
      t += stopServiceSec(s) * 1000;
    });
    const finish = new Date(t + (route.returnToStart ? (Number(route.returnLegSec) || 0) * 1000 : 0));
    return { etas, late, finish, any: Object.keys(etas).length > 0 };
  }
  const fmtClock = (d) => d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
  function routeAnchor(route) {
    const done = (route.stops || []).filter((s) => s.status !== 'pending' && s.doneAt);
    if (!done.length) return route.start;
    return done.reduce((a, b) => (String(b.doneAt) > String(a.doneAt) ? b : a));
  }

  // Free address lookup on OpenStreetMap (Nominatim), done from the phone at
  // most once per second as their usage policy asks. Answers are sent back to
  // the Worker and saved, so each address is only ever looked up once.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let lastOsmCall = 0;
  async function osmSearch(params) {
    const wait = lastOsmCall + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastOsmCall = Date.now();
    const qs = new URLSearchParams(Object.assign({ format: 'jsonv2', countrycodes: 'au', limit: '1', addressdetails: '0', 'accept-language': 'en' }, params));
    const res = await fetch('https://nominatim.openstreetmap.org/search?' + qs.toString(), { headers: { Accept: 'application/json' } });
    if (res.status === 429) throw new Error('The free address service is busy. Wait a minute and try again.');
    if (!res.ok) throw new Error('The free address service did not respond. Try again shortly.');
    const list = await res.json();
    return Array.isArray(list) && list.length ? list[0] : null;
  }
  // Run sheets write units many ways ("Unit 428, 50A Jacqui Ave",
  // "206/20C Hasluck St", "4B Hasluck St, Unit 706"). Map search finds the
  // building, so the unit is taken out for the lookup (the driver still sees
  // the full original address).
  const UNIT_WORDS = 'unit|u|apt|apartment|flat|suite|ste|shop|villa|townhouse|th|level|lvl|lot';
  function splitUnit(text) {
    let unit = '';
    let s = ' ' + String(text || '').replace(/\s+/g, ' ') + ' ';
    s = s.replace(new RegExp(`[\\s,](?:${UNIT_WORDS})\\.?\\s*#?\\s*([a-z]?\\d+[a-z]?)\\s*(?:[,/]|(?=\\s))`, 'ig'), (m, n) => { if (!unit) unit = n; return ', '; });
    s = s.trim().replace(/^,\s*/, '').replace(/^([a-z]?\d+[a-z]?)\s*\/\s*(?=\d)/i, (m, n) => { if (!unit) unit = n; return ''; });
    s = s.replace(/\s*,\s*/g, ', ').replace(/(,\s*)+/g, ', ').replace(/^[,\s]+|[,\s]+$/g, '').replace(/\s+/g, ' ');
    return { rest: s, unit };
  }
  function splitHouse(street) {
    const m = String(street || '').match(/^(\d+)([a-z])?(?:\s*-\s*\d+[a-z]?)?\s+(.+)$/i);
    return m ? { num: m[1], letter: m[2] || '', name: m[3] } : { num: '', letter: '', name: String(street || '') };
  }
  function osmResult(hit, address, forceApprox) {
    const type = String(hit.addresstype || hit.type || '');
    const exact = !forceApprox && (['house', 'building', 'residential', 'apartments', 'commercial', 'retail', 'industrial', 'office', 'shop', 'amenity'].includes(type) || /^\d/.test(String(hit.name || '')));
    return { lat: Number(hit.lat), lng: Number(hit.lon), formatted: String(hit.display_name || address).replace(/, Australia$/, ''), precision: type, partial: !exact };
  }
  let lastPhotonCall = 0;
  async function photonSearch(q, area) {
    const wait = lastPhotonCall + 350 - Date.now();
    if (wait > 0) await sleep(wait);
    lastPhotonCall = Date.now();
    try {
      const res = await fetch('https://photon.komoot.io/api/?' + new URLSearchParams({ q, limit: '5', lang: 'en', bbox: '112.9,-43.7,153.7,-10.6' }).toString());
      if (!res.ok) return [];
      const data = await res.json();
      const sub = String(area.suburb || '').toLowerCase(), pc = String(area.postcode || '');
      return (data.features || []).filter((f) => {
        const p = f.properties || {};
        if (p.countrycode && p.countrycode !== 'AU') return false;
        if (!sub && !pc) return true;
        const places = [p.locality, p.district, p.city, p.name, p.county].filter(Boolean).map((x) => String(x).toLowerCase());
        return (pc && String(p.postcode || '') === pc) || (sub && places.some((x) => x === sub || x.includes(sub)));
      });
    } catch (e) { return []; }
  }
  // Tries, in order: the address as given (unit removed), without a letter on
  // the house number (50A → 50), a second free search (Photon), and finally
  // the street itself — returned as an approximate pin rather than "not found".
  async function osmLookup(address, parts) {
    const fromParts = parts && parts.street;
    const { rest, unit } = splitUnit(fromParts ? parts.street : address);
    const area = fromParts ? { suburb: parts.suburb || '', state: parts.state || '', postcode: parts.postcode || '' } : {};
    if (!area.suburb && !area.postcode) {
      // Whole address in one box: pull a trailing "SUBURB NSW 2762" off for checks.
      const m = rest.match(/,\s*([A-Za-z][A-Za-z\s'-]+?)\s+(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b\.?\s*(\d{4})?\s*$/i);
      if (m) Object.assign(area, { suburb: m[1].trim(), state: m[2].toUpperCase(), postcode: m[3] || '' });
    }
    // oneBox: suburb/postcode came from the address text itself, not separate columns.
    const oneBox = !(fromParts && (parts.suburb || parts.postcode));
    const streetPart = oneBox && area.suburb ? rest.split(',')[0].trim() : rest;
    const tail = [area.suburb, area.state, area.postcode].filter(Boolean).join(' ');
    const h = splitHouse(streetPart);
    const structured = (street) => {
      const p = { street };
      if (area.suburb) p.city = area.suburb;
      if (area.state) p.state = area.state;
      if (area.postcode) p.postalcode = area.postcode;
      return p;
    };
    const canStructure = !!(area.suburb || area.postcode);
    const freeText = (street) => (oneBox ? rest.replace(streetPart, street) : tail ? `${street}, ${tail}` : street);
    const attempts = [];
    if (canStructure) attempts.push(() => osmSearch(structured(streetPart)));
    attempts.push(() => osmSearch({ q: freeText(streetPart) }));
    if (h.letter) {
      const plain = `${h.num} ${h.name}`;
      attempts.push(() => (canStructure ? osmSearch(structured(plain)) : osmSearch({ q: freeText(plain) })));
    }
    let hit = null;
    for (const attempt of attempts) { hit = await attempt(); if (hit) { const r = osmResult(hit, address); if (!r.partial) return r; break; } }
    let approx = hit ? osmResult(hit, address, true) : null;
    // Second free service — better at fuzzy matches and some new estates.
    const photon = await photonSearch(freeText(streetPart), area);
    const wanted = h.num ? h.num.toLowerCase() : '';
    const exactP = photon.find((f) => wanted && String(f.properties.housenumber || '').toLowerCase().replace(/[^0-9a-z]/g, '').replace(/[a-z]$/, '') === wanted);
    if (exactP) {
      const [lng, lat] = exactP.geometry.coordinates;
      return { lat, lng, formatted: addrLabel(exactP.properties), precision: 'house', partial: false };
    }
    if (!approx && photon.length) {
      const [lng, lat] = photon[0].geometry.coordinates;
      approx = { lat, lng, formatted: addrLabel(photon[0].properties), precision: photon[0].properties.osm_value || 'street', partial: true };
    }
    if (!approx && h.name && h.num) {
      // Street only (new estates often have the street mapped but not the houses).
      const st = canStructure ? await osmSearch(structured(h.name)) : await osmSearch({ q: freeText(h.name) });
      if (st) approx = osmResult(st, address, true);
    }
    if (approx) return Object.assign(approx, { unit });
    return { error: 'Address not found' };
  }
  async function geocodeForRoute(addresses, onProgress, partsList) {
    const out = [];
    for (let i = 0; i < addresses.length; i += 50) {
      const chunk = addresses.slice(i, i + 50);
      const res = await fetch('/api/route/geocode', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ addresses: chunk }) });
      let body = {}; try { body = await res.json(); } catch (e) {}
      if (!res.ok) throw new Error(body.error || 'Address lookup failed.');
      out.push(...body.results);
    }
    const misses = out.map((r, i) => (r && r.lookupInBrowser ? i : -1)).filter((i) => i >= 0);
    const saved = [];
    let done = addresses.length - misses.length;
    if (onProgress) onProgress(done, addresses.length, misses.length);
    for (let m = 0; m < misses.length; m++) {
      const i = misses[m];
      const savedAccess = out[i] && out[i].access;
      try { out[i] = await osmLookup(addresses[i], partsList ? partsList[i] : null); if (savedAccess) out[i].access = savedAccess; }
      catch (e) {
        // Stop asking a busy service; leave the rest for the driver to retry.
        for (let k = m; k < misses.length; k++) out[misses[k]] = { error: e.message };
        break;
      }
      if (!out[i].error) saved.push(Object.assign({ address: addresses[i] }, out[i]));
      done++;
      if (onProgress) onProgress(done, addresses.length, misses.length - m - 1);
    }
    if (saved.length) {
      fetch('/api/route/geocache', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: saved }) }).catch(() => {});
    }
    return out;
  }

  // ---- Map ----
  async function loadLeaflet() {
    if (!document.querySelector('link[data-leaflet]')) {
      const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'vendor/leaflet.css'; l.dataset.leaflet = '1'; document.head.appendChild(l);
    }
    await loadScriptOnce('vendor/leaflet.js');
    return window.L;
  }
  let routeMap = null;
  async function initRouteMap() {
    const el = document.getElementById('routeMap');
    if (routeMap) { try { routeMap.remove(); } catch (e) {} routeMap = null; }
    if (!el) return;
    const route = (state.routes || []).find((r) => r.id === el.dataset.routeId);
    if (!route) return;
    let L; try { L = await loadLeaflet(); } catch (e) { el.innerHTML = '<p class="helptext" style="padding:16px;">Map could not load. The stop list below still works.</p>'; return; }
    if (!document.body.contains(el)) return;
    routeMap = L.map(el, { zoomControl: true, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(routeMap);
    const pts = [];
    if (route.start && Number.isFinite(route.start.lat)) {
      L.marker([route.start.lat, route.start.lng], { icon: L.divIcon({ className: 'route-pin route-pin-start', html: 'S', iconSize: [26, 26] }) }).addTo(routeMap).bindPopup('Start: ' + esc(route.start.label || ''));
      pts.push([route.start.lat, route.start.lng]);
    }
    const next = (route.stops || []).find((s) => s.status === 'pending');
    (route.stops || []).forEach((s, i) => {
      const cls = s.status === 'delivered' ? 'is-done' : s.status === 'failed' ? 'is-failed' : (next && s.id === next.id ? 'is-next' : '');
      const colour = s.status === 'pending' && !(next && s.id === next.id) ? stopColour(s) : '';
      L.marker([s.lat, s.lng], { icon: L.divIcon({ className: 'route-pin ' + cls, html: `<span${colour ? ` style="background:${colour};border-color:${colour};color:#fff;"` : ''}>${i + 1}</span>`, iconSize: [26, 26] }) })
        .addTo(routeMap).bindPopup(`<strong>${i + 1}. ${esc(s.address)}</strong>${s.name ? '<br>' + esc(s.name) : ''}`);
      pts.push([s.lat, s.lng]);
    });
    if (route.returnToStart && route.start && Number.isFinite(route.start.lat)) pts.push([route.start.lat, route.start.lng]);
    const road = Array.isArray(route.geometry) ? route.geometry.filter(Boolean) : [];
    if (road.length) road.forEach((g) => { try { L.polyline(decodePolyline(g), { color: '#131c2e', weight: 4, opacity: 0.7 }).addTo(routeMap); } catch (e) {} });
    else if (pts.length > 1) L.polyline(pts, { color: '#131c2e', weight: 3, opacity: 0.45, dashArray: '6 6' }).addTo(routeMap);
    if (pts.length) routeMap.fitBounds(pts, { padding: [24, 24], maxZoom: 15 });
    else routeMap.setView([-33.87, 151.21], 10);
  }
  function navLinks(s) {
    const g = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=driving`;
    const a = `https://maps.apple.com/?daddr=${s.lat},${s.lng}&dirflg=d`;
    return `<a class="btn btn-sm" href="${g}" target="_blank" rel="noopener">Google Maps</a><a class="btn btn-sm" href="${a}" target="_blank" rel="noopener">Apple Maps</a>`;
  }

  // ---- Views ----
  // Spoke-style colours: pickups purple, multi-package stops teal, or the
  // colour the driver picked.
  function stopColour(s) {
    if (s.colour) return s.colour;
    if (s.stopType === 'pickup') return '#7b4bc4';
    if ((Number(s.parcels) || 1) > 1) return '#14919b';
    return '';
  }
  function pkgSummary(s) {
    const p = s.pkg || {};
    const where = [p.position, p.side, p.surface].filter(Boolean).join(' · ');
    const what = [p.size, p.type].filter(Boolean).join(' ');
    return [where, what].filter(Boolean).join(' — ');
  }
  function stopChips(s, etas) {
    const chips = [];
    if (s.stopType === 'pickup') chips.push('<span class="stop-chip chip-pickup">Pickup</span>');
    if (s.placement === 'first') chips.push('<span class="stop-chip">First</span>');
    if (s.placement === 'last') chips.push('<span class="stop-chip">Last</span>');
    if ((Number(s.parcels) || 1) > 1) chips.push(`<span class="stop-chip chip-multi">${s.parcels} packages</span>`);
    if (s.windowStart || s.windowEnd) chips.push(`<span class="stop-chip ${etas && etas.late && etas.late[s.id] ? 'chip-late' : ''}">${esc(fmtWindow(s))}${etas && etas.late && etas.late[s.id] ? ' · may be late' : ''}</span>`);
    if (pkgSummary(s)) chips.push(`<span class="stop-chip chip-pkg">${esc(pkgSummary(s))}</span>`);
    if (s.photoId) chips.push('<span class="stop-chip">Photo</span>');
    return chips.length ? `<div class="stop-chips">${chips.join('')}</div>` : '';
  }
  function routeStopRow(route, s, i, editable, etas) {
    const status = s.status === 'delivered' ? `<span class="pill pill-paid">${s.stopType === 'pickup' ? 'Picked up' : 'Delivered'}</span>`
      : s.status === 'failed' ? `<span class="pill pill-cancelled">Failed</span>${s.reason ? `<div class="helptext">${esc(s.reason)}</div>` : ''}` : '';
    const reorder = editable && routeUi.reorder && s.status === 'pending'
      ? `<div class="route-move"><button class="btn btn-sm" data-action="route-stop-move" data-route="${route.id}" data-stop="${s.id}" data-dir="-1" aria-label="Move up">↑</button><button class="btn btn-sm" data-action="route-stop-move" data-route="${route.id}" data-stop="${s.id}" data-dir="1" aria-label="Move down">↓</button></div>` : '';
    const actions = !editable ? '' : s.status === 'pending'
      ? `<div class="route-stop-actions">${navLinks(s)}<button class="btn btn-sm btn-primary" data-action="route-stop-done" data-route="${route.id}" data-stop="${s.id}">${s.stopType === 'pickup' ? 'Picked up' : 'Delivered'}</button><button class="btn btn-sm" data-action="route-stop-fail" data-route="${route.id}" data-stop="${s.id}">Failed</button><button class="btn btn-sm" data-action="route-stop-edit" data-route="${route.id}" data-stop="${s.id}">Edit</button><button class="btn btn-sm" data-action="route-stop-next" data-route="${route.id}" data-stop="${s.id}" title="Make this my next stop">Do next</button></div>`
      : `<div class="route-stop-actions"><button class="btn btn-sm" data-action="route-stop-undo" data-route="${route.id}" data-stop="${s.id}">Undo</button><button class="btn btn-sm" data-action="route-stop-edit" data-route="${route.id}" data-stop="${s.id}">Edit</button></div>`;
    const colour = s.status === 'pending' ? stopColour(s) : '';
    return `<li class="route-stop ${s.status !== 'pending' ? 'is-' + s.status : ''}">
      <span class="route-num"${colour ? ` style="background:${colour};color:#fff;"` : ''}>${i + 1}</span>
      <div class="route-stop-body">
        <div class="route-stop-addr">${esc(s.address)}</div>
        ${s.partial ? `<div class="helptext route-approx">Approximate pin (street only) — check the house number</div>` : ''}
        <div class="helptext">${[s.name ? esc(s.name) : '', s.refs && s.refs.length ? esc(s.refs.slice(0, 3).join(', ')) + (s.refs.length > 3 ? '…' : '') : ''].filter(Boolean).join(' · ')}</div>
        ${stopChips(s, etas)}
        ${s.access ? `<div class="helptext route-access">Access: ${esc(s.access)}</div>` : ''}
        ${s.notes ? `<div class="helptext">Note: ${esc(s.notes)}</div>` : ''}
        ${s.status === 'pending' && etas && etas.etas[s.id] ? `<div class="route-eta">Arrive ≈ ${fmtClock(etas.etas[s.id])}${s.legSec ? ` · ${fmtDuration(s.legSec / 60)} drive` : ''}</div>` : ''}
        ${status}${actions}
      </div>
      ${reorder}
    </li>`;
  }
  function routeDetail(route, editable) {
    const c = routeCounts(route);
    const pct = c.stops ? Math.round((c.done / c.stops) * 100) : 0;
    const next = (route.stops || []).find((s) => s.status === 'pending');
    const nextIdx = next ? route.stops.indexOf(next) : -1;
    const unmatched = route.unmatched || [];
    const etas = routeEtas(route);
    return `
      <div class="card route-summary">
        <div class="route-summary-figures">
          <div><span class="kpi-label">Stops</span><strong>${c.done}/${c.stops}</strong></div>
          <div><span class="kpi-label">Delivered</span><strong>${c.delivered}${c.pickedUp ? `<small class="helptext"> +${c.pickedUp} picked up</small>` : ''}</strong></div>
          <div><span class="kpi-label">Failed</span><strong>${c.failed}</strong></div>
          <div><span class="kpi-label">Driving</span><strong>${route.driveMin != null ? '≈ ' + fmtDuration(route.driveMin) : '—'}</strong></div>
        </div>
        <div class="route-progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
        <p class="helptext route-meta">≈ ${route.distanceKm || 0} km${etas.any ? ` · finish around ${fmtClock(etas.finish)}` : ''} · ${route.orderedBy === 'roads' ? 'ordered by real driving times' : 'ordered by straight-line distance (road data was unavailable)'}</p>
      </div>
      ${editable && next ? `
        <div class="card route-next">
          <p class="eyebrow" style="margin:0 0 6px;">Next stop · ${nextIdx + 1} of ${c.stops}${etas.etas[next.id] ? ' · arrive ≈ ' + fmtClock(etas.etas[next.id]) : ''}</p>
          <h2 style="margin:0 0 4px;font-size:1.25rem;">${esc(next.address)}</h2>
          ${next.partial ? '<p class="helptext route-approx" style="margin:0 0 4px;">Map pin is approximate (street only) — check the house number when you arrive.</p>' : ''}
          <p class="helptext" style="margin:0 0 4px;">${[next.name ? esc(next.name) : '', (next.parcels > 1 ? next.parcels + ' packages' : '1 package') + (next.stopType === 'pickup' ? ' to pick up' : ''), next.refs && next.refs.length ? esc(next.refs.join(', ')) : ''].filter(Boolean).join(' · ')}</p>
          ${stopChips(next, etas)}
          ${next.access ? `<p class="route-access-big"><strong>Access:</strong> ${esc(next.access)}</p>` : ''}
          ${next.notes ? `<p class="helptext" style="margin:0 0 8px;">Note: ${esc(next.notes)}</p>` : ''}
          ${next.photoId ? `<button class="btn btn-sm" data-action="route-photo-view" data-photo="${esc(next.photoId)}" style="margin:0 0 6px;">See package photo</button>` : ''}
          ${next.phone || next.email ? `<p style="margin:0 0 4px;display:flex;gap:14px;flex-wrap:wrap;">${next.phone ? `<a href="tel:${esc(next.phone.replace(/[^\d+]/g, ''))}">Call ${esc(next.phone)}</a><a href="sms:${esc(next.phone.replace(/[^\d+]/g, ''))}">Text</a>` : ''}${next.email ? `<a href="mailto:${esc(next.email)}">Email</a>` : ''}</p>` : ''}
          <div class="route-next-actions">
            ${navLinks(next)}
          </div>
          <div class="route-next-actions">
            <button class="btn btn-primary" data-action="route-stop-done" data-route="${route.id}" data-stop="${next.id}">${next.stopType === 'pickup' ? 'Picked up' : 'Delivered'}</button>
            <button class="btn" data-action="route-stop-fail" data-route="${route.id}" data-stop="${next.id}">Failed</button>
            <button class="btn" data-action="route-stop-edit" data-route="${route.id}" data-stop="${next.id}">Edit stop</button>
          </div>
        </div>` : editable && c.stops ? `<div class="card route-next"><h2 style="margin:0 0 6px;">All stops done</h2><p class="helptext" style="margin:0 0 12px;">${c.delivered} delivered, ${c.failed} failed. These numbers are filled in for you on Today's Deliveries.</p><button class="btn btn-primary" data-action="nav" data-route="driver-submit">Go to Today's Deliveries</button></div>` : ''}
      <div class="card route-map-card"><div id="routeMap" class="route-map" data-route-id="${route.id}"></div></div>
      ${unmatched.length ? `
        <div class="card" style="margin-bottom:16px;">
          <h3 style="margin:0 0 4px;">Couldn't find ${unmatched.length} address${unmatched.length > 1 ? 'es' : ''}</h3>
          <p class="helptext" style="margin:0 0 12px;">Fix the address and tap Find, or remove it from today's route. Tip: start typing and pick from the suggestions.</p>
          ${editable ? `<button class="btn btn-sm btn-primary" style="margin-bottom:10px;" data-action="route-unmatched-retry" data-route="${route.id}">Try all again</button>` : ''}
          ${unmatched.map((u, i) => `
            <form class="route-fix" data-onsubmit="route-fix-address" data-route="${route.id}" data-index="${i}">
              <div class="field" style="flex:1;"><label class="field-label">${esc(u.name || 'Stop')}${u.refs && u.refs.length ? ' · ' + esc(u.refs[0]) : ''} — ${esc(u.error || 'Not found')}</label><input type="text" name="address" value="${esc(u.address)}" ${editable ? '' : 'disabled'}></div>
              ${editable ? `<button class="btn btn-sm btn-primary" type="submit">Find</button><button class="btn btn-sm" type="button" data-action="route-unmatched-remove" data-route="${route.id}" data-index="${i}">Remove</button>` : ''}
            </form>`).join('')}
        </div>` : ''}
      <div class="card">
        <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;"><h3 style="margin:0;">All stops</h3>${route.fileName ? `<span class="helptext">From ${esc(route.fileName)}</span>` : ''}</div>
        ${editable ? `<div class="route-tools">
          <button class="btn btn-sm btn-primary" data-action="route-stop-add" data-route="${route.id}">+ Add stop</button>
          <button class="btn btn-sm" data-action="route-reorder-toggle" aria-pressed="${routeUi.reorder ? 'true' : 'false'}">${routeUi.reorder ? 'Done ordering' : 'Manually order'}</button>
          <button class="btn btn-sm" data-action="route-reverse" data-route="${route.id}">Reverse route</button>
          <button class="btn btn-sm" data-action="route-replan" data-route="${route.id}">Re-optimise</button>
        </div>` : ''}
        <ol class="route-stops">${(route.stops || []).map((s, i) => routeStopRow(route, s, i, editable, etas)).join('')}</ol>
      </div>
      ${editable ? `
        <div class="route-footer-actions">
          <button class="btn btn-danger" data-action="route-archive" data-route="${route.id}">Start a new route</button>
        </div>` : ''}
    `;
  }
  function routeUploadCard() {
    const d = routeUi.draft;
    if (routeUi.busy) {
      return `<div class="card" style="text-align:center;padding:32px 20px;"><div class="route-spinner" aria-hidden="true"></div><p style="margin:12px 0 0;font-weight:600;">${esc(routeUi.busy)}</p></div>`;
    }
    if (!d) {
      return `
        <div class="card route-upload">
          <h2 style="margin:0 0 6px;">Plan today's route</h2>
          <p class="helptext" style="margin:0 0 16px;">Upload your run sheet (Excel .xlsx or CSV). We'll find every address, group parcels going to the same place, and put the stops in a short driving order. New addresses take about a second each the first time; saved ones are instant.</p>
          <label class="route-drop">
            <input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" data-onchange="route-file">
            <span class="route-drop-title">Choose run sheet</span>
            <span class="helptext">.xlsx or .csv · up to 300 stops</span>
          </label>
        </div>`;
    }
    const stops = draftStops(d);
    const options = (key) => `<option value="-1">— not in file —</option>` + d.headers.map((h, i) => `<option value="${i}" ${d.map[key] === i ? 'selected' : ''}>${esc(h)}</option>`).join('');
    return `
      <div class="card">
        <h2 style="margin:0 0 4px;">${esc(d.fileName)}</h2>
        <p class="helptext" style="margin:0 0 16px;">${d.rows.length} rows · <strong>${stops.length} stops</strong>${stops.length < d.rows.length ? ' (parcels to the same address are grouped)' : ''}</p>
        <form data-onsubmit="route-plan">
          <p class="eyebrow" style="margin:0 0 8px;">Match the columns</p>
          <div class="route-mapping">
            ${ROUTE_FIELDS.map(([key, label]) => `<div class="field"><label class="field-label">${label}${key === 'address' ? ' *' : ''}</label><select data-onchange="route-map" data-field="${key}">${options(key)}</select></div>`).join('')}
          </div>
          ${stops.length ? `<div class="table-wrap" style="margin:6px 0 16px;"><table class="data"><thead><tr><th>Address we'll look up</th><th>Recipient</th><th class="tnum">Parcels</th></tr></thead><tbody>${stops.slice(0, 4).map((s) => `<tr><td>${esc(s.address)}</td><td>${esc(s.name)}</td><td class="tnum">${s.parcels}</td></tr>`).join('')}</tbody></table></div>` : '<p class="helptext" style="color:var(--danger);">No addresses found — choose the column that holds the street address.</p>'}
          <p class="eyebrow" style="margin:0 0 8px;">Start and finish</p>
          <div class="field-row" style="margin-bottom:12px;">
            <div class="field"><label class="field-label">Start from</label><select name="startMode" data-onchange="route-start-mode"><option value="here">My current location</option><option value="address">An address (e.g. depot)</option></select></div>
            <div class="field"><label class="field-label">Finish</label><select name="finish"><option value="last">At the last stop</option><option value="return">Back at the start</option></select></div>
          </div>
          <div class="field" id="routeStartAddress" style="margin-bottom:12px;display:none;"><label class="field-label">Start address</label><input type="text" name="startAddress" value="${esc(state.settings.routeDepotAddress || '')}" placeholder="Depot address"></div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <button class="btn btn-primary" type="submit" ${stops.length ? '' : 'disabled'}>Plan my route</button>
            <button class="btn" type="button" data-action="route-draft-clear">Choose a different file</button>
          </div>
        </form>
      </div>`;
  }
  function viewDriverRoute() {
    const driverId = currentDriverId();
    const route = todaysRoute(driverId);
    const header = `<div class="view-header"><div><h1>Route</h1><div class="sub">${fmtDateHuman(todayStr())}</div></div></div>`;
    if (route && !routeUi.busy) return header + routeDetail(route, true);
    return header + routeUploadCard();
  }
  function viewRoutesAdmin() {
    const date = routeUi.adminDate || todayStr();
    const list = (state.routes || []).filter((r) => r.date === date && r.status !== 'archived');
    const viewing = routeUi.viewId ? (state.routes || []).find((r) => r.id === routeUi.viewId) : null;
    if (viewing) {
      return `
        <div class="view-header"><div><h1>${esc(viewing.driverName || 'Driver')}'s route</h1><div class="sub">${fmtDateHuman(viewing.date)} · updated ${viewing.updatedAt ? fmtTimeHuman(viewing.updatedAt) : '—'}</div></div>
          <div class="view-actions"><button class="btn" data-action="route-admin-back">All routes</button><button class="btn" data-action="route-admin-refresh">Refresh</button></div></div>
        ${routeDetail(viewing, false)}`;
    }
    return `
      <div class="view-header"><div><h1>Routes</h1><div class="sub">Drivers' planned routes and progress</div></div>
        <div class="view-actions"><input type="date" value="${date}" data-onchange="route-admin-date" aria-label="Date"><button class="btn" data-action="route-admin-refresh">Refresh</button></div></div>
      ${list.length ? `<div class="route-admin-grid">${list.map((r) => {
        const c = routeCounts(r); const pct = c.stops ? Math.round((c.done / c.stops) * 100) : 0;
        return `<div class="card route-admin-card">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;"><h3 style="margin:0;">${esc(r.driverName || 'Driver')}</h3><span class="helptext">${r.updatedAt ? 'Updated ' + fmtTimeHuman(r.updatedAt) : ''}</span></div>
          <p class="helptext" style="margin:4px 0 10px;">${c.stops} stops · ${c.parcels} parcels · ≈ ${r.distanceKm || 0} km${r.driveMin != null ? ' · ' + fmtDuration(r.driveMin) + ' driving' : ''}${(r.unmatched || []).length ? ` · <span style="color:var(--danger);">${r.unmatched.length} not found</span>` : ''}</p>
          <div class="route-progress"><span style="width:${pct}%"></span></div>
          <p class="helptext" style="margin:8px 0 12px;">${c.done} of ${c.stops} stops done — ${c.delivered} delivered, ${c.failed} failed</p>
          <button class="btn btn-sm" data-action="route-admin-view" data-id="${r.id}">View route</button>
        </div>`;
      }).join('')}</div>` : `<div class="card empty-state"><p>No routes planned for ${fmtDateHuman(date)}.</p><p class="helptext">Drivers plan a route from the Route page on their phone by uploading their run sheet.</p></div>`}`;
  }

  // ---- Saving changes ----
  // Puts a stop where it adds the least extra distance among stops still to do.
  function insertCheapest(route, stops, stop) {
    let bestAt = stops.length, bestCost = Infinity;
    for (let i = 0; i <= stops.length; i++) {
      if (i < stops.length && stops[i].status !== 'pending') continue;
      const prev = i === 0 ? route.start : stops[i - 1]; const next = stops[i];
      const cost = (prev ? kmBetween(prev, stop) : 0) + (next ? kmBetween(stop, next) : 0) - (prev && next ? kmBetween(prev, next) : 0);
      if (cost < bestCost) { bestCost = cost; bestAt = i; }
    }
    stops.splice(bestAt, 0, stop);
    return bestAt;
  }

  // ---- Editing stops (Spoke-style) ----
  const metricsPatch = (m) => ({ stops: m.stops, distanceKm: m.distanceKm, driveMin: m.driveMin, returnLegSec: m.returnLegSec, geometry: m.geometry, metricsSource: m.metricsSource });
  async function applyStops(route, stops, extra) {
    const m = await routeMetrics(Object.assign({}, route, { stops }), routeAnchor(route));
    await saveRouteStops(route, Object.assign(metricsPatch(m), extra || {}));
  }
  function choiceGroup(name, options, value, labels) {
    return `<div class="seg-choice" role="radiogroup">${options.map((o, i) => `<label class="seg-option"><input type="radio" name="${name}" value="${esc(o)}" ${String(value || '') === String(o) ? 'checked' : ''}><span>${esc(labels ? labels[i] : (o || '—'))}</span></label>`).join('')}</div>`;
  }
  function routeStopEditModal(route, stop) {
    const p = stop.pkg || {};
    openModal(`
      <div class="modal-head"><h3>Edit stop</h3><button class="modal-close" data-action="modal-close" aria-label="Close">×</button></div>
      <form class="stop-edit" data-onsubmit="route-stop-save" data-route="${route.id}" data-stop="${stop.id}">
        <div class="field"><label class="field-label">Address</label><input type="text" name="address" value="${esc(stop.address)}" autocomplete="off"></div>
        <p class="helptext" style="margin:-4px 0 12px;">Change the address by typing and picking from the list. The pin moves when you save.</p>
        <div class="field"><label class="field-label">Notes</label><textarea name="notes" rows="2" placeholder="Anything that helps with this stop">${esc(stop.notes || '')}</textarea></div>
        <div class="field"><label class="field-label">Access instructions</label><input type="text" name="access" value="${esc(stop.access || '')}" placeholder="Gate code, buzzer, where to leave it…"></div>
        <label class="check-row"><input type="checkbox" name="rememberAccess"> Remember for this address (shows next time)</label>

        <p class="eyebrow stop-edit-section">Recipient</p>
        <div class="field-row">
          <div class="field"><label class="field-label">Name</label><input type="text" name="name" value="${esc(stop.name || '')}"></div>
          <div class="field"><label class="field-label">Phone</label><input type="tel" name="phone" value="${esc(stop.phone || '')}"></div>
        </div>
        <div class="field"><label class="field-label">Email</label><input type="email" name="email" value="${esc(stop.email || '')}"></div>

        <p class="eyebrow stop-edit-section">Packages</p>
        <div class="pkg-count"><button class="btn" type="button" data-action="route-pkg-step" data-step="-1" aria-label="One less">−</button><input type="number" name="parcels" min="1" max="99" value="${Number(stop.parcels) || 1}" aria-label="Packages"><button class="btn" type="button" data-action="route-pkg-step" data-step="1" aria-label="One more">+</button><span class="helptext">packages</span></div>
        <div class="field"><label class="field-label">Package / barcode IDs</label><input type="text" name="refs" value="${esc((stop.refs || []).join(', '))}" placeholder="Separate with commas"></div>
        <p class="field-label" style="margin:10px 0 6px;">Package finder — where it is in the vehicle</p>
        <div class="pkg-finder">
          <span class="pkg-label">Size</span>${choiceGroup('pkgSize', [''].concat(PKG_SIZES), p.size)}
          <span class="pkg-label">Type</span>${choiceGroup('pkgType', [''].concat(PKG_TYPES), p.type)}
          <span class="pkg-label">Position</span>${choiceGroup('pkgPosition', [''].concat(PKG_POSITIONS), p.position)}
          <span class="pkg-label">Side</span>${choiceGroup('pkgSide', [''].concat(PKG_SIDES), p.side)}
          <span class="pkg-label">Shelf</span>${choiceGroup('pkgSurface', [''].concat(PKG_SURFACES), p.surface)}
        </div>
        <div class="field" style="margin-top:10px;"><label class="field-label">Package photo</label>
          ${stop.photoId ? `<button class="btn btn-sm" type="button" data-action="route-photo-view" data-photo="${esc(stop.photoId)}" style="margin-bottom:6px;">View current photo</button>` : ''}
          <input type="file" name="photo" accept="image/*" capture="environment"></div>

        <p class="eyebrow stop-edit-section">Stop setup</p>
        <p class="field-label" style="margin:0 0 6px;">Type</p>
        ${choiceGroup('stopType', ['delivery', 'pickup'], stop.stopType || 'delivery', ['Delivery', 'Pickup'])}
        <p class="field-label" style="margin:12px 0 6px;">Order</p>
        ${choiceGroup('placement', ['first', 'auto', 'last'], stop.placement || 'auto', ['First', 'Auto', 'Last'])}
        <div class="field-row" style="margin-top:12px;">
          <div class="field"><label class="field-label">Arrive after</label><input type="time" name="windowStart" value="${esc(stop.windowStart || '')}"></div>
          <div class="field"><label class="field-label">Arrive before</label><input type="time" name="windowEnd" value="${esc(stop.windowEnd || '')}"></div>
          <div class="field"><label class="field-label">Time at stop (min)</label><input type="number" name="serviceMin" min="0" max="240" value="${stop.serviceMin != null ? stop.serviceMin : ''}" placeholder="${STOP_SERVICE_SEC / 60}"></div>
        </div>
        <p class="helptext" style="margin:-4px 0 10px;">Leave times empty for Anytime.</p>
        <p class="field-label" style="margin:0 0 6px;">Colour</p>
        <div class="colour-choice">${STOP_COLOURS.map(([c, label]) => `<label class="colour-option" title="${label}"><input type="radio" name="colour" value="${c}" ${String(stop.colour || '') === c ? 'checked' : ''}><span style="${c ? `background:${c};` : ''}" class="${c ? '' : 'colour-auto'}">${c ? '' : 'Auto'}</span></label>`).join('')}</div>

        <div class="stop-edit-actions">
          <button class="btn btn-primary" type="submit">Save</button>
          <button class="btn" type="button" data-action="route-stop-duplicate" data-route="${route.id}" data-stop="${stop.id}">Duplicate stop</button>
          <button class="btn btn-danger" type="button" data-action="route-stop-remove" data-route="${route.id}" data-stop="${stop.id}">Remove stop</button>
        </div>
      </form>`);
  }
  function routeStopAddModal(route) {
    openModal(`
      <div class="modal-head"><h3>Add stop</h3><button class="modal-close" data-action="modal-close" aria-label="Close">×</button></div>
      <form class="stop-edit" data-onsubmit="route-stop-add-save" data-route="${route.id}">
        <div class="field"><label class="field-label">Address</label><input type="text" name="address" required autocomplete="off" placeholder="Start typing and pick from the list"></div>
        <div class="field-row">
          <div class="field"><label class="field-label">Recipient name</label><input type="text" name="name"></div>
          <div class="field"><label class="field-label">Phone</label><input type="tel" name="phone"></div>
        </div>
        <div class="field"><label class="field-label">Notes</label><input type="text" name="notes"></div>
        <div class="pkg-count"><button class="btn" type="button" data-action="route-pkg-step" data-step="-1" aria-label="One less">−</button><input type="number" name="parcels" min="1" max="99" value="1" aria-label="Packages"><button class="btn" type="button" data-action="route-pkg-step" data-step="1" aria-label="One more">+</button><span class="helptext">packages</span></div>
        <p class="field-label" style="margin:12px 0 6px;">Type</p>
        ${choiceGroup('stopType', ['delivery', 'pickup'], 'delivery', ['Delivery', 'Pickup'])}
        <div class="stop-edit-actions"><button class="btn btn-primary" type="submit">Add to route</button><button class="btn" type="button" data-action="modal-close">Cancel</button></div>
      </form>`);
  }
  async function lookupOne(input) {
    const address = String(input.value || '').trim();
    if (input.dataset.lat && input.dataset.lng) return { lat: Number(input.dataset.lat), lng: Number(input.dataset.lng), formatted: address, precision: 'house', partial: false };
    const [g] = await geocodeForRoute([address]);
    return g;
  }
  async function saveRouteStops(route, patch) {
    Object.assign(route, patch, { updatedAt: new Date().toISOString() });
    await state.db.doc('routes/' + route.id).update(Object.assign({}, patch, { updatedAt: route.updatedAt }));
  }
  async function planRoute(form) {
    const d = routeUi.draft; if (!d) return;
    const fd = new FormData(form);
    const stops = draftStops(d);
    if (!stops.length) { toast('No addresses to plan.', 'err'); return; }
    if (stops.length > 300) { toast(`That's ${stops.length} stops — the limit is 300 per route. Split the file and try again.`, 'err'); return; }
    const startMode = fd.get('startMode'); const returnToStart = fd.get('finish') === 'return';
    const startAddress = String(fd.get('startAddress') || '').trim();
    if (startMode === 'address' && !startAddress) { toast('Enter the start address.', 'err'); return; }
    const driverId = currentDriverId();
    const driver = state.drivers.find((x) => x.id === driverId);
    try {
      let start = null;
      if (startMode === 'here') {
        routeUi.busy = 'Getting your location…'; renderView();
        try { const pos = await getCurrentPosition(); start = { label: 'My location', lat: pos.lat, lng: pos.lng }; }
        catch (e) { routeUi.busy = ''; renderView(); toast(e.message + ' Or choose "An address" as the start.', 'err'); return; }
      }
      routeUi.busy = `Finding ${stops.length} addresses…`; renderView();
      const lookups = await geocodeForRoute(stops.map((s) => s.address).concat(startMode === 'address' ? [startAddress] : []), (done, total, left) => {
        routeUi.busy = `Finding addresses… ${done} of ${total}` + (left > 3 ? ` (about ${Math.ceil(left * 1.1)} seconds left — saved addresses are instant next time)` : '');
        const p = document.querySelector('.route-spinner + p'); if (p) p.textContent = routeUi.busy;
      }, stops.map((s) => s.parts).concat(startMode === 'address' ? [null] : []));
      if (startMode === 'address') {
        const s = lookups.pop();
        if (s.error) { routeUi.busy = ''; renderView(); toast('Start address: ' + s.error, 'err'); return; }
        start = { label: startAddress, lat: s.lat, lng: s.lng };
      }
      const found = [], unmatched = [];
      stops.forEach((s, i) => {
        const g = lookups[i];
        if (g && !g.error) found.push(Object.assign({}, s, { lat: g.lat, lng: g.lng, formatted: g.formatted, precision: g.precision, partial: g.partial, access: s.access || g.access || '' }));
        else unmatched.push(Object.assign({}, s, { error: g ? g.error : 'Not found' }));
      });
      if (!found.length) { routeUi.busy = ''; renderView(); toast(unmatched.length ? unmatched[0].error + ' — check the address column is right.' : 'No addresses found.', 'err'); return; }
      routeUi.busy = 'Checking real driving times between stops…'; renderView();
      const plan = await planStopOrder(start, found, returnToStart);
      routeUi.busy = 'Putting stops in the best order…'; renderView();
      const ordered = plan.order.map((idx, i) => Object.assign({}, found[idx], { id: 's' + (i + 1) + '_' + genId().slice(0, 6), status: 'pending', reason: '', doneAt: null }));
      const metrics = await routeMetrics({ stops: ordered, start, returnToStart }, start);
      const nowIso = new Date().toISOString();
      const doc = {
        driverId, driverName: driver ? driver.name : (state.session.name || ''), date: todayStr(), status: 'active',
        fileName: d.fileName, start, returnToStart, unmatched, orderedBy: plan.source,
        stops: metrics.stops, distanceKm: metrics.distanceKm, driveMin: metrics.driveMin, returnLegSec: metrics.returnLegSec,
        geometry: metrics.geometry, metricsSource: metrics.metricsSource, createdAt: nowIso, updatedAt: nowIso,
      };
      const ref = await state.db.collection('routes').add(doc);
      state.routes = state.routes || [];
      state.routes.unshift(Object.assign({ id: ref.id }, doc));
      routeUi.draft = null; routeUi.busy = '';
      renderView();
      toast(`Route ready: ${ordered.length} stops${unmatched.length ? `, ${unmatched.length} need checking` : ''}.`, unmatched.length ? 'err' : 'ok');
    } catch (e) {
      console.error('Route planning failed', e);
      routeUi.busy = ''; renderView(); toast(e.message || 'Could not plan the route.', 'err');
    }
  }

  function renderView() {
    let route = VIEWS[state.route] ? state.route : 'dashboard';
    const role = state.session ? state.session.role : null;
    if (!roleAllowed(route, role)) { route = role === 'driver' ? 'driver-submit' : role === 'labour' ? 'labour-log' : 'dashboard'; }
    state.route = route;
    document.getElementById('content').innerHTML = VIEWS[route]();
    if (document.getElementById('routeMap')) initRouteMap(); else if (routeMap) { try { routeMap.remove(); } catch (e) {} routeMap = null; }
    const topbarTitle = document.getElementById('topbar-title');
    if (topbarTitle) { const item = NAV.find((n) => n.id === route); topbarTitle.textContent = item ? item.label : ''; }
  }

  // ---------------------------------------------------------------
  // Global action handlers
  // ---------------------------------------------------------------

  // Local smart parser for bulk daily entries. This works on a normal static
  // deployment without exposing an AI API key in the browser. When the original
  // embedded AI provider is available, the action below still uses it first.
  function parseBulkTextLocally(rawText) {
    const companies = activeDeliveryCompanies();
    const knownDrivers = activeDrivers().map((d) => d.name).sort((a, b) => b.length - a.length);
    const lines = String(rawText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return [];

    const splitCells = (line, delimiter) => {
      // Practical CSV/TSV parser with support for quoted cells.
      const out = []; let cell = ''; let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' && line[i + 1] === '"' && quoted) { cell += '"'; i++; }
        else if (ch === '"') quoted = !quoted;
        else if (ch === delimiter && !quoted) { out.push(cell.trim()); cell = ''; }
        else cell += ch;
      }
      out.push(cell.trim());
      return out;
    };
    const norm = (v) => String(v || '').trim().toLowerCase().replace(/[ _-]+/g, ' ');
    const headerAliases = {
      date: ['date', 'day', 'work date'], block: ['block', 'route', 'zone', 'route/block'],
      driverName: ['driver', 'driver name', 'name', 'worker'], vehicle: ['vehicle', 'vehicle type', 'car/van'],
      companyName: ['company', 'client', 'contract', 'customer'], parcels: ['parcels', 'parcel count', 'deliveries', 'quantity'],
      bonus: ['bonus', 'extra'], adjustment: ['adjustment', 'adjust', 'deduction'], notes: ['notes', 'note', 'comments']
    };
    const delimiter = lines[0].includes('\t') ? '\t' : (lines[0].includes(',') ? ',' : null);
    if (delimiter) {
      const first = splitCells(lines[0], delimiter).map(norm);
      const headerMap = {};
      first.forEach((h, i) => Object.keys(headerAliases).forEach((field) => { if (headerAliases[field].includes(h)) headerMap[field] = i; }));
      if (headerMap.driverName !== undefined) {
        return lines.slice(1).map((line) => {
          const cells = splitCells(line, delimiter);
          const get = (field) => headerMap[field] === undefined ? '' : (cells[headerMap[field]] || '');
          const rawVehicle = get('vehicle').toLowerCase();
          const vehicle = /van/.test(rawVehicle) ? 'Van' : (/other/.test(rawVehicle) ? 'Other' : 'Car');
          const companyInput = get('companyName');
          const company = companies.find((c) => norm(c.name) === norm(companyInput)) || companies.find((c) => norm(c.name).includes(norm(companyInput)) || norm(companyInput).includes(norm(c.name)));
          return {
            id: genId(), _new: true, block: get('block'), driverName: get('driverName').trim(), vehicle,
            companyName: company ? company.name : (companies[0] ? companies[0].name : ''),
            parcels: Math.max(0, parseInt(get('parcels'), 10) || 0), bonus: Number(get('bonus')) || 0,
            adjustment: Number(get('adjustment')) || 0, notes: get('notes')
          };
        }).filter((r) => r.driverName);
      }
    }

    return lines.map((line) => {
      const lower = line.toLowerCase();
      const row = { id: genId(), _new: true, block: '', driverName: '', vehicle: /\bvan\b/i.test(line) ? 'Van' : (/\bother\b/i.test(line) ? 'Other' : 'Car'), companyName: companies[0] ? companies[0].name : '', parcels: 0, bonus: 0, adjustment: 0, notes: '' };
      const blockMatch = line.match(/\b(block|route|zone)\s*#?\s*([a-z0-9-]+)\b/i);
      if (blockMatch) row.block = `${/^block$/i.test(blockMatch[1]) ? 'Block' : blockMatch[1][0].toUpperCase() + blockMatch[1].slice(1).toLowerCase()} ${blockMatch[2]}`;
      const parcelMatch = line.match(/\b(\d+)\s*(?:parcels?|deliveries|packages)\b/i) || line.match(/\bparcels?\s*[:=]?\s*(\d+)\b/i);
      if (parcelMatch) row.parcels = Math.max(0, parseInt(parcelMatch[1], 10) || 0);
      const bonusMatch = line.match(/\bbonus\s*[:=]?\s*\$?(-?\d+(?:\.\d{1,2})?)/i);
      if (bonusMatch) row.bonus = Number(bonusMatch[1]) || 0;
      const adjMatch = line.match(/\b(?:adjust(?:ment)?|deduction)\s*[:=]?\s*\$?(-?\d+(?:\.\d{1,2})?)/i);
      if (adjMatch) row.adjustment = Number(adjMatch[1]) || 0;
      const matchedCompany = companies.find((c) => lower.includes(c.name.toLowerCase()));
      if (matchedCompany) row.companyName = matchedCompany.name;
      const matchedDriver = knownDrivers.find((name) => lower.includes(name.toLowerCase()));
      if (matchedDriver) row.driverName = matchedDriver;
      else {
        // Prefer the text before the first recognisable field marker, then
        // remove block/company/vehicle/amount tokens from the candidate.
        const markers = [blockMatch && blockMatch.index, /\b(?:car|van|other)\b/i.exec(line)?.index,
          matchedCompany ? lower.indexOf(matchedCompany.name.toLowerCase()) : -1,
          /\b\d+\s*(?:parcels?|deliveries|packages)\b/i.exec(line)?.index,
          /\bbonus\b/i.exec(line)?.index, /\b(?:adjust(?:ment)?|deduction)\b/i.exec(line)?.index].filter((n) => n !== null && n !== undefined && n >= 0);
        let candidate = markers.length ? line.slice(0, Math.min(...markers)) : line;
        candidate = candidate.replace(/\b(block|route|zone)\s*#?\s*[a-z0-9-]+\b/ig, ' ')
          .replace(/\b(car|van|other)\b/ig, ' ').replace(/\$?\d+(?:\.\d{1,2})?/g, ' ')
          .replace(/\b(parcels?|deliveries|packages|bonus|adjustment|adjust|deduction)\b/ig, ' ')
          .replace(/\s+/g, ' ').trim();
        // If line begins with a block label (e.g. "Block 1 Honey Van"),
        // look for the name between the block and vehicle/company marker.
        if (!candidate && blockMatch) {
          const afterBlock = line.slice(blockMatch.index + blockMatch[0].length);
          const endMarkers = [ /\b(?:car|van|other)\b/i.exec(afterBlock)?.index,
            matchedCompany ? afterBlock.toLowerCase().indexOf(matchedCompany.name.toLowerCase()) : -1 ].filter((n) => n !== null && n !== undefined && n >= 0);
          candidate = endMarkers.length ? afterBlock.slice(0, Math.min(...endMarkers)).trim() : afterBlock.trim();
        }
        row.driverName = candidate.replace(/^[,;:\s-]+|[,;:\s-]+$/g, '').trim();
      }
      const knownFields = [row.driverName, row.block, matchedCompany && matchedCompany.name, row.vehicle, parcelMatch && parcelMatch[0], bonusMatch && bonusMatch[0], adjMatch && adjMatch[0]].filter(Boolean);
      let note = line;
      knownFields.forEach((part) => { note = note.replace(new RegExp(String(part).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' '); });
      row.notes = note.replace(/[,$;|]+/g, ' ').replace(/\s+/g, ' ').trim();
      return row;
    }).filter((r) => r.driverName);
  }

  const ACTIONS = {
    'nav': (el) => setRoute(el.dataset.route),
    'route-draft-clear': () => { routeUi.draft = null; renderView(); },
    'route-stop-done': async (el) => {
      const route = state.routes.find((r) => r.id === el.dataset.route); if (!route) return;
      const stops = route.stops.map((s) => s.id === el.dataset.stop ? Object.assign({}, s, { status: 'delivered', reason: '', doneAt: new Date().toISOString() }) : s);
      el.disabled = true;
      try { await saveRouteStops(route, { stops }); renderView(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
      catch (e) { el.disabled = false; toast(e.message, 'err'); }
    },
    'route-stop-fail': (el) => {
      const route = state.routes.find((r) => r.id === el.dataset.route); if (!route) return;
      const stop = route.stops.find((s) => s.id === el.dataset.stop); if (!stop) return;
      openModal(`
        <div class="modal-head"><h3>Why did this delivery fail?</h3><button class="modal-close" data-action="modal-close" aria-label="Close">×</button></div>
        <p class="helptext" style="margin:0 0 12px;">${esc(stop.address)}</p>
        <form data-onsubmit="route-fail-save" data-route="${route.id}" data-stop="${stop.id}">
          <div class="route-reasons">${FAIL_REASONS.map((r, i) => `<label class="route-reason"><input type="radio" name="reason" value="${r}" ${i === 0 ? 'checked' : ''}> ${r}</label>`).join('')}</div>
          <div class="field" style="margin:12px 0;"><label class="field-label">Note (optional)</label><input type="text" name="note" placeholder="e.g. Card left, gate locked"></div>
          <div style="display:flex;gap:10px;justify-content:flex-end;"><button class="btn" type="button" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">Mark failed</button></div>
        </form>`);
    },
    'route-stop-undo': async (el) => {
      const route = state.routes.find((r) => r.id === el.dataset.route); if (!route) return;
      const stops = route.stops.map((s) => s.id === el.dataset.stop ? Object.assign({}, s, { status: 'pending', reason: '', doneAt: null }) : s);
      try { await saveRouteStops(route, { stops }); renderView(); } catch (e) { toast(e.message, 'err'); }
    },
    'route-stop-edit': (el) => {
      const route = state.routes.find((r) => r.id === el.dataset.route); if (!route) return;
      const stop = route.stops.find((x) => x.id === el.dataset.stop); if (stop) routeStopEditModal(route, stop);
    },
    'route-stop-add': (el) => { const route = state.routes.find((r) => r.id === el.dataset.route); if (route) routeStopAddModal(route); },
    'route-pkg-step': (el) => {
      const input = el.closest('form').querySelector('input[name="parcels"]');
      input.value = Math.min(99, Math.max(1, (Number(input.value) || 1) + Number(el.dataset.step)));
    },
    'route-stop-duplicate': async (el) => {
      const route = state.routes.find((r) => r.id === el.dataset.route); if (!route) return;
      const i = route.stops.findIndex((x) => x.id === el.dataset.stop); if (i < 0) return;
      const copy = Object.assign({}, route.stops[i], { id: 's' + genId(), status: 'pending', reason: '', doneAt: null, photoId: null });
      const stops = route.stops.slice(); stops.splice(i + 1, 0, copy);
      try { await applyStops(route, stops); closeModal(); renderView(); toast('Stop duplicated.', 'ok'); } catch (e) { toast(e.message, 'err'); }
    },
    'route-stop-remove': async (el) => {
      const route = state.routes.find((r) => r.id === el.dataset.route); if (!route) return;
      const ok = await confirmDialog('Remove this stop from today\'s route?', { title: 'Remove stop?', okLabel: 'Remove stop' });
      if (!ok) return;
      try { await applyStops(route, route.stops.filter((x) => x.id !== el.dataset.stop)); closeModal(); renderView(); toast('Stop removed.', 'ok'); } catch (e) { toast(e.message, 'err'); }
    },
    'route-reorder-toggle': () => { routeUi.reorder = !routeUi.reorder; renderView(); },
    'route-stop-move': async (el) => {
      const route = state.routes.find((r) => r.id === el.dataset.route); if (!route) return;
      const stops = route.stops.slice(); const i = stops.findIndex((x) => x.id === el.dataset.stop);
      let j = i + Number(el.dataset.dir);
      while (j >= 0 && j < stops.length && stops[j].status !== 'pending') j += Number(el.dataset.dir);
      if (i < 0 || j < 0 || j >= stops.length) return;
      [stops[i], stops[j]] = [stops[j], stops[i]];
      el.disabled = true;
      try { await applyStops(route, stops); renderView(); } catch (e) { el.disabled = false; toast(e.message, 'err'); }
    },
    'route-reverse': async (el) => {
      const route = state.routes.find((r) => r.id === el.dataset.route); if (!route) return;
      const done = route.stops.filter((x) => x.status !== 'pending'); const pending = route.stops.filter((x) => x.status === 'pending').reverse();
      el.disabled = true;
      try { await applyStops(route, done.concat(pending)); renderView(); toast('Route reversed.', 'ok'); } catch (e) { el.disabled = false; toast(e.message, 'err'); }
    },
    'route-photo-view': async (el) => {
      try {
        const snap = await state.db.doc('routePhotos/' + el.dataset.photo).get();
        if (!snap.exists) { toast('Photo not found.', 'err'); return; }
        openModal(`<div class="modal-head"><h3>Package photo</h3><button class="modal-close" data-action="modal-close" aria-label="Close">×</button></div><img src="${esc(snap.data().image)}" alt="Package photo" style="width:100%;border-radius:10px;">`);
      } catch (e) { toast(e.message, 'err'); }
    },
    'route-unmatched-retry': async (el) => {
      const route = state.routes.find((r) => r.id === el.dataset.route); if (!route || !(route.unmatched || []).length) return;
      const list = route.unmatched;
      el.disabled = true; const label = el.textContent;
      try {
        const res = await geocodeForRoute(list.map((u) => u.address), (done, total) => { el.textContent = `Checking ${Math.min(done, total)} of ${total}…`; }, list.map((u) => u.parts || null));
        const stops = route.stops.slice(); const still = []; let added = 0, approx = 0;
        list.forEach((u, i) => {
          const g = res[i];
          if (!g || g.error) { still.push(Object.assign({}, u, { error: g ? g.error : 'Address not found' })); return; }
          const stop = Object.assign({}, u, { lat: g.lat, lng: g.lng, formatted: g.formatted, precision: g.precision, partial: g.partial, id: 's' + genId(), status: 'pending', reason: '', doneAt: null });
          delete stop.error;
          insertCheapest(route, stops, stop); added++; if (g.partial) approx++;
        });
        if (!added) { el.disabled = false; el.textContent = label; toast('Still couldn\'t find these. Edit them (check spelling and suburb) and tap Find.', 'err'); return; }
        const m = await routeMetrics(Object.assign({}, route, { stops }), routeAnchor(route));
        await saveRouteStops(route, { stops: m.stops, unmatched: still, distanceKm: m.distanceKm, driveMin: m.driveMin, returnLegSec: m.returnLegSec, geometry: m.geometry, metricsSource: m.metricsSource });
        renderView();
        toast(`Added ${added} stop${added > 1 ? 's' : ''}${approx ? ` (${approx} with an approximate pin — check the house number on arrival)` : ''}${still.length ? `. ${still.length} still need fixing.` : '.'}`, still.length ? 'err' : 'ok');
      } catch (e) { el.disabled = false; el.textContent = label; toast(e.message, 'err'); }
    },
    'route-unmatched-remove': async (el) => {
      const route = state.routes.find((r) => r.id === el.dataset.route); if (!route) return;
      const unmatched = (route.unmatched || []).filter((_, i) => i !== Number(el.dataset.index));
      try { await saveRouteStops(route, { unmatched }); renderView(); } catch (e) { toast(e.message, 'err'); }
    },
    'route-replan': async (el) => {
      const route = state.routes.find((r) => r.id === el.dataset.route); if (!route) return;
      const done = route.stops.filter((s) => s.status !== 'pending');
      const pending = route.stops.filter((s) => s.status === 'pending');
      if (!pending.length) { toast('No stops left to plan.', 'ok'); return; }
      el.disabled = true; const label = el.textContent; el.textContent = 'Getting your location…';
      try {
        const pos = await getCurrentPosition();
        const here = { label: 'My location', lat: pos.lat, lng: pos.lng };
        el.textContent = 'Re-planning…';
        const plan = await planStopOrder(here, pending, route.returnToStart);
        const reordered = Object.assign({}, route, { stops: done.concat(plan.order.map((i) => pending[i])) });
        const m = await routeMetrics(reordered, here);
        await saveRouteStops(route, { stops: m.stops, distanceKm: m.distanceKm, driveMin: m.driveMin, returnLegSec: m.returnLegSec, geometry: m.geometry, metricsSource: m.metricsSource, orderedBy: plan.source });
        renderView(); toast('Remaining stops re-planned from where you are.', 'ok');
      } catch (e) { toast(e.message, 'err'); el.disabled = false; el.textContent = label; }
    },
    'route-stop-next': async (el) => {
      const route = state.routes.find((r) => r.id === el.dataset.route); if (!route) return;
      const stop = route.stops.find((s) => s.id === el.dataset.stop); if (!stop || stop.status !== 'pending') return;
      const others = route.stops.filter((s) => s.id !== stop.id);
      const firstPending = others.findIndex((s) => s.status === 'pending');
      others.splice(firstPending < 0 ? others.length : firstPending, 0, stop);
      el.disabled = true;
      try {
        const m = await routeMetrics(Object.assign({}, route, { stops: others }), routeAnchor(route));
        await saveRouteStops(route, { stops: m.stops, distanceKm: m.distanceKm, driveMin: m.driveMin, returnLegSec: m.returnLegSec, geometry: m.geometry, metricsSource: m.metricsSource });
        renderView(); window.scrollTo({ top: 0, behavior: 'smooth' }); toast('Moved to your next stop.', 'ok');
      } catch (e) { el.disabled = false; toast(e.message, 'err'); }
    },
    'route-archive': async (el) => {
      const route = state.routes.find((r) => r.id === el.dataset.route); if (!route) return;
      const ok = await confirmDialog('Start a new route? Today\'s current route will be closed (its delivered/failed counts are kept).', { title: 'Start a new route?', okLabel: 'Start new route' });
      if (!ok) return;
      try { await saveRouteStops(route, { status: 'archived' }); renderView(); } catch (e) { toast(e.message, 'err'); }
    },
    'route-admin-view': (el) => { routeUi.viewId = el.dataset.id; renderView(); window.scrollTo(0, 0); },
    'route-admin-back': () => { routeUi.viewId = null; renderView(); },
    'route-admin-refresh': async (el) => { el.disabled = true; try { await loadRoutes(); } finally { renderView(); } },
    'company-use-my-location': async (el) => {
      const form = el.closest('form');
      const input = form && form.querySelector('input[name="siteCoords"]');
      if (!input) return;
      const label = el.textContent; el.disabled = true; el.textContent = 'Getting location…';
      try {
        const pos = await getCurrentPosition();
        input.value = pos.lat.toFixed(6) + ', ' + pos.lng.toFixed(6);
        toast(`Site pin set (accurate to about ${pos.accuracy} m).`, 'ok');
      } catch (e) { toast(e.message, 'err'); }
      finally { el.disabled = false; el.textContent = label; }
    },
    'switch-user': async () => {
      if (switchingUser) return;
      switchingUser = true;
      try {
        const ok = await confirmDialog('Switch to a different account? Your current session will be closed.', { okLabel: 'Switch account' });
        if (!ok) return;
        // Close the current role immediately, even if a data refresh later
        // encounters a network error. Then refresh account/role data in place.
        // Do not reload: reloads can restore an old hash or cached role.
        showLoginGate();
        try {
          await loadAll();
          renderGate();
          const mobileInput = document.querySelector('#gate input[name="mobile"]');
          if (mobileInput) mobileInput.focus();
        } catch (refreshError) {
          console.warn('UMA could not refresh data while switching accounts:', refreshError);
          toast('You are signed out. The account list could not be refreshed; check your connection and reload.', 'err');
        }
      } catch (err) {
        console.error('UMA account switch failed:', err);
        toast('Could not switch accounts. Please try again.', 'err');
      } finally {
        switchingUser = false;
      }
    },
    'modal-backdrop': (el, e) => { if (e.target === el) closeModal(); },
    'modal-close': () => closeModal(),
    'confirm-yes': () => window.__confirmResolve && window.__confirmResolve(true),
    'confirm-no': () => window.__confirmResolve && window.__confirmResolve(false),

    // Gate
    'gate-mobile-continue': async (el) => {
      const form = el.closest('form[data-onsubmit="gate-mobile-continue"]');
      if (!form || gateSubmitting || form.dataset.submitting === 'true') return;
      form.dataset.submitting = 'true';
      const button = el;
      const originalText = button.textContent;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = 'Checking number…';
      try {
        await SUBMIT_HANDLERS['gate-mobile-continue'](form);
      } catch (err) {
        console.error('UMA mobile login failed:', err);
        showGateError(err && err.message ? err.message : 'Unable to check this mobile number. Please try again.');
      } finally {
        if (button.isConnected) {
          button.disabled = false;
          button.removeAttribute('aria-busy');
          button.textContent = originalText || 'Continue';
        }
        if (form.isConnected) delete form.dataset.submitting;
      }
    },
    'gate-back': () => { pinTargetStaffId = null; gateCandidateStaffIds = []; pinBuffer = ''; gateStage = 'mobile'; renderGate(); },
    'gate-select-account': (el) => {
      const chosen = state.staff.find((s) => s.id === el.dataset.staffId && s.active !== false);
      if (!chosen || !gateCandidateStaffIds.includes(chosen.id)) { toast('That account is no longer available. Please try again.', 'err'); gateStage = 'mobile'; renderGate(); return; }
      pinTargetStaffId = chosen.id;
      pinBuffer = '';
      gateStage = 'pin';
      renderGate();
    },
    'gate-key': (el) => {
      if (gateSubmitting || pinBuffer.length >= 4 || !/^[0-9]$/.test(el.dataset.key || '')) return;
      pinBuffer += el.dataset.key;
      renderGate();
      if (pinBuffer.length === 4) checkPin();
    },
    'gate-backspace': () => { pinBuffer = pinBuffer.slice(0, -1); renderGate(); },

    // Entry
    'entry-save-all': async () => {
      const n = await commitEntryRows(state.entryDate, state.entryRows);
      if (n < 0) return;
      toast('Record saved.', 'ok');
      // Reset Daily Entry back to a single fresh row for the next record and stay
      // right here — no navigation away, so entering several records in a row is
      // quick.
      loadEntryRowsForDate();
      renderView();
    },

    // Bulk Add (AI)
    'entry-mode': (el) => { state.entryMode = el.dataset.mode; renderView(); },
    'bulk-add-row': () => {
      if (!state.bulkRows) state.bulkRows = [];
      state.bulkRows.push(blankEntryRow());
      renderView();
    },
    'bulk-remove-row': (el) => {
      if (!state.bulkRows) return;
      state.bulkRows = state.bulkRows.filter((r) => r.id !== el.dataset.row);
      renderView();
    },
    'bulk-discard': async () => {
      const ok = await confirmDialog('Discard the pasted text and parsed rows?', { okLabel: 'Discard', danger: true });
      if (!ok) return;
      state.bulkText = '';
      state.bulkRows = null;
      state.bulkError = '';
      renderView();
    },
    'bulk-parse': async () => {
      const text = (state.bulkText || '').trim();
      if (!text) return;
      state.bulkBusy = true;
      state.bulkError = '';
      renderView();
      try {
        if (!state.sample) {
          state.bulkRows = parseBulkTextLocally(text).map((r) => Object.assign(r, { companyName: companyByName(r.companyName) ? r.companyName : (activeDeliveryCompanies()[0] ? activeDeliveryCompanies()[0].name : '') }));
          if (!state.bulkRows.length) state.bulkError = 'No driver rows found. Try one driver per line or paste a table with a Driver/Name column.';
          return;
        }
        const driverNames = activeDrivers().map((d) => d.name);
        const companyNames = activeDeliveryCompanies().map((c) => c.name);
        const prompt = `You turn a delivery dispatcher's rough shorthand notes into structured records, one per driver/block combination mentioned.

Known drivers (reuse these exact names when a note clearly refers to one of them; otherwise use the new name as typed): ${JSON.stringify(driverNames)}
Known companies (match to the closest one of these EXACT names whenever the note reasonably refers to one; only use a name outside this list if truly nothing matches): ${JSON.stringify(companyNames)}
Valid vehicle values: "Car", "Van", "Other" — default to "Car" when not stated.

Notes to parse:
"""
${text.slice(0, 6000)}
"""

Reply with ONLY a JSON array, one object per record, shaped exactly like this example (no other text):
[{"driverName": "Ravi", "block": "Block 1", "vehicle": "Car", "companyName": "Amazon Flex", "parcels": 0, "bonus": 0, "adjustment": 0, "notes": ""}]

Rules: "block" is whatever block/route label the note gives, or "" if none is mentioned. "parcels" is an integer, 0 if not mentioned. "bonus" and "adjustment" are numbers, 0 if not mentioned. "notes" carries any extra detail that doesn't fit the other fields, or "". Never invent a driver, block or company that isn't in the notes or the known lists above. Skip a line only if it has no driver name at all.`;
        const parsed = await state.sample.json(prompt, { modelTier: 'default', cache: false });
        const list = Array.isArray(parsed) ? parsed : [];
        state.bulkRows = list.map((p) => ({
          id: genId(),
          _new: true,
          block: String((p && p.block) || ''),
          driverName: String((p && p.driverName) || '').trim(),
          vehicle: (p && VEHICLES.includes(p.vehicle)) ? p.vehicle : 'Car',
          companyName: (p && companyByName(p.companyName)) ? p.companyName : (activeDeliveryCompanies()[0] ? activeDeliveryCompanies()[0].name : ''),
          parcels: Number(p && p.parcels) || 0,
          bonus: Number(p && p.bonus) || 0,
          adjustment: Number(p && p.adjustment) || 0,
          notes: String((p && p.notes) || ''),
        })).filter((r) => r.driverName);
        if (!state.bulkRows.length) state.bulkError = "Couldn't find any driver records in that text — try adding a bit more detail.";
      } catch (e) {
        const copy = {
          not_granted: "AI parsing isn't allowed for this page right now.",
          rate_limited: 'Too many requests right now — try again in a moment.',
          invalid_json: "AI couldn't return clean data for that text — try simplifying it.",
          prompt_too_large: "That's too much text at once — try pasting a smaller batch.",
        };
        state.bulkError = copy[e && e.code] || "Something went wrong parsing that text — try again.";
      } finally {
        state.bulkBusy = false;
        renderView();
      }
    },
    'bulk-save-all': async () => {
      if (!state.bulkRows || !state.bulkRows.length) return;
      const n = await commitEntryRows(state.entryDate, state.bulkRows);
      if (n < 0) return;
      toast(`${n} record${n === 1 ? '' : 's'} saved.`, 'ok');
      state.bulkText = '';
      state.bulkRows = null;
      state.bulkError = '';
      renderView();
    },

    // Records
    'rec-select': (el) => {
      const key = el.dataset.date + '|' + el.dataset.id;
      if (el.checked) recordsUi.selected.add(key); else recordsUi.selected.delete(key);
      renderView();
    },
    'rec-select-all': (el) => {
      const shown = capRows(filteredRecords()).shown;
      shown.forEach((r) => { const key = r.date + '|' + r.id; if (el.checked) recordsUi.selected.add(key); else recordsUi.selected.delete(key); });
      renderView();
    },
    'rec-clear-selection': () => { recordsUi.selected.clear(); renderView(); },
    'rec-bulk-delete': async () => {
      const count = recordsUi.selected.size;
      if (!count) return;
      const ok = await confirmDialog(`Delete ${count} selected record${count === 1 ? '' : 's'}? This cannot be undone.`, { okLabel: `Delete ${count}`, danger: true });
      if (!ok) return;
      const byDate = {};
      recordsUi.selected.forEach((key) => { const i = key.indexOf('|'); const date = key.slice(0, i), id = key.slice(i + 1); (byDate[date] = byDate[date] || []).push(id); });
      let removed = 0;
      for (const date of Object.keys(byDate)) {
        const day = getDay(date); if (!day) continue;
        const keep = day.records.filter((r) => !byDate[date].includes(r.id));
        removed += day.records.length - keep.length;
        await saveDay(date, keep);
      }
      recordsUi.selected.clear();
      toast(`${removed} record${removed === 1 ? '' : 's'} deleted.`, 'ok');
      renderView();
    },
    'rec-edit': (el) => recordEditModal(el.dataset.date, el.dataset.id),
    'rec-del': async (el) => {
      const ok = await confirmDialog('Delete this record? This cannot be undone.', { okLabel: 'Delete', danger: true });
      if (!ok) return;
      const day = getDay(el.dataset.date);
      if (!day) return;
      await saveDay(el.dataset.date, day.records.filter((r) => r.id !== el.dataset.id));
      toast('Record deleted.', 'ok');
      renderView();
    },
    'rec-dup': async (el) => {
      const day = getDay(el.dataset.date);
      const rec = day && day.records.find((r) => r.id === el.dataset.id);
      if (!rec) return;
      const ref = await claimPaymentRef(el.dataset.date);
      const clone = Object.assign({}, rec, { id: genId(), paymentRef: ref, status: 'Pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await saveDay(el.dataset.date, day.records.concat([clone]));
      toast('Record duplicated — edit as needed.', 'ok');
      renderView();
    },
    'rec-bulk-status': async () => {
      const sel = document.getElementById('bulkStatusSelect');
      const newStatus = sel ? sel.value : 'Pending';
      const byDate = {};
      recordsUi.selected.forEach((key) => { const [date, id] = key.split('|'); (byDate[date] = byDate[date] || []).push(id); });
      for (const date of Object.keys(byDate)) {
        const day = getDay(date); if (!day) continue;
        const records = day.records.map((r) => byDate[date].includes(r.id) ? Object.assign({}, r, { status: newStatus, updatedAt: new Date().toISOString() }) : r);
        await saveDay(date, records);
      }
      recordsUi.selected.clear();
      toast('Status updated.', 'ok');
      renderView();
    },

    // Drivers
    'driver-add': () => driverModal(null),
    'driver-edit': (el) => driverModal(state.drivers.find((d) => d.id === el.dataset.id)),
    'driver-history': (el) => { state.recordsFilter = { driver: el.dataset.name, search: '', from: '', to: '', vehicle: '', block: '' }; setRoute('records'); },
    'driver-deactivate': async (el) => {
      const ok = await confirmDialog('Deactivate this driver? Historical records are kept.', { okLabel: 'Deactivate', danger: true });
      if (!ok) return;
      await state.db.doc('drivers/' + el.dataset.id).update({ active: false });
      await loadDrivers(); toast('Driver deactivated.', 'ok'); renderView();
    },
    'driver-reactivate': async (el) => {
      await state.db.doc('drivers/' + el.dataset.id).update({ active: true });
      await loadDrivers(); toast('Driver reactivated.', 'ok'); renderView();
    },
    'driver-delete-account': async (el) => {
      if (!isAdmin()) { toast('Only Admin can delete Driver accounts.', 'err'); return; }
      const id = el.dataset.id;
      const driver = state.drivers.find((item) => item.id === id);
      if (!driver) return;
      const ok = await confirmDialog(
        `Delete ${driver.name}'s Driver profile and linked login? Historical delivery submissions and payment records will be retained; future assignments and the linked login will be removed. This cannot be undone.`,
        { okLabel: 'Delete account', danger: true }
      );
      if (!ok) return;
      await state.db.doc('drivers/' + id).delete();
      await loadDrivers(); await loadStaff(); await loadDriverAssignments();
      toast('Driver profile deleted; historical submissions and payments were retained.', 'ok');
      renderView();
    },
    'driver-tab': (el) => { driversUi.tab = el.dataset.tab; renderView(); },

    // Companies
    'company-add': () => companyModal(null),
    'company-edit': (el) => companyModal(state.companies.find((c) => c.id === el.dataset.id)),
    'company-tab': (el) => { companiesUi.tab = el.dataset.tab; renderView(); },
    'company-deactivate': async (el) => {
      const ok = await confirmDialog('Deactivate this company? Historical records and exports are kept.', { okLabel: 'Deactivate', danger: true });
      if (!ok) return;
      await state.db.doc('companies/' + el.dataset.id).update({ active: false });
      await loadCompanies(); toast('Company deactivated.', 'ok'); renderView();
    },
    'company-reactivate': async (el) => {
      await state.db.doc('companies/' + el.dataset.id).update({ active: true });
      await loadCompanies(); toast('Company reactivated.', 'ok'); renderView();
    },
    'company-manage-rates': (el) => { rateCardsUi.companyId = el.dataset.id; setRoute('rate-cards'); },

    // Summary
    'summary-range': (el) => { summaryUi.range = el.dataset.range; renderView(); },

    // Dashboard
    'dash-range': (el) => { dashboardUi.range = el.dataset.range; renderView(); },

    // Export
    'export-mode': (el) => { exportUi.mode = el.dataset.mode; renderView(); },
    'export-run': runExport,
    'import-run': runImportPreview,
    'import-commit': commitImport,

    // Staff
    'staff-add': () => openModal(`
      <div class="modal-head"><h3>Add staff</h3><button data-action="modal-close" aria-label="Close">✕</button></div>
      <form data-onsubmit="staff-save">
        <div class="field" style="margin-bottom:12px;"><label class="field-label">Name</label><input type="text" name="name" required></div>
        <div class="field" style="margin-bottom:12px;"><label class="field-label">Mobile number</label><input type="tel" inputmode="numeric" name="mobile" required></div>
        <div class="field" style="margin-bottom:12px;"><label class="field-label">4-digit PIN</label><input type="password" name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></div>
        <div class="field"><label class="field-label">Role</label><select name="role"><option value="staff">Staff</option><option value="manager">Manager</option><option value="admin">Admin</option></select></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;"><button type="button" class="btn" data-action="modal-close">Cancel</button><button type="submit" class="btn btn-primary">Add</button></div>
      </form>
    `),
    'staff-reset-pin': () => openModal(`
      <div class="modal-head"><h3>Reset PIN</h3><button data-action="modal-close" aria-label="Close">✕</button></div>
      <form data-onsubmit="staff-reset-pin-save" data-id="${document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.id : ''}">
        <div class="field"><label class="field-label">New 4-digit PIN</label><input type="password" name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;"><button type="button" class="btn" data-action="modal-close">Cancel</button><button type="submit" class="btn btn-primary">Save</button></div>
      </form>
    `),
    'staff-toggle-role': async (el) => {
      // Cycles plain staff logins through admin/manager/staff. Never touches
      // a 'labour' role here — those are only created via the Labour page
      // and stay tied to their labourId.
      const s = state.staff.find((x) => x.id === el.dataset.id);
      if (!s) { toast('Account not found. Refresh and try again.', 'err'); return; }
      if (s.role === 'labour') { toast('This is a labour portal login — manage it from the Labour page.', 'err'); return; }
      if (s.role === 'driver') { toast('This is a driver portal login — manage it from the Drivers page.', 'err'); return; }
      const next = s.role === 'admin' ? 'manager' : s.role === 'manager' ? 'staff' : 'admin';
      await state.db.doc('staff/' + el.dataset.id).update({ role: next });
      await loadStaff();
      if (state.session && state.session.staffId === s.id) {
        const updatedSelf = state.staff.find((x) => x.id === s.id);
        if (updatedSelf && updatedSelf.active !== false) {
          state.session = sessionFromStaff(updatedSelf);
          if (!state.remoteDb) persistSession(state.session);
          if (!roleAllowed(state.route, state.session.role)) state.route = 'dashboard';
          history.replaceState(null, '', location.pathname + location.search + '#' + state.route);
          renderSidebar();
        }
      }
      renderView();
    },
    'staff-deactivate': async (el) => {
      await state.db.doc('staff/' + el.dataset.id).update({ active: false });
      await loadStaff();
      if (state.session && state.session.staffId === el.dataset.id) { showLoginGate(); toast('This account has been deactivated.', 'err'); return; }
      renderView();
    },
    'staff-reactivate': async (el) => { await state.db.doc('staff/' + el.dataset.id).update({ active: true }); await loadStaff(); renderView(); },
    'staff-delete-account': async (el) => {
      if (!isAdmin()) { toast('Only Admin can delete login accounts.', 'err'); return; }
      const id = el.dataset.id;
      const staff = state.staff.find((item) => item.id === id);
      if (!staff || (state.session && state.session.staffId === id)) return;
      const ok = await confirmDialog(
        `Delete the ${staff.role} login for ${staff.name}? This revokes the login and all active sessions. The Driver/Labour profile and historical operations remain unless you delete that profile from its own page.`,
        { okLabel: 'Delete login', danger: true }
      );
      if (!ok) return;
      await state.db.doc('staff/' + id).delete();
      await loadStaff();
      toast('Login deleted and sessions revoked.', 'ok');
      renderView();
    },
    'settings-add-holiday': async () => {
      const input = document.getElementById('newPublicHoliday');
      const date = input ? input.value : '';
      if (!date) { toast('Pick a date first.', 'err'); return; }
      const list = (state.settings.publicHolidays || []).slice();
      if (!list.includes(date)) list.push(date);
      await saveSettings({ publicHolidays: list });
      renderView(); toast('Public holiday added.', 'ok');
    },
    'settings-remove-holiday': async (el) => {
      const list = (state.settings.publicHolidays || []).filter((d) => d !== el.dataset.date);
      await saveSettings({ publicHolidays: list });
      renderView(); toast('Public holiday removed.', 'ok');
    },
    'settings-add-failure-reason': async () => {
      const input = document.getElementById('newFailureReason');
      const reason = input ? input.value.trim() : '';
      if (!reason) { toast('Type a reason first.', 'err'); return; }
      const list = (state.settings.failureReasons || []).slice();
      if (!list.includes(reason)) list.push(reason);
      await saveSettings({ failureReasons: list });
      renderView(); toast('Failure reason added.', 'ok');
    },
    'settings-remove-failure-reason': async (el) => {
      const list = (state.settings.failureReasons || []).filter((r) => r !== el.dataset.reason);
      await saveSettings({ failureReasons: list });
      renderView(); toast('Failure reason removed.', 'ok');
    },

    // Mobile nav
    'open-drawer': () => { document.getElementById('mobilenav').classList.remove('hidden'); document.getElementById('drawer-backdrop').classList.remove('hidden'); },
    'entry-date-today': () => { state.entryDate = todayStr(); loadEntryRowsForDate(); renderView(); },
  };

  // fix staff-reset-pin to carry the id properly (button click target, not activeElement)
  ACTIONS['staff-reset-pin'] = (el) => openModal(`
    <div class="modal-head"><h3>Reset PIN</h3><button data-action="modal-close" aria-label="Close">✕</button></div>
    <form data-onsubmit="staff-reset-pin-save" data-id="${el.dataset.id}">
      <div class="field"><label class="field-label">New 4-digit PIN</label><input type="password" name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;"><button type="button" class="btn" data-action="modal-close">Cancel</button><button type="submit" class="btn btn-primary">Save</button></div>
    </form>
  `);

  const CHANGE_HANDLERS = {
    'route-file': async (el) => {
      const file = el.files && el.files[0]; if (!file) return;
      try { routeUi.draft = await readRunSheet(file); renderView(); }
      catch (e) { el.value = ''; toast(e.message, 'err'); }
    },
    'route-map': (el) => {
      if (!routeUi.draft) return;
      routeUi.draft.map[el.dataset.field] = Number(el.value);
      const form = el.closest('form'); const keep = form ? { startMode: form.startMode.value, finish: form.finish.value, startAddress: form.startAddress.value } : null;
      renderView();
      const f2 = document.querySelector('form[data-onsubmit="route-plan"]');
      if (f2 && keep) { f2.startMode.value = keep.startMode; f2.finish.value = keep.finish; f2.startAddress.value = keep.startAddress; document.getElementById('routeStartAddress').style.display = keep.startMode === 'address' ? '' : 'none'; }
    },
    'route-start-mode': (el) => { const box = document.getElementById('routeStartAddress'); if (box) box.style.display = el.value === 'address' ? '' : 'none'; },
    'route-admin-date': (el) => { routeUi.adminDate = el.value; routeUi.viewId = null; renderView(); },
    'entry-date-change': async (el) => { state.entryDate = el.value; loadEntryRowsForDate(state.entryDate); renderView(); },
    'entry-field': (el) => {
      const row = state.entryRows.find((r) => r.id === el.dataset.row);
      if (!row) return;
      // The driver name field is free text with <datalist> suggestions — any
      // brand-new name typed here is created quietly when the row is saved.
      row[el.dataset.field] = el.type === 'number' ? Number(el.value) : el.value;
      renderView();
    },
    'bulk-text-change': (el) => { state.bulkText = el.value; renderView(); },
    'bulk-field': (el) => {
      const row = (state.bulkRows || []).find((r) => r.id === el.dataset.row);
      if (!row) return;
      row[el.dataset.field] = el.type === 'number' ? Number(el.value) : el.value;
      renderView();
    },
    'rec-filter': (el) => { recordsUi[el.dataset.field] = el.value; renderView(); },
    'driver-search': (el) => { driversUi.search = el.value; renderView(); },
    'summary-custom': (el) => { summaryUi[el.dataset.field] = el.value; renderView(); },
    'summary-only-active': (el) => { summaryUi.onlyActive = el.checked; renderView(); },
    'dash-custom': (el) => { dashboardUi[el.dataset.field] = el.value; renderView(); },
    'payment-filter': (el) => { paymentsUi[el.dataset.field] = el.value; renderView(); },
    'payment-status': async (el) => {
      const day = getDay(el.dataset.date); if (!day) return;
      const records = day.records.map((r) => r.id === el.dataset.id ? Object.assign({}, r, { status: el.value, updatedAt: new Date().toISOString() }) : r);
      await saveDay(el.dataset.date, records);
      toast('Status updated.', 'ok');
    },
    'export-field': (el) => { exportUi[el.dataset.field] = el.value; renderView(); },
    'edit-modal-recalc': (el) => {
      const form = el.closest('form');
      if (!form) return;
      const companySel = form.querySelector('[name="companyName"]');
      const vehicleSel = form.querySelector('[name="vehicle"]');
      const parcelsInput = form.querySelector('[name="parcels"]');
      const baseInput = form.querySelector('[name="baseRate"]');
      const company = companyByName(companySel.value);
      const perParcel = company && company.rateType === 'per_parcel';
      if (parcelsInput) parcelsInput.disabled = !perParcel;
      if (baseInput) baseInput.value = computeBaseRate(companySel.value, vehicleSel ? vehicleSel.value : 'Car', parcelsInput ? parcelsInput.value : 0);
    },
    'company-search': (el) => { companiesUi.search = el.value; renderView(); },
    'company-rate-type-change': (el) => {
      const form = el.closest('form');
      if (!form) return;
      const unit = el.value === 'per_parcel' ? '/parcel' : '/block';
      form.querySelectorAll('.rate-unit').forEach((s) => { s.textContent = unit; });
    },
    'company-type-change': (el) => {
      const form = el.closest('form');
      if (!form) return;
      const del = form.querySelector('#companyDeliveryFields');
      const lab = form.querySelector('#companyLabourFields');
      if (el.value === 'labour') { if (del) del.style.display = 'none'; if (lab) lab.style.display = ''; }
      else { if (del) del.style.display = ''; if (lab) lab.style.display = 'none'; }
    },
  };

  const SUBMIT_HANDLERS = {
    'route-plan': async (form) => { await planRoute(form); },
    'route-stop-save': async (form) => {
      const route = state.routes.find((r) => r.id === form.dataset.route); if (!route) return;
      const old = route.stops.find((x) => x.id === form.dataset.stop); if (!old) return;
      const fd = new FormData(form); const get = (k) => String(fd.get(k) || '').trim();
      const btn = form.querySelector('button[type="submit"]'); btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const stop = Object.assign({}, old, {
          notes: get('notes'), access: get('access'), name: get('name'), phone: get('phone'), email: get('email'),
          parcels: Math.min(99, Math.max(1, Number(fd.get('parcels')) || 1)), refs: get('refs').split(',').map((x) => x.trim()).filter(Boolean),
          pkg: { size: get('pkgSize'), type: get('pkgType'), position: get('pkgPosition'), side: get('pkgSide'), surface: get('pkgSurface') },
          stopType: get('stopType') === 'pickup' ? 'pickup' : 'delivery', placement: ['first', 'last'].includes(get('placement')) ? get('placement') : 'auto',
          windowStart: get('windowStart'), windowEnd: get('windowEnd'), serviceMin: get('serviceMin') === '' ? null : Math.max(0, Number(get('serviceMin'))), colour: get('colour'),
        });
        const addressInput = form.querySelector('input[name="address"]');
        const newAddress = get('address');
        let moved = false;
        if (newAddress && newAddress !== old.address) {
          const g = await lookupOne(addressInput);
          if (!g || g.error) { toast((g && g.error) || 'Address not found', 'err'); btn.disabled = false; btn.textContent = 'Save'; return; }
          Object.assign(stop, { address: newAddress, lat: g.lat, lng: g.lng, formatted: g.formatted, precision: g.precision, partial: !!g.partial, parts: null });
          moved = true;
        }
        const file = form.querySelector('input[name="photo"]').files[0];
        if (file) {
          const image = await readAndCompressImage(file, 900);
          const ref = await state.db.collection('routePhotos').add({ driverId: route.driverId, routeId: route.id, stopId: stop.id, image, createdAt: new Date().toISOString() });
          stop.photoId = ref.id;
        }
        if (fd.get('rememberAccess') && stop.access) {
          fetch('/api/route/address-note', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: stop.address, note: stop.access }) }).catch(() => {});
        }
        let stops = route.stops.map((x) => (x.id === stop.id ? stop : x));
        if (stop.status === 'pending' && stop.placement !== old.placement && stop.placement !== 'auto') {
          stops = stops.filter((x) => x.id !== stop.id);
          if (stop.placement === 'first') { const at = stops.findIndex((x) => x.status === 'pending'); stops.splice(at < 0 ? stops.length : at, 0, stop); }
          else stops.push(stop);
          moved = true;
        }
        const timing = stop.windowStart !== old.windowStart || stop.windowEnd !== old.windowEnd || stop.serviceMin !== old.serviceMin;
        if (moved || timing) await applyStops(route, stops); else await saveRouteStops(route, { stops });
        closeModal(); renderView();
        toast(timing && stop.status === 'pending' ? 'Saved. Tap Re-optimise to fit the new arrival time.' : 'Stop saved.', 'ok');
      } catch (e) { btn.disabled = false; btn.textContent = 'Save'; toast(e.message, 'err'); }
    },
    'route-stop-add-save': async (form) => {
      const route = state.routes.find((r) => r.id === form.dataset.route); if (!route) return;
      const fd = new FormData(form); const get = (k) => String(fd.get(k) || '').trim();
      const btn = form.querySelector('button[type="submit"]'); btn.disabled = true; btn.textContent = 'Finding address…';
      try {
        const g = await lookupOne(form.querySelector('input[name="address"]'));
        if (!g || g.error) { toast((g && g.error) || 'Address not found', 'err'); btn.disabled = false; btn.textContent = 'Add to route'; return; }
        const stop = { id: 's' + genId(), address: get('address'), name: get('name'), phone: get('phone'), email: '', notes: get('notes'), access: g.access || '', refs: [],
          parcels: Math.min(99, Math.max(1, Number(fd.get('parcels')) || 1)), stopType: get('stopType') === 'pickup' ? 'pickup' : 'delivery', placement: 'auto',
          lat: g.lat, lng: g.lng, formatted: g.formatted, precision: g.precision, partial: !!g.partial, status: 'pending', reason: '', doneAt: null };
        const stops = route.stops.slice();
        const at = insertCheapest(route, stops, stop);
        await applyStops(route, stops);
        closeModal(); renderView(); toast(`Added as stop ${at + 1}.`, 'ok');
      } catch (e) { btn.disabled = false; btn.textContent = 'Add to route'; toast(e.message, 'err'); }
    },
    'route-fail-save': async (form) => {
      const route = state.routes.find((r) => r.id === form.dataset.route); if (!route) return;
      const fd = new FormData(form);
      const reason = [fd.get('reason'), String(fd.get('note') || '').trim()].filter(Boolean).join(' — ');
      const stops = route.stops.map((s) => s.id === form.dataset.stop ? Object.assign({}, s, { status: 'failed', reason, doneAt: new Date().toISOString() }) : s);
      try { await saveRouteStops(route, { stops }); closeModal(); renderView(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
      catch (e) { toast(e.message, 'err'); }
    },
    'route-fix-address': async (form) => {
      const route = state.routes.find((r) => r.id === form.dataset.route); if (!route) return;
      const idx = Number(form.dataset.index); const u = (route.unmatched || [])[idx]; if (!u) return;
      const address = String(new FormData(form).get('address') || '').trim(); if (!address) return;
      try {
        const [g] = await geocodeForRoute([address]);
        if (g.error) { toast(/not found/i.test(g.error) ? g.error + ' — try adding the suburb and postcode.' : g.error, 'err'); return; }
        const stop = Object.assign({}, u, { address, lat: g.lat, lng: g.lng, formatted: g.formatted, precision: g.precision, partial: g.partial, id: 's' + genId(), status: 'pending', reason: '', doneAt: null });
        delete stop.error;
        const stops = route.stops.slice();
        const bestAt = insertCheapest(route, stops, stop);
        const unmatched = route.unmatched.filter((_, i) => i !== idx);
        const m = await routeMetrics(Object.assign({}, route, { stops }), routeAnchor(route));
        await saveRouteStops(route, { stops: m.stops, unmatched, distanceKm: m.distanceKm, driveMin: m.driveMin, returnLegSec: m.returnLegSec, geometry: m.geometry, metricsSource: m.metricsSource });
        renderView(); toast(`Added as stop ${bestAt + 1}.`, 'ok');
      } catch (e) { toast(e.message, 'err'); }
    },
    'gate-signup-admin': async (form) => {
      const fd = new FormData(form);
      const name = String(fd.get('name') || '').trim();
      const mobileInput = String(fd.get('mobile') || '').trim();
      const mobile = normalizeMobile(mobileInput);
      const pin = String(fd.get('pin') || '').trim();
      if (!name) { toast('Enter your name.', 'err'); return; }
      if (mobile.length < 8 || mobile.length > 15) { toast('Enter a valid mobile number.', 'err'); return; }
      if (!/^[0-9]{4}$/.test(pin)) { toast('Your PIN must be exactly 4 digits.', 'err'); return; }
      if (state.remoteDb) {
        const result = await state.db.authSignup(name, mobile, pin);
        state.session = sessionFromStaff(result.user);
        await loadAll();
      } else {
        const ref = await state.db.collection('staff').add({ name, mobile, pin, role: 'admin', active: true, createdAt: new Date().toISOString() });
        await loadStaff();
        state.session = { staffId: ref.id, name, role: 'admin' };
        persistSession(state.session);
      }
      document.getElementById('gate').innerHTML = ''; document.getElementById('gate').classList.add('hidden');
      boot2();
    },
    'gate-mobile-continue': async (form) => {
      if (gateSubmitting) return;
      gateSubmitting = true;
      clearGateError();
      try {
        const fd = new FormData(form);
        const rawMobile = String(fd.get('mobile') || '').trim();
        const mobile = normalizeMobile(rawMobile);
        gateMobileDraft = rawMobile;
        if (mobile.length < 8 || mobile.length > 15) {
          showGateError('Enter a mobile number like 0412 345 678.');
          return;
        }

        // In shared mode, look up only accounts matching this mobile number.
        // In local preview mode, retain the original per-device lookup.
        let matches;
        if (state.remoteDb) {
          matches = await state.db.lookupStaff(mobile);
          state.staff = matches;
        } else {
          await loadStaff();
          matches = state.staff.filter((account) => account.active !== false
            && normalizeMobile(account.mobile) === mobile);
        }

        if (!matches.length) {
          showGateError(state.usingFallback
            ? 'No account uses this number on this phone. Ask your manager to check your login — don\'t create a new one.'
            : 'No account uses this number. Check it with your manager.');
          return;
        }

        gateCandidateStaffIds = matches.map((account) => account.id);
        pinBuffer = '';
        if (matches.length > 1) {
          pinTargetStaffId = null;
          gateStage = 'account';
        } else {
          pinTargetStaffId = matches[0].id;
          gateStage = 'pin';
        }
        renderGate();
      } finally {
        gateSubmitting = false;
      }
    },
    'rec-save-edit': async (form) => {
      const fd = new FormData(form);
      const oldDate = form.dataset.date, id = form.dataset.id, newDate = fd.get('date');
      const oldDay = getDay(oldDate);
      const rec = oldDay.records.find((r) => r.id === id);
      // Driver is a free-text field with suggestions here too: reuse an existing
      // driver regardless of case/spacing, or quietly create a new one.
      const typedDriverName = (fd.get('driverName') || '').trim();
      const existingDriver = driverByNameLoose(typedDriverName);
      if (!existingDriver && typedDriverName) {
        await state.db.collection('drivers').add({ name: typedDriverName, vehicleType: fd.get('vehicle') || 'Car', active: true, createdAt: new Date().toISOString() });
        await loadDrivers();
      }
      const finalDriverName = existingDriver ? existingDriver.name : typedDriverName;
      const updated = Object.assign({}, rec, {
        block: fd.get('block'), driverName: finalDriverName, vehicle: fd.get('vehicle'),
        companyName: fd.get('companyName') || '', parcels: Number(fd.get('parcels')) || 0,
        baseRate: Number(fd.get('baseRate')) || 0, bonus: Number(fd.get('bonus')) || 0, adjustment: Number(fd.get('adjustment')) || 0,
        status: fd.get('status'), notes: fd.get('notes'), updatedAt: new Date().toISOString(),
      });
      if (newDate !== oldDate) {
        await saveDay(oldDate, oldDay.records.filter((r) => r.id !== id));
        const newDay = getDay(newDate);
        await saveDay(newDate, (newDay ? newDay.records.slice() : []).concat([updated]));
      } else {
        await saveDay(oldDate, oldDay.records.map((r) => r.id === id ? updated : r));
      }
      closeModal(); toast('Record updated.', 'ok'); renderView();
    },
    'driver-save': async (form) => {
      const fd = new FormData(form);
      const id = form.dataset.id;
      const data = { name: fd.get('name').trim(), vehicleType: fd.get('vehicleType') };
      if (id) await state.db.doc('drivers/' + id).update(data);
      else await state.db.collection('drivers').add(Object.assign({ active: true, createdAt: new Date().toISOString() }, data));
      await loadDrivers(); closeModal(); toast('Driver saved.', 'ok'); renderView();
    },
    'company-save': async (form) => {
      const fd = new FormData(form);
      const id = form.dataset.id;
      const type = fd.get('type') || 'delivery';
      const data = { name: fd.get('name').trim(), type };
      if (type === 'labour') {
        data.rate = Number(fd.get('rate')) || 0;
        data.rateType = 'fixed'; data.carRate = 0; data.vanRate = 0; data.otherRate = 0;
        data.abn = fd.get('abn') || ''; data.contactPerson = fd.get('contactPerson') || '';
        data.email = fd.get('email') || ''; data.phone = fd.get('phone') || '';
        data.siteAddress = fd.get('siteAddress') || '';
        data.contractStartDate = fd.get('contractStartDate') || ''; data.contractEndDate = fd.get('contractEndDate') || '';
        data.contractStatus = fd.get('contractStatus') || 'Active';
        const coordsText = String(fd.get('siteCoords') || '').trim();
        if (coordsText) {
          const pin = parseSiteCoords(coordsText);
          if (!pin) { toast('Site pin should look like: -33.86882, 151.20929', 'err'); return; }
          data.siteLat = pin.lat; data.siteLng = pin.lng;
        } else {
          data.siteLat = null; data.siteLng = null;
        }
        data.siteRadius = Math.min(5000, Math.max(25, Number(fd.get('siteRadius')) || 200));
      } else {
        data.rateType = fd.get('rateType');
        data.carRate = Number(fd.get('carRate')) || 0;
        data.vanRate = Number(fd.get('vanRate')) || 0;
        data.otherRate = Number(fd.get('otherRate')) || 0;
        data.rate = 0;
      }
      if (id) await state.db.doc('companies/' + id).update(data);
      else await state.db.collection('companies').add(Object.assign({ active: true, createdAt: new Date().toISOString() }, data));
      await loadCompanies(); closeModal(); toast('Company saved.', 'ok'); renderView();
    },
    'staff-save': async (form) => {
      const fd = new FormData(form);
      const mobile = normalizeMobile(fd.get('mobile'));
      if (!mobile) { toast('Enter a mobile number.', 'err'); return; }
      if (mobileTaken(mobile, null)) { toast('That mobile number is already used for another login.', 'err'); return; }
      await state.db.collection('staff').add({ name: fd.get('name').trim(), mobile, pin: fd.get('pin'), role: fd.get('role'), active: true, createdAt: new Date().toISOString() });
      await loadStaff(); closeModal(); toast('Staff added.', 'ok'); renderView();
    },
    'staff-reset-pin-save': async (form) => {
      const fd = new FormData(form);
      await state.db.doc('staff/' + form.dataset.id).update({ pin: fd.get('pin') });
      await loadStaff(); closeModal(); toast('PIN reset.', 'ok');
    },
    'settings-save-rates': async (form) => {
      const fd = new FormData(form);
      await saveSettings({ businessName: fd.get('businessName') });
      renderSidebar(); renderView(); toast('Business name saved.', 'ok');
    },
    'settings-save-route': async (form) => {
      await saveSettings({ routeDepotAddress: String(new FormData(form).get('routeDepotAddress') || '').trim() });
      renderView(); toast('Depot address saved.', 'ok');
    },
    'settings-save-invoice': async (form) => {
      const fd = new FormData(form);
      const get = (k) => String(fd.get(k) || '').trim();
      await saveSettings({
        invoiceAbn: get('invoiceAbn'), invoicePhone: get('invoicePhone'), invoiceEmail: get('invoiceEmail'),
        invoiceAddress: get('invoiceAddress'), invoiceGst: get('invoiceGst') === 'add10' ? 'add10' : 'none',
        invoiceTermsDays: Math.min(120, Math.max(0, Number(fd.get('invoiceTermsDays')) || 0)),
        invoiceBankName: get('invoiceBankName'), invoiceBsb: get('invoiceBsb'), invoiceAccount: get('invoiceAccount'),
        invoiceNote: get('invoiceNote'),
      });
      renderView(); toast('Invoice details saved.', 'ok');
    },
    'settings-save-prefix': async (form) => {
      const fd = new FormData(form);
      const ok = await confirmDialog('This changes how new payment references are generated. Existing references are not affected.', { okLabel: 'Save format' });
      if (!ok) return;
      await saveSettings({ prefixFormat: fd.get('prefixFormat'), nextPaymentNumber: Number(fd.get('nextPaymentNumber')) || 1 });
      renderView(); toast('Payment format saved.', 'ok');
    },
    'settings-save-tiers': async (form) => {
      const fd = new FormData(form);
      await saveSettings({
        overtimeThresholdHours: Number(fd.get('overtimeThresholdHours')) || 8,
        nightShiftStart: fd.get('nightShiftStart') || '18:00',
        nightShiftEnd: fd.get('nightShiftEnd') || '06:00',
      });
      renderView(); toast('Rate tier rules saved.', 'ok');
    },
    'settings-save-delivery': async (form) => {
      const fd = new FormData(form);
      await saveSettings({
        submissionPrefixFormat: fd.get('submissionPrefixFormat') || 'SUB-{NUMBER}',
        nextSubmissionNumber: Number(fd.get('nextSubmissionNumber')) || 1,
        screenshotRequired: fd.get('screenshotRequired') === 'on',
      });
      renderView(); toast('Delivery settings saved.', 'ok');
    },
  };


  // ---------------------------------------------------------------
  // Address suggestions (works on every address box)
  // ---------------------------------------------------------------
  // Any text input whose name ends in "address" (or has data-address) gets a
  // drop-down of Australian address suggestions from Photon, a free
  // OpenStreetMap search made for search-as-you-type. Picking one fills the
  // box; on a company form it also fills the clock-in site pin, and the
  // address is saved for the route planner so it never needs looking up again.
  const AU_STATES = { 'New South Wales': 'NSW', Victoria: 'VIC', Queensland: 'QLD', 'Western Australia': 'WA', 'South Australia': 'SA', Tasmania: 'TAS', 'Australian Capital Territory': 'ACT', 'Northern Territory': 'NT' };
  const addrUi = { input: null, box: null, items: [], active: -1, timer: null, ctl: null, cache: new Map() };
  const isAddressInput = (el) => el && el.tagName === 'INPUT' && !el.disabled && !el.readOnly && (el.type === 'text' || el.type === 'search' || !el.type) &&
    (el.hasAttribute('data-address') || /address$/i.test(el.name || ''));
  function addrLabel(p) {
    const street = p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street ? (p.name && p.name !== p.street ? `${p.name}, ${p.street}` : p.street) : (p.name || '');
    const suburb = p.locality || p.district || p.city || p.county || '';
    const st = AU_STATES[p.state] || p.state || '';
    return [street, [suburb, st, p.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  }
  async function addrFetch(q) {
    const key = q.toLowerCase();
    if (addrUi.cache.has(key)) return addrUi.cache.get(key);
    if (addrUi.ctl) addrUi.ctl.abort();
    addrUi.ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const url = 'https://photon.komoot.io/api/?' + new URLSearchParams({ q, limit: '7', lang: 'en', bbox: '112.9,-43.7,153.7,-10.6' }).toString();
    const res = await fetch(url, addrUi.ctl ? { signal: addrUi.ctl.signal } : {});
    if (!res.ok) throw new Error('suggestions unavailable');
    const data = await res.json();
    const seen = new Set();
    const items = (data.features || []).filter((f) => !f.properties.countrycode || f.properties.countrycode === 'AU').map((f) => ({
      label: addrLabel(f.properties), lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0],
      exact: !!(f.properties.housenumber), type: f.properties.osm_value || f.properties.type || '',
    })).filter((it) => it.label && !seen.has(it.label) && seen.add(it.label));
    addrUi.cache.set(key, items);
    return items;
  }
  function addrClose() {
    if (addrUi.box) addrUi.box.remove();
    if (addrUi.input) { addrUi.input.setAttribute('aria-expanded', 'false'); addrUi.input.removeAttribute('aria-activedescendant'); }
    addrUi.box = null; addrUi.items = []; addrUi.active = -1;
  }
  function addrPosition() {
    if (!addrUi.box || !addrUi.input) return;
    const r = addrUi.input.getBoundingClientRect();
    if (!r.width) { addrClose(); return; }
    // Use the visible area (excludes a phone's on-screen keyboard) and open
    // above the box when there isn't room below it.
    const vv = window.visualViewport;
    const viewH = vv ? vv.height + vv.offsetTop : window.innerHeight;
    const below = viewH - r.bottom - 8, above = r.top - 8;
    const width = Math.min(Math.max(r.width, 260), window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    const style = { left: left + 'px', width: width + 'px', top: '', bottom: '' };
    if (below < 180 && above > below) {
      style.bottom = (window.innerHeight - r.top + 4) + 'px';
      style.maxHeight = Math.min(300, above) + 'px';
    } else {
      style.top = (r.bottom + 4) + 'px';
      style.maxHeight = Math.min(300, Math.max(120, below)) + 'px';
    }
    Object.assign(addrUi.box.style, style);
  }
  function addrRender(items, input) {
    addrUi.items = items; addrUi.active = -1;
    if (!addrUi.box) {
      addrUi.box = document.createElement('div');
      addrUi.box.className = 'addr-suggest'; addrUi.box.id = 'addrSuggest'; addrUi.box.setAttribute('role', 'listbox');
      addrUi.box.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
      document.body.appendChild(addrUi.box);
    }
    input.setAttribute('aria-controls', 'addrSuggest'); input.setAttribute('aria-expanded', 'true');
    addrUi.box.innerHTML = items.length
      ? items.map((it, i) => `<div class="addr-option" role="option" id="addrOpt${i}" data-index="${i}">${esc(it.label)}${it.exact ? '' : '<span class="addr-hint">street / area</span>'}</div>`).join('') + '<div class="addr-credit">Suggestions © OpenStreetMap</div>'
      : '<div class="addr-empty">No matching addresses — keep typing, or enter it in full.</div>';
    addrUi.box.querySelectorAll('.addr-option').forEach((el) => el.addEventListener('click', () => addrPick(Number(el.dataset.index))));
    addrPosition();
  }
  function addrHighlight(i) {
    const opts = addrUi.box ? addrUi.box.querySelectorAll('.addr-option') : [];
    if (!opts.length) return;
    addrUi.active = (i + opts.length) % opts.length;
    opts.forEach((o, k) => o.setAttribute('aria-selected', k === addrUi.active ? 'true' : 'false'));
    addrUi.input.setAttribute('aria-activedescendant', 'addrOpt' + addrUi.active);
    opts[addrUi.active].scrollIntoView({ block: 'nearest' });
  }
  function addrPick(i) {
    const it = addrUi.items[i]; const input = addrUi.input;
    if (!it || !input) return;
    input.value = it.label;
    input.dataset.lat = it.lat; input.dataset.lng = it.lng;
    const form = input.form || input.closest('form');
    const pin = form && form.querySelector('input[name="siteCoords"]');
    if (pin && input.name === 'siteAddress' && it.exact) { pin.value = Number(it.lat).toFixed(6) + ', ' + Number(it.lng).toFixed(6); toast('Site pin filled in from the address.', 'ok'); }
    addrClose();
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (it.exact && state.session && ['admin', 'manager', 'staff', 'driver'].includes(state.session.role)) {
      fetch('/api/route/geocache', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ address: it.label, lat: it.lat, lng: it.lng, formatted: it.label, precision: 'house', partial: false }] }) }).catch(() => {});
    }
  }
  function setupAddressSuggestions() {
    document.addEventListener('input', (e) => {
      const el = e.target;
      if (!isAddressInput(el)) return;
      addrUi.input = el; el.setAttribute('autocomplete', 'off'); el.setAttribute('aria-autocomplete', 'list');
      delete el.dataset.lat; delete el.dataset.lng;
      clearTimeout(addrUi.timer);
      const q = el.value.trim();
      if (q.length < 3) { addrClose(); return; }
      addrUi.timer = setTimeout(async () => {
        try { const items = await addrFetch(q); if (addrUi.input === el && document.activeElement === el && el.value.trim() === q) addrRender(items, el); }
        catch (err) { if (err && err.name !== 'AbortError') addrClose(); }
      }, 300);
    });
    document.addEventListener('keydown', (e) => {
      if (!addrUi.box || e.target !== addrUi.input) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); addrHighlight(addrUi.active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); addrHighlight(addrUi.active - 1); }
      else if (e.key === 'Enter' && addrUi.active >= 0) { e.preventDefault(); addrPick(addrUi.active); }
      else if (e.key === 'Escape') { addrClose(); }
    });
    document.addEventListener('focusout', (e) => { if (e.target === addrUi.input) setTimeout(() => { if (document.activeElement !== addrUi.input) addrClose(); }, 150); });
    window.addEventListener('resize', addrPosition);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', addrPosition);
    document.addEventListener('scroll', addrPosition, true);
  }
  setupAddressSuggestions();

  document.addEventListener('click', async (e) => {
    const target = e.target;
    const el = target && target.closest ? target.closest('[data-action]') : null;
    if (!el) return;
    // The modal backdrop only reacts when the backdrop itself is clicked.
    if (el.dataset.action === 'modal-backdrop' && target !== el) return;
    const fn = ACTIONS[el.dataset.action];
    if (!fn) return;
    e.preventDefault();
    try {
      await fn(el, e);
    } catch (err) {
      console.error('UMA action failed:', err);
      toast((err && err.message) ? err.message : 'That action could not be completed. Please try again.', 'err');
    }
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-onchange]');
    if (!el) return;
    const fn = CHANGE_HANDLERS[el.dataset.onchange];
    if (fn) fn(el, e);
  });
  document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'gate-mobile-input') clearGateError();
  });
  document.addEventListener('submit', async (e) => {
    const form = e.target && e.target.closest ? e.target.closest('[data-onsubmit]') : null;
    if (!form) return;
    e.preventDefault();
    const fn = SUBMIT_HANDLERS[form.dataset.onsubmit];
    if (!fn || form.dataset.submitting === 'true') return;
    form.dataset.submitting = 'true';
    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.setAttribute('aria-busy', 'true');
      submitButton.dataset.originalLabel = submitButton.textContent;
      submitButton.textContent = 'Please wait…';
    }
    try {
      await fn(form);
    } catch (err) {
      console.error('UMA form submission failed:', err);
      toast((err && err.message) ? err.message : 'Unable to complete this action. Please try again.', 'err');
    } finally {
      if (form.isConnected) {
        delete form.dataset.submitting;
        if (submitButton && submitButton.isConnected) {
          submitButton.disabled = false;
          submitButton.removeAttribute('aria-busy');
          if (submitButton.dataset.originalLabel) submitButton.textContent = submitButton.dataset.originalLabel;
          delete submitButton.dataset.originalLabel;
        }
      }
    }
  });
  document.getElementById('hamburgerBtn') && document.getElementById('hamburgerBtn').addEventListener('click', () => {
    document.getElementById('mobilenav').classList.remove('hidden');
    document.getElementById('drawer-backdrop').classList.remove('hidden');
  });
  document.getElementById('drawer-backdrop').addEventListener('click', () => {
    document.getElementById('mobilenav').classList.add('hidden');
    document.getElementById('drawer-backdrop').classList.add('hidden');
  });
  window.addEventListener('hashchange', () => {
    const r = location.hash.replace('#', '');
    if (r) { state.route = r; renderSidebar(); renderView(); }
  });

  // A switch/logout in another tab should not leave this tab showing the
  // previous account's dashboard.
  window.addEventListener('storage', (event) => {
    if (event.key === SESSION_KEY && !event.newValue && state.session) showLoginGate();
  });

  // ---------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------
  async function boot2() {
    document.getElementById('shell').classList.remove('hidden');
    const initialRoute = location.hash.replace('#', '') || 'dashboard';
    state.route = VIEWS[initialRoute] ? initialRoute : 'dashboard';
    renderSidebar();
    renderView();
  }

  async function boot() {
    await initDb();
    if (state.remoteDb) {
      try {
        const status = await state.db.authStatus();
        state.accountSetupRequired = !status.hasAccounts;
        const result = await state.db.authMe();
        state.session = sessionFromStaff(result.user);
        await loadAll();
        document.getElementById('gate').innerHTML = '';
        document.getElementById('gate').classList.add('hidden');
        boot2();
      } catch (error) {
        // A 401 is the normal signed-out state. Other errors are surfaced and
        // must never cause this browser to create a second local database.
        if (error && /Sign in required|401/i.test(error.message || '')) {
          state.session = null;
          state.staff = [];
          document.getElementById('shell').classList.add('hidden');
          document.getElementById('gate').classList.remove('hidden');
          renderGate();
        } else {
          console.error('UMA shared database startup failed:', error);
          document.getElementById('shell').classList.add('hidden');
          document.getElementById('gate').classList.remove('hidden');
          document.getElementById('gate').innerHTML = `<div class="gate-card card"><h2>Shared database unavailable</h2><p class="helptext">UMA Management could not connect to the shared Cloudflare database. Your existing device data has not been changed. Please contact the administrator or try again later.</p><button class="btn btn-primary gate-submit" type="button" onclick="location.reload()">Retry connection</button></div>`;
        }
      }
    } else {
      await loadAll();
      let restored = null;
      try { restored = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) {}
      const savedStaff = restored && state.staff.find((s) => s.id === restored.staffId && s.active !== false);
      if (savedStaff) {
        state.session = sessionFromStaff(savedStaff);
        persistSession(state.session);
        document.getElementById('gate').innerHTML = '';
        document.getElementById('gate').classList.add('hidden');
        boot2();
      } else {
        clearPersistedSession();
        document.getElementById('shell').classList.add('hidden');
        document.getElementById('gate').classList.remove('hidden');
        renderGate();
      }
    }
    // hot-reload support for the artifact host (state carried across republish, best-effort)
    if (window.claude && window.claude.hot) {
      try {
        window.claude.hot.snapshot ? window.claude.hot.snapshot(() => ({ route: state.route })) : null;
      } catch (e) {}
    }
  }

  // =================================================================
  // Labour roster (simple, separate from Drivers)
  //
  // A Labour entry is a name + mobile number + one or both work types
  // (Delivery Person / Warehouse — the same person can be "multipurpose")
  // + a Company link. Creating one also creates its own mobile-number +
  // PIN login in the same step — unlike Drivers, there's no separate
  // "grant login" action, since a Labour record without a login isn't
  // useful yet. Once logged in, a Labour person's "operation" is logging
  // their hours each day (see the Labour Work Log section below), which
  // feeds both Labour Logs review and the Invoice generator.
  // =================================================================
  const labourUi = { search: '', tab: 'active' };
  const LABOUR_TYPE_LABEL = { delivery_person: 'Delivery Person', warehouse: 'Warehouse' };
  function labourCompanyLabel(l) {
    const c = state.companies.find((x) => x.id === l.companyId);
    return c ? c.name : '—';
  }
  // Two independent rates exist per work type, and they are never the same
  // figure: the Company's rate is the BILL rate (what the invoice charges
  // that company), while the Labour person's own rate is the PAY rate (what
  // they're actually paid). A log's hours get multiplied by both, so an
  // invoice always bills at the company's rate while cost-visibility views
  // can show the worker's pay and the resulting margin alongside it.
  // A Labour-type company has one hourly bill rate (what it's charged),
  // regardless of what kind of work happens on a given day; a labour person
  // has their own single hourly pay rate (what they're paid) — the two are
  // never the same figure, and the difference is the margin. `workType` is
  // accepted (and ignored) on the *ForType helpers purely so existing call
  // sites that still pass it keep working unchanged.
  function companyBillRate(company) {
    if (!company) return 0;
    if (company.rate !== undefined) return Number(company.rate) || 0;
    // backward-compat fallback for companies saved before the single-rate model
    return Number(company.deliveryRate) || Number(company.warehouseRate) || 0;
  }
  function labourPayRate(labour) {
    if (!labour) return 0;
    if (labour.payRate !== undefined) return Number(labour.payRate) || 0;
    // backward-compat fallback for labour saved before the single-rate model
    return Number(labour.deliveryPayRate) || Number(labour.warehousePayRate) || 0;
  }
  function labourRateForType(company) { return companyBillRate(company); }
  function labourPayRateForType(labour) { return labourPayRate(labour); }

  // =================================================================
  // Rate Cards — per-company, per-labour-category, effective-dated rate
  // tiers (Standard/Overtime/Saturday/Sunday/Public Holiday/Night/Casual),
  // tracked on BOTH sides (worker pay vs client billing) so margin can
  // always be shown. Each rateCards doc is one immutable version; adding a
  // new one (rather than editing an old one) IS the rate-history record —
  // resolveRateCard() always picks the version whose effectiveDate is the
  // latest one on/before the date the work happened, so a rate change
  // never rewrites an already-logged shift (that log snapshotted its own
  // amounts at clock-out time — see 'labour-clock-out').
  // When a company/category has no rate card at all yet, everything below
  // falls back to the flat companyBillRate()/labourPayRate() figures so a
  // simple one-rate setup (the common case) still works with zero setup.
  // =================================================================
  const TIER_KEYS = ['standard', 'overtime', 'saturday', 'sunday', 'publicHoliday', 'night', 'casual'];
  const TIER_LABEL = { standard: 'Standard', overtime: 'Overtime', saturday: 'Saturday', sunday: 'Sunday', publicHoliday: 'Public Holiday', night: 'Night', casual: 'Casual' };
  function companyCategories(companyId) {
    const cats = ['Standard'];
    state.rateCards.filter((r) => r.companyId === companyId).forEach((r) => { if (!cats.includes(r.category)) cats.push(r.category); });
    return cats;
  }
  function rateCardsFor(companyId, category) {
    return state.rateCards.filter((r) => r.companyId === companyId && r.category === category).sort((a, b) => (a.effectiveDate || '').localeCompare(b.effectiveDate || ''));
  }
  function resolveRateCard(companyId, category, dateStr) {
    let cards = rateCardsFor(companyId, category || 'Standard').filter((r) => r.effectiveDate <= dateStr);
    if (!cards.length && category && category !== 'Standard') cards = rateCardsFor(companyId, 'Standard').filter((r) => r.effectiveDate <= dateStr);
    return cards.length ? cards[cards.length - 1] : null;
  }
  function tierRateValue(card, tier, side) {
    const key = side + tier.charAt(0).toUpperCase() + tier.slice(1);
    return Number(card[key]) || 0;
  }
  // Which tier applies for a given calendar date, before any OT/night/casual
  // refinement — a public holiday or weekend always wins over those.
  function resolveDayTier(dateStr) {
    if ((state.settings.publicHolidays || []).includes(dateStr)) return 'publicHoliday';
    const dow = new Date(dateStr + 'T00:00:00').getDay();
    if (dow === 6) return 'saturday';
    if (dow === 0) return 'sunday';
    return 'standard';
  }
  function isNightShift(startTime) {
    if (!startTime) return false;
    const s = timeToDecimal(state.settings.nightShiftStart || '18:00');
    const e = timeToDecimal(state.settings.nightShiftEnd || '06:00');
    const t = timeToDecimal(startTime);
    return s > e ? (t >= s || t < e) : (t >= s && t < e);
  }
  // Splits a block of hours into one or more tier segments. A weekday
  // "standard" block itself splits further into Standard + Overtime once it
  // crosses settings.overtimeThresholdHours. Casual/Night only apply on an
  // otherwise-standard weekday (a public holiday or weekend rate always wins).
  function computeHourBreakdown(dateStr, startTime, hours, employmentType) {
    const dayTier = resolveDayTier(dateStr);
    if (dayTier !== 'standard') return [{ tier: dayTier, hours }];
    if (employmentType === 'Casual') return [{ tier: 'casual', hours }];
    if (isNightShift(startTime)) return [{ tier: 'night', hours }];
    const otThreshold = Number(state.settings.overtimeThresholdHours) || 8;
    if (hours > otThreshold) {
      return [{ tier: 'standard', hours: otThreshold }, { tier: 'overtime', hours: Math.round((hours - otThreshold) * 100) / 100 }];
    }
    return [{ tier: 'standard', hours }];
  }
  // The one function shifts/logs/invoices all go through to get pay & bill
  // amounts. Returns { lines, payAmount, billAmount, marginAmount, usedRateCard }.
  // `lines` is null when no rate card exists yet (flat-rate fallback mode).
  function summarizeShiftCost(company, labour, category, dateStr, startTime, hours) {
    const companyId = company ? company.id : null;
    const employmentType = labour ? (labour.employmentType || 'Standard') : 'Standard';
    const segments = computeHourBreakdown(dateStr, startTime, hours, employmentType);
    const card = companyId ? resolveRateCard(companyId, category, dateStr) : null;
    if (!card) {
      const payAmount = Math.round(hours * labourPayRate(labour) * 100) / 100;
      const billAmount = Math.round(hours * companyBillRate(company) * 100) / 100;
      return { lines: null, payAmount, billAmount, marginAmount: Math.round((billAmount - payAmount) * 100) / 100, usedRateCard: false };
    }
    let payAmount = 0, billAmount = 0;
    const lines = segments.map((seg) => {
      const payRate = tierRateValue(card, seg.tier, 'pay');
      const billRate = tierRateValue(card, seg.tier, 'bill');
      const payAmt = Math.round(seg.hours * payRate * 100) / 100;
      const billAmt = Math.round(seg.hours * billRate * 100) / 100;
      payAmount += payAmt; billAmount += billAmt;
      return { tier: seg.tier, hours: seg.hours, payRate, billRate, payAmount: payAmt, billAmount: billAmt };
    });
    payAmount = Math.round(payAmount * 100) / 100; billAmount = Math.round(billAmount * 100) / 100;
    return { lines, payAmount, billAmount, marginAmount: Math.round((billAmount - payAmount) * 100) / 100, usedRateCard: true, card };
  }
  function tierBreakdownLabel(lines) {
    if (!lines || !lines.length) return '';
    return lines.map((l) => `${TIER_LABEL[l.tier] || l.tier} ${l.hours}h`).join(' + ');
  }

  function labourRateLabel(l) {
    const c = state.companies.find((x) => x.id === l.companyId);
    return c ? `${fmtMoney(companyBillRate(c))}/hr` : '—';
  }
  function labourPayRateLabel(l) {
    return `${fmtMoney(labourPayRate(l))}/hr`;
  }
  function labourCompanyOptions() {
    return activeCompanies().filter((c) => (c.type || 'delivery') === 'labour');
  }
  function viewLabour() {
    let rows = state.labour.filter((l) => (labourUi.tab === 'active' ? l.active !== false : l.active === false));
    if (labourUi.search.trim()) {
      const q = labourUi.search.toLowerCase();
      rows = rows.filter((l) => (l.name || '').toLowerCase().includes(q) || (l.mobile || '').includes(q));
    }
    const body = rows.length ? rows.map((l) => `
      <tr>
        <td><div class="avatar" style="width:26px;height:26px;font-size:.68rem;">${esc((l.name || '?').slice(0, 2).toUpperCase())}</div></td>
        <td>${esc(l.name)}</td>
        <td>${esc(l.mobile || '—')}</td>
        <td>${(l.labourTypes || []).map((t) => `<span class="pill pill-other">${esc(LABOUR_TYPE_LABEL[t] || t)}</span>`).join(' ') || '—'}</td>
        <td>${esc(labourCompanyLabel(l))}</td>
        <td class="tnum" style="white-space:nowrap;">${esc(labourRateLabel(l))}</td>
        <td class="tnum" style="white-space:nowrap;">${esc(labourPayRateLabel(l))}</td>
        <td>${l.active !== false ? '<span class="pill pill-paid">Active</span>' : '<span class="pill pill-cancelled">Inactive</span>'}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-sm" data-action="labour-edit" data-id="${l.id}">Edit</button>
          <button class="btn btn-sm" data-action="labour-reset-pin" data-id="${l.id}">Reset PIN</button>
          ${l.active !== false
            ? `<button class="btn btn-sm btn-danger" data-action="labour-deactivate" data-id="${l.id}">Deactivate</button>`
            : `<button class="btn btn-sm" data-action="labour-reactivate" data-id="${l.id}">Reactivate</button>`}
          ${isAdmin() ? `<button class="btn btn-sm btn-danger" data-action="labour-delete-account" data-id="${l.id}">Delete account</button>` : ''}
        </td>
      </tr>
    `).join('') : `<tr><td colspan="9"><div class="empty-state">No ${labourUi.tab} labour found.</div></td></tr>`;
    return `
      <div class="view-header">
        <div><h1>Labour</h1><div class="sub">${state.labour.length} total — each has their own mobile-number login and logs their own hours</div></div>
        <button class="btn btn-primary" data-action="labour-add">+ Add labour</button>
      </div>
      <div class="toolbar">
        <button class="btn btn-sm ${labourUi.tab === 'active' ? 'btn-primary' : ''}" data-action="labour-tab" data-tab="active">Active</button>
        <button class="btn btn-sm ${labourUi.tab === 'inactive' ? 'btn-primary' : ''}" data-action="labour-tab" data-tab="inactive">Inactive</button>
        <div class="search-input grow"><span class="ic">⌕</span><input type="text" placeholder="Search name or mobile…" value="${esc(labourUi.search)}" data-onchange="labour-search"></div>
      </div>
      <div class="table-wrap">
        <table class="data"><thead><tr><th></th><th>Name</th><th>Mobile</th><th>Type</th><th>Company</th><th>Bill Rate</th><th>Pay Rate</th><th>Status</th><th>Actions</th></tr></thead><tbody>${body}</tbody></table>
      </div>
      <p class="helptext" style="margin-top:12px;">Bill Rate is what the company is charged; Pay Rate is what this person is paid — the difference is your margin. A labour person logs in on their own phone and logs their hours each day — see Labour Logs to review and approve them, and Invoices to bill the company for approved hours.</p>
    `;
  }
  function labourModal(labour) {
    const isEdit = !!labour;
    const types = isEdit ? (labour.labourTypes || []) : ['warehouse'];
    const companies = labourCompanyOptions();
    const companyOpts = companies.map((c) => `<option value="${c.id}" ${isEdit && labour.companyId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    openModal(`
      <div class="modal-head"><h3>${isEdit ? 'Edit labour' : 'Add labour'}</h3><button data-action="modal-close" aria-label="Close">✕</button></div>
      <form data-onsubmit="labour-save" data-id="${isEdit ? labour.id : ''}">
        <div class="field" style="margin-bottom:12px;"><label class="field-label">Name</label><input type="text" name="name" value="${isEdit ? esc(labour.name) : ''}" required></div>
        <div class="field" style="margin-bottom:12px;"><label class="field-label">Mobile number</label><input type="tel" inputmode="numeric" name="mobile" value="${isEdit ? esc(labour.mobile || '') : ''}" required></div>
        <div class="field" style="margin-bottom:12px;">
          <label class="field-label">Type (select one or both — a "multipurpose" labour can do either)</label>
          <div class="checkbox-row"><label><input type="checkbox" name="labourTypes" value="delivery_person" ${types.includes('delivery_person') ? 'checked' : ''}> Delivery Person</label></div>
          <div class="checkbox-row"><label><input type="checkbox" name="labourTypes" value="warehouse" ${types.includes('warehouse') ? 'checked' : ''}> Warehouse</label></div>
        </div>
        <div class="field" style="margin-bottom:12px;">
          <label class="field-label">Company</label>
          ${companies.length ? `<select name="companyId"><option value="">— None —</option>${companyOpts}</select>` : `<p class="helptext" style="margin:0;">No Labour-type companies yet — add one on the Companies page first, then assign it here.</p>`}
        </div>
        <div class="field" style="margin-bottom:12px;">
          <label class="field-label">Pay rate ($/hr) — fallback, used only where no rate card applies; separate from what the company is billed</label>
          <input type="number" step="0.01" min="0" name="payRate" value="${isEdit ? (labourPayRate(labour) || 0) : ''}">
        </div>
        <div class="field" style="margin-bottom:12px;">
          <label class="field-label">Employment type</label>
          <select name="employmentType"><option value="Standard" ${isEdit && (labour.employmentType || 'Standard') === 'Standard' ? 'selected' : ''}>Standard</option><option value="Casual" ${isEdit && labour.employmentType === 'Casual' ? 'selected' : ''}>Casual</option></select>
          <p class="helptext" style="margin:4px 0 0;">Drives which rate-card tier applies on an otherwise-standard weekday (Casual rate vs Standard/Overtime).</p>
        </div>
        <div class="field"><label class="field-label">${isEdit ? 'New 4-digit PIN (leave blank to keep current)' : '4-digit PIN for login'}</label><input type="password" name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" ${isEdit ? '' : 'required'}></div>
        <p class="helptext" style="margin:10px 0 0;">${isEdit ? "This person's login uses the mobile number above." : "This mobile number + PIN becomes this person's own login."}</p>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
          <button type="button" class="btn" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Add labour & create login'}</button>
        </div>
      </form>
    `);
  }
  function labourResetPinModal(labourId) {
    openModal(`
      <div class="modal-head"><h3>Reset PIN</h3><button data-action="modal-close" aria-label="Close">✕</button></div>
      <form data-onsubmit="labour-reset-pin-save" data-id="${labourId}">
        <div class="field"><label class="field-label">New 4-digit PIN</label><input type="password" name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;"><button type="button" class="btn" data-action="modal-close">Cancel</button><button type="submit" class="btn btn-primary">Save</button></div>
      </form>
    `);
  }

  Object.assign(ACTIONS, {
    'labour-add': () => labourModal(null),
    'labour-edit': (el) => labourModal(state.labour.find((l) => l.id === el.dataset.id)),
    'labour-tab': (el) => { labourUi.tab = el.dataset.tab; renderView(); },
    'labour-reset-pin': (el) => labourResetPinModal(el.dataset.id),
    'labour-deactivate': async (el) => {
      const ok = await confirmDialog('Deactivate this labour entry? Their login stops working too.', { okLabel: 'Deactivate', danger: true });
      if (!ok) return;
      await state.db.doc('labour/' + el.dataset.id).update({ active: false });
      const linked = state.staff.find((s) => s.labourId === el.dataset.id);
      if (linked) await state.db.doc('staff/' + linked.id).update({ active: false });
      await loadLabour(); await loadStaff(); toast('Labour deactivated.', 'ok'); renderView();
    },
    'labour-reactivate': async (el) => {
      await state.db.doc('labour/' + el.dataset.id).update({ active: true });
      const linked = state.staff.find((s) => s.labourId === el.dataset.id);
      if (linked) await state.db.doc('staff/' + linked.id).update({ active: true });
      await loadLabour(); await loadStaff(); toast('Labour reactivated.', 'ok'); renderView();
    },
    'labour-delete-account': async (el) => {
      if (!isAdmin()) { toast('Only Admin can delete Labour accounts.', 'err'); return; }
      const id = el.dataset.id;
      const labour = state.labour.find((item) => item.id === id);
      if (!labour) return;
      const ok = await confirmDialog(
        `Delete ${labour.name}'s Labour profile and linked login? Historical Labour Logs and invoices will be retained; future rostered shifts and the linked login will be removed. This cannot be undone.`,
        { okLabel: 'Delete account', danger: true }
      );
      if (!ok) return;
      await state.db.doc('labour/' + id).delete();
      await loadLabour(); await loadStaff(); await loadLabourShifts();
      toast('Labour profile deleted; historical logs and invoices were retained.', 'ok');
      renderView();
    },
  });
  Object.assign(CHANGE_HANDLERS, {
    'labour-search': (el) => { labourUi.search = el.value; renderView(); },
  });
  Object.assign(SUBMIT_HANDLERS, {
    'labour-save': async (form) => {
      const fd = new FormData(form);
      const id = form.dataset.id;
      const mobile = normalizeMobile(fd.get('mobile'));
      if (!mobile) { toast('Enter a mobile number.', 'err'); return; }
      const labourTypes = fd.getAll('labourTypes');
      if (!labourTypes.length) { toast('Select at least one type — Delivery Person, Warehouse, or both.', 'err'); return; }
      const linked = id ? state.staff.find((s) => s.labourId === id) : null;
      if (mobileTaken(mobile, linked ? linked.id : null)) { toast('That mobile number is already used for another login.', 'err'); return; }
      const data = {
        name: fd.get('name').trim(),
        mobile,
        labourTypes,
        companyId: fd.get('companyId') || '',
        payRate: Number(fd.get('payRate')) || 0,
        employmentType: fd.get('employmentType') || 'Standard',
      };
      if (id) {
        await state.db.doc('labour/' + id).update(data);
        if (linked) {
          const patch = { name: data.name, mobile };
          if (fd.get('pin')) patch.pin = fd.get('pin');
          await state.db.doc('staff/' + linked.id).update(patch);
        }
        await loadLabour(); await loadStaff(); closeModal(); toast('Labour updated.', 'ok'); renderView();
      } else {
        const pin = fd.get('pin');
        if (!pin) { toast('Set a 4-digit PIN for this login.', 'err'); return; }
        const ref = await claimLabourRef();
        const labourDocRef = await state.db.collection('labour').add(Object.assign({ labourRef: ref, active: true, createdAt: new Date().toISOString() }, data));
        await state.db.collection('staff').add({ name: data.name, mobile, pin, role: 'labour', labourId: labourDocRef.id, active: true, createdAt: new Date().toISOString() });
        await loadLabour(); await loadStaff(); closeModal(); toast('Labour added — login created.', 'ok'); renderView();
      }
    },
    'labour-reset-pin-save': async (form) => {
      const fd = new FormData(form);
      const labourId = form.dataset.id;
      const linked = state.staff.find((s) => s.labourId === labourId);
      if (!linked) { toast('No login found for this labour entry.', 'err'); closeModal(); return; }
      await state.db.doc('staff/' + linked.id).update({ pin: fd.get('pin') });
      await loadStaff(); closeModal(); toast('PIN reset.', 'ok');
    },
  });

  // =================================================================
  // Rate Cards — dated, per-company, per-labour-category rate tiers (see
  // the big comment above summarizeShiftCost()). Each version is immutable
  // once saved; adding a new one for the same company+category is how you
  // record a rate change, and the list of versions IS the rate history.
  // =================================================================
  const rateCardsUi = { companyId: '' };
  function rateCardHistoryRows(companyId, category) {
    return rateCardsFor(companyId, category);
  }
  function viewRateCards() {
    const companies = labourCompanyOptions();
    if (rateCardsUi.companyId && !companies.find((c) => c.id === rateCardsUi.companyId)) rateCardsUi.companyId = '';
    let rows = state.rateCards.slice();
    if (rateCardsUi.companyId) rows = rows.filter((r) => r.companyId === rateCardsUi.companyId);
    rows.sort((a, b) => (a.companyName + a.category).localeCompare(b.companyName + b.category) || b.effectiveDate.localeCompare(a.effectiveDate));
    const body = rows.length ? rows.map((r) => {
      const history = rateCardHistoryRows(r.companyId, r.category);
      const idx = history.findIndex((h) => h.id === r.id);
      const prev = idx > 0 ? history[idx - 1] : null;
      const deltaHtml = prev
        ? `<span class="helptext">was ${fmtMoney(prev.payStandard)}/${fmtMoney(prev.billStandard)}</span>`
        : `<span class="helptext">first version</span>`;
      return `<tr>
        <td>${esc(r.companyName)}</td><td>${esc(r.category)}</td><td>${r.effectiveDate}</td>
        <td class="tnum" style="white-space:nowrap;">${fmtMoney(r.payStandard)} / ${fmtMoney(r.billStandard)}</td>
        <td class="tnum" style="white-space:nowrap;">${fmtMoney(r.payOvertime)} / ${fmtMoney(r.billOvertime)}</td>
        <td class="tnum" style="white-space:nowrap;">${fmtMoney(r.paySaturday)} / ${fmtMoney(r.billSaturday)}</td>
        <td class="tnum" style="white-space:nowrap;">${fmtMoney(r.paySunday)} / ${fmtMoney(r.billSunday)}</td>
        <td class="tnum" style="white-space:nowrap;">${fmtMoney(r.payPublicHoliday)} / ${fmtMoney(r.billPublicHoliday)}</td>
        <td class="tnum" style="white-space:nowrap;">${fmtMoney(r.payNight)} / ${fmtMoney(r.billNight)}</td>
        <td class="tnum" style="white-space:nowrap;">${fmtMoney(r.payCasual)} / ${fmtMoney(r.billCasual)}</td>
        <td>${deltaHtml}</td>
        <td>${esc(r.createdBy || '—')}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-sm" data-action="rate-card-edit" data-id="${r.id}">Edit</button>
          <button class="btn btn-sm btn-danger" data-action="rate-card-delete" data-id="${r.id}">Delete</button>
        </td>
      </tr>`;
    }).join('') : `<tr><td colspan="12"><div class="empty-state">No rate cards yet${rateCardsUi.companyId ? ' for this company' : ''} — add one below, or the flat "Hourly bill rate" / "Pay rate" on Companies/Labour is used instead.</div></td></tr>`;
    return `
      <div class="view-header">
        <div><h1>Rate Cards</h1><div class="sub">Effective-dated Standard/Overtime/Saturday/Sunday/Public Holiday/Night/Casual rates, per company and labour category — shown as Worker Pay / Client Bill</div></div>
        <button class="btn btn-primary" data-action="rate-card-add">+ Add rate card</button>
      </div>
      <div class="toolbar">
        <select data-onchange="rate-card-company-filter"><option value="">All labour companies</option>${companies.map((c) => `<option value="${c.id}" ${rateCardsUi.companyId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      </div>
      <div class="table-wrap">
        <table class="data"><thead><tr><th>Company</th><th>Category</th><th>Effective</th><th>Standard</th><th>Overtime</th><th>Saturday</th><th>Sunday</th><th>Public Holiday</th><th>Night</th><th>Casual</th><th>vs previous</th><th>Changed by</th><th>Actions</th></tr></thead><tbody>${body}</tbody></table>
      </div>
      <p class="helptext" style="margin-top:12px;">Each row is Pay/hr ÷ Bill/hr for that tier. Adding a new version for a company+category is how you change a rate — it applies from its Effective date onward; work already logged keeps the rate that was live when it was clocked out, so nothing historical changes. Min shift hours, break minutes, allowances and charges are editable per version too.</p>
    `;
  }
  function rateCardModal(rateCard) {
    const isEdit = !!rateCard;
    const companies = labourCompanyOptions();
    const defaultCompanyId = isEdit ? rateCard.companyId : (rateCardsUi.companyId || (companies[0] ? companies[0].id : ''));
    const cats = defaultCompanyId ? companyCategories(defaultCompanyId) : ['Standard'];
    const tierField = (label, key) => `
      <div class="field-row" style="margin-bottom:8px;align-items:center;">
        <div style="flex:0 0 120px;font-size:0.82rem;font-weight:600;">${label}</div>
        <div class="field"><label class="field-label">Worker pay $/hr</label><input type="number" step="0.01" min="0" name="pay${key}" value="${isEdit ? (rateCard['pay' + key] || 0) : 0}"></div>
        <div class="field"><label class="field-label">Client bill $/hr</label><input type="number" step="0.01" min="0" name="bill${key}" value="${isEdit ? (rateCard['bill' + key] || 0) : 0}"></div>
      </div>`;
    openModal(`
      <div class="modal-head"><h3>${isEdit ? 'Edit rate card version' : 'Add rate card'}</h3><button data-action="modal-close" aria-label="Close">✕</button></div>
      ${companies.length ? `
      <form data-onsubmit="rate-card-save" data-id="${isEdit ? rateCard.id : ''}">
        <div class="field-row" style="margin-bottom:12px;">
          <div class="field"><label class="field-label">Company</label><select name="companyId" data-onchange="rate-card-company-change" ${isEdit ? 'disabled' : ''}>${companies.map((c) => `<option value="${c.id}" ${defaultCompanyId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>${isEdit ? `<input type="hidden" name="companyId" value="${rateCard.companyId}">` : ''}</div>
          <div class="field"><label class="field-label">Effective date</label><input type="date" name="effectiveDate" value="${isEdit ? rateCard.effectiveDate : todayStr()}" required></div>
        </div>
        <div class="field" style="margin-bottom:12px;">
          <label class="field-label">Labour category</label>
          <input type="text" name="category" list="rateCardCategoryList" value="${isEdit ? esc(rateCard.category) : 'Standard'}" required>
          <datalist id="rateCardCategoryList">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
          <p class="helptext" style="margin:4px 0 0;">Pick an existing category or type a new one (e.g. "Warehouse Picker", "Forklift Operator", "Supervisor").</p>
        </div>
        <p class="eyebrow" style="margin:4px 0 8px;">Rate tiers</p>
        ${tierField('Standard', 'Standard')}
        ${tierField('Overtime', 'Overtime')}
        ${tierField('Saturday', 'Saturday')}
        ${tierField('Sunday', 'Sunday')}
        ${tierField('Public Holiday', 'PublicHoliday')}
        ${tierField('Night', 'Night')}
        ${tierField('Casual', 'Casual')}
        <p class="eyebrow" style="margin:14px 0 8px;">Other terms</p>
        <div class="field-row" style="margin-bottom:12px;">
          <div class="field"><label class="field-label">Minimum shift hours</label><input type="number" step="0.5" min="0" name="minimumShiftHours" value="${isEdit ? (rateCard.minimumShiftHours || 0) : 0}"></div>
          <div class="field"><label class="field-label">Break (minutes)</label><input type="number" step="1" min="0" name="breakMinutes" value="${isEdit ? (rateCard.breakMinutes || 0) : 0}"></div>
        </div>
        <div class="field-row" style="margin-bottom:12px;">
          <div class="field"><label class="field-label">Other allowances ($)</label><input type="number" step="0.01" min="0" name="otherAllowances" value="${isEdit ? (rateCard.otherAllowances || 0) : 0}"></div>
          <div class="field"><label class="field-label">Other charges ($)</label><input type="number" step="0.01" min="0" name="otherCharges" value="${isEdit ? (rateCard.otherCharges || 0) : 0}"></div>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
          <button type="button" class="btn" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Add rate card'}</button>
        </div>
      </form>` : `<p class="helptext">No Labour-type companies yet — add one on the Companies page first.</p>`}
    `, { wide: true });
  }
  Object.assign(ACTIONS, {
    'rate-card-add': () => rateCardModal(null),
    'rate-card-edit': (el) => rateCardModal(state.rateCards.find((r) => r.id === el.dataset.id)),
    'rate-card-delete': async (el) => {
      const ok = await confirmDialog('Delete this rate card version? Hours already logged against it are unaffected (they keep their own snapshotted amounts).', { okLabel: 'Delete', danger: true });
      if (!ok) return;
      await state.db.doc('rateCards/' + el.dataset.id).delete();
      await loadRateCards(); toast('Rate card deleted.', 'ok'); renderView();
    },
  });
  Object.assign(CHANGE_HANDLERS, {
    'rate-card-company-filter': (el) => { rateCardsUi.companyId = el.value; renderView(); },
    'rate-card-company-change': (el) => {
      const form = el.closest('form');
      if (!form) return;
      const dl = form.querySelector('#rateCardCategoryList');
      if (dl) dl.innerHTML = companyCategories(el.value).map((c) => `<option value="${esc(c)}">`).join('');
    },
  });
  Object.assign(SUBMIT_HANDLERS, {
    'rate-card-save': async (form) => {
      const fd = new FormData(form);
      const id = form.dataset.id;
      const companyId = fd.get('companyId');
      const company = state.companies.find((c) => c.id === companyId);
      if (!company) { toast('Select a company.', 'err'); return; }
      const category = (fd.get('category') || 'Standard').trim() || 'Standard';
      const data = { companyId, companyName: company.name, category, effectiveDate: fd.get('effectiveDate') };
      TIER_KEYS.forEach((t) => {
        const key = t.charAt(0).toUpperCase() + t.slice(1);
        data['pay' + key] = Number(fd.get('pay' + key)) || 0;
        data['bill' + key] = Number(fd.get('bill' + key)) || 0;
      });
      data.minimumShiftHours = Number(fd.get('minimumShiftHours')) || 0;
      data.breakMinutes = Number(fd.get('breakMinutes')) || 0;
      data.otherAllowances = Number(fd.get('otherAllowances')) || 0;
      data.otherCharges = Number(fd.get('otherCharges')) || 0;
      if (id) {
        await state.db.doc('rateCards/' + id).update(data);
      } else {
        data.createdBy = state.session ? state.session.name : '';
        await state.db.collection('rateCards').add(Object.assign({ createdAt: new Date().toISOString() }, data));
      }
      await loadRateCards(); closeModal(); toast('Rate card saved.', 'ok'); renderView();
    },
  });

  // =================================================================
  // Labour Shifts (rostering) — modelled on how Employment Hero's Rostering
  // module works: an admin/manager schedules a labour person onto a shift
  // (date + start/end time + work type) ahead of time, with a live estimated
  // cost, and the shift stays a Draft until explicitly Published. Only a
  // Published shift for today shows up on the labour person's own Today
  // screen for them to clock in against — a shift itself never carries
  // hours/pay, that only happens once someone clocks in and out (see the
  // Labour Work Log section below).
  // =================================================================
  function timeToDecimal(t) {
    if (!t) return 0;
    const parts = String(t).split(':').map(Number);
    return (parts[0] || 0) + (parts[1] || 0) / 60;
  }
  function shiftDurationHours(startTime, endTime) {
    const diff = timeToDecimal(endTime) - timeToDecimal(startTime);
    return diff > 0 ? Math.round(diff * 100) / 100 : 0;
  }
  function eligibleShiftLabour() {
    return state.labour.filter((l) => l.active !== false && l.companyId);
  }
  function shiftDynamicFieldsHtml(labour, selectedWorkType, selectedCategory) {
    if (!labour) return '<p class="helptext">Add labour with an assigned company first.</p>';
    const company = state.companies.find((c) => c.id === labour.companyId);
    const types = labour.labourTypes && labour.labourTypes.length ? labour.labourTypes : [];
    const typeField = types.length > 1
      ? `<div class="field" style="margin-bottom:12px;"><label class="field-label">Work type</label><select name="workType" data-onchange="shift-recalc">${types.map((t) => `<option value="${t}" ${selectedWorkType === t ? 'selected' : ''}>${esc(LABOUR_TYPE_LABEL[t] || t)}</option>`).join('')}</select></div>`
      : `<input type="hidden" name="workType" value="${types[0] || ''}">`;
    const cats = company ? companyCategories(company.id) : ['Standard'];
    const cat = selectedCategory || 'Standard';
    const categoryField = `<div class="field" style="margin-bottom:12px;"><label class="field-label">Labour category</label><select name="category" data-onchange="shift-recalc">${cats.map((c) => `<option value="${esc(c)}" ${cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>`;
    return `<p class="helptext" style="margin:0 0 12px;">Company: <strong>${esc(company ? company.name : '— none assigned —')}</strong></p>${typeField}${categoryField}`;
  }
  function updateShiftEstCostDisplay() {
    const form = document.querySelector('form[data-onsubmit="shift-save"]');
    if (!form) return;
    const fd = new FormData(form);
    const labour = state.labour.find((l) => l.id === fd.get('labourId'));
    const company = labour ? state.companies.find((c) => c.id === labour.companyId) : null;
    const category = fd.get('category') || 'Standard';
    const date = fd.get('date') || todayStr();
    const startTime = fd.get('startTime');
    const hours = shiftDurationHours(startTime, fd.get('endTime'));
    const el = form.querySelector('#shiftEstCost');
    if (!el) return;
    if (!hours) { el.textContent = 'Set a start and end time to see the estimated cost.'; return; }
    const cost = summarizeShiftCost(company, labour, category, date, startTime, hours);
    const tierNote = cost.usedRateCard ? ` <span class="helptext">(${esc(tierBreakdownLabel(cost.lines))})</span>` : ' <span class="helptext">(flat fallback rate — no rate card set up for this category yet)</span>';
    el.innerHTML = `${hours} hrs — Bill (to company): <strong>${fmtMoney(cost.billAmount)}</strong> · Pay (to worker): <strong>${fmtMoney(cost.payAmount)}</strong> · Margin: <strong>${fmtMoney(cost.marginAmount)}</strong>${tierNote}`;
  }
  const labourShiftsUi = { from: todayStr(), to: '', companyId: '' };
  function labourShiftsRange() {
    if (!labourShiftsUi.to) {
      const d = new Date(); d.setDate(d.getDate() + 13);
      labourShiftsUi.to = toDateStr(d);
    }
    return { from: labourShiftsUi.from || todayStr(), to: labourShiftsUi.to };
  }
  function viewLabourShifts() {
    const { from, to } = labourShiftsRange();
    let rows = state.labourShifts.filter((s) => s.date >= from && s.date <= to);
    if (labourShiftsUi.companyId) rows = rows.filter((s) => s.companyId === labourShiftsUi.companyId);
    rows.sort((a, b) => (a.date === b.date ? (a.startTime || '').localeCompare(b.startTime || '') : a.date.localeCompare(b.date)));
    const companies = labourCompanyOptions();
    const totals = rows.reduce((acc, s) => ({
      hours: acc.hours + (Number(s.estHours) || 0),
      bill: acc.bill + (Number(s.estBillCost) || 0),
      pay: acc.pay + (Number(s.estPayCost) || 0),
    }), { hours: 0, bill: 0, pay: 0 });
    const body = rows.length ? rows.map((s) => `
      <tr>
        <td>${s.date}</td><td>${esc(s.labourName)}</td><td>${esc(s.companyName)}</td>
        <td>${esc(LABOUR_TYPE_LABEL[s.workType] || s.workType)}</td>
        <td>${esc(s.category || 'Standard')}</td>
        <td class="tnum" style="white-space:nowrap;">${esc(s.startTime)}–${esc(s.endTime)}</td>
        <td class="tnum">${s.estHours}</td>
        <td class="tnum" style="font-weight:700;">${fmtMoney(s.estBillCost)}</td>
        <td class="tnum">${fmtMoney(s.estPayCost)}</td>
        <td class="tnum">${fmtMoney((Number(s.estBillCost) || 0) - (Number(s.estPayCost) || 0))}</td>
        <td>${s.published ? '<span class="pill pill-paid">Published</span>' : '<span class="pill pill-pending">Draft</span>'}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-sm" data-action="shift-edit" data-id="${s.id}">Edit</button>
          ${s.published
            ? `<button class="btn btn-sm" data-action="shift-unpublish" data-id="${s.id}">Unpublish</button>`
            : `<button class="btn btn-sm btn-primary" data-action="shift-publish" data-id="${s.id}">Publish</button>`}
          <button class="btn btn-sm btn-danger" data-action="shift-delete" data-id="${s.id}">Delete</button>
        </td>
      </tr>
    `).join('') : `<tr><td colspan="12"><div class="empty-state">No shifts in this range.</div></td></tr>`;
    return `
      <div class="view-header">
        <div><h1>Labour Shifts</h1><div class="sub">Roster labour ahead of time — a shift must be Published before it shows on their phone</div></div>
        <button class="btn btn-primary" data-action="shift-add">+ Add shift</button>
      </div>
      <div class="card date-section" style="margin-bottom:16px;">
        <div class="date-section-inner">
          <div class="field-row">
            <div class="field"><label class="field-label">From</label><input type="date" value="${from}" data-onchange="shift-range" data-field="from"></div>
            <div class="field"><label class="field-label">To</label><input type="date" value="${to}" data-onchange="shift-range" data-field="to"></div>
            <div class="field"><label class="field-label">Company</label><select data-onchange="shift-company-filter"><option value="">All labour companies</option>${companies.map((c) => `<option value="${c.id}" ${labourShiftsUi.companyId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
          </div>
        </div>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Date</th><th>Labour</th><th>Company</th><th>Type</th><th>Category</th><th>Time</th><th>Est Hours</th><th>Est Bill</th><th>Est Pay</th><th>Est Margin</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>${body}</tbody>
          <tfoot><tr><td colspan="6">TOTAL (this range)</td><td class="tnum">${Math.round(totals.hours * 100) / 100}</td><td class="tnum" style="font-weight:700;">${fmtMoney(totals.bill)}</td><td class="tnum">${fmtMoney(totals.pay)}</td><td class="tnum">${fmtMoney(totals.bill - totals.pay)}</td><td colspan="2"></td></tr></tfoot>
        </table>
      </div>
      <p class="helptext" style="margin-top:12px;">Bill = what the company will be charged. Pay = what the labour person earns. Margin = the difference — the same figures a shift's actual clock-in/out will be compared against once worked.</p>
    `;
  }
  function shiftModal(shift) {
    const isEdit = !!shift;
    const eligible = eligibleShiftLabour();
    const selectedLabourId = isEdit ? shift.labourId : (eligible[0] ? eligible[0].id : '');
    const selectedLabour = eligible.find((l) => l.id === selectedLabourId) || null;
    const labourOpts = eligible.map((l) => {
      const c = state.companies.find((x) => x.id === l.companyId);
      return `<option value="${l.id}" ${selectedLabourId === l.id ? 'selected' : ''}>${esc(l.name)}${c ? ' — ' + esc(c.name) : ''}</option>`;
    }).join('');
    openModal(`
      <div class="modal-head"><h3>${isEdit ? 'Edit shift' : 'Add shift'}</h3><button data-action="modal-close" aria-label="Close">✕</button></div>
      ${eligible.length ? `
      <form data-onsubmit="shift-save" data-id="${isEdit ? shift.id : ''}">
        <div class="field" style="margin-bottom:12px;"><label class="field-label">Labour person</label><select name="labourId" data-onchange="shift-labour-change">${labourOpts}</select></div>
        <div id="shiftDynamicFields">${shiftDynamicFieldsHtml(selectedLabour, isEdit ? shift.workType : '', isEdit ? shift.category : '')}</div>
        <div class="field" style="margin-bottom:12px;"><label class="field-label">Date</label><input type="date" name="date" value="${isEdit ? shift.date : todayStr()}" required></div>
        <div class="field-row" style="margin-bottom:12px;">
          <div class="field"><label class="field-label">Start time</label><input type="time" name="startTime" value="${isEdit ? (shift.startTime || '') : '09:00'}" data-onchange="shift-recalc" required></div>
          <div class="field"><label class="field-label">End time</label><input type="time" name="endTime" value="${isEdit ? (shift.endTime || '') : '17:00'}" data-onchange="shift-recalc" required></div>
        </div>
        <p class="helptext" id="shiftEstCost" style="margin:0 0 12px;font-weight:600;"></p>
        <div class="field"><label class="field-label">Notes (optional)</label><textarea name="notes" rows="2">${isEdit ? esc(shift.notes || '') : ''}</textarea></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
          <button type="button" class="btn" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Add shift'}</button>
        </div>
      </form>` : `<p class="helptext">No labour with an assigned Labour-type company yet — add labour and assign a company first.</p>`}
    `);
    if (eligible.length) updateShiftEstCostDisplay();
  }
  Object.assign(ACTIONS, {
    'shift-add': () => shiftModal(null),
    'shift-edit': (el) => shiftModal(state.labourShifts.find((s) => s.id === el.dataset.id)),
    'shift-publish': async (el) => {
      await state.db.doc('labourShifts/' + el.dataset.id).update({ published: true, updatedAt: new Date().toISOString() });
      await loadLabourShifts(); toast('Shift published — the labour person can now see it.', 'ok'); renderView();
    },
    'shift-unpublish': async (el) => {
      await state.db.doc('labourShifts/' + el.dataset.id).update({ published: false, updatedAt: new Date().toISOString() });
      await loadLabourShifts(); toast('Shift unpublished.', 'ok'); renderView();
    },
    'shift-delete': async (el) => {
      const ok = await confirmDialog('Delete this shift? This cannot be undone.', { okLabel: 'Delete', danger: true });
      if (!ok) return;
      await state.db.doc('labourShifts/' + el.dataset.id).delete();
      await loadLabourShifts(); toast('Shift deleted.', 'ok'); renderView();
    },
  });
  Object.assign(CHANGE_HANDLERS, {
    'shift-range': (el) => { labourShiftsUi[el.dataset.field] = el.value; renderView(); },
    'shift-company-filter': (el) => { labourShiftsUi.companyId = el.value; renderView(); },
    'shift-labour-change': (el) => {
      const form = el.closest('form');
      if (!form) return;
      const labour = state.labour.find((l) => l.id === el.value);
      const container = form.querySelector('#shiftDynamicFields');
      if (container) container.innerHTML = shiftDynamicFieldsHtml(labour, '', '');
      updateShiftEstCostDisplay();
    },
    'shift-recalc': () => updateShiftEstCostDisplay(),
  });
  Object.assign(SUBMIT_HANDLERS, {
    'shift-save': async (form) => {
      const fd = new FormData(form);
      const id = form.dataset.id;
      const labour = state.labour.find((l) => l.id === fd.get('labourId'));
      if (!labour) { toast('Select a labour person.', 'err'); return; }
      const company = state.companies.find((c) => c.id === labour.companyId);
      const startTime = fd.get('startTime'), endTime = fd.get('endTime');
      const estHours = shiftDurationHours(startTime, endTime);
      if (!estHours) { toast('End time must be after start time.', 'err'); return; }
      const workType = fd.get('workType');
      const category = fd.get('category') || 'Standard';
      const date = fd.get('date');
      const cost = summarizeShiftCost(company, labour, category, date, startTime, estHours);
      const data = {
        labourId: labour.id, labourName: labour.name,
        companyId: labour.companyId, companyName: company ? company.name : '',
        date, startTime, endTime, workType, category,
        estHours,
        estBillCost: cost.billAmount,
        estPayCost: cost.payAmount,
        estLines: cost.lines,
        notes: fd.get('notes') || '', updatedAt: new Date().toISOString(),
      };
      if (id) {
        await state.db.doc('labourShifts/' + id).update(data);
      } else {
        await state.db.collection('labourShifts').add(Object.assign({ published: false, createdAt: new Date().toISOString() }, data));
      }
      await loadLabourShifts(); closeModal();
      toast(id ? 'Shift updated.' : 'Shift added — publish it so the labour person can see it.', 'ok');
      renderView();
    },
  });

  // =================================================================
  // Labour Work Log (how labour "operates" once logged in) + Invoices
  //
  // A labour person logs their hours for the day — work type (only asked
  // when they're set up as both Delivery Person and Warehouse), hours,
  // optional notes. A manager/admin reviews and approves/rejects it on
  // the Labour Logs page, the same Pending/Approved/Rejected pattern as
  // Driver Submissions. Approved, not-yet-invoiced logs are exactly what
  // the Invoice generator pulls together to bill the Labour company —
  // this is the connected chain: Labour login -> Log Work -> Approval ->
  // Invoice.
  // =================================================================
  function labourLogsBanner() {
    const pending = state.labourLogs.filter((g) => g.status === 'Pending').length;
    if (!pending) return '';
    return `<li><span><strong class="tnum">${pending}</strong> labour log${pending === 1 ? '' : 's'} to approve</span><button class="btn btn-sm" data-action="nav" data-route="labour-logs">Review</button></li>`;
  }
  function todaysMatchedShift(labourId, today) {
    return state.labourShifts.find((s) => s.labourId === labourId && s.date === today && s.published);
  }
  function fmtTimeHuman(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function viewLabourLog() {
    const labourId = currentLabourId();
    const l = state.labour.find((x) => x.id === labourId);
    if (!l) {
      return `<div class="view-header"><div><h1>Today</h1></div></div><div class="card empty-state"><p>No labour record found for this login.</p></div>`;
    }
    const company = state.companies.find((c) => c.id === l.companyId);
    if (!company) {
      return `
        <div class="view-header"><div><h1>Hi, ${esc(l.name)}</h1></div></div>
        <div class="card empty-state"><p>No company assigned yet — ask your admin to assign one before clocking in.</p></div>
      `;
    }

    const types = l.labourTypes && l.labourTypes.length ? l.labourTypes : ['warehouse'];
    const today = todayStr();
    const todayLogs = state.labourLogs
      .filter((g) => g.labourId === labourId && g.date === today)
      .sort((a, b) => (b.clockInAt || b.createdAt || '').localeCompare(a.clockInAt || a.createdAt || ''));
    const activeLog = todayLogs.find((g) => g.status === 'InProgress' && g.clockInAt && !g.clockOutAt) || null;

    // A rostered shift can be used once. After it is clocked, the Labour
    // person can select another unused rostered shift or choose other work.
    const usedShiftIds = new Set(todayLogs.map((g) => g.shiftId).filter(Boolean));
    const availableShifts = state.labourShifts
      .filter((s) => s.labourId === labourId && s.date === today && s.published && !usedShiftIds.has(s.id))
      .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));

    const todayHistory = todayLogs.length ? `
      <div class="card" style="margin-top:16px;">
        <h3 style="margin:0 0 12px;">Today's work entries (${todayLogs.length})</h3>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Work</th><th>Clocked</th><th>Hours</th><th>Status</th></tr></thead>
          <tbody>${todayLogs.map((g) => `<tr>
            <td>${esc(LABOUR_TYPE_LABEL[g.workType] || g.workType || 'Work')}${g.shiftId ? '<div class="helptext">Rostered shift</div>' : ''}</td>
            <td style="white-space:nowrap;">${g.clockInAt ? fmtTimeHuman(g.clockInAt) + (g.clockOutAt ? '–' + fmtTimeHuman(g.clockOutAt) : '– In progress') : '—'}</td>
            <td class="tnum">${Number(g.hours || 0).toFixed(2)}</td>
            <td>${g.status === 'Approved' ? '<span class="pill pill-paid">Approved</span>' : g.status === 'Rejected' ? '<span class="pill pill-cancelled">Rejected</span>' : g.status === 'InProgress' ? '<span class="pill pill-other">In progress</span>' : '<span class="pill pill-pending">Pending</span>'}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>
    ` : '';

    const header = `<div class="view-header"><div><h1>Hi, ${esc(l.name)}</h1><div class="sub">${fmtDateHuman(today)}</div></div></div>`;

    if (activeLog) {
      return `
        ${header}
        <div class="card" style="text-align:center;padding:28px 20px;">
          <p class="helptext" style="margin:0;">Current work — clocked in at</p>
          <p style="font-size:1.4rem;font-weight:700;margin:6px 0 20px;">${fmtTimeHuman(activeLog.clockInAt)}</p>
          <p class="helptext">${esc(LABOUR_TYPE_LABEL[activeLog.workType] || activeLog.workType)}${activeLog.shiftId ? ' · rostered shift' : ''}</p>
          <form data-onsubmit="labour-clock-out" data-id="${activeLog.id}">
            <div class="field" style="margin-bottom:16px;text-align:left;"><label class="field-label">Notes (optional)</label><textarea name="notes" rows="2" placeholder="Anything the manager should know">${esc(activeLog.notes || '')}</textarea></div>
            <button class="btn btn-primary" type="submit" style="width:100%;font-size:1.2rem;padding:18px;">CLOCK OUT</button>
          </form>
        </div>
        ${todayHistory}
      `;
    }

    const shiftOptions = availableShifts.map((s) =>
      `<option value="${s.id}">${esc(company.name)} — ${esc(LABOUR_TYPE_LABEL[s.workType] || s.workType)} · ${esc(s.startTime)}–${esc(s.endTime)}</option>`
    ).join('');
    const shiftPicker = availableShifts.length
      ? `<div class="field" style="margin-bottom:16px;"><label class="field-label">Rostered shift (optional)</label><select name="shiftId"><option value="">Other / unrostered work</option>${shiftOptions}</select></div>`
      : `<input type="hidden" name="shiftId" value="">`;

    const needsTypePick = types.length > 1;
    const workTypePicker = needsTypePick
      ? `<div class="field" style="margin-bottom:16px;"><label class="field-label">Type of work (for other / unrostered work)</label><select name="workType" required>${types.map((t) => `<option value="${t}">${esc(LABOUR_TYPE_LABEL[t] || t)}</option>`).join('')}</select></div>`
      : `<input type="hidden" name="workType" value="${types[0]}">`;

    return `
      ${header}
      <div class="card">
        <h3 style="margin:0 0 8px;">${todayLogs.length ? 'Start another work entry' : "Today's work"}</h3>
        <p class="helptext" style="margin:0 0 16px;">You can record multiple separate work periods today. Clock out of the current one before starting another. Each entry is sent separately for approval.</p>
        ${hasSitePin(company) ? `<p class="helptext" style="margin:0 0 16px;">You need to be at ${esc(company.siteAddress || company.name)} to clock in and out. Your phone will ask to share your location.</p>` : ''}
        <form data-onsubmit="labour-clock-in">
          ${shiftPicker}
          ${workTypePicker}
          <button class="btn btn-primary" type="submit" style="width:100%;font-size:1.2rem;padding:18px;">CLOCK IN</button>
        </form>
      </div>
      ${todayHistory}
    `;
  }
  function viewLabourMyShifts() {
    const labourId = currentLabourId();
    const today = todayStr();
    const rows = state.labourShifts.filter((s) => s.labourId === labourId && s.published && s.date >= today).sort((a, b) => a.date.localeCompare(b.date));
    const body = rows.length ? rows.map((s) => `<tr>
      <td>${fmtDateHuman(s.date)}</td><td>${esc(s.companyName)}</td><td>${esc(LABOUR_TYPE_LABEL[s.workType] || s.workType)}</td>
      <td class="tnum" style="white-space:nowrap;">${esc(s.startTime)}–${esc(s.endTime)}</td><td class="tnum">${s.estHours} hrs</td><td class="tnum">${fmtMoney(s.estPayCost)}</td>
    </tr>`).join('') : `<tr><td colspan="6"><div class="empty-state">No upcoming shifts scheduled.</div></td></tr>`;
    return `
      <div class="view-header"><div><h1>My Shifts</h1></div></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>Company</th><th>Type</th><th>Time</th><th>Hours</th><th>Est. Pay</th></tr></thead><tbody>${body}</tbody></table></div>
    `;
  }
  function viewLabourMyHistory() {
    const labourId = currentLabourId();
    const rows = state.labourLogs.filter((g) => g.labourId === labourId && g.status !== 'InProgress').sort((a, b) => b.date.localeCompare(a.date));
    const body = rows.length ? rows.map((g) => `<tr>
      <td>${g.date}</td><td>${esc(LABOUR_TYPE_LABEL[g.workType] || g.workType)}</td>
      <td class="tnum" style="white-space:nowrap;">${g.clockInAt ? fmtTimeHuman(g.clockInAt) + '–' + fmtTimeHuman(g.clockOutAt) : '—'}</td>
      <td class="tnum">${g.hours}</td><td class="tnum">${fmtMoney(g.payAmount)}</td>
      <td>${g.status === 'Approved' ? '<span class="pill pill-paid">Approved</span>' : g.status === 'Rejected' ? '<span class="pill pill-cancelled">Rejected</span>' : '<span class="pill pill-pending">Pending</span>'}</td>
    </tr>`).join('') : `<tr><td colspan="6"><div class="empty-state">No logs yet.</div></td></tr>`;
    return `
      <div class="view-header"><div><h1>My Logs</h1></div></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>Type</th><th>Clocked</th><th>Hours</th><th>Pay</th><th>Status</th></tr></thead><tbody>${body}</tbody></table></div>
    `;
  }

  const labourLogsUi = { status: 'Pending' };
  function viewLabourLogs() {
    let rows = state.labourLogs.filter((g) => g.status !== 'InProgress');
    if (labourLogsUi.status) rows = rows.filter((g) => g.status === labourLogsUi.status);
    rows.sort((a, b) => b.date.localeCompare(a.date));
    const cap = capRows(rows);
    rows = cap.shown;
    const body = rows.length ? rows.map((g) => {
      const scheduledHours = (g.scheduledStart && g.scheduledFinish) ? shiftDurationHours(g.scheduledStart, g.scheduledFinish) : null;
      const variance = scheduledHours != null ? Math.round((g.hours - scheduledHours) * 100) / 100 : null;
      const varianceHtml = variance == null ? '—' : (variance === 0 ? '<span class="helptext">On time</span>' : `<span style="color:${variance > 0 ? '#b45309' : '#dc2626'};font-weight:600;">${variance > 0 ? '+' : ''}${variance} hrs</span>`);
      const margin = (Number(g.amount) || 0) - (Number(g.payAmount) || 0);
      const tierHtml = g.tierLines && g.tierLines.length ? esc(tierBreakdownLabel(g.tierLines)) : (g.usedRateCard === false ? '<span class="helptext">flat rate</span>' : '—');
      return `<tr>
      <td>${g.date}</td><td>${esc(g.labourName)}</td><td>${esc(g.companyName)}</td><td>${esc(LABOUR_TYPE_LABEL[g.workType] || g.workType)}</td>
      <td>${esc(g.category || 'Standard')}<br>${tierHtml}</td>
      <td class="tnum">${scheduledHours != null ? scheduledHours : '—'}</td>
      <td class="tnum" style="white-space:nowrap;">${g.clockInAt ? `${fmtTimeHuman(g.clockInAt)} – ${g.clockOutAt ? fmtTimeHuman(g.clockOutAt) : 'In progress'}` : '—'}${g.clockInLocation || g.clockOutLocation ? `<div class="helptext">${g.clockInLocation ? 'In: ' + g.clockInLocation.distance + ' m' : ''}${g.clockInLocation && g.clockOutLocation ? ' · ' : ''}${g.clockOutLocation ? 'Out: ' + g.clockOutLocation.distance + ' m' : ''} from site</div>` : ''}</td>
      <td class="tnum">${g.hours}</td>
      <td>${varianceHtml}</td>
      <td class="tnum" style="font-weight:700;">${fmtMoney(g.amount)}</td>
      <td class="tnum">${fmtMoney(g.payAmount)}</td>
      <td class="tnum">${fmtMoney(margin)}</td>
      <td class="wrap">${esc(g.notes || '')}${g.overridden ? ' <span class="pill pill-other">Overridden</span>' : ''}</td>
      <td>${g.status === 'Approved' ? '<span class="pill pill-paid">Approved</span>' : g.status === 'Rejected' ? '<span class="pill pill-cancelled">Rejected</span>' : '<span class="pill pill-pending">Pending</span>'}</td>
      <td style="white-space:nowrap;">
        ${isAdmin() && !g.invoiceId ? `<button class="btn btn-sm" data-action="labour-log-edit-times" data-id="${g.id}">Edit times</button><br>` : ''}
        ${g.status === 'Pending'
        ? `<button class="btn btn-sm btn-primary" data-action="labour-log-approve" data-id="${g.id}">Approve</button> <button class="btn btn-sm btn-danger" data-action="labour-log-reject" data-id="${g.id}">Reject</button><br><button class="btn btn-sm" style="margin-top:4px;" data-action="labour-log-override" data-id="${g.id}">Override rate</button>`
        : g.status === 'Rejected' ? `<span class="helptext">${esc(g.rejectionReason || '')}</span>` : (g.invoiceId ? '<span class="helptext">Invoiced — time edits locked</span>' : `<span class="helptext">Ready to invoice</span><br><button class="btn btn-sm" style="margin-top:4px;" data-action="labour-log-override" data-id="${g.id}">Override rate</button>`)}</td>
    </tr>`;
    }).join('') : `<tr><td colspan="15"><div class="empty-state">No logs.</div></td></tr>`;
    const recentAudit = state.auditLog.filter((a) => a.entityType === 'labourLog').slice(0, 15);
    const auditHtml = recentAudit.length ? `
      <div class="section-title"><h2>Recent rate overrides</h2></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>When</th><th>Changed by</th><th>Field</th><th>Old</th><th>New</th><th>Reason</th></tr></thead><tbody>
        ${recentAudit.map((a) => `<tr><td>${new Date(a.changedAt).toLocaleString()}</td><td>${esc(a.changedBy)}</td><td>${esc(a.field)}</td><td class="tnum">${fmtMoney(a.oldValue)}</td><td class="tnum">${fmtMoney(a.newValue)}</td><td class="wrap">${esc(a.reason)}</td></tr>`).join('')}
      </tbody></table></div>` : '';
    return `
      <div class="view-header"><div><h1>Labour Logs</h1><div class="sub">Clocked hours, compared against the rostered shift where one exists</div></div></div>
      <div class="toolbar">
        <select data-onchange="labour-log-filter">
          <option value="Pending" ${labourLogsUi.status === 'Pending' ? 'selected' : ''}>Pending</option>
          <option value="Approved" ${labourLogsUi.status === 'Approved' ? 'selected' : ''}>Approved</option>
          <option value="Rejected" ${labourLogsUi.status === 'Rejected' ? 'selected' : ''}>Rejected</option>
          <option value="" ${labourLogsUi.status === '' ? 'selected' : ''}>All</option>
        </select>
      </div>
      ${capNoticeHtml(cap)}
      <div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>Labour</th><th>Company</th><th>Type</th><th>Category / Tiers</th><th>Scheduled</th><th>Clock times</th><th>Actual hours</th><th>Variance</th><th>Bill Amount</th><th>Pay Amount</th><th>Margin</th><th>Notes</th><th>Status</th><th>Actions</th></tr></thead><tbody>${body}</tbody></table></div>
      <p class="helptext" style="margin-top:12px;">Bill Amount is what will be invoiced to the company; Pay Amount is what the labour person earns. Approving a log makes those hours billable — generate an invoice for the company to include them. "Override rate" lets an authorised manager adjust the computed amounts, with a mandatory reason recorded below.</p>
      ${auditHtml}
    `;
  }
  function labourLogRejectModal(logId) {
    openModal(`
      <div class="modal-head"><h3>Reject log</h3><button data-action="modal-close" aria-label="Close">✕</button></div>
      <form data-onsubmit="labour-log-reject-save" data-id="${logId}">
        <div class="field"><label class="field-label">Reason (shown to the labour person)</label><textarea name="reason" rows="2" required></textarea></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
          <button type="button" class="btn" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn-danger">Reject</button>
        </div>
      </form>
    `);
  }
  function labourDateTimeInputValue(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }
  function labourLogEditTimesModal(logId) {
    if (!isAdmin()) { toast('Only Admin can edit Labour clock times.', 'err'); return; }
    const log = state.labourLogs.find((g) => g.id === logId);
    if (!log) return;
    if (log.invoiceId) { toast('This log is invoiced; its clock times are locked.', 'err'); return; }
    openModal(`
      <div class="modal-head"><h3>Edit clock times — ${esc(log.labourName)} · ${esc(log.date)}</h3><button data-action="modal-close" aria-label="Close">✕</button></div>
      <p class="helptext" style="margin-bottom:12px;">Times are shown in your device's local timezone. Actual hours, bill amount and worker pay are recalculated. A reason is required and the changes are recorded in the audit log.</p>
      <form data-onsubmit="labour-log-edit-times-save" data-id="${logId}">
        <div class="field-row" style="margin-bottom:12px;">
          <div class="field"><label class="field-label">Clock-in</label><input type="datetime-local" name="clockInAt" value="${esc(labourDateTimeInputValue(log.clockInAt))}" required></div>
          <div class="field"><label class="field-label">Clock-out</label><input type="datetime-local" name="clockOutAt" value="${esc(labourDateTimeInputValue(log.clockOutAt))}" required></div>
        </div>
        <div class="field"><label class="field-label">Reason for correction</label><textarea name="reason" rows="2" required placeholder="Explain why the recorded times are being corrected"></textarea></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
          <button type="button" class="btn" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn-primary">Save times</button>
        </div>
      </form>
    `, { wide: true });
  }

  // Writes one immutable auditLog entry per changed field — used whenever an
  // authorised manager manually overrides a computed rate/amount.
  async function writeAuditEntry(entityType, entityId, field, oldValue, newValue, reason) {
    await state.db.collection('auditLog').add({
      entityType, entityId, field, oldValue, newValue, reason,
      changedBy: state.session ? state.session.name : '', changedAt: new Date().toISOString(),
    });
  }
  function labourLogOverrideModal(logId) {
    const log = state.labourLogs.find((g) => g.id === logId);
    if (!log) return;
    openModal(`
      <div class="modal-head"><h3>Override rate — ${esc(log.labourName)} · ${esc(log.date)}</h3><button data-action="modal-close" aria-label="Close">✕</button></div>
      <p class="helptext" style="margin-bottom:12px;">Computed from ${log.hours} hrs${log.tierLines ? ' (' + esc(tierBreakdownLabel(log.tierLines)) + ')' : ''}. Overriding replaces the amounts below and is recorded in the audit log with your name, the old and new values, and your reason.</p>
      <form data-onsubmit="labour-log-override-save" data-id="${logId}">
        <div class="field-row" style="margin-bottom:12px;">
          <div class="field"><label class="field-label">Bill amount ($, charged to company)</label><input type="number" step="0.01" min="0" name="amount" value="${log.amount || 0}" required></div>
          <div class="field"><label class="field-label">Pay amount ($, paid to worker)</label><input type="number" step="0.01" min="0" name="payAmount" value="${log.payAmount || 0}" required></div>
        </div>
        <div class="field"><label class="field-label">Reason for override (required, authorised managers only)</label><textarea name="reason" rows="2" required></textarea></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
          <button type="button" class="btn" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn-primary">Save override</button>
        </div>
      </form>
    `);
  }

  // ---------------- Invoices (bills a Labour company for approved hours) ----------------
  let invoiceDraft = null;
  function viewInvoices() {
    const rows = state.invoices.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const body = rows.length ? rows.map((inv) => `<tr>
      <td class="tnum">${esc(inv.invoiceRef)}</td><td>${esc(inv.companyName)}</td><td>${inv.periodFrom} – ${inv.periodTo}</td>
      <td class="tnum">${inv.lineItems.length}</td><td class="tnum" style="font-weight:700;">${fmtMoney(invoiceTotals(inv).total)}</td>
      <td class="tnum">${fmtMoney((Number(inv.total) || 0) - (Number(inv.payTotal) || 0))}</td>
      <td>${inv.status === 'Paid' ? '<span class="pill pill-paid">Paid</span>' : inv.status === 'Sent' ? '<span class="pill pill-other">Sent</span>' : '<span class="pill pill-pending">Draft</span>'}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-sm" data-action="invoice-view" data-id="${inv.id}">View</button>
        <button class="btn btn-sm" data-action="invoice-pdf" data-id="${inv.id}">Download PDF</button>
        ${inv.status === 'Draft' ? `<button class="btn btn-sm" data-action="invoice-mark-sent" data-id="${inv.id}">Mark sent</button>` : ''}
        ${inv.status === 'Sent' ? `<button class="btn btn-sm" data-action="invoice-mark-paid" data-id="${inv.id}">Mark paid</button>` : ''}
      </td>
    </tr>`).join('') : `<tr><td colspan="8"><div class="empty-state">No invoices yet.</div></td></tr>`;
    return `
      <div class="view-header">
        <div><h1>Invoices</h1><div class="sub">Bill a Labour company for its approved, uninvoiced hours — always at the company's bill rate</div></div>
        <button class="btn btn-primary" data-action="invoice-generate">+ Generate invoice</button>
      </div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Ref</th><th>Company</th><th>Period</th><th>Lines</th><th>Total</th><th>Margin</th><th>Status</th><th>Actions</th></tr></thead><tbody>${body}</tbody></table></div>
    `;
  }
  function invoiceGenerateModal() {
    const companies = labourCompanyOptions();
    const opts = companies.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    openModal(`
      <div class="modal-head"><h3>Generate invoice</h3><button data-action="modal-close" aria-label="Close">✕</button></div>
      ${companies.length ? `
      <form data-onsubmit="invoice-preview">
        <div class="field" style="margin-bottom:12px;"><label class="field-label">Company</label><select name="companyId" required><option value="">Select company…</option>${opts}</select></div>
        <div class="field-row" style="margin-bottom:12px;">
          <div class="field"><label class="field-label">From</label><input type="date" name="from" required></div>
          <div class="field"><label class="field-label">To</label><input type="date" name="to" required></div>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
          <button type="button" class="btn" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn-primary">Preview</button>
        </div>
      </form>` : `<p class="helptext">No Labour-type companies yet — add one on the Companies page first.</p>`}
    `);
  }
  function invoicePreviewModal(companyId, from, to) {
    const company = state.companies.find((c) => c.id === companyId);
    const logs = state.labourLogs.filter((g) => g.companyId === companyId && g.status === 'Approved' && !g.invoiceId && g.date >= from && g.date <= to);
    // The invoice always bills at the company's bill rate (g.rate/g.amount) —
    // never the labour person's own pay rate — payAmount is carried along
    // only so admin/manager can see the resulting margin before committing.
    const total = logs.reduce((s, g) => s + (Number(g.amount) || 0), 0);
    const payTotal = logs.reduce((s, g) => s + (Number(g.payAmount) || 0), 0);
    invoiceDraft = {
      companyId, companyName: company ? company.name : '', from, to,
      logIds: logs.map((g) => g.id),
      lineItems: logs.map((g) => ({ logId: g.id, labourName: g.labourName, date: g.date, workType: g.workType, category: g.category || 'Standard', tierSummary: tierBreakdownLabel(g.tierLines), hours: g.hours, rate: g.rate, amount: g.amount, payRate: g.payRate, payAmount: g.payAmount })),
      total, payTotal,
    };
    const rowsHtml = logs.length ? logs.map((g) => `<tr><td>${g.date}</td><td>${esc(g.labourName)}</td><td>${esc(LABOUR_TYPE_LABEL[g.workType] || g.workType)}</td><td class="tnum">${g.hours}</td><td class="tnum">${fmtMoney(g.rate)}</td><td class="tnum">${fmtMoney(g.amount)}</td><td class="tnum">${fmtMoney(g.payAmount)}</td></tr>`).join('') : `<tr><td colspan="7"><div class="empty-state">No approved, uninvoiced hours in this range.</div></td></tr>`;
    openModal(`
      <div class="modal-head"><h3>Invoice preview — ${esc(company ? company.name : '')}</h3><button data-action="modal-close" aria-label="Close">✕</button></div>
      <p class="helptext" style="margin-bottom:10px;">${esc(from)} – ${esc(to)}</p>
      <div class="table-wrap" style="max-height:320px;overflow-y:auto;">
        <table class="data"><thead><tr><th>Date</th><th>Labour</th><th>Type</th><th>Hours</th><th>Rate</th><th>Amount</th><th>Worker Pay</th></tr></thead><tbody>${rowsHtml}</tbody></table>
      </div>
      <p style="text-align:right;margin-top:10px;">Worker cost: ${fmtMoney(payTotal)} · Margin: <strong>${fmtMoney(total - payTotal)}</strong></p>
      <p style="text-align:right;font-weight:700;margin-top:4px;">Invoice total: ${fmtMoney(total)}</p>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
        <button class="btn" data-action="modal-close">Cancel</button>
        <button class="btn btn-primary" data-action="invoice-commit" ${logs.length ? '' : 'disabled'}>Create invoice</button>
      </div>
    `, { wide: true });
  }
  // ---- Invoice PDF ------------------------------------------------------
  // jsPDF + AutoTable are served from /vendor and loaded only when needed.
  const scriptLoads = {};
  function loadScriptOnce(src) {
    if (!scriptLoads[src]) {
      scriptLoads[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src; s.async = true;
        s.onload = () => resolve();
        s.onerror = () => { delete scriptLoads[src]; reject(new Error('Could not load the PDF tool. Check your connection and try again.')); };
        document.head.appendChild(s);
      });
    }
    return scriptLoads[src];
  }
  async function loadPdfLib() {
    await loadScriptOnce('vendor/jspdf.umd.min.js');
    await loadScriptOnce('vendor/jspdf.plugin.autotable.min.js');
    if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('The PDF tool did not load. Refresh the page and try again.');
    return window.jspdf.jsPDF;
  }
  function invoiceDates(inv) {
    const issued = String(inv.issuedDate || inv.createdAt || todayStr()).slice(0, 10);
    const terms = Number(state.settings.invoiceTermsDays != null ? state.settings.invoiceTermsDays : 14) || 0;
    const [y, m, d] = issued.split('-').map(Number);
    const due = new Date(y, m - 1, d + terms);
    const dueStr = due.getFullYear() + '-' + String(due.getMonth() + 1).padStart(2, '0') + '-' + String(due.getDate()).padStart(2, '0');
    return { issued, due: dueStr, terms };
  }
  function invoiceTotals(inv) {
    const subtotal = Math.round((Number(inv.subtotal != null ? inv.subtotal : inv.total) || 0) * 100) / 100;
    const gst = state.settings.invoiceGst === 'add10' ? Math.round(subtotal * 10) / 100 : 0;
    return { subtotal, gst, total: Math.round((subtotal + gst) * 100) / 100, hasGst: state.settings.invoiceGst === 'add10' };
  }
  function pdfDate(dateStr) {
    if (!dateStr) return '';
    const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  async function downloadInvoicePdf(invId) {
    const inv = state.invoices.find((i) => i.id === invId);
    if (!inv) { toast('Invoice not found.', 'err'); return; }
    const JsPDF = await loadPdfLib();
    const s = state.settings;
    const company = state.companies.find((c) => c.id === inv.companyId) || {};
    const { issued, due } = invoiceDates(inv);
    const totals = invoiceTotals(inv);
    const NAVY = [19, 28, 46], GOLD = [184, 146, 90], INK = [19, 28, 46], MUTED = [88, 98, 117], LINE = [228, 223, 212];
    const money = (n) => fmtMoney(n);

    const doc = new JsPDF({ unit: 'mm', format: 'a4' });
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 16;

    // Header band
    doc.setFillColor(...NAVY); doc.rect(0, 0, W, 38, 'F');
    doc.setFillColor(...GOLD); doc.rect(0, 38, W, 1.2, 'F');
    doc.setFont('times', 'bold'); doc.setFontSize(21); doc.setTextColor(255, 255, 255);
    doc.text(s.businessName || 'UMA Management', M, 20);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(216, 187, 134);
    const fromBits = [s.invoiceAbn ? 'ABN ' + s.invoiceAbn : '', s.invoicePhone, s.invoiceEmail].filter(Boolean).join('   ·   ');
    if (fromBits) doc.text(fromBits, M, 28);
    if (s.invoiceAddress) { doc.setTextColor(200, 206, 216); doc.text(s.invoiceAddress, M, 33); }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(216, 187, 134);
    const title = totals.hasGst ? 'TAX INVOICE' : 'INVOICE';
    const titleWidth = doc.getTextWidth(title) + 1.2 * (title.length - 1);
    doc.text(title, W - M - titleWidth, 20, { charSpace: 1.2 });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(255, 255, 255);
    doc.text(inv.invoiceRef || '', W - M, 27, { align: 'right' });

    // Bill to + invoice facts
    let y = 52;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(...GOLD);
    doc.text('BILL TO', M, y, { charSpace: 0.8 });
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...INK);
    doc.text(inv.companyName || company.name || '', M, y + 7);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
    const billLines = [company.contactPerson ? 'Attn: ' + company.contactPerson : '', company.abn ? 'ABN ' + company.abn : '', company.siteAddress || '', company.email || ''].filter(Boolean);
    billLines.forEach((line, i) => doc.text(doc.splitTextToSize(line, 90)[0], M, y + 13 + i * 5));

    const facts = [['Invoice number', inv.invoiceRef || ''], ['Issue date', pdfDate(issued)], ['Due date', pdfDate(due)], ['Work period', pdfDate(inv.periodFrom) + ' – ' + pdfDate(inv.periodTo)]];
    facts.forEach(([k, v], i) => {
      const fy = y + i * 6.5;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...MUTED); doc.text(k, W - M - 62, fy);
      doc.setFont('helvetica', 'bold'); doc.setTextColor(...INK); doc.text(v, W - M, fy, { align: 'right' });
    });

    // Line items (client-facing only: no worker pay or margin)
    const startY = Math.max(y + 16 + billLines.length * 5, y + facts.length * 6.5 + 6);
    const items = (inv.lineItems || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    doc.autoTable({
      startY,
      margin: { left: M, right: M },
      head: [['Date', 'Worker', 'Work', 'Hours', 'Rate', 'Amount']],
      body: items.map((li) => [pdfDate(li.date), li.labourName || '', LABOUR_TYPE_LABEL[li.workType] || li.workType || '', (Number(li.hours) || 0).toFixed(2), money(li.rate), money(li.amount)]),
      theme: 'plain',
      styles: { font: 'helvetica', fontSize: 9, textColor: INK, cellPadding: { top: 3, bottom: 3, left: 3, right: 3 }, lineColor: LINE },
      headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
      alternateRowStyles: { fillColor: [250, 248, 244] },
      columnStyles: { 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right', fontStyle: 'bold' } },
      didParseCell: (data) => { if (data.section === 'head' && data.column.index >= 3) data.cell.styles.halign = 'right'; },
    });

    // Totals
    y = doc.lastAutoTable.finalY + 8;
    if (y > H - 70) { doc.addPage(); y = 24; }
    const tx = W - M - 70;
    const totalRows = [['Subtotal', money(totals.subtotal)]];
    if (totals.hasGst) totalRows.push(['GST (10%)', money(totals.gst)]);
    doc.setFontSize(9.5);
    totalRows.forEach(([k, v], i) => {
      doc.setFont('helvetica', 'normal'); doc.setTextColor(...MUTED); doc.text(k, tx, y + i * 6.5);
      doc.setTextColor(...INK); doc.text(v, W - M, y + i * 6.5, { align: 'right' });
    });
    y += totalRows.length * 6.5;
    doc.setFillColor(...NAVY); doc.roundedRect(tx - 4, y - 1, W - M - tx + 4, 12, 2, 2, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(216, 187, 134); doc.text('Total due', tx, y + 6.8);
    doc.setTextColor(255, 255, 255); doc.text(money(totals.total) + ' AUD', W - M - 3, y + 6.8, { align: 'right' });
    if (totals.hasGst) { doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...MUTED); doc.text('Total includes GST of ' + money(totals.gst), W - M, y + 17, { align: 'right' }); }

    // Payment details
    if (s.invoiceBankName || s.invoiceBsb || s.invoiceAccount) {
      let py = y + 26;
      doc.setDrawColor(...LINE); doc.setLineWidth(0.3); doc.line(M, py - 6, W - M, py - 6);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(...GOLD); doc.text('HOW TO PAY', M, py, { charSpace: 0.8 });
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...INK);
      const payLines = [['Account name', s.invoiceBankName], ['BSB', s.invoiceBsb], ['Account number', s.invoiceAccount], ['Reference', inv.invoiceRef], ['Pay by', pdfDate(due)]].filter((r) => r[1]);
      payLines.forEach(([k, v], i) => { doc.setTextColor(...MUTED); doc.text(k, M, py + 7 + i * 5.5); doc.setTextColor(...INK); doc.text(String(v), M + 34, py + 7 + i * 5.5); });
    }

    // Footer on every page
    const pages = doc.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setDrawColor(...GOLD); doc.setLineWidth(0.4); doc.line(M, H - 16, W - M, H - 16);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
      doc.text(s.invoiceNote || 'Thank you for your business.', M, H - 10);
      doc.text(`${inv.invoiceRef || ''}  ·  Page ${p} of ${pages}`, W - M, H - 10, { align: 'right' });
    }

    const safeName = `${inv.invoiceRef || 'Invoice'} ${inv.companyName || ''}`.replace(/[\\/:*?"<>|]+/g, '').trim();
    doc.save(safeName + '.pdf');
    toast('Invoice PDF downloaded.', 'ok');
  }

  function invoiceViewModal(invId) {
    const inv = state.invoices.find((i) => i.id === invId);
    if (!inv) return;
    const payTotal = inv.lineItems.reduce((s, li) => s + (Number(li.payAmount) || 0), 0);
    const rowsHtml = inv.lineItems.map((li) => `<tr><td>${li.date}</td><td>${esc(li.labourName)}</td><td>${esc(LABOUR_TYPE_LABEL[li.workType] || li.workType)}</td><td class="tnum">${li.hours}</td><td class="tnum">${fmtMoney(li.rate)}</td><td class="tnum">${fmtMoney(li.amount)}</td><td class="tnum">${fmtMoney(li.payAmount)}</td></tr>`).join('');
    openModal(`
      <div class="modal-head"><h3>${esc(inv.invoiceRef)} — ${esc(inv.companyName)}</h3><button data-action="modal-close" aria-label="Close">✕</button></div>
      <p class="helptext" style="margin-bottom:10px;">${inv.periodFrom} – ${inv.periodTo} · <span class="pill ${inv.status === 'Paid' ? 'pill-paid' : inv.status === 'Sent' ? 'pill-other' : 'pill-pending'}">${esc(inv.status)}</span></p>
      <div class="table-wrap" style="max-height:320px;overflow-y:auto;">
        <table class="data"><thead><tr><th>Date</th><th>Labour</th><th>Type</th><th>Hours</th><th>Rate</th><th>Amount</th><th>Worker Pay</th></tr></thead><tbody>${rowsHtml}</tbody></table>
      </div>
      <p style="text-align:right;margin-top:10px;">Worker cost: ${fmtMoney(payTotal)} · Margin: <strong>${fmtMoney((Number(inv.total) || 0) - payTotal)}</strong></p>
      ${invoiceTotals(inv).hasGst ? `<p style="text-align:right;margin-top:4px;">Subtotal: ${fmtMoney(invoiceTotals(inv).subtotal)} · GST: ${fmtMoney(invoiceTotals(inv).gst)}</p>` : ''}
      <p style="text-align:right;font-weight:700;margin-top:4px;">Total${invoiceTotals(inv).hasGst ? ' incl. GST' : ''}: ${fmtMoney(invoiceTotals(inv).total)}</p>
      <p class="helptext" style="text-align:right;margin-top:4px;">Worker pay and margin are for you only — they're not printed on the PDF.</p>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;"><button class="btn" data-action="modal-close">Close</button><button class="btn btn-primary" data-action="invoice-pdf" data-id="${inv.id}">Download PDF</button></div>
    `, { wide: true });
  }

  Object.assign(ACTIONS, {
    'labour-log-approve': async (el) => {
      const log = state.labourLogs.find((g) => g.id === el.dataset.id);
      if (!log) return;
      await state.db.doc('labourLogs/' + log.id).update({ status: 'Approved', approvedBy: state.session ? state.session.name : '', approvedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await loadLabourLogs();
      toast('Approved — ready to invoice.', 'ok');
      renderView();
    },
    'labour-log-reject': (el) => labourLogRejectModal(el.dataset.id),
    'labour-log-edit-times': (el) => labourLogEditTimesModal(el.dataset.id),
    'labour-log-override': (el) => labourLogOverrideModal(el.dataset.id),
    'invoice-generate': () => invoiceGenerateModal(),
    'invoice-view': (el) => invoiceViewModal(el.dataset.id),
    'invoice-pdf': async (el) => {
      const label = el.textContent; el.disabled = true; el.textContent = 'Preparing PDF…';
      try { await downloadInvoicePdf(el.dataset.id); }
      finally { if (el.isConnected) { el.disabled = false; el.textContent = label; } }
    },
    'invoice-mark-sent': async (el) => {
      await state.db.doc('invoices/' + el.dataset.id).update({ status: 'Sent', updatedAt: new Date().toISOString() });
      await loadInvoices(); toast('Marked sent.', 'ok'); renderView();
    },
    'invoice-mark-paid': async (el) => {
      await state.db.doc('invoices/' + el.dataset.id).update({ status: 'Paid', updatedAt: new Date().toISOString() });
      await loadInvoices(); toast('Marked paid.', 'ok'); renderView();
    },
    'invoice-commit': async () => {
      if (!invoiceDraft || !invoiceDraft.logIds.length) return;
      const ref = await claimInvoiceRef(todayStr());
      const invRef = await state.db.collection('invoices').add({
        invoiceRef: ref, companyId: invoiceDraft.companyId, companyName: invoiceDraft.companyName,
        periodFrom: invoiceDraft.from, periodTo: invoiceDraft.to, lineItems: invoiceDraft.lineItems,
        subtotal: invoiceDraft.total, total: invoiceDraft.total, payTotal: invoiceDraft.payTotal || 0, status: 'Draft',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      for (const logId of invoiceDraft.logIds) {
        await state.db.doc('labourLogs/' + logId).update({ invoiceId: invRef.id, updatedAt: new Date().toISOString() });
      }
      await loadInvoices(); await loadLabourLogs();
      invoiceDraft = null;
      closeModal();
      toast('Invoice created.', 'ok');
      setRoute('invoices');
    },
  });
  Object.assign(CHANGE_HANDLERS, {
    'labour-log-filter': (el) => { labourLogsUi.status = el.value; renderView(); },
  });
  Object.assign(SUBMIT_HANDLERS, {
    'labour-clock-in': async (form) => {
      const fd = new FormData(form);
      const labourId = currentLabourId();
      const l = state.labour.find((x) => x.id === labourId);
      if (!l) return;

      const today = todayStr();
      const currentActive = state.labourLogs.find((g) =>
        g.labourId === labourId && g.date === today &&
        g.status === 'InProgress' && g.clockInAt && !g.clockOutAt
      );
      if (currentActive) {
        toast('Please clock out of your current work before starting another.', 'err');
        return;
      }

      const company = state.companies.find((c) => c.id === l.companyId);
      const shiftId = String(fd.get('shiftId') || form.dataset.shiftId || '');
      const shift = shiftId ? state.labourShifts.find((s) =>
        s.id === shiftId && s.labourId === labourId && s.date === today && s.published
      ) : null;
      if (shiftId && !shift) {
        toast('That rostered shift is no longer available. Refresh and try again.', 'err');
        return;
      }
      if (shift && state.labourLogs.some((g) => g.labourId === labourId && g.shiftId === shift.id)) {
        toast('This rostered shift already has a work entry.', 'err');
        return;
      }

      const types = l.labourTypes && l.labourTypes.length ? l.labourTypes : ['warehouse'];
      const requestedType = String(fd.get('workType') || types[0]);
      const workType = shift ? shift.workType : requestedType;
      if (!types.includes(workType)) {
        toast('Select a valid type of work.', 'err');
        return;
      }
      const category = shift ? (shift.category || 'Standard') : 'Standard';
      const site = await checkLabourSite(company, 'clock in');
      if (!site.ok) { toast(site.message, 'err'); return; }
      const nowIso = new Date().toISOString();
      const data = {
        clockInLocation: site.location,
        labourId, labourName: l.name, companyId: l.companyId, companyName: company ? company.name : '',
        shiftId: shift ? shift.id : '', date: today, workType, category,
        scheduledStart: shift ? shift.startTime : '', scheduledFinish: shift ? shift.endTime : '',
        clockInAt: nowIso, clockOutAt: '', hours: 0,
        rate: 0, amount: 0, payRate: 0, payAmount: 0,
        tierLines: null, overridden: false,
        notes: '', status: 'InProgress', rejectionReason: '', invoiceId: null,
        submittedAt: '', createdAt: nowIso, updatedAt: nowIso,
        approvedBy: null, approvedAt: null,
      };
      await state.db.collection('labourLogs').add(data);
      await loadLabourLogs();
      toast('Clocked in — this work is a separate entry.', 'ok');
      renderView();
    },
    'labour-clock-out': async (form) => {
      const fd = new FormData(form);
      const id = form.dataset.id;
      const log = state.labourLogs.find((g) => g.id === id);
      if (!log) return;
      const company = state.companies.find((c) => c.id === log.companyId);
      const site = await checkLabourSite(company, 'clock out');
      if (!site.ok) { toast(site.message, 'err'); return; }
      const clockOutAt = new Date().toISOString();
      const ms = new Date(clockOutAt).getTime() - new Date(log.clockInAt).getTime();
      const hours = Math.max(0, Math.round((ms / 3600000) * 100) / 100);
      const labourPerson = state.labour.find((x) => x.id === log.labourId);
      const clockInLocal = new Date(log.clockInAt);
      const startTimeForCalc = log.scheduledStart || (String(clockInLocal.getHours()).padStart(2, '0') + ':' + String(clockInLocal.getMinutes()).padStart(2, '0'));
      const cost = summarizeShiftCost(company, labourPerson, log.category || 'Standard', log.date, startTimeForCalc, hours);
      const rate = hours > 0 ? Math.round((cost.billAmount / hours) * 100) / 100 : 0;
      const payRate = hours > 0 ? Math.round((cost.payAmount / hours) * 100) / 100 : 0;
      await state.db.doc('labourLogs/' + id).update({
        clockOutAt, hours, amount: cost.billAmount, payAmount: cost.payAmount, rate, payRate,
        tierLines: cost.lines, usedRateCard: cost.usedRateCard,
        clockOutLocation: site.location,
        notes: fd.get('notes') || '', status: 'Pending',
        submittedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await loadLabourLogs();
      toast('Clocked out — submitted for approval.', 'ok');
      renderView();
    },
    'labour-log-reject-save': async (form) => {
      const fd = new FormData(form);
      const id = form.dataset.id;
      await state.db.doc('labourLogs/' + id).update({ status: 'Rejected', rejectionReason: fd.get('reason'), updatedAt: new Date().toISOString() });
      await loadLabourLogs();
      closeModal(); toast('Log rejected.', 'ok'); renderView();
    },
    'labour-log-edit-times-save': async (form) => {
      if (!isAdmin()) { toast('Only Admin can edit Labour clock times.', 'err'); return; }
      const fd = new FormData(form);
      const id = form.dataset.id;
      const log = state.labourLogs.find((g) => g.id === id);
      if (!log) return;
      if (log.invoiceId) { toast('This log is invoiced; its clock times are locked.', 'err'); return; }
      const clockIn = new Date(String(fd.get('clockInAt') || ''));
      const clockOut = new Date(String(fd.get('clockOutAt') || ''));
      const reason = String(fd.get('reason') || '').trim();
      if (!Number.isFinite(clockIn.getTime()) || !Number.isFinite(clockOut.getTime()) || clockOut <= clockIn) {
        toast('Clock-out must be later than clock-in.', 'err'); return;
      }
      if (!reason) { toast('A reason is required.', 'err'); return; }
      const company = state.companies.find((c) => c.id === log.companyId);
      const labourPerson = state.labour.find((l) => l.id === log.labourId);
      if (!company || !labourPerson) { toast('Linked company or labour profile not found. No changes saved.', 'err'); return; }
      const hours = Math.round(((clockOut.getTime() - clockIn.getTime()) / 3600000) * 100) / 100;
      const pad = (n) => String(n).padStart(2, '0');
      const localStart = pad(clockIn.getHours()) + ':' + pad(clockIn.getMinutes());
      const startForRates = log.scheduledStart || localStart;
      const cost = summarizeShiftCost(company, labourPerson, log.category || 'Standard', log.date, startForRates, hours);
      const amount = cost.billAmount, payAmount = cost.payAmount;
      const rate = hours > 0 ? Math.round(amount / hours * 100) / 100 : 0;
      const payRate = hours > 0 ? Math.round(payAmount / hours * 100) / 100 : 0;
      const patch = {
        clockInAt: clockIn.toISOString(), clockOutAt: clockOut.toISOString(),
        hours, amount, payAmount, rate, payRate,
        tierLines: cost.lines, usedRateCard: cost.usedRateCard,
        timeEdited: true, timeEditedBy: state.session ? state.session.name : 'Admin',
        timeEditedAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      await state.db.doc('labourLogs/' + id).update(patch);
      const changes = [
        ['clockInAt', log.clockInAt || '', patch.clockInAt],
        ['clockOutAt', log.clockOutAt || '', patch.clockOutAt],
        ['hours', Number(log.hours) || 0, hours],
        ['amount (bill)', Number(log.amount) || 0, amount],
        ['payAmount (pay)', Number(log.payAmount) || 0, payAmount]
      ];
      for (const [field, oldValue, newValue] of changes) {
        if (String(oldValue) !== String(newValue)) await writeAuditEntry('labourLog', id, field, oldValue, newValue, reason);
      }
      await loadLabourLogs(); await loadAuditLog();
      closeModal(); toast('Clock times updated; hours and pay recalculated.', 'ok'); renderView();
    },
    'labour-log-override-save': async (form) => {
      const fd = new FormData(form);
      const id = form.dataset.id;
      const log = state.labourLogs.find((g) => g.id === id);
      if (!log) return;
      const newAmount = Number(fd.get('amount')) || 0;
      const newPayAmount = Number(fd.get('payAmount')) || 0;
      const reason = fd.get('reason');
      if (!reason || !reason.trim()) { toast('A reason is required to override a rate.', 'err'); return; }
      if (newAmount !== (Number(log.amount) || 0)) await writeAuditEntry('labourLog', id, 'amount (bill)', Number(log.amount) || 0, newAmount, reason);
      if (newPayAmount !== (Number(log.payAmount) || 0)) await writeAuditEntry('labourLog', id, 'payAmount (pay)', Number(log.payAmount) || 0, newPayAmount, reason);
      await state.db.doc('labourLogs/' + id).update({ amount: newAmount, payAmount: newPayAmount, overridden: true, updatedAt: new Date().toISOString() });
      await loadLabourLogs(); await loadAuditLog();
      closeModal(); toast('Override saved and recorded in the audit log.', 'ok'); renderView();
    },
    'invoice-preview': async (form) => {
      const fd = new FormData(form);
      invoicePreviewModal(fd.get('companyId'), fd.get('from'), fd.get('to'));
    },
  });

  // =================================================================
  // Driver Daily Work Completion (separate driver login)
  //
  // A driver signs in on their own phone with their own mobile number + PIN
  // (granted from the Drivers page, same login pattern as every other
  // account) and submits
  // one end-of-day report: which company they worked for, how many
  // deliveries they completed, how many failed, an optional proof-of-work
  // screenshot, and optional notes. This is deliberately NOT the same as
  // Daily Entry (that stays the admin/manager-operated quick-entry grid) —
  // a driver's own submission sits in its own Pending/Approved/Rejected
  // queue and only becomes a real payment record (via the existing
  // commitEntryRows pipeline, so it gets the same duplicate check, payment
  // ref and Excel export as every other driver payment) once a manager
  // approves it.
  // =================================================================
  // Downscales + JPEG-compresses an uploaded image client-side before it
  // goes into the db capability's JSON document store — there's no file/blob
  // storage on this platform, so the screenshot is kept as a data: URL, and
  // shrinking it first keeps documents (and the db) from bloating.
  function readAndCompressImage(file, maxWidth) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Could not read image'));
        img.onload = () => {
          const scale = Math.min(1, (maxWidth || 900) / (img.width || maxWidth || 900));
          const w = Math.max(1, Math.round((img.width || maxWidth || 900) * scale));
          const h = Math.max(1, Math.round((img.height || maxWidth || 900) * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.72));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }
  function driverSubmissionsBanner() {
    const pending = state.driverSubmissions.filter((s) => s.status === 'Pending').length;
    const missing = missingSubmissionsToday().length;
    if (!pending && !missing) return '';
    const rows = [];
    if (pending) rows.push(`<li><span><strong class="tnum">${pending}</strong> driver submission${pending === 1 ? '' : 's'} to review</span><button class="btn btn-sm" data-action="nav" data-route="driver-submissions">Review</button></li>`);
    if (missing) rows.push(`<li><span><strong class="tnum">${missing}</strong> assigned driver${missing === 1 ? '' : 's'} ${missing === 1 ? "hasn't" : "haven't"} started</span><button class="btn btn-sm" data-action="nav" data-route="driver-submissions">Check</button></li>`);
    return rows.join('');
  }
  function submissionStatusPill(status) {
    if (status === 'Approved') return '<span class="pill pill-paid">Approved</span>';
    if (status === 'Rejected') return '<span class="pill pill-cancelled">Rejected</span>';
    if (status === 'InProgress') return '<span class="pill pill-other">In progress</span>';
    return '<span class="pill pill-pending">Pending</span>';
  }
  function todaysDriverAssignment(driverId, dateStr) {
    return state.driverAssignments.find((a) => a.driverId === driverId && a.date === dateStr) || null;
  }
  // Assigned-for-today drivers who haven't even started work yet — flagged on
  // the Dashboard and the Driver Submissions page so a no-show is caught the
  // same day rather than discovered at end-of-week reconciliation.
  function missingSubmissionsToday() {
    const today = todayStr();
    return state.driverAssignments.filter((a) => a.date === today)
      .filter((a) => !state.driverSubmissions.find((s) => s.driverId === a.driverId && s.date === today));
  }
  // Renders the shared Finish Work form — used both when a driver is
  // actively working (status 'InProgress') and when a rejected submission
  // needs correcting (isCorrection true reuses the exact same fields so the
  // driver never has to re-enter anything that wasn't flagged).
  function finishWorkFormHtml(existing, isCorrection) {
    // Pre-fill delivered/failed from today's planned route when the driver
    // hasn't entered numbers yet.
    const plannedRoute = !isCorrection && !Number(existing.delivered) && !Number(existing.failed)
      ? todaysRoute(existing.driverId) || (state.routes || []).find((r) => r.driverId === existing.driverId && r.date === todayStr()) : null;
    let routePrefilled = false;
    if (plannedRoute) {
      const rc = routeCounts(plannedRoute);
      if (rc.done) { existing = Object.assign({}, existing, { delivered: rc.delivered, failed: rc.failed }); routePrefilled = true; }
    }
    const s = state.settings;
    const failed0 = Number(existing.failed) || 0;
    const linkedDriver = state.drivers.find((d) => d.id === existing.driverId);
    const defaultVehicle = existing.vehicle || (linkedDriver && ['Car', 'Van'].includes(linkedDriver.vehicleType) ? linkedDriver.vehicleType : 'Car');
    const failureOptions = (s.failureReasons || []).map((r) => `<option value="${esc(r)}" ${existing.failureReason === r ? 'selected' : ''}>${esc(r)}</option>`).join('');
    return `
      <div class="card">
        <form data-onsubmit="driver-finish-work" data-id="${existing.id}">
          <div class="field" style="margin-bottom:14px;">
            <label class="field-label" style="font-size:0.95rem;">Vehicle used today</label>
            <select name="vehicle" required>
              <option value="Car" ${defaultVehicle === 'Car' ? 'selected' : ''}>🚗 Car</option>
              <option value="Van" ${defaultVehicle === 'Van' ? 'selected' : ''}>🚐 Van</option>
            </select>
          </div>
          ${routePrefilled ? '<p class="helptext" style="margin:0 0 8px;">Filled in from your Route page — change them if they\'re not right.</p>' : ''}
          <div class="field-row">
            <div class="field"><label class="field-label" style="font-size:0.95rem;">Deliveries completed</label><input type="number" min="0" name="delivered" required value="${existing.delivered != null ? existing.delivered : ''}" style="font-size:1.6rem;padding:14px;text-align:center;" data-onchange="driver-finish-recalc"></div>
            <div class="field"><label class="field-label" style="font-size:0.95rem;">Deliveries failed</label><input type="number" min="0" name="failed" value="${existing.failed != null ? existing.failed : 0}" style="font-size:1.6rem;padding:14px;text-align:center;" data-onchange="driver-finish-recalc"></div>
          </div>
          <div class="field" id="failureReasonField" style="margin-bottom:16px;${failed0 > 0 ? '' : 'display:none;'}">
            <label class="field-label">Main reason for failed deliveries</label>
            <select name="failureReason">${failureOptions}</select>
          </div>
          <div class="field" style="margin-bottom:16px;">
            <label class="field-label">Screenshot${s.screenshotRequired ? ' (required proof of deliveries)' : ' (optional proof of deliveries)'}</label>
            <input type="file" accept="image/*" name="screenshot" data-onchange="driver-screenshot-preview" ${s.screenshotRequired && !existing.screenshotDataUrl ? 'required' : ''}>
            <img id="screenshotPreview" src="${existing.screenshotDataUrl || ''}" style="${existing.screenshotDataUrl ? '' : 'display:none;'}max-width:160px;margin-top:8px;border-radius:8px;border:1px solid var(--border);">
          </div>
          <div class="field"><label class="field-label">Notes (optional)</label><textarea name="notes" rows="2" placeholder="Anything the manager should know">${esc(existing.notes || '')}</textarea></div>
          <button class="btn btn-primary" type="submit" style="width:100%;font-size:1.1rem;padding:16px;margin-top:10px;">${isCorrection ? 'RESUBMIT' : 'FINISH WORK'}</button>
        </form>
      </div>
    `;
  }
  // Start Work / Finish Work state machine — five states keyed off today's
  // driverSubmissions doc for this driver:
  //   1. no doc                -> Start Work screen (uses today's assignment if any, else a manual company pick)
  //   2. status 'InProgress'   -> Finish Work form (delivered/failed/screenshot/failure reason/notes)
  //   3. status 'Pending'      -> read-only "waiting for review" summary
  //   4. status 'Rejected'     -> correction banner + the same Finish Work form, resubmit writes an audit trail
  //   5. status 'Approved'     -> read-only approved summary
  function viewDriverSubmit() {
    const driverId = currentDriverId();
    const driver = state.drivers.find((d) => d.id === driverId);
    const today = todayStr();
    const assignments = state.driverAssignments
      .filter((a) => a.driverId === driverId && a.date === today)
      .sort((a, b) => (a.blockName || a.companyName || '').localeCompare(b.blockName || b.companyName || ''));
    const todaySubs = state.driverSubmissions
      .filter((s) => s.driverId === driverId && s.date === today)
      .sort((a, b) => (b.startTime || b.createdAt || '').localeCompare(a.startTime || a.createdAt || ''));
    const active = todaySubs.find((s) => s.status === 'InProgress') || null;
    const rejected = todaySubs.filter((s) => s.status === 'Rejected');
    const header = `<div class="view-header"><div><h1>Hi, ${esc(driver ? driver.name : '')}</h1><div class="sub">${fmtDateHuman(today)}</div></div></div>`;

    const todayHistory = todaySubs.length ? `
      <div class="card" style="margin-top:16px;">
        <h3 style="margin:0 0 12px;">Today's work entries (${todaySubs.length})</h3>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Started</th><th>Company / Block</th><th>Vehicle</th><th>Delivered</th><th>Failed</th><th>Status</th></tr></thead>
          <tbody>${todaySubs.map((s) => `<tr>
            <td style="white-space:nowrap;">${s.startTime ? fmtTimeHuman(s.startTime) : '—'}</td>
            <td>${esc(s.companyName || '—')}${s.blockName ? ' · ' + esc(s.blockName) : ''}</td>
            <td>${esc(s.vehicle || '—')}</td>
            <td class="tnum">${Number(s.delivered || 0)}</td>
            <td class="tnum">${Number(s.failed || 0)}</td>
            <td>${submissionStatusPill(s.status)}${s.submissionRef ? `<div class="helptext">${esc(s.submissionRef)}</div>` : ''}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>
    ` : '';

    if (active) {
      return `
        ${header}
        <p class="helptext" style="margin-bottom:12px;">Current work started at ${fmtTimeHuman(active.startTime)}${active.companyName ? ' — ' + esc(active.companyName) : ''}${active.blockName ? ' · ' + esc(active.blockName) : ''}. Finish this entry before starting another.</p>
        ${finishWorkFormHtml(active, false)}
        ${todayHistory}
      `;
    }

    const correctionForms = rejected.map((s) => `
      <div class="card" style="border-left:4px solid #dc2626;margin-bottom:12px;">
        <strong>Correction needed — ${esc(s.companyName || 'Work entry')}</strong>
        <p class="helptext" style="margin:6px 0 12px;">${esc(s.rejectionReason || 'Please review and resubmit this entry.')}</p>
        ${finishWorkFormHtml(s, true)}
      </div>
    `).join('');

    const assignmentPicker = assignments.length
      ? `<div class="field" style="margin-bottom:16px;"><label class="field-label">Today's assigned work</label><select name="assignmentId" required><option value="">Choose an assignment</option>${assignments.map((a) => `<option value="${a.id}">${esc(a.companyName || 'Company')}${a.blockName ? ' — ' + esc(a.blockName) : ''}</option>`).join('')}</select></div>`
      : `<div class="field" style="margin-bottom:16px;"><label class="field-label">Company</label><select name="companyName" required>${companyOptions('')}</select></div>`;

    return `
      ${header}
      ${correctionForms}
      <div class="card">
        <h3 style="margin:0 0 8px;">${todaySubs.length ? 'Start another work entry' : 'Start work'}</h3>
        <p class="helptext" style="margin:0 0 16px;">You can submit multiple separate work entries in one day. Finish the current entry before starting the next one. Each company or block is recorded separately for review and payment.</p>
        <form data-onsubmit="driver-start-work">
          ${assignmentPicker}
          <button class="btn btn-primary" type="submit" style="width:100%;font-size:1.1rem;padding:16px;">${todaySubs.length ? 'START ANOTHER WORK' : 'START WORK'}</button>
        </form>
      </div>
      ${todayHistory}
    `;
  }
  function viewDriverMyHistory() {
    const driverId = currentDriverId();
    const rows = state.driverSubmissions.filter((s) => s.driverId === driverId).sort((a, b) => b.date.localeCompare(a.date));
    const body = rows.length ? rows.map((s) => {
      const attempted = submissionAttempted(s);
      return `<tr>
      <td>${s.date}</td><td>${esc(s.companyName)}${s.blockName ? ' · ' + esc(s.blockName) : ''}</td><td>${esc(s.vehicle || '—')}</td><td class="tnum">${s.delivered}</td><td class="tnum">${s.failed}</td>
      <td class="tnum">${s.status === 'InProgress' ? '—' : successRatePct(s.delivered, attempted) + '%'}</td>
      <td>${s.screenshotDataUrl ? `<img src="${s.screenshotDataUrl}" data-action="view-screenshot" data-id="${s.id}" style="width:32px;height:32px;object-fit:cover;border-radius:6px;cursor:pointer;border:1px solid var(--border);">` : '—'}</td>
      <td>${submissionStatusPill(s.status)}</td>
    </tr>`;
    }).join('') : `<tr><td colspan="8"><div class="empty-state">No submissions yet.</div></td></tr>`;
    return `
      <div class="view-header"><div><h1>My Submissions</h1></div></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>Company / Block</th><th>Vehicle</th><th>Delivered</th><th>Failed</th><th>Success</th><th>Photo</th><th>Status</th></tr></thead><tbody>${body}</tbody></table></div>
    `;
  }

  const driverSubsUi = { status: 'Pending' };
  function viewDriverSubmissions() {
    let rows = state.driverSubmissions.slice();
    if (driverSubsUi.status) rows = rows.filter((s) => s.status === driverSubsUi.status);
    rows.sort((a, b) => b.date.localeCompare(a.date));
    const cap = capRows(rows);
    rows = cap.shown;
    const missing = missingSubmissionsToday();
    const missingBanner = missing.length ? `<div class="card" style="border-left:4px solid #dc2626;margin-bottom:16px;"><strong>${missing.length} assigned driver${missing.length === 1 ? '' : 's'}</strong> haven't started today's work yet: ${missing.map((a) => esc(a.driverName)).join(', ')}.</div>` : '';
    const body = rows.length ? rows.map((s) => {
      const attempted = submissionAttempted(s);
      return `<tr>
      <td>${s.date}</td><td>${esc(s.driverName)}</td><td>${esc(s.companyName)}${s.blockName ? ' · ' + esc(s.blockName) : ''}</td>
      <td>${esc(s.vehicle || '—')}</td>
      <td class="tnum">${s.delivered}</td><td class="tnum">${s.failed}</td><td class="tnum">${attempted}</td>
      <td class="tnum">${s.status === 'InProgress' ? '—' : successRatePct(s.delivered, attempted) + '%'}</td>
      <td>${esc(s.failureReason || '—')}</td>
      <td>${s.screenshotDataUrl ? `<img src="${s.screenshotDataUrl}" data-action="view-screenshot" data-id="${s.id}" style="width:32px;height:32px;object-fit:cover;border-radius:6px;cursor:pointer;border:1px solid var(--border);">` : '—'}</td>
      <td class="wrap">${esc(s.notes || '')}</td>
      <td>${submissionStatusPill(s.status)}</td>
      <td style="white-space:nowrap;">${s.status === 'Pending'
        ? `<button class="btn btn-sm btn-primary" data-action="driver-sub-approve" data-id="${s.id}">Approve</button> <button class="btn btn-sm btn-danger" data-action="driver-sub-reject" data-id="${s.id}">Request correction</button>`
        : s.status === 'Rejected' ? `<span class="helptext">${esc(s.rejectionReason || '')}</span>` : s.status === 'InProgress' ? `<span class="helptext">Started ${fmtTimeHuman(s.startTime)}</span>` : '—'}</td>
    </tr>`;
    }).join('') : `<tr><td colspan="13"><div class="empty-state">No submissions.</div></td></tr>`;
    const recentAudit = state.auditLog.filter((a) => a.entityType === 'driverSubmission').slice(0, 15);
    const auditHtml = recentAudit.length ? `
      <div class="section-title"><h2>Recent corrections</h2></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>When</th><th>Field</th><th>Old</th><th>New</th><th>Reason</th></tr></thead><tbody>
        ${recentAudit.map((a) => `<tr><td>${new Date(a.changedAt).toLocaleString()}</td><td>${esc(a.field)}</td><td class="tnum">${esc(a.oldValue)}</td><td class="tnum">${esc(a.newValue)}</td><td class="wrap">${esc(a.reason)}</td></tr>`).join('')}
      </tbody></table></div>` : '';
    return `
      <div class="view-header"><div><h1>Driver Submissions</h1><div class="sub">Start Work / Finish Work delivery counts drivers submit from their own phones</div></div></div>
      ${missingBanner}
      <div class="toolbar">
        <select data-onchange="driver-sub-filter">
          <option value="Pending" ${driverSubsUi.status === 'Pending' ? 'selected' : ''}>Pending</option>
          <option value="InProgress" ${driverSubsUi.status === 'InProgress' ? 'selected' : ''}>In progress</option>
          <option value="Approved" ${driverSubsUi.status === 'Approved' ? 'selected' : ''}>Approved</option>
          <option value="Rejected" ${driverSubsUi.status === 'Rejected' ? 'selected' : ''}>Rejected</option>
          <option value="" ${driverSubsUi.status === '' ? 'selected' : ''}>All</option>
        </select>
      </div>
      ${capNoticeHtml(cap)}
      <div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>Driver</th><th>Company / Block</th><th>Vehicle</th><th>Delivered</th><th>Failed</th><th>Attempted</th><th>Success</th><th>Failure reason</th><th>Photo</th><th>Notes</th><th>Status</th><th>Actions</th></tr></thead><tbody>${body}</tbody></table></div>
      <p class="helptext" style="margin-top:12px;">Approving a submission creates the matching driver payment record automatically (Deliveries completed → Parcels), using the same rate/prefix logic as Daily Entry — it will appear on Records, Payments and the Excel export. Requesting a correction sends it back to the driver; their resubmission is recorded in the audit log alongside the original values.</p>
      ${auditHtml}
    `;
  }

  // ---------------- Delivery Blocks (named routes/zones drivers can be assigned to) ----------------
  function viewDeliveryBlocks() {
    const rows = state.deliveryBlocks.filter((b) => b.active !== false);
    const body = rows.length ? rows.map((b) => `
      <tr>
        <td class="tnum">${esc(b.blockRef || '—')}</td><td>${esc(b.name)}</td><td>${esc(b.companyName || '—')}</td><td class="wrap">${esc(b.notes || '')}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-sm" data-action="block-edit" data-id="${b.id}">Edit</button>
          <button class="btn btn-sm btn-danger" data-action="block-deactivate" data-id="${b.id}">Deactivate</button>
        </td>
      </tr>
    `).join('') : `<tr><td colspan="5"><div class="empty-state">No delivery blocks/routes yet.</div></td></tr>`;
    return `
      <div class="view-header"><div><h1>Delivery Blocks</h1><div class="sub">Named routes/zones drivers can be assigned to each day</div></div>
      <button class="btn btn-primary" data-action="block-add">+ Add block</button></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Ref</th><th>Name</th><th>Company</th><th>Notes</th><th>Actions</th></tr></thead><tbody>${body}</tbody></table></div>
    `;
  }
  function deliveryBlockModal(block) {
    const isEdit = !!block;
    openModal(`
      <div class="modal-head"><h3>${isEdit ? 'Edit block' : 'Add delivery block'}</h3><button data-action="modal-close" aria-label="Close">✕</button></div>
      <form data-onsubmit="block-save" data-id="${isEdit ? block.id : ''}">
        <div class="field" style="margin-bottom:12px;"><label class="field-label">Name</label><input type="text" name="name" value="${isEdit ? esc(block.name) : ''}" required placeholder="e.g. Route 12 / Zone A"></div>
        <div class="field" style="margin-bottom:12px;"><label class="field-label">Company</label><select name="companyName">${companyOptions(isEdit ? block.companyName : '')}</select></div>
        <div class="field"><label class="field-label">Notes (optional)</label><textarea name="notes" rows="2">${isEdit ? esc(block.notes || '') : ''}</textarea></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
          <button type="button" class="btn" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Add block'}</button>
        </div>
      </form>
    `);
  }

  // ---------------- Driver Assignments (which driver covers which block, on which date) ----------------
  const assignUi = { date: todayStr() };
  function viewDriverAssignments() {
    const rows = state.driverAssignments.filter((a) => a.date === assignUi.date);
    const body = rows.length ? rows.map((a) => `
      <tr><td>${esc(a.driverName)}</td><td>${esc(a.companyName || '—')}</td><td>${esc(a.blockName || '—')}</td>
        <td style="white-space:nowrap;"><button class="btn btn-sm btn-danger" data-action="assignment-remove" data-id="${a.id}">Remove</button></td>
      </tr>
    `).join('') : `<tr><td colspan="4"><div class="empty-state">No assignments for this date.</div></td></tr>`;
    return `
      <div class="view-header"><div><h1>Driver Assignments</h1><div class="sub">Assign a driver to a block/route for a day</div></div>
      <button class="btn btn-primary" data-action="assignment-add">+ Add assignment</button></div>
      <div class="card date-section" style="margin-bottom:16px;">
        <div class="date-section-inner">
          <div><label class="field-label">Date</label><input type="date" value="${assignUi.date}" data-onchange="assignment-date"></div>
        </div>
      </div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Driver</th><th>Company</th><th>Block</th><th>Actions</th></tr></thead><tbody>${body}</tbody></table></div>
    `;
  }
  function driverAssignmentModal() {
    const blocks = state.deliveryBlocks.filter((b) => b.active !== false);
    const driverOpts = activeDrivers().map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
    const blockOpts = blocks.map((b) => `<option value="${b.id}">${esc(b.name)}${b.companyName ? ' — ' + esc(b.companyName) : ''}</option>`).join('');
    openModal(`
      <div class="modal-head"><h3>Add assignment</h3><button data-action="modal-close" aria-label="Close">✕</button></div>
      <form data-onsubmit="assignment-save">
        <div class="field" style="margin-bottom:12px;"><label class="field-label">Date</label><input type="date" name="date" value="${assignUi.date}" required></div>
        <div class="field" style="margin-bottom:12px;"><label class="field-label">Driver</label>${activeDrivers().length ? `<select name="driverId" required>${driverOpts}</select>` : '<p class="helptext" style="margin:0;">No drivers set up yet.</p>'}</div>
        <div class="field"><label class="field-label">Block / route</label>${blocks.length ? `<select name="blockId" required>${blockOpts}</select>` : '<p class="helptext" style="margin:0;">No delivery blocks yet — add one on the Delivery Blocks page first.</p>'}</div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
          <button type="button" class="btn" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn-primary" ${blocks.length && activeDrivers().length ? '' : 'disabled'}>Assign</button>
        </div>
      </form>
    `);
  }

  // ---------------- Driver Performance (success rate + failure-reason analytics over a range) ----------------
  const driverPerfUi = { range: 'week', from: '', to: '' };
  function driverPerfRange() {
    const today = todayStr();
    if (driverPerfUi.range === 'today') return { from: today, to: today };
    if (driverPerfUi.range === 'week') return { from: toDateStr(startOfWeek(new Date())), to: today };
    if (driverPerfUi.range === 'month') { const n = new Date(); return { from: n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-01', to: today }; }
    return { from: driverPerfUi.from || today, to: driverPerfUi.to || today };
  }
  function viewDriverPerformance() {
    const { from, to } = driverPerfRange();
    // Excludes InProgress (not yet finished, so no attempted count) and Rejected (superseded by the resubmission).
    const inRange = state.driverSubmissions.filter((s) => s.date >= from && s.date <= to && (s.status === 'Approved' || s.status === 'Pending'));
    const byDriver = {};
    const failureCounts = {};
    inRange.forEach((s) => {
      const attempted = submissionAttempted(s);
      const key = s.driverName || '(Unknown)';
      const d = byDriver[key] || { name: key, submissions: 0, delivered: 0, failed: 0, attempted: 0 };
      d.submissions++; d.delivered += Number(s.delivered) || 0; d.failed += Number(s.failed) || 0; d.attempted += attempted;
      byDriver[key] = d;
      if ((Number(s.failed) || 0) > 0 && s.failureReason) failureCounts[s.failureReason] = (failureCounts[s.failureReason] || 0) + (Number(s.failed) || 0);
    });
    const driverRows = Object.values(byDriver).sort((a, b) => b.attempted - a.attempted);
    const driverBody = driverRows.length ? driverRows.map((d) => `
      <tr><td>${esc(d.name)}</td><td class="tnum">${d.submissions}</td><td class="tnum">${d.delivered}</td><td class="tnum">${d.failed}</td><td class="tnum">${d.attempted}</td><td class="tnum">${successRatePct(d.delivered, d.attempted)}%</td></tr>
    `).join('') : `<tr><td colspan="6"><div class="empty-state">No submissions in this range.</div></td></tr>`;
    const failureRows = Object.entries(failureCounts).sort((a, b) => b[1] - a[1]);
    const totalFailed = failureRows.reduce((sum, [, n]) => sum + n, 0);
    const failureBody = failureRows.length ? failureRows.map(([reason, n]) => `
      <tr><td>${esc(reason)}</td><td class="tnum">${n}</td><td class="tnum">${totalFailed ? Math.round((n / totalFailed) * 1000) / 10 : 0}%</td></tr>
    `).join('') : `<tr><td colspan="3"><div class="empty-state">No failed deliveries in this range.</div></td></tr>`;
    return `
      <div class="view-header"><div><h1>Driver Performance</h1><div class="sub">${fmtDateHuman(from)} – ${fmtDateHuman(to)}</div></div></div>
      <div class="card date-section" style="margin-bottom:16px;">
        <div class="date-section-inner">
          <div><label class="field-label">Showing</label><div class="date-display">${fmtDateHuman(from)} – ${fmtDateHuman(to)}</div></div>
          <div class="date-section-controls">
            <button class="btn btn-sm ${driverPerfUi.range === 'today' ? 'btn-primary' : ''}" data-action="driverperf-range" data-range="today">Today</button>
            <button class="btn btn-sm ${driverPerfUi.range === 'week' ? 'btn-primary' : ''}" data-action="driverperf-range" data-range="week">This Week</button>
            <button class="btn btn-sm ${driverPerfUi.range === 'month' ? 'btn-primary' : ''}" data-action="driverperf-range" data-range="month">This Month</button>
            <button class="btn btn-sm ${driverPerfUi.range === 'custom' ? 'btn-primary' : ''}" data-action="driverperf-range" data-range="custom">Custom</button>
            ${driverPerfUi.range === 'custom' ? `<input type="date" value="${driverPerfUi.from}" data-onchange="driverperf-custom" data-field="from"><input type="date" value="${driverPerfUi.to}" data-onchange="driverperf-custom" data-field="to">` : ''}
          </div>
        </div>
      </div>
      <div class="section-title"><h2>By driver</h2></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Driver</th><th>Submissions</th><th>Delivered</th><th>Failed</th><th>Attempted</th><th>Success rate</th></tr></thead><tbody>${driverBody}</tbody></table></div>
      <div class="section-title" style="margin-top:20px;"><h2>Failure reasons</h2></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Reason</th><th>Count</th><th>Share</th></tr></thead><tbody>${failureBody}</tbody></table></div>
    `;
  }

  function driverGrantLoginModal(driverId) {
    const driver = state.drivers.find((d) => d.id === driverId);
    if (!driver) return;
    openModal(`
      <div class="modal-head"><h3>Grant portal login — ${esc(driver.name)}</h3><button data-action="modal-close" aria-label="Close">✕</button></div>
      <p class="helptext" style="margin-bottom:12px;">Lets this driver sign in on their own phone (with their mobile number + PIN) to submit their daily delivery count — not secure authentication.</p>
      <form data-onsubmit="driver-grant-login-save" data-driver="${driverId}">
        <div class="field" style="margin-bottom:12px;"><label class="field-label">Mobile number</label><input type="tel" inputmode="numeric" name="mobile" required></div>
        <div class="field"><label class="field-label">4-digit PIN</label><input type="password" name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
          <button type="button" class="btn" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn-primary">Grant login</button>
        </div>
      </form>
    `);
  }
  function driverSubRejectModal(subId) {
    openModal(`
      <div class="modal-head"><h3>Reject submission</h3><button data-action="modal-close" aria-label="Close">✕</button></div>
      <form data-onsubmit="driver-sub-reject-save" data-id="${subId}">
        <div class="field"><label class="field-label">Reason (shown to the driver)</label><textarea name="reason" rows="2" required></textarea></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
          <button type="button" class="btn" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn-danger">Reject</button>
        </div>
      </form>
    `);
  }

  Object.assign(ACTIONS, {
    'driver-grant-login': (el) => driverGrantLoginModal(el.dataset.id),
    'view-screenshot': (el) => {
      const sub = state.driverSubmissions.find((s) => s.id === el.dataset.id);
      if (!sub || !sub.screenshotDataUrl) return;
      openModal(`
        <div class="modal-head"><h3>Screenshot — ${esc(sub.driverName)} · ${esc(sub.date)}</h3><button data-action="modal-close" aria-label="Close">✕</button></div>
        <img src="${sub.screenshotDataUrl}" style="width:100%;border-radius:8px;display:block;">
      `, { wide: true });
    },
    'driver-sub-reject': (el) => driverSubRejectModal(el.dataset.id),
    'driver-sub-approve': async (el) => {
      const sub = state.driverSubmissions.find((s) => s.id === el.dataset.id);
      if (!sub) return;
      const driver = state.drivers.find((d) => d.id === sub.driverId) || driverByNameLoose(sub.driverName);
      const vehicle = sub.vehicle || (driver && driver.vehicleType) || 'Car';
      const summaryNotes = `Delivered ${sub.delivered}, Failed ${sub.failed}.${sub.notes ? ' ' + sub.notes : ''}`;
      const n = await commitEntryRows(sub.date, [{ id: genId(), driverName: sub.driverName, vehicle, companyName: sub.companyName, parcels: sub.delivered, bonus: 0, adjustment: 0, notes: summaryNotes }]);
      if (n < 0) return; // cancelled (e.g. the duplicate-record warning was declined)
      await state.db.doc('driverSubmissions/' + sub.id).update({ status: 'Approved', approvedBy: state.session ? state.session.name : '', approvedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await loadDriverSubmissions();
      toast('Approved — payment record created.', 'ok');
      renderView();
    },

    // Delivery Blocks
    'block-add': () => deliveryBlockModal(null),
    'block-edit': (el) => deliveryBlockModal(state.deliveryBlocks.find((b) => b.id === el.dataset.id)),
    'block-deactivate': async (el) => {
      const ok = await confirmDialog('Deactivate this block? It stops appearing as an assignment option.', { okLabel: 'Deactivate', danger: true });
      if (!ok) return;
      await state.db.doc('deliveryBlocks/' + el.dataset.id).update({ active: false });
      await loadDeliveryBlocks(); toast('Block deactivated.', 'ok'); renderView();
    },

    // Driver Assignments
    'assignment-add': () => driverAssignmentModal(),
    'assignment-remove': async (el) => {
      const ok = await confirmDialog('Remove this assignment?', { okLabel: 'Remove', danger: true });
      if (!ok) return;
      await state.db.doc('driverAssignments/' + el.dataset.id).delete();
      await loadDriverAssignments(); toast('Assignment removed.', 'ok'); renderView();
    },

    // Driver Performance
    'driverperf-range': (el) => { driverPerfUi.range = el.dataset.range; renderView(); },
  });
  Object.assign(CHANGE_HANDLERS, {
    'driver-sub-filter': (el) => { driverSubsUi.status = el.value; renderView(); },
    'driver-screenshot-preview': async (el) => {
      const file = el.files && el.files[0];
      if (!file) return;
      try {
        const dataUrl = await readAndCompressImage(file, 900);
        el.dataset.compressed = dataUrl;
        const img = document.getElementById('screenshotPreview');
        if (img) { img.src = dataUrl; img.style.display = ''; }
      } catch (e) {
        toast('Could not read that image.', 'err');
      }
    },
    'driver-finish-recalc': (el) => {
      const form = el.closest('form');
      if (!form) return;
      const failedInput = form.querySelector('[name="failed"]');
      const failed = failedInput ? Number(failedInput.value) || 0 : 0;
      const field = document.getElementById('failureReasonField');
      if (field) field.style.display = failed > 0 ? '' : 'none';
    },
    'assignment-date': (el) => { assignUi.date = el.value; renderView(); },
    'driverperf-custom': (el) => { driverPerfUi[el.dataset.field] = el.value; renderView(); },
  });
  Object.assign(SUBMIT_HANDLERS, {
    'driver-start-work': async (form) => {
      const driverId = currentDriverId();
      const driver = state.drivers.find((d) => d.id === driverId);
      const today = todayStr();
      const currentActive = state.driverSubmissions.find((s) =>
        s.driverId === driverId && s.date === today && s.status === 'InProgress'
      );
      if (currentActive) {
        toast('Please finish your current work before starting another.', 'err');
        return;
      }

      const fd = new FormData(form);
      const assignmentId = String(fd.get('assignmentId') || form.dataset.assignment || '');
      const assignment = assignmentId ? state.driverAssignments.find((a) =>
        a.id === assignmentId && a.driverId === driverId && a.date === today
      ) : null;
      if (assignmentId && !assignment) {
        toast('That assignment is not valid for your account or today. Refresh and try again.', 'err');
        return;
      }

      let companyName = '', blockId = '', blockName = '';
      if (assignment) {
        companyName = assignment.companyName || '';
        blockId = assignment.blockId || '';
        blockName = assignment.blockName || '';
      } else {
        companyName = String(fd.get('companyName') || '');
      }
      if (!companyName) {
        toast('Select a company or assigned work before starting.', 'err');
        return;
      }

      const nowIso = new Date().toISOString();
      await state.db.collection('driverSubmissions').add({
        driverId, driverName: driver ? driver.name : '', date: today,
        assignmentId, blockId, blockName, companyName,
        startTime: nowIso, finishTime: null,
        delivered: 0, failed: 0, attempted: 0, failureReason: '', screenshotDataUrl: '', notes: '',
        vehicle: '', status: 'InProgress', rejectionReason: '', submissionRef: '',
        submittedAt: null, createdAt: nowIso, updatedAt: nowIso,
        approvedBy: null, approvedAt: null,
      });
      await loadDriverSubmissions();
      toast('Work started — you can start another entry after finishing this one.', 'ok');
      renderView();
    },
    'driver-finish-work': async (form) => {
      const fd = new FormData(form);
      const id = form.dataset.id;
      const existing = state.driverSubmissions.find((s) => s.id === id);
      if (!existing) return;
      const delivered = Number(fd.get('delivered')) || 0;
      const failed = Number(fd.get('failed')) || 0;
      const attempted = delivered + failed; // client-side validation: attempted always equals delivered + failed
      const screenshotInput = form.querySelector('input[name="screenshot"]');
      const newScreenshot = screenshotInput && screenshotInput.dataset.compressed;
      if (state.settings.screenshotRequired && !newScreenshot && !existing.screenshotDataUrl) {
        toast('A screenshot is required before finishing.', 'err'); return;
      }
      const screenshotDataUrl = newScreenshot || existing.screenshotDataUrl || '';
      const failureReason = failed > 0 ? (fd.get('failureReason') || '') : '';
      const vehicle = String(fd.get('vehicle') || existing.vehicle || 'Car');
      if (!['Car', 'Van'].includes(vehicle)) { toast('Select Car or Van.', 'err'); return; }
      const notes = fd.get('notes') || '';
      const wasRejected = existing.status === 'Rejected';
      if (wasRejected) {
        // Preserve the original values in the audit trail before they're overwritten.
        const changed = [
          ['delivered', existing.delivered, delivered],
          ['failed', existing.failed, failed],
          ['vehicle', existing.vehicle || 'Car', vehicle],
          ['notes', existing.notes || '', notes],
        ];
        for (const [field, oldV, newV] of changed) {
          if (String(oldV) !== String(newV)) await writeAuditEntry('driverSubmission', existing.id, field, oldV, newV, 'Driver correction resubmit');
        }
      }
      const ref = existing.submissionRef || await claimSubmissionRef(existing.id, existing.date);
      await state.db.doc('driverSubmissions/' + id).update({
        delivered, failed, attempted, failureReason, screenshotDataUrl, notes, vehicle,
        finishTime: new Date().toISOString(), status: 'Pending', rejectionReason: '',
        submissionRef: ref, submittedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await loadDriverSubmissions();
      toast(wasRejected ? 'Resubmitted — pending manager review.' : 'Submitted — pending manager review.', 'ok');
      renderView();
    },
    'driver-grant-login-save': async (form) => {
      const fd = new FormData(form);
      const driverId = form.dataset.driver;
      const driver = state.drivers.find((d) => d.id === driverId);
      const mobile = normalizeMobile(fd.get('mobile'));
      if (!mobile) { toast('Enter a mobile number.', 'err'); return; }
      if (mobileTaken(mobile, null)) { toast('That mobile number is already used for another login.', 'err'); return; }
      await state.db.collection('staff').add({ name: driver ? driver.name : 'Driver', mobile, pin: fd.get('pin'), role: 'driver', driverId, active: true, createdAt: new Date().toISOString() });
      await loadStaff(); closeModal(); toast('Portal login granted.', 'ok'); renderView();
    },
    'driver-sub-reject-save': async (form) => {
      const fd = new FormData(form);
      const id = form.dataset.id;
      await state.db.doc('driverSubmissions/' + id).update({ status: 'Rejected', rejectionReason: fd.get('reason'), updatedAt: new Date().toISOString() });
      await loadDriverSubmissions();
      closeModal(); toast('Submission rejected.', 'ok'); renderView();
    },

    // Delivery Blocks
    'block-save': async (form) => {
      const fd = new FormData(form);
      const id = form.dataset.id;
      const companyName = fd.get('companyName') || '';
      const company = companyByName(companyName);
      const data = { name: fd.get('name').trim(), companyName, companyId: company ? company.id : '', notes: fd.get('notes') || '' };
      if (id) {
        await state.db.doc('deliveryBlocks/' + id).update(data);
      } else {
        const ref = await claimBlockRef();
        await state.db.collection('deliveryBlocks').add(Object.assign({ blockRef: ref, active: true, createdAt: new Date().toISOString() }, data));
      }
      await loadDeliveryBlocks(); closeModal(); toast(id ? 'Block updated.' : 'Block added.', 'ok'); renderView();
    },

    // Driver Assignments
    'assignment-save': async (form) => {
      const fd = new FormData(form);
      const date = fd.get('date');
      const driverId = fd.get('driverId');
      const blockId = fd.get('blockId');
      const driver = state.drivers.find((d) => d.id === driverId);
      const block = state.deliveryBlocks.find((b) => b.id === blockId);
      if (!driver || !block) { toast('Select a driver and a block.', 'err'); return; }
      const dup = state.driverAssignments.find((a) => a.date === date && a.driverId === driverId);
      if (dup) { toast('This driver already has an assignment for that date.', 'err'); return; }
      await state.db.collection('driverAssignments').add({
        date, driverId, driverName: driver.name,
        blockId, blockName: block.name, companyId: block.companyId || '', companyName: block.companyName || '',
        createdAt: new Date().toISOString(), createdBy: state.session ? state.session.name : '',
      });
      await loadDriverAssignments(); assignUi.date = date; closeModal(); toast('Assignment added.', 'ok'); renderView();
    },
  });

  // ---------------------------------------------------------------
  // Full local data backup/restore. This works with the localStorage
  // database used by ordinary static hosting. Backups contain sensitive
  // operational data, so the user must initiate downloads/restores.
  // ---------------------------------------------------------------
  const BACKUP_COLLECTIONS = [
    'settings', 'staff', 'drivers', 'companies', 'days', 'driverSubmissions',
    'labour', 'labourShifts', 'labourLogs', 'invoices', 'rateCards', 'auditLog',
    'deliveryBlocks', 'driverAssignments'
  ];

  async function exportFullBackup() {
    try {
      const backup = {
        format: 'uma-management-backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        note: 'Contains private business and staff data. Store securely.',
        collections: {}
      };
      for (const name of BACKUP_COLLECTIONS) {
        const result = await state.db.collection(name).get();
        backup.collections[name] = result.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
      }
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'uma-management-backup-' + todayStr() + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Full backup downloaded. Keep it somewhere private.', 'ok');
    } catch (err) {
      toast('Backup failed: ' + (err && err.message ? err.message : err), 'err');
    }
  }

  async function restoreFullBackup() {
    if (state.remoteDb) {
      toast('Direct backup restore is disabled in shared mode to protect existing cloud records. Use the reviewed local D1 importer instead.', 'err');
      return;
    }
    const input = document.getElementById('backupFileInput');
    const file = input && input.files && input.files[0];
    if (!file) { toast('Choose a JSON backup file first.', 'err'); return; }
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || parsed.format !== 'uma-management-backup' || !parsed.collections || typeof parsed.collections !== 'object') {
        throw new Error('This does not look like a valid UMA Management backup.');
      }
      const confirmed = await confirmDialog('Restore this backup? Existing local data in the listed collections will be replaced. Export a backup first if you need to keep current records.', { okLabel: 'Replace local data', danger: true });
      if (!confirmed) return;
      for (const name of BACKUP_COLLECTIONS) {
        const collData = parsed.collections[name];
        if (!Array.isArray(collData)) continue;
        const current = await state.db.collection(name).get();
        for (const doc of current.docs) await state.db.doc(name + '/' + doc.id).delete();
        for (const row of collData) {
          if (!row || typeof row.id !== 'string' || !row.id || !row.data || typeof row.data !== 'object') continue;
          await state.db.doc(name + '/' + row.id).set(row.data);
        }
      }
      input.value = '';
      await loadAll();
      state.session = null;
      try { localStorage.removeItem('driverpay_session'); } catch (e) {}
      toast('Backup restored. Please sign in again.', 'ok');
      setTimeout(() => location.reload(), 700);
    } catch (err) {
      toast('Restore failed: ' + (err && err.message ? err.message : err), 'err');
    }
  }

  Object.assign(ACTIONS, {
    'backup-export': exportFullBackup,
    'backup-import-open': () => {
      const input = document.getElementById('backupFileInput');
      if (input) { input.onchange = () => { if (input.files && input.files.length) restoreFullBackup(); }; input.click(); }
    },
  });

  boot();
})();
