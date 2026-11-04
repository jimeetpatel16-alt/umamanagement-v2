# UMA Management — Shared Cloudflare D1 setup

This package adds a shared D1-backed document adapter while preserving the existing app screens and navy/white/gold theme.

## Important safety notes

- Keep the original JSON backup private and unchanged.
- The importer uses `INSERT OR IGNORE`: it does not delete or overwrite existing D1 documents.
- Staff PINs are removed from profile JSON and stored as PBKDF2-SHA256 hashes in `app_auth_accounts`.
- Do not run the importer against a different database. First compare the `database_id` in `worker/wrangler.toml` with the ID on the Cloudflare D1 dashboard.
- The migration is additive. It creates new tables and leaves existing D1 tables alone.

## 1. Prepare the project

1. Make a separate copy of your current `umamanagement-v2` repository folder.
2. Copy the files from this package into that copy, preserving the `web` and `worker` folders.
3. Open Terminal and enter the `worker` folder (the folder containing `wrangler.toml`).
4. Install dependencies:

   ```bash
   npm install
   ```

5. Check the configured database:

   ```bash
   npx wrangler d1 list
   ```

   Confirm that the database named `uma-management-v2` has the same ID as `database_id` in `wrangler.toml`. If it does not match, stop and correct `wrangler.toml` before continuing.

## 2. Import the backup locally

Keep the backup in your Downloads folder. From the `worker` directory run:

```bash
node scripts/import-backup-to-d1.mjs "$HOME/Downloads/uma-management-backup-2026-11-04.json"
```

The script first shows a preview of the collections and record counts. Verify the target database name and ID. Only type `IMPORT` when the target is your existing UMA Management D1 database and the counts look right.

The script applies the additive D1 migrations and imports each backup document with `INSERT OR IGNORE`. It does not upload the backup to this chat or another application. It creates a temporary SQL file with restrictive permissions and removes it after the import attempt.

If your backup has a different filename, replace the JSON path in the command with the exact filename.

## 3. Deploy the Worker and frontend

After the import succeeds:

1. Review the modified files in GitHub Desktop.
2. Commit the changes on your existing `main` branch (or a separate test branch if you use one).
3. Push to GitHub.
4. Cloudflare should build from the `worker` root using its existing settings. Do not change the D1 binding or R2 bucket settings in the dashboard.
5. Confirm the build and deploy complete successfully.

The new Worker health endpoint should return JSON containing:

```json
{"ok":true,"service":"UMA Management Shared D1","storage":"d1"}
```

## 4. Test before relying on it

1. Open the website on the laptop and sign in with the existing mobile number and 4-digit PIN.
2. Confirm the Admin dashboard loads the existing companies, drivers and records.
3. Open the same URL on the iPhone. The same mobile number should now be found by the shared lookup endpoint.
4. Enter the existing PIN and confirm the Labour dashboard opens.
5. Create a small test record and verify it appears on the other device.
6. Keep the original backup until every collection is reconciled.

## Scope and limitations to review

- This migration imports only the records present in the supplied laptop backup. Any data created separately on another device needs its own backup before cutover.
- The old email/password Worker endpoints are no longer used by this frontend; shared login uses the existing mobile + PIN model.
- The app's full feature set should be regression-tested after deployment, especially driver photo submissions, labour logs, payment totals, invoices and role access. Do not use the new deployment for live payroll until the counts and totals reconcile with the backup.
- If Cloudflare's D1 database ID does not match the configured ID, do not import. A mismatch could target the wrong database.
