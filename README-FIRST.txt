# UMA Management V2 — Source Bundle

This bundle contains:

1. `uma-management-v2/` — the original V2 project snapshot, including its Worker, D1 schema migration, web files and Wrangler configuration.
2. `legacy-reference/` — the fuller legacy browser application and its Excel module, supplied as a functional/design reference.

## Important — read before replacing anything

This is a source/reference bundle, **not a verified production-ready replacement**.

The legacy app uses browser-side/localStorage behaviour and must not be copied directly over the V2 web files without a proper D1/R2 integration. Doing so can make existing V2 data appear missing or disconnected.

The V2 project uses Cloudflare Worker + D1 + R2. Preserve the live Cloudflare D1 database, R2 bucket, Worker bindings, and production secrets. Do not run migrations again if they were already applied manually.

The currently deployed GitHub repository may contain newer changes than the V2 snapshot in this bundle. Before replacing files, back up the live GitHub repository and export the D1 database.

## Recommended safe workflow

1. Download and extract this ZIP.
2. Keep the `legacy-reference` folder as a reference only.
3. Clone the current GitHub repository separately.
4. Compare the current repository against the V2 snapshot before copying anything.
5. Test changes against a non-production database first.
6. Deploy only after login, company creation, driver creation, single entry, bulk entry, records, payments, and XLSX export have been tested.

## Known outstanding work

- Fix and verify the Admin recovery toggle in the current V2 frontend.
- Implement a real email reset flow only after configuring an email provider and secrets.
- Complete the D1-backed management screens and XLSX import/export.
- Validate bulk parsing and all write APIs against the actual deployed Worker and schema.

No production database or Cloudflare resource is changed by this ZIP.
