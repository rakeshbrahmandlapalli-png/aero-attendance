# Local verification

The app remains static HTML/JavaScript. This folder and its pinned dependencies
are developer-only and excluded from hosting by `.vercelignore`.

For the Step 4 shared staff gate, put `Parking-Ops` and `aero-attendance` side by
side and check out `attendance-integration` in both. Fetch each remote PR branch
first; the shared checks reject unrelated branches or heads which do not include
their fetched remote branch. They print both heads and test the working files.

```sh
npm --prefix ../Parking-Ops/checks ci --ignore-scripts
npm --prefix ../aero-attendance/checks ci --ignore-scripts
npm --prefix ../aero-attendance/checks run step4
```

Run these from either repository root, adjusting the sibling paths if needed.
The full gate includes the 577 baseline checks, shared SQL/transport checks, staff
SQL and browser acceptance, companion regressions and syntax/generated checks.
`npm run shared:staff` inside this folder runs only the new staff SQL/browser gate.
`npm run shared` runs the shared transport and integration regressions.
`npm run shared:browser` retains the existing demo/navigation check.

Install a local Chromium at `/usr/bin/chromium` (or set `CHROMIUM_PATH` for staff
acceptance). Browser execution may need permission to create local sockets in a
sandbox. The browser serves disk files and intercepts all API/SDK requests; it
blocks external network requests. It never opens a live Supabase session.

The test backend is PGlite with synthetic users/companies and a limited Auth/REST
adapter. SQL policies and RPCs are real; Supabase Auth, PostgREST and GPS are not.
See [Step 4 scope and evidence](../../Parking-Ops/docs/attendance-step4.md).

## Step 5 manager gate

```sh
npm --prefix ../aero-attendance/checks run step5
```

Run from either repository root after installing both repositories' pinned check
dependencies. `npm run shared:manager` inside this folder runs the new manager
SQL, runtime and browser suites on their own.

The Step 5 gate runs existing manager-relevant smoke/embed/resilience/pay checks,
shared transport and staff regressions, backend handoff, new manager SQL/runtime
checks, and responsive staff/manager browser journeys. It excludes dedicated and
mixed notification suites. Notification preference reads during page bootstrap
are rejected by the test adapter; no notification delivery, phone or GPS test is
performed. The manager suite intercepts every request and uses only synthetic data.

See [Step 5 scope and evidence](../../Parking-Ops/docs/attendance-step5.md) for
session/tenant isolation, correction/audit, pagination, date/DST and CSV coverage.
