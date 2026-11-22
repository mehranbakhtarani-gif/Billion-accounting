# Billion Enterprise Upgrade Roadmap

Date: 2026-11-22
Target branch: `feat/enterprise-controls-foundation`
Baseline: `main` at `fcb443ea7fa22924871aefef13f35d1285841eef`

## Goals and non-negotiable safeguards

Implement the ten selected capabilities without deleting or silently rewriting existing company data. Existing local IndexedDB snapshots, Supabase company-scoped records, invoices, vouchers, inventory, cheques, imports, currencies, and audit logs remain readable throughout migration.

- No destructive schema migration.
- No automatic rewrite of permanent vouchers.
- No silent conflict resolution for accounting records.
- No stock issue if eligible lot balances are insufficient.
- No bank auto-match when more than one ledger candidate exists.
- No production deployment until type-check, build, domain tests, migration checks, and a controlled test-company scenario pass.
- Device identity is not authentication. Cloud writes must continue to be authorized by Supabase Row Level Security policies and a verified company membership model.

## Repository baseline findings

1. The app persists a complete local snapshot in IndexedDB (`src/lib/localAccountingStore.ts`) and subscribes to owner-scoped Supabase company-scoped records in `AccountingContext.tsx`.
2. Supabase company membership currently binds records to `request.auth.uid`. Three devices must therefore use a properly authorized shared company identity/membership design; simply assigning three device IDs or relaxing rules to public access would be unsafe.
3. Existing Supabase RLS policies are default-deny and validate many entity schemas. Any new fields/collections must be introduced with matching rules and tests, not by broadening access.
4. Product currently has a single `lotNumber` field and aggregate `stock`; that is not a multi-lot inventory ledger.
5. Invoice items carry quantities and unit prices; current product profitability uses the product's current `buyPrice`, not actual issue-layer costs.
6. Voucher update/delete and year-end closing flows exist. A period lock must guard every entry point, not just the UI.
7. Existing bank CSV and cheque features are present; the new work must add reviewable reconciliation and read-only audit findings, not silently mutate ledger data.

## Stage 0 — Baseline, backup and compatibility

- Record the current main commit and inventory all persisted entity shapes.
- Add synthetic fixtures representing one fiscal year, a purchase, sale, partial receipts, cheque lifecycle, imports, and multi-currency.
- Export/backup path and restore test for IndexedDB snapshot and cloud collections.
- Establish a migration version marker; migration must be additive and idempotent.
- Capture current build/type-check results before domain changes.

Acceptance: a backup can be restored to an isolated test environment and existing seed data loads unchanged.

## Stage 1 — Three-device sync foundation

- Define company-scoped operation envelopes with operation ID, idempotency key, actor ID, device ID, entity ID, base version, timestamp, schema version and payload.
- Add stable per-installation device identity and a device registry. Device registration is metadata, not proof of authorization.
- Add an append-only operation journal/outbox, retry state, acknowledgement, and deduplication.
- Use server-side transactions / compare-and-set version checks for cloud application.
- Classify same-entity stale-base updates as conflicts; do not use last-write-wins for vouchers, invoices, cheque state, or stock movements.
- Support three active devices through an explicit company membership/device enrollment model. Retain offline local work until cloud acknowledgement.
- Add conflict review UI and a device activity view.

Acceptance: replaying one operation twice changes balances once; concurrent edits to the same invoice or voucher are held for review; independent records merge; offline work survives restart and syncs after reconnection.

## Stage 2 — Atomic financial operations

- Introduce a validated command layer for invoice issue/cancel, stock movement, cheque transitions and treasury receipts/payments.
- Commit related Supabase records and operation-journal marker in one transaction/batch where Postgres limits permit.
- For workflows exceeding one Postgres transaction, use a durable saga with explicit pending/completed/compensated states and a reconciliation worker.
- Enforce balanced journal lines, unique source references, nonnegative inventory policy, and idempotency at the command boundary.
- Make retry safe; a network timeout must not create a second voucher.

Acceptance: fault injection at every step never leaves an untraceable partial transaction; retry creates no duplicate invoice, stock movement, cheque transition, or voucher.

## Stage 3 — Fiscal periods and permanent-voucher correction

- Add fiscal-period records with start/end dates, open/closed status, close metadata and lock version.
- Guard create/update/delete/finalize/reverse/renumber/year-end operations in domain services, not only components.
- Disallow edits/deletes of permanent vouchers; correction is a linked reversal/correction voucher with actor, reason and original reference.
- Prevent overlapping periods, out-of-period posting, duplicate close, and reopening without explicit elevated authorization.
- Reconcile closing balances to next-year opening balances.

Acceptance: all write paths reject a closed-period posting; a correction preserves the original permanent voucher and produces a traceable balanced reversal.

## Stage 4 — Lot / expiry / FIFO inventory

- Add stock-lot and stock-movement ledgers; retain Product.stock as a derived compatibility total during migration.
- Track product, warehouse, lot, receipt date, optional expiry date, received quantity, remaining quantity, unit cost and source document.
- Allocate sales/dispatch from eligible lots by FIFO; expired lots are excluded according to configured policy.
- Persist the exact lot allocations on invoice/dispatch lines and use allocated historical cost for COGS and profitability.
- Handle returns against original lot allocations where known; otherwise require an explicit receiving lot.
- Add reconciliation between aggregate Product.stock and summed lot balances.

Acceptance: FIFO order is deterministic; insufficient stock is rejected; lot totals reconcile to aggregate stock; returned goods and cancelled invoices restore the correct layer quantities.

## Stage 5 — Open-item receivables and payables aging

- Introduce explicit invoice settlement allocations linking receipts/payments to invoice IDs.
- Compute outstanding invoice balances from invoice total less valid allocations and credit notes/returns.
- Show current, 1–30, 31–60, 61–90, and over-90-day buckets using due date, with issue-date fallback only where terms are absent.
- Separate customer receivables and supplier payables.
- Reject allocations above available payment or invoice balances; allow one payment across many invoices and many payments against one invoice.
- Reconcile party subledgers to control accounts.

Acceptance: aging totals equal open-item balances and party subledgers; partial payments move only the remaining amount between buckets.

## Stage 6 — Bank reconciliation and treasury/cheque audit

- Import statement lines with source-file hash, account, statement period, opening/closing balance and duplicate detection.
- Suggest exact-reference matches first, then amount/date candidates; ambiguous matches require human selection.
- Track reviewed, matched, unmatched and approved states without changing ledger entries during analysis.
- Reconcile opening balance + statement movements = closing balance.
- Audit each treasury transaction for exactly one posted voucher with matching date, direction, bank/cash account, party and fee.
- Audit cheque lifecycle transitions and linked vouchers for missing, duplicate or invalid transitions.
- Record approval as a separate auditable action.

Acceptance: duplicate statement rows are detected; ambiguous matches are not auto-approved; audit reports are read-only; approved reconciliations retain source and reviewer details.

## Stage 7 — FX commitments and landed import costing

- Add FX commitment records linked to supplier/import dossier, currency, original rate, amount, due dates and outstanding balance.
- Record partial settlements with settlement date/rate and bank reference.
- Calculate realized FX difference on settlement and unrealized revaluation at reporting date without overwriting historical rates.
- Extend import costing to allocate freight, insurance, customs, clearance, demurrage, inland transport and other charges by configured basis.
- Track goods-in-transit separately from warehouse inventory; capitalize landed cost on actual receipt/clearance.
- Prevent the same landed cost or shipment receipt from being posted twice.

Acceptance: remaining foreign commitment reconciles to settlements; realized/unrealized FX differences are reproducible; landed costs sum exactly to the dossier total and posted inventory cost.

## Stage 8 — Audit center

- Read-only cross-module checks: invoice-voucher, treasury-voucher, cheque-voucher, stock-lot, import-cost, party-control-account, bank-statement and fiscal opening/closing links.
- Severity, entity references, evidence, detection time, acknowledgement and resolution note.
- No auto-fix for accounting discrepancies. Any correction launches an authorized workflow with a new journal event.
- Exportable audit evidence and immutable audit history.

Acceptance: synthetic fault cases are detected; reports never mutate source records; every resolved issue links to the correcting operation.

## Delivery and release gates

Each stage is delivered as a separate commit/PR on this feature branch. After each stage:
1. run `npm run lint`;
2. run the relevant domain tests;
3. run `npm run build`;
4. inspect GitHub Actions;
5. test on an isolated company fixture;
6. only then proceed.

Do not merge or deploy unfinished enterprise controls to the production Pages branch. A successful compile is not proof of multi-device concurrency correctness or accounting correctness.


## Implementation progress — 2026-11-22

### Completed in the feature branch

- Added pure domain primitives for fiscal-period validation, operation-envelope validation and conflict classification, FIFO lot allocation, open-item aging, atomic-plan validation, bank-line reconciliation suggestions, and treasury-voucher link auditing.
- Upgraded IndexedDB from version 1 to 2 with additive creation of a durable sync outbox and a stable installation identity. Existing snapshot storage is retained.
- The AccountingContext now initializes the local device identity before auth readiness and registers/updates a device heartbeat under the authenticated Supabase Auth user ID.
- Added owner-scoped Supabase RLS policies for the device registry. Device IDs are explicitly metadata and are not treated as credentials.
- Added automated tests and a GitHub Actions workflow. The base foundation commit `4abaf84` passed type-check, domain tests, and Vite build. Subsequent context/rules integration commits are awaiting their own workflow completion.

### Validation update — 2026-11-22\n\n- GitHub Actions completed successfully for the current PR head `8164ea668134e0b5b79a8b5ab0d2e88f426f566c` (type-check, enterprise domain tests, and production build).\n- This green CI validates compilation and the current pure domain tests; it does not validate Supabase RLS in an emulator, shared membership, real multi-device replay, or accounting concurrency.\n- A dedicated design gate for passwordless company membership and three-device enrollment is documented in `docs/SECURE_COMPANY_ENROLLMENT.md`. The repository currently has no Supabase Edge Functions deployment scaffold, so trusted backend enrollment is not yet live.\n\n### Supabase backend progress — 2026-11-22

- Confirmed the correct Billion Supabase project is `Holoo pro` (`qsdlthvnfmjbodtdkbqc`); the separate `Glass-Accounting` project is not the Billion target.
- Applied additive migrations for `billion_company_devices`, `billion_company_invites`, membership-aware RLS policies for passwordless identities, and the transactional `billion_apply_record_batch` RPC.
- Deployed JWT-verified Edge Function `billion-enrollment` for one-time company bootstrap, invite acceptance, and invite creation.
- Added browser-safe Supabase client and enrollment helper modules to the repository.
- Required dashboard actions remain: enable Anonymous Sign-Ins and set the server-only `BILLION_BOOTSTRAP_TOKEN` secret. No service-role key is embedded in the client.
- The accounting React context still uses its Supabase adapter. Supabase is provisioned, but frontend CRUD/realtime cutover and historical data reconciliation are not yet complete. Do not describe the app as fully migrated yet.

### Still outstanding in Stage 1

- A device registry scoped to one Supabase Auth user ID does not yet allow separate Mehran/Ehsan identities to share one company. That requires a secure company-membership and device-enrollment mechanism, preferably a trusted backend or callable function issuing one-time enrollment grants.
- The outbox is durable locally but is not yet connected to every CRUD write or a cloud replay worker. No claim of live three-device synchronization is made at this point.
- Conflict review, server-side idempotent application, membership revocation, and multi-device concurrency tests remain outstanding.


## Supabase-only cutover update — 2026-11-22

- Removed Firebase SDK and security-rules dependencies, configuration files, Firestore rules, and Firebase PWA network routes.
- Replaced the accounting context's cloud authentication, CRUD, batched writes, and live subscriptions with Supabase Auth, the company-scoped `billion_records` table, transactional RPC, and Realtime.
- The app now uses passwordless anonymous sessions and one-time invitation enrollment. The owner can issue a one-time invite from the app for the other devices.
- The owner explicitly accepted loss of previous Firebase cloud data; no Firestore export/import was attempted. Existing local IndexedDB snapshots remain device-local and are not automatically imported to the new company.
- Supabase dashboard setup remains required: enable Anonymous Sign-Ins and set the server-only `BILLION_BOOTSTRAP_TOKEN` Edge Function secret.
- End-to-end three-device validation and final GitHub Actions validation remain release gates.
