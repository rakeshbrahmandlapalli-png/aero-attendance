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
