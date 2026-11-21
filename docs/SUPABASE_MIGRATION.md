# Billion — Supabase migration

The target Supabase project is **Holoo pro** (`qsdlthvnfmjbodtdkbqc`). The unrelated `Glass-Accounting` project is not used by Billion.

## Provisioned database layer

- `billion_companies`, `billion_company_members`, `billion_records`, `billion_operation_log` were already present.
- Added `billion_company_devices` and `billion_company_invites`.
- Added transactional RPCs for one-time company bootstrap, one-time invite acceptance, and atomic record batches.
- Added RLS policies allowing enrolled passwordless identities while preserving membership checks. Device identifiers are metadata, not credentials.
- Deployed Edge Function `billion-enrollment` with JWT verification enabled.

## Required one-time Supabase dashboard configuration

1. In Authentication → Sign In / Providers, enable **Anonymous Sign-Ins**. The app must still enroll each installation into the company before it can read accounting data.
2. In Edge Functions → Secrets, set `BILLION_BOOTSTRAP_TOKEN` to a fresh random value of at least 32 characters. Do not put it in the repository or a Vite environment variable.
3. The first installation calls the bootstrap action using that token. This creates the one company and owner membership. The owner then creates one-time invite tokens for the two Ehsan installations. Each invite expires after 24 hours and is single-use.
4. Active device enrollment is capped at three. Revoke devices through an authenticated administrative workflow before replacing hardware.

## Important migration boundary

The Supabase database and secure enrollment backend are provisioned, but the Billion React data layer still uses the legacy Firebase/Firestore adapter at this commit. Do not remove Firebase configuration or claim the application is fully switched until the frontend repository migration is complete, the existing Firestore records have been exported/imported and reconciled, and all cloud CRUD/realtime flows pass tests.

The publishable Supabase key in `src/lib/supabaseClient.ts` is public by design. Never add a service-role key to frontend code.
