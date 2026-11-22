# Secure company membership and device enrollment

Status: implemented on the Supabase backend; requires the dashboard setup in `docs/SUPABASE_MIGRATION.md`.

## Target model

- One company row in `public.billion_companies`.
- Memberships in `public.billion_company_members`, keyed by company and Supabase Auth user.
- Device metadata in `public.billion_company_devices`.
- Hashed, one-time invitations in `public.billion_company_invites`.
- A maximum of three active enrolled devices.
- Accounting records in `public.billion_records`, scoped by company ID and protected by RLS.
- Device UUIDs are not credentials and never authorize access.

## Passwordless flow

1. Each installation obtains a Supabase Anonymous Auth session.
2. The first installation calls the JWT-verified `billion-enrollment` Edge Function with the server-configured bootstrap token. The backend creates the single company, owner membership, and first device in one transaction.
3. The owner creates one-time invitations. The raw token is shown once; only its SHA-256 hash is stored. It expires after 24 hours.
4. Each additional installation submits its invite token. The backend locks the invitation and company, checks expiry/replay and the three-device ceiling, then creates membership and device records transactionally.
5. Accounting data is accessible only after membership exists. RLS checks `auth.uid()` against company membership.
6. Revocation should be performed by an owner-only administrative backend workflow; revoking a device must not delete accounting records.

## Trusted backend

The `billion-enrollment` Edge Function verifies the caller JWT and uses the service-role key only in the Edge Function runtime. The service-role key is never included in the PWA/APK.

Database RPCs:
- `billion_bootstrap_company`: creates the single company, owner membership, and first device.
- `billion_accept_company_invite`: atomically consumes an invitation and enrolls another device.
- `billion_apply_record_batch`: applies company-scoped record mutations transactionally under the caller's RLS identity.

## Release gates

- Enable Anonymous Sign-Ins in Supabase Auth.
- Set a high-entropy `BILLION_BOOTSTRAP_TOKEN` secret in Edge Function secrets.
- Test invalid, expired, and replayed invitations.
- Test concurrent invite acceptance and verify no more than three active devices can be enrolled.
- Verify non-members and revoked members cannot read or mutate company records.
- Test all three installations: bootstrap owner device, then two invite-based devices.
- Test record create/update/delete and Realtime propagation across all devices.
