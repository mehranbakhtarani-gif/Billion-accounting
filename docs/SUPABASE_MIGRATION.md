# Billion — Supabase architecture and migration

Target Supabase project: **Billion** (`pnzxxdaxvjfacztussxl`, region `eu-west-1`). The previous Holoo pro Supabase project is not the target for this repository.

## Active application path

- Browser client: `src/lib/supabaseClient.ts` (publishable key only).
- Passwordless session and enrollment: `src/lib/supabaseEnrollment.ts`.
- Company-scoped accounting records: `public.billion_records`.
- Company membership: `public.billion_company_members`.
- Device registry and one-time invitations: `public.billion_company_devices`, `public.billion_company_invites`.
- Atomic batch write RPC: `billion_apply_record_batch`.
- Device heartbeat RPC: `billion_touch_device`.
- Realtime subscription: Supabase Realtime on `billion_records`.
- Offline snapshots and outbox: local IndexedDB. Supabase is the cloud authority after enrollment.

## Database migration order

The repository migration files are versioned in the same order as the applied project history:

1. `20261123001513_billion_core_schema_secure_enrollment.sql`
2. `20261123001517_billion_inventory_lots_fifo_records.sql`
3. `20261123001518_billion_device_aware_operation_log.sql`
4. `20261123001546_billion_harden_enrollment_rpc.sql`
5. `20261123001607_billion_invoker_rls_accounting_writes.sql`

The baseline is additive and leaves the legacy `holoo_apex_*` tables untouched. It creates one-company, membership, device, invite, record and operation-log structures. The later migrations add the FIFO record types, device sequencing, atomic idempotent batch writes and invoker-based RLS policies.

## One-time setup still required

1. Supabase Authentication → Sign In / Providers → enable **Anonymous Sign-Ins**. This is required by `signInAnonymously()` in the PWA. It has not been verified as enabled through the available project-management connection.
2. The first installation uses the one-time bootstrap token provisioned for the project. Only its SHA-256 hash is stored in the non-exposed `billion_private.bootstrap_credentials` schema; the raw token is not committed to GitHub or put in a Vite variable.
3. After bootstrap, the owner creates one-time invitations, each valid for 24 hours. The raw invitation is shown once; only its hash is stored.
4. The database enforces a maximum of three active devices. Device IDs are metadata, not credentials.

## Security model

- The PWA contains only a publishable key. Service-role credentials are used only by the deployed `billion-enrollment` Edge Function.
- The Edge Function requires a valid Supabase JWT (`verify_jwt=true`) and checks the caller identity before enrollment.
- Reads and writes are scoped by RLS membership. Accounting batch writes and device heartbeat use `SECURITY INVOKER`; bootstrap/invite-consumption RPCs are restricted to `service_role`.
- Invitation and bootstrap secrets are stored as SHA-256 hashes and are single-use. Invite expiry is 24 hours.
- Inventory lot movements are append-only at the database policy and RPC layers.

## Current validation status

- The core tables and five ordered migrations are applied to project `pnzxxdaxvjfacztussxl`.
- `billion-enrollment` is deployed with JWT verification enabled.
- Security advisors show no public/authenticated-executable SECURITY DEFINER function warnings. Remaining RLS-without-policy notices are intentional for the invite table (service-role-only) and untouched legacy Holoo tables.
- No company or accounting records have been created yet. Anonymous Auth must be enabled, then bootstrap and three-device end-to-end tests must pass before production use.
