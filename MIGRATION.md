# Shared D1 migration

The existing full backup is in the format `uma-management-backup` with a `collections` object. The owner has already inspected a local backup summary showing 4 staff/login profiles (1 Admin, 2 Driver, 1 Labour), 2 companies, 37 drivers, 8 delivery-day documents containing 144 nested delivery records, 1 Labour roster row, 1 Labour log, 1 invoice and 1 driver submission.

## Safe import behavior

- `worker/migrations/0002_shared_documents.sql` adds `app_documents`, `app_auth_accounts` and `app_auth_sessions`.
- `worker/scripts/import-backup-to-d1.mjs` reads the JSON file locally on the owner's Mac.
- It imports the existing collections by original document ID using `INSERT OR IGNORE`, so it does not delete or overwrite existing D1 documents.
- It strips each staff `pin` from the staff profile JSON, creates a random salt, derives a PBKDF2-SHA256 hash, and stores the hash separately.
- Nested `days[].records[]` stay inside their original day document JSON, preserving all 144 delivery records.
- It reports collections and counts before proceeding and requires the owner to type `IMPORT`.

## Run the import

From the `worker` directory, after verifying that `database_id` in `wrangler.toml` matches the existing D1 database in Cloudflare:

```bash
npm install
node scripts/import-backup-to-d1.mjs "$HOME/Downloads/uma-management-backup-2026-11-04.json"
```

The importer applies the additive migrations and executes SQL against the configured remote D1 database. It uses the database name from `wrangler.toml`. If the backup has a different name or location, pass its exact path.

## Cutover checklist

- [ ] Verify the exact D1 database name and ID in Cloudflare.
- [ ] Preserve the JSON backup unchanged.
- [ ] Run the importer and retain its terminal output.
- [ ] Check that the imported collection counts match the backup summary.
- [ ] Deploy the Worker and frontend only after the import succeeds.
- [ ] Test the existing Labour mobile + PIN login on an iPhone.
- [ ] Test Admin and Driver logins and all role-specific screens.
- [ ] Reconcile delivery record counts, total driver pay, payment statuses, Labour logs and invoices.
- [ ] Keep the original device backup until all counts and totals match.

Do not use this project for live payroll until deployment and regression tests are complete. If records exist on other devices, export those devices separately before cutover; this import includes only the uploaded-by-owner laptop backup that was inspected.
