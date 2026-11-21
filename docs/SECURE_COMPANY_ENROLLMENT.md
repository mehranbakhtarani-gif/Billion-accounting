# Secure company membership and device enrollment

Status: design gate; implementation must not be enabled until the trusted backend is deployed.

## Why this is required

The current data model authorizes Firestore records by `ownerId == request.auth.uid`. The device registry is also scoped to that UID. This is safe for one authenticated owner, but it does not let different Firebase identities collaborate on one company. A device UUID is attacker-controlled metadata and must never grant access.

The repository currently has no `firebase.json`, Firebase Functions source tree, or Firebase Admin SDK dependency. The existing Express `server.ts` is an application/API server, not a trusted Firebase membership service. Adding a client-side invite check or a public Firestore write rule would not be a safe substitute.

## Target model

- One immutable `companyId` identifies the single company.
- `companyMembers/{uid}` stores `companyId`, role, status, enrolledAt, and revokedAt.
- `companyDevices/{deviceId}` stores companyId, uid, label, platform, enrolledAt, lastSeenAt, and revokedAt.
- At most three active devices are enrolled for the company.
- Every accounting document is migrated additively to include `companyId`; existing `ownerId` is retained during the compatibility period.
- Reads and writes require an authenticated Firebase principal and an active membership for the document's company. Device metadata is never an authorization factor.
- Permanent accounting records remain append-only or use explicit reversal/correction workflows; enrollment does not imply unrestricted accounting privileges.

## Passwordless enrollment flow

1. A trusted bootstrap operation creates the company and its first owner membership. It must not be callable by an arbitrary unauthenticated client.
2. An authorized owner creates a one-time enrollment invitation. The backend stores only a cryptographic hash of a high-entropy random token, plus companyId, allowed role, expiry, remaining uses, and creator UID.
3. Each target installation authenticates with Firebase Anonymous Authentication (only after that provider is enabled in Firebase Console) and submits the token to a callable backend function.
4. The callable function verifies the Firebase ID token, validates the invitation hash and expiry, checks that fewer than three devices are active, and atomically consumes the invitation and creates the membership/device records in a Firestore transaction.
5. The backend returns only the enrolled company metadata. The raw token is never persisted in Firestore or local storage.
6. Revocation disables membership/device access in Security Rules. Revocation must not delete accounting history.

This supports a passwordless flow, but it still requires a short-lived enrollment action on each device. Anonymous auth is per installation; it is not a cross-device identity by itself.

## Required trusted backend endpoints

- `createCompanyInvite`: owner/admin only; creates a high-entropy, expiring, single-use invite (or explicitly bounded use count).
- `acceptCompanyInvite`: authenticated user only; transactionally consumes invite and enrolls the device, enforcing the three-device ceiling.
- `revokeCompanyMember` and `revokeCompanyDevice`: owner/admin only; append audit event and revoke access.
- `applyAccountingOperation`: authenticated active member; validates company membership, idempotency key, entity version, and operation schema; applies one operation transactionally or records a conflict without overwriting the source record.

All functions must use Firebase Admin SDK on a trusted runtime. Secrets and service-account credentials must never be shipped to the PWA/APK.

## Data migration and compatibility

1. Back up all Firestore collections and export a verified local snapshot.
2. Create company and owner membership records through the trusted bootstrap.
3. Backfill companyId for each existing owner-scoped document in bounded, restartable batches.
4. Deploy rules that temporarily accept the legacy owner path only for records without companyId and only for their original owner.
5. Verify record counts, references, and totals before enabling company-scoped access.
6. Switch client queries and writes to companyId; then remove the legacy owner-only rule after a successful reconciliation.
7. Keep a rollback plan and do not delete legacy ownerId fields during the migration.

## Release gates

- Rules emulator tests prove non-members cannot read/write and revoked members lose access.
- Invitation tests cover expired, replayed, brute-force throttling, and concurrent acceptance.
- Concurrent enrollment tests prove the active-device count never exceeds three.
- Operation tests prove replay is idempotent and stale versions become reviewable conflicts.
- Test the exact topology: one Mehran installation and two Ehsan installations.
- Do not enable this design until Firebase Anonymous Authentication is enabled, the trusted backend is deployed, and all three target devices can be enrolled and revoked in a controlled test company.
