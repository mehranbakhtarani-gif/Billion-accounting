# Secure Billion company membership and device enrollment

## Target model

- Exactly one company in `public.billion_companies`.
- Memberships in `public.billion_company_members`, one company per Supabase Auth user.
- Device metadata in `public.billion_company_devices`.
- Hashed, single-use invitations in `public.billion_company_invites`.
- A maximum of three active devices, enforced transactionally when accepting invitations.
- Accounting records in `public.billion_records`, scoped by company ID and protected by RLS.
- Device UUIDs are metadata, never credentials.

## Passwordless flow

1. Each installation obtains its own Supabase Anonymous Auth session.
2. The first installation calls the JWT-verified `billion-enrollment` Edge Function with the provisioned one-time bootstrap token. The database validates its SHA-256 hash and atomically creates the single company, owner membership and first device.
3. The owner creates one-time invitations. The raw token is returned once; only its SHA-256 hash is stored. It expires after 24 hours.
4. Each additional installation submits its invite token. The database locks the invitation and company, checks expiry/replay and the three-device ceiling, then creates membership and device rows in one transaction.
5. The owner device and two invited devices share the same company data. Each installation has its own anonymous Auth user.
6. Device revocation must be an owner-only administrative workflow; revoking a device must not delete accounting records.

## Trusted backend

The deployed `billion-enrollment` Edge Function verifies the caller JWT and uses the service-role key only inside the Edge Function runtime. It is deployed with `verify_jwt=true`; the service-role key is never included in the PWA/APK.

Database RPCs:
- `billion_bootstrap_company`: service-role-only; validates and consumes the one-time bootstrap token.
- `billion_accept_company_invite`: service-role-only; atomically consumes an invitation and enrolls a device.
- `billion_apply_record_batch`: invoker-based; applies company-scoped record mutations with optimistic revisions, device sequence and append-only operation log.
- `billion_touch_device`: invoker-based device heartbeat.

## Remaining release gates

- Enable Anonymous Sign-Ins in Supabase Auth.
- Run bootstrap once, then issue and accept two invitations.
- Test invalid, expired and replayed invitations.
- Test concurrent invite acceptance and verify the three-device ceiling.
- Verify non-members and revoked devices cannot read or mutate company records.
- Test create/update/delete, conflict detection, idempotent retry, offline outbox recovery and Realtime propagation across three installations.
- Do not treat the app as production-ready until those end-to-end checks pass.
