UMA MANAGEMENT — COMBINED WEBSITE BUILD
=======================================

This package combines the full UMA legacy operations interface and Excel engine
from the Bulk Add / Excel Fix ZIP with the Cloudflare Worker + D1 + R2 backend
source from the V2 ZIP.

FRONTEND FEATURES INCLUDED
- Mobile number + 4-digit PIN sign-in flow
- First-use Admin account setup
- Role-based Admin / Manager / Staff / Driver / Labour screens
- Company and driver management
- Daily delivery entry and Bulk Add / Smart Parse
- Delivery records, summaries and payment workflows
- Excel workbook export and historical Excel import preview
- Labour roster, shifts, logs and invoices
- Rate cards, delivery blocks, driver assignments and submissions
- Driver evidence/screenshot submission screens
- Responsive mobile layout

IMPORTANT DEPLOYMENT / DATA WARNING
-----------------------------------
The supplied legacy frontend currently uses browser localStorage as its database
when the embedded `window.claude.use('db')` service is unavailable. Therefore,
its records and PINs are local to that browser/device and are NOT shared across
phones/computers. The V2 Worker included in /worker is a separate secure backend
scaffold and is NOT yet wired to the legacy frontend's document-database API.
Do not use this build as a production multi-user payroll system until that
integration is completed and tested. Do not put real payroll or personal data
into the localStorage version.

RUN THE FRONTEND LOCALLY
------------------------
1. Install Node.js 20+.
2. Open Terminal and run:
   cd web
   npx serve .
3. Open the local URL printed by the command.
4. On first launch, create the first Admin using name, mobile number and a
   4-digit PIN. Keep those details safe.

Excel export loads ExcelJS from a CDN, so internet access is needed for export.

CLOUDFLARE BACKEND
------------------
The /worker directory contains the V2 Worker, D1 migration and Wrangler config.
Before deploying it, set the real D1 database ID and create the R2 bucket,
configure SESSION_SECRET / BOOTSTRAP_SECRET, and follow the V2 setup guide.
The current Worker login is email/password and its CRUD coverage is incomplete;
it does not yet provide the mobile/PIN + legacy document API required by the
frontend. It is included as the preserved backend foundation, not represented
as a completed integration.

PRODUCTION COMPLETION REQUIRED
------------------------------
- Implement server-side mobile + PIN authentication (salted PIN hashing,
  rate limiting / lockout, secure session cookies and account recovery).
- Implement and authorize all legacy collections and CRUD operations in D1.
- Connect evidence uploads to R2 and enforce company/role boundaries.
- Complete migration of companies, drivers, staff, daily records, labour,
  invoices, rate cards, settings and payment references.
- Test import/export totals and every role on multiple devices before cutover.

Never overwrite an existing production D1 database or deploy a migration against
production without a verified backup and a staging test.


2026-11-04 FRONTEND UPDATE
-------------------------
- Repaired Australian mobile-number matching: 04xx, +614xx and 4xx forms are
  normalised to the same comparison value without rewriting stored accounts.
- Hardened delegated form submission against double taps and surfaced errors.
- Improved login/PIN keypad accessibility and small-screen touch targets.
- Corrected HTML document structure, mobile viewport handling and safe-area
  spacing for iOS/Android.
- Added responsive layout improvements for narrow screens, tables and modals.
- Added an explicit device-only storage warning when the Cloudflare shared-data
  connection is unavailable.

IMPORTANT: These frontend fixes do not complete the Cloudflare D1 integration.
The legacy data adapter still falls back to localStorage when the hosting
environment does not provide the legacy `window.claude.use('db')` interface.
This package therefore improves device compatibility and login matching, but
does not by itself make records synchronise between devices. The D1 Worker
source remains preserved and must be mapped to the existing production schema
before it can be enabled safely. Do not deploy its placeholder D1 binding or
run migrations against production as part of this frontend-only update.


2026-11-04 MOBILE LABOUR LOGIN / THEME DIAGNOSTIC UPDATE
-------------------------------------------------------
- Mobile account lookup now refreshes its current staff list before matching.
- If the same mobile number belongs to multiple active accounts on this device,
  the login gate asks the user to select the intended role/account instead of
  silently selecting the first record (which could be Admin instead of Labour).
- Role names are normalised case-insensitively and Australian mobile formats
  include +61 04... handling.
- If no account exists on this device while local fallback mode is active, the
  login message explains that accounts from another device are not available.
- Dashboard surfaces are locked to the premium light palette, irrespective of
  the phone or laptop OS dark-mode preference. Navy sidebar and gold accents
  remain; cards and dashboard text use high-contrast light styling.

IMPORTANT: the supplied Worker is still not connected to the legacy frontend's
collection API and uses a different email/password schema. The app still uses
browser localStorage when its host database adapter is absent. Therefore this
frontend update can disambiguate duplicate local accounts and expose device
mismatch, but cannot make a Labour account created on the laptop appear on a
phone. Real cross-device parity requires completing the shared D1 integration
and migrating the existing data safely. Do not run the placeholder Worker
migration against production or overwrite the live D1 database.

- The login screen now includes an optional Account type selector. Choosing
  Labour prevents an Admin record with the same mobile number from being
  selected. If the Labour account is missing on that device, the login gives a
  clear device-local data warning instead of silently signing into Admin.
