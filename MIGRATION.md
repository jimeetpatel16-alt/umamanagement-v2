# Legacy data migration

Expected JSON: `{"version":1,"exportedAt":"ISO_DATE","companies":[],"drivers":[],"labour":[],"days":[],"driverSubmissions":[],"labourShifts":[],"labourLogs":[],"rateCards":[],"invoices":[],"deliveryBlocks":[],"driverAssignments":[],"settings":{}}`.

The current import route imports company, driver, labour, rate card, invoice, block, assignment, shift and submission master rows. It does not yet map nested legacy `days[].records[]`, legacy labour logs, settings or user PINs. Those need a reviewed mapping before cutover.

Checklist:
- Export every browser/device that may hold local data.
- Preserve original exports unchanged.
- Deduplicate using legacy IDs.
- Compare companies, drivers, labour and record counts.
- Reconcile each date's block count and total driver pay.
- Reconcile pending/approved/paid amounts and payment references.
- Reconcile labour hours, pay, bill totals and invoices.
- Create fresh accounts with unique passwords.
- Test every role and company boundary.
- Keep a read-only legacy backup and obtain owner sign-off.
