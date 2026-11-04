UMA MANAGEMENT — SHARED CLOUDFLARE D1 INTEGRATION PACKAGE
========================================================

This package keeps the existing UMA Management interface and premium
navy/white/gold theme, and adds a Cloudflare D1-backed storage adapter.
The login remains mobile number + 4-digit PIN for Admin, Manager, Staff,
Driver and Labour accounts.

WHAT THIS PACKAGE CHANGES
-------------------------
- Adds a D1 document store so the legacy app collections are shared across
  devices instead of using each device's browser localStorage.
- Adds shared mobile-number account lookup and server-side PIN verification.
- Stores PIN hashes separately from staff profile JSON using PBKDF2-SHA256.
- Adds role-aware reads and writes for the app's existing collections.
- Adds a local Node.js importer for the existing UMA full JSON backup.
- Adds an additive D1 migration; it does not drop or replace existing tables.

IMPORTANT BEFORE USING
---------------------
- Keep the original JSON backup unchanged and private.
- Check worker/wrangler.toml: its database_id must exactly match the existing
  UMA Management D1 database in your Cloudflare account. The ID in this file
  was copied from the current GitHub repository, but must be verified in your
  Cloudflare dashboard before running the importer.
- This package has not been deployed to your Cloudflare account. Do not assume
  that the live website is already synchronised.
- Do not run the importer against a different database. It applies only
  additive migrations and uses INSERT OR IGNORE, but must still target the
  correct D1 database.

FOLLOW THE SETUP GUIDE
---------------------
Read SHARED-D1-SETUP.md before replacing project files or running commands.
The guide covers the safe sequence: verify D1 ID, migrate and import locally,
then push/deploy the updated Worker and frontend.

EXISTING BACKUP SUMMARY
-----------------------
The local backup summary shared by the owner showed:
- 4 staff/login profiles: 1 Admin, 2 Driver, 1 Labour
- 2 companies
- 37 drivers
- 8 delivery days containing 144 delivery records
- 1 Labour roster record, 1 Labour log, 1 invoice and 1 driver submission

The importer reads the local JSON file on the owner's Mac. It does not send
that backup to this chat. It strips staff PINs from profile documents and
stores salted PBKDF2 hashes in the D1 auth table.

REGRESSION TESTING REQUIRED
---------------------------
After deployment, reconcile collection counts and monetary totals with the
backup before using the system for live payroll. Test Admin, Staff, Driver and
Labour login on desktop and mobile. In particular, test driver screenshot
submissions, labour logs, payments, invoices, role permissions and switching
between accounts. Keep the original backup until all comparisons are signed off.
