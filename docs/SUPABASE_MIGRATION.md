# Billion — Supabase-only architecture

Status: Firebase/Firestore application dependencies and configuration have been removed from the repository. The React accounting data context now uses Supabase Auth, Postgres, RLS, RPC transactions, and Realtime.

Target project: **Holoo pro** (`qsdlthvnfmjbodtdkbqc`). The unrelated `Glass-Accounting` project is not used.

## Active application path

- Browser-safe client: `src/lib/supabaseClient.ts`.
- Passwordless auth and enrollment: `src/lib/supabaseEnrollment.ts`.
- Company-scoped accounting records: `public.billion_records`.
- Company membership: `public.billion_company_members`.
- Device registry and one-time invitations: `public.billion_company_devices`, `public.billion_company_invites`.
- Atomic multi-record write RPC: `billion_apply_record_batch`.
- Realtime subscription: Supabase Realtime on `billion_records`.
- The app uses local IndexedDB for offline snapshots; Supabase is the cloud authority after a device has been enrolled.

## Required one-time Supabase dashboard setup

1. Authentication → Sign In / Providers → enable **Anonymous Sign-Ins**.
2. Edge Functions → Secrets → set `BILLION_BOOTSTRAP_TOKEN` to a newly generated random value of at least 32 characters. Keep it server-side; never place it in source code or a `VITE_*` variable.
3. On the first installation, select “first device” and enter that bootstrap token. This creates the single company and owner membership.
4. The owner selects “invite device” to create a single-use invite valid for 24 hours. Enter the invite token on each of the other two installations.
5. Enrollment is capped at three active devices. The invitation and membership backend enforces this cap; device IDs are metadata, not credentials.

## Data-loss acceptance and migration boundary

The old Firebase adapter, SDK dependency, app configuration, Firestore rules, and PWA Firebase network routes have been removed. No Firestore export/import is performed, as the owner explicitly accepted losing the previous cloud data.

Existing local IndexedDB snapshots may still be present on devices, but they are not automatically uploaded or merged into the new Supabase company. The first company bootstrap creates a fresh seed dataset. Export any local data you later decide to retain before clearing app storage.

## Security

- The browser contains only the Supabase publishable key.
- Service-role credentials remain inside Supabase Edge Functions.
- Database reads/writes are scoped to the authenticated company membership through RLS.
- Atomic writes are applied through a Postgres function and cannot write across company IDs.
- Anonymous auth is passwordless but each installation has its own Supabase user identity. One-time company invites establish membership; sharing a device ID does not grant access.

## Validation still required

GitHub Actions type-check, tests, and production build must pass on the final branch head. Then test the bootstrap and invitation flow in Supabase with three real installations, including record creation, edit, delete, and realtime propagation. Do not treat the application as production-ready until those end-to-end checks pass.
