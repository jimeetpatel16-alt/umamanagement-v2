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
