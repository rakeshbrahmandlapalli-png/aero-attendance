# Step 6 local readiness evidence

Run `node checks/release-readiness.mjs` from this repository root. It uses only
synthetic PostgreSQL, fake Web Push, and a service-worker VM. No device or external
delivery endpoint is contacted. Current result: 27 checks passed.

Checks cover real shared SQL rejecting missing/outside-site GPS, valid clock-in,
break closure after the 134 kill switch, denial of new access, retention of shift
records/parking staff, and a synthetic full-database archive/restore. The actual
generated sender is exercised with fake SDKs for bounded transient retries,
expired subscriptions, server-side recipient filtering, revocation and gate
failure. Actual service-worker code is exercised for offline no-store navigation,
non-interception of API/auth traffic, notification display/click routing and the
two install manifests/icons.

Existing Step 5 browser journeys also cover failed handoffs, interrupted writes,
response loss/retry, tenant/session boundaries, revoked-access finishing and
responsive views. Existing resilience checks exercise bounded request timeout.
Isolation, shared-backend and restore round-trip regressions are rerun separately.

These do not prove real Auth/PostgREST, physical GPS, Web Push delivery, PWA install
or durable delivery after all transient retries are exhausted. Three-attempt
retry logic is not a durable recovery guarantee. These remain release gates.

## Physical checks — all unperformed

Record model, OS/browser, account UUID, company UUID, time, evidence and outcome
for each device. Use isolated staging services and synthetic identities first.

| Check | Android Chrome | iPhone Home Screen |
| --- | --- | --- |
| Staff and manager install as separate apps; reopen after browser closes | Unperformed | Unperformed |
| Foreground/background push, tap target, denied permission, unsubscribe | Unperformed | Unperformed |
| On-site/outside GPS, permission denied, poor accuracy, location turned off | Unperformed | Unperformed |
| Airplane mode, timeout, response lost after commit; no offline queue | Unperformed | Unperformed |
| Resume/restart, expired login/handoff, revoked access during shift/break | Unperformed | Unperformed |
| Kill switch stops new access/delivery; existing open shift can finish | Unperformed | Unperformed |

No phone acceptance is marked passed. Do not activate the pilot to obtain this
evidence before production approval. See the companion Parking-Ops document
`docs/attendance-release-approval.md` for backup, target, security and rollback
gates. Step 8 remains prohibited pending explicit approval.

## Next physical round — Android and iPhone confirmed

The owner confirmed both device types are available. No physical result has been
recorded yet. Before starting, supply an HTTPS staging URL with an **isolated**
shared test backend, synthetic staff/manager identities in two fictional tenants,
and separate test push credentials. Verify its configuration before any login.
The Parking Preview at commit 569b604 still references the production backend;
only signed-out display/assets were verified there, with all Supabase requests
blocked. Do not enter a production personal link, clock a shift or test live push
on that Preview as a substitute for staging acceptance.

For each device:

1. Record model, OS/browser version, staging URL/source commit and synthetic
   identity UUIDs. Install the staff and manager apps separately, reopen both,
   and check their icons, destination and session isolation.
2. Use the synthetic staff handoff once, repeat it to confirm rejection, then
   check failed/expired handoff cleanup without clearing the manager session.
3. Clock in, start/end a break, clock out, review the current shift and request a
   correction. In the manager app, approve/reject synthetic requests and check
   audit/CSV results. Another test tenant must see none of these records.
4. Check push permission denied/allowed, foreground/background delivery, tap
   destinations, sign-out/unsubscribe and access revocation. Record observed
   delivery; push-service acceptance alone is not a pass.
5. Check location denied/off, poor accuracy, inside/outside the configured test
   site, and the documented policy result. Do not publish precise coordinates or
   location screenshots in the evidence.
6. Check airplane mode and reconnect, bounded timeout, a response lost after a
   successful write, retry without duplicate writes, restart and expired sessions.
   Attendance must not silently queue unverified clock actions offline.
7. Revoke access and exercise the kill switch **in staging only**: deny new work
   and delivery while permitting the supported open-shift/break finish path.
   Verify recovery without enabling production Attendance.

Record pass/fail and timestamps for every row above, including failures and the
retry/recovery result. Keep tokens, PINs, real client records and precise GPS out
of reports. A failure remains a release blocker; it is not waived by a synthetic
browser pass. Durable notification recovery after retry exhaustion, real
Auth/PostgREST acceptance and production recovery/security gates remain separate.
