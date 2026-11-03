# UMA Management V2

Cloudflare Workers + D1 + R2 rebuild scaffold. The existing production app is not overwritten.

## Setup
1. Install Node.js 20+.
2. `cd worker && npm install && npx wrangler login`
3. `npx wrangler d1 create uma-management-v2`
4. Put the returned database ID in `wrangler.toml`.
5. `npx wrangler r2 bucket create uma-management-private`
6. `npx wrangler d1 migrations apply uma-management-v2 --remote`
7. `npx wrangler secret put SESSION_SECRET` (32+ random bytes)
8. `npx wrangler secret put BOOTSTRAP_SECRET`
9. `npm run deploy`

Create the first admin once:
POST `/api/bootstrap`, header `x-bootstrap-secret`, JSON:
`{"name":"UMA Owner","email":"owner@example.com","password":"a-long-unique-password-14-chars-min"}`.
The endpoint closes after the first admin exists. Remove BOOTSTRAP_SECRET after setup.

## Data preservation
The old app can use browser localStorage (`driverpay_local_db_v1`) when its injected DB is unavailable. That data is isolated per browser/device and cannot be read by this new server. Keep the old site running, export from every device, review and reconcile counts/totals, then import using the Admin-only migration endpoint. Legacy PINs are never migrated; create new passwords. See MIGRATION.md.

## Important
This is a new foundation and migration scaffold, not a completed cutover. Validate all business workflows, complete resource write APIs, backups, access tests and payroll reconciliation before using it for real payroll or sensitive records.
