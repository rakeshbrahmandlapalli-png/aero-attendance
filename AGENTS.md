# Aero Attendance — instructions for AI coding assistants

Read this whole file before changing anything. It applies to every assistant
working here (ChatGPT/Codex, Claude, or anything else). More than one AI edits
this repo, so the rules below are what keeps the work from drifting.

## What this is

A staff attendance app sold to several client companies (the first two are
247 Airport Parking and A-Z). Staff clock in and out on their phone. Managers
see who is on shift, exceptions, timesheets, staff and worksites.

- Live: https://aero-attendance.vercel.app (manager board at `/admin.html`)
- Two home-screen apps from the same files: **Aero** (staff, `manifest.webmanifest`,
  navy icon) at `/`, and **Aero Manager** (`manager.webmanifest`, orange icon) at
  `/manager` (a rewrite of admin.html). Each page must keep its own manifest,
  or the manager icon opens the staff app.
- Sales demo: https://aero-attendance.vercel.app/demo (manager: `/demo/admin`).
  Same files; `/demo` or `?demo` forces demo mode (rewrites in `vercel.json`).
  Demo data must use made-up names only — never a real client's company name.
- Hosting: Vercel, auto-deploys from `main`
- Database and login: Supabase, **EU region** (owner, 19 Sep 2026; the privacy notice says so, so tell the owner before ever moving it)

## Files

```
index.html            staff app: sign in, clock in/out, site map, shift history
admin.html            manager board: on shift now, stats, flags, timesheets, CSV, staff, sites
setup/schema.sql      the whole database: tables, row-level security, clock_in/clock_out
setup/update-2026-09-rota-and-staff.sql  the September update on its own (already inside schema.sql)
setup/update-2026-09-breaks.sql  breaks: start/end break, minutes off paid hours (already inside schema.sql)
setup/update-2026-09-privacy-notice.sql  privacy notice fields and the read-record (already inside schema.sql)
setup/update-2026-09-tenant-integrity.sql  a shift may only point at its own company's people and sites (already inside schema.sql)
checks/isolation.mjs  tenant isolation test: runs the REAL schema.sql in PostgreSQL (PGlite) and attacks it as two companies
checks/harness.mjs    the Supabase stand-in the test runs on (roles, auth.uid(), no-op cron/net)
checks/payroll.mjs     the pay maths, to the penny (real code extracted from admin.html, checked against sums worked out by hand)
checks/resilience.mjs  what the pages do when the network drops or a request never answers (real code, extracted from the pages)
checks/embeds.mjs     can PostgREST still work out every embedded table? (a new table's primary key can silently break sign-in)
checks/restore.mjs    turns a backup from /platform back into SQL to paste into Supabase (no keys, connects to nothing)
checks/roundtrip.mjs  proves it: builds a company on the real schema, backs it up, restores it into an empty one, compares row by row
supabase/functions/manage-staff/index.ts  Edge Function: add staff logins, remove/restore leavers
supabase/functions/send-push/index.ts  Edge Function: phone notifications (web push)
supabase/functions/platform/index.ts  Edge Function: the owner's "Add a client" (platform admins only)
platform.html         the owner's own page at /platform: client list and one form to add a client
CHANGELOG.md          what changed and when; add an entry with every release
setup/update-2026-09-pause-client.sql  companies.suspended, current_company_id()/is_manager() honour it, my_company_paused() (already inside schema.sql)
setup/update-2026-09-roles.sql  profiles_guard: who may change whose role (already inside schema.sql)
setup/update-2026-09-announcements.sql  announcements and who has read them (already inside schema.sql)
setup/update-2026-09-audit.sql  audit_events and the triggers that fill it (already inside schema.sql)
setup/update-2026-09-manager-clock-out.sql  clock_out_for(): a manager closing a forgotten shift (already inside schema.sql)
setup/update-2026-09-handover.sql  my_handover(): the note the last person left on your worksite (already inside schema.sql)
setup/update-2026-09-overtime.sql  overtime threshold, overtime_weeks(), decide_overtime() (already inside schema.sql)
setup/update-2026-09-add-ons.sql  company_features + has_feature(): which add-ons a client has been given (already inside schema.sql)
setup/update-2026-09-rota-notify.sql  publish_rota() records who a publish affected (removals too); rota_reach() (already inside schema.sql)
setup/update-2026-09-profiles-alerts-notices.sql  job_roles, staff_details (private), dismiss_alert(), notice push (already inside schema.sql)
setup/update-2026-09-push-check.sql  push_check() / push_check_result(): a real test down the database-to-send-push route (already inside schema.sql)
setup/update-2026-09-clients-and-settings.sql  platform_admins, per-company time zone / currency / brand name, and the manager column grants (already inside schema.sql)
setup/update-2026-09-notifications.sql  the notifications update on its own (already inside schema.sql)
sw.js                 service worker: offline page, and showing push notifications
setup/SETUP-GUIDE.txt  step-by-step Supabase setup for the owner
.vercelignore         keeps setup/, supabase/ and .env* OFF the public website — do not remove
```

There is no build step, no framework and no package.json in the app. Each HTML
file holds its own CSS and JavaScript. (`checks/` is the one exception: a
developer-only folder with its own package.json, kept out of the site by
`.vercelignore`. The app never depends on it.) The only external script is supabase-js from a CDN.

## Rules that must not be broken

1. **Do not rewrite into a framework or start a parallel copy.** No Next.js,
   React, Vite or new folders holding "a new version". Improve these files.
   A separate Next.js prototype was built once and thrown away for this reason.
   **One deliberate exception: `platform.html`.** It is the owner's own tool
   (add a client), not another version of the staff or manager app, so it has
   its own file, no manifest and `noindex`. It must never grow staff or
   manager features, and nothing in it is a security boundary: the `platform`
   Edge Function checks `platform_admins` on the server on every call.
2. **One app for every client (multi-tenant).** Every row belongs to a
   `company_id`. A new client is a new row in `companies`, never a copied app
   or a second deployment. Never hardcode a company name outside demo data.
   **⚠️ Careful with a composite primary key that contains two foreign keys.**
   PostgREST reads a table whose primary key holds FKs to two other tables as a
   *junction*, and infers a many-to-many between them. On 19 Sep 2026
   `overtime_decisions` was added with `primary key (company_id, user_id,
   week_start)`. PostgREST then saw two ways to get from `profiles` to
   `companies` — the direct `company_id`, and that inferred many-to-many — and
   refused to guess, so `companies(name)` stopped resolving and **nobody could
   sign in to either app**. Neither the isolation test nor smoke caught it,
   because the harness is PGlite and nothing in it is PostgREST.
   Both pages now name the constraint: `companies!profiles_company_id_fkey(name)`.
   **Run `cd checks && npm run embeds` after adding any table.** It reads the
   real schema, works out every route between the tables the pages embed, and
   fails when one is ambiguous.
   **Personal details never go on `profiles`.** Every colleague can read profiles (the app shows names), so a
   date of birth or phone number there would be readable by the whole team. `staff_details` is its own table:
   managers and the person themselves only, written only by `save_staff_details()`, which audits THAT it
   changed and never WHAT it held.
3. **Security lives in the database, not the browser.** Row-level security
   decides who sees what. The distance-from-site check runs inside the
   `clock_in()` / `clock_out()` Postgres functions, so editing the page's
   JavaScript cannot fake being on site. Never move that check into the page.
4. **Keep `current_company_id()` and `is_manager()` as `security definer`.**
   They look "simplifiable". They are not: removing `security definer` makes
   the policies on `profiles` query `profiles` and recurse forever.
5. **Clock-in on site only, clock-out never blocked.** Owner's decision, 17
   Sep 2026. When a company has `require_on_site` on (the default),
   `clock_in()` refuses a clock-in with no location or outside the zone
   (radius plus up to 50m of the accuracy the phone reports). Clock-out is
   never blocked: it is recorded and flagged, because blocking someone who
   has already driven off turns into a pay dispute. With `require_on_site`
   off, clock-in is flagged instead of blocked, as before. The check lives
   only in the database.
6. **Location is recorded at clock-in and clock-out only.** Never track staff
   in between. The app is sold on exactly that promise.
7. **`clock_in()` must stay idempotent.** A double tap returns the open shift
   instead of opening a second one.
8. **Show the real error.** Display Supabase's error message as it is. Never
   replace it with a vague "not allowed".
   Errors go through `fail()`: a lost sign-in returns to the sign-in screen,
   a timeout or dropped connection gets plain words (every request gives up
   after 20s via `timedFetch`), and anything else shows the real message.
   A clock-in or clock-out that times out is checked against the database
   (`confirmClock`) before staff are told whether it worked.
9. **Demo mode must keep working.** With `APP_CONFIG.url` / `.key` empty,
   both pages run on sample data in memory with no network calls. Every new
   feature needs a demo-mode path too. Clients are sent the demo link.
10. **No map library.** The map is plain Web Mercator maths over image tiles.
    Do not add Leaflet, Google Maps or Mapbox. No icon library either: icons
    are small inline SVGs in the page (`icon()` helper).
    Tiles: the clock screen uses **MapTiler satellite** (`MAP_KEY` in
    index.html, done 18 Sep 2026). That key is public by design: it is
    restricted to `aero-attendance.vercel.app`, `*.vercel.app` and `localhost`
    in the MapTiler dashboard, so it belongs in the page. Every tile falls back
    to OpenStreetMap if MapTiler fails, so a quota problem never leaves a blank
    map. Keep both attributions. **Test on `localhost`, not `127.0.0.1`**: the
    key's origin list does not include 127.0.0.1 and the tiles read
    "Invalid key". CARTO's basemaps now need a key too; do not switch to them.
12. **Run the tenant isolation test after ANY change to `setup/schema.sql`, a
    policy, a view or a database function, and it must stay green:**
    `cd checks && npm install && npm run isolation`. It signs in as every kind
    of user in two companies and tries to read or change the other company's
    data, promote itself, abuse functions with the other company's ids, and
    reach anything signed out or removed. Add an attack for every new table or
    function. It proves the row-level-security policies and functions on the
    real SQL; it does NOT prove Supabase's own login, PostgREST or Edge
    Functions. Every new table needs `company_id`, a policy scoped to
    `current_company_id()`, and a line in `TABLES` in the test. To prove a
    check can fail, run the test on a deliberately broken copy of the schema:
    `SCHEMA_FILE=path/to/broken.sql node isolation.mjs`.
11. **The privacy notice must stay true.** `noticeHtml()` in index.html is what
    every member of staff can open under Account. It never pops up by itself (owner's decision, 19 Sep 2026); opening it records that they read it, for the manager's Staff tab. It is the
    employer's notice to its staff (the company is the controller; this app and
    AeroOne are the processor), built from what the app really does and from
    `companies.privacy_contact` / `retention_text`. If a change collects, shows
    or shares any new personal data, or adds any third-party service or script,
    update that text in the same commit and bump `NOTICE_VERSION` if the meaning
    changed, so everybody is asked to read it again. There is no analytics or
    tracking in these pages: do not add any without changing the notice and
    telling the owner first. Never make the notice block clocking in.

## Secrets

- The only key allowed in these files is the Supabase **publishable** key
  (`sb_publishable_...`, or the legacy anon key). It is safe in the browser
  because row-level security limits what it can do.
- **Never** put the Supabase secret key (`sb_secret_...`), the service_role
  key, the database password or any login password in any file, commit or
  chat message.
- Never commit `.env*` or `.vercel/`. They are in `.gitignore`.
- When filling data into HTML, pass it through the existing `esc()` helper.
- CSV cells go through the existing `cell()` helper, which blocks spreadsheet
  formula injection. Keep that.

## Design

Phone-first quiet premium. Design at 390 x 844, check 360 and 430px, then
adapt to tablet and desktop. The staff app stays a single 560px column.

Staff app structure — keep it:
- **Home**: greeting, a today card (status, running time while on shift, the
  Clock in/out button), and a Mon–Sun hours bar chart with the week total.
  The chart's bars are buttons: tapping a day shows that day's shifts below.
- **Timesheet** tab: one calendar month at a time (arrows for earlier
  months), totals for hours, shifts and days worked, estimated pay when the
  company has it on, and every shift (tap one to request a correction).
  Activity and Account are the other bottom tabs.
- **Rota** (optional, only when `companies.use_rota` is on): Home gets a
  "Next shift" section under the navy block, and a Rota tab appears after
  Home with the person's published shifts, their usual week (Available /
  Available between / Not available per weekday) and their days off.
- **Clock screen**: a separate full-screen view opened from Home. Full map
  with back button and today's hours, position against the site zone, and a
  bottom sheet with the worksite (picked automatically from GPS: the site
  you're inside, or the nearest; a "Change" link stays for when GPS is off
  or wrong), or the shift note when clocking out, the clock action and the
  location notice. The phone's back button closes it. Live position is only
  watched while this screen is open.
- Estimated pay is optional and off by default for each company
  (`companies.show_pay`). Hourly rates live in `pay_rates`, never on
  `profiles` (colleagues can read profiles). Staff read their own rate only
  when pay is on; managers set rates on the Staff tab and switch pay on in
  Company settings. Estimate = completed hours × rate, always labelled as an
  estimate, not a payslip. Pages must keep working if the pay SQL hasn't
  been run: treat a failed pay query as "pay off".

- **Own identity, not Connecteam's.** The owner rejected a look that copied
  Connecteam (bright blue, round clock button, white blocks on grey). Never
  bring back blue as the brand colour or a round tap-to-clock button.
- Aero palette: deep navy `#0E1420` (ink, header, Home today block, Clock
  screen sheet), raised navy `#1A2233`, navy hairline `#2A3447`, secondary
  text on navy `#AEB7C4`. Aero orange `#E8871E` is the brand: fills with navy
  text, the tab indicator, the site zone. Orange text on light surfaces uses
  `#9A5200`. White surfaces, secondary text `#4A5363`, neutral surface
  `#F3F5F8`. Attention red `#B42318` on `#FEF1F0` (never orange: orange is
  the brand). Success green `#0F7B4A`.
- Verified WCAG text contrast: ink on white 18.43:1, secondary on white
  7.75:1 (7.10:1 on the neutral surface), navy on orange 6.95:1, orange text
  on white 5.86:1, white on navy-2 15.90:1, `#AEB7C4` on navy 9.10:1, red on
  its attention surface 5.97:1, white on green 5.31:1. Recalculate after
  palette changes.
- The phone's own font (system-ui stack: San Francisco on Apple, Roboto on
  Android, Segoe UI on Windows). No web fonts. Weights 400/500/600 only. Six sizes: 14/16/20/24/32/48px,
  defined as `--t1` through `--t6`. Headings use 1.2 line-height, body 1.5.
  Use zero letter-spacing, sentence case, and tabular changing numbers.
- Spacing: 4/8/12/16/24/32/48px, via `--s*` tokens. Component dimensions,
  map coordinates, hairlines and safe-area offsets are not spacing tokens.
- One white surface level, open sections separated by space or hairlines.
  No nested panels, coloured pill badges, gradients or drop shadows.
  Corners at most 8px. Exception: circular location/status dots.
- Home opens with one navy block (header + today status + orange Clock in
  button); the other staff app sections are white blocks with 8px gaps,
  never cards inside cards. Keep it light: section titles 16px, weight 600 only
  for section titles and the running timer; everything else 400-500.
- Few words on Home: no helper sentences. A shift row is tappable (chevron)
  and opens the correction request; don't add a link under every shift.
- Week chart: pale grey bars, today in navy, faint day guides and a dashed
  8-hour reference line so empty days still read as a chart.
- The Clock screen's action is **slide to confirm**: a 64px navy track with a
  square handle (orange to clock in, white to clock out). A tap only nudges
  the handle, so a phone in a pocket can't clock anyone in; dragging to the
  end clocks. Keyboard users press the handle (click with `detail === 0`).
  Spinner in the handle while locating, the track turns green with a tick on
  success, and a zone line sits under it (inside / metres away, still allowed
  and flagged / no fix). Today's hours sit at the top of the navy sheet, not
  in a pill over the map.
- Controls at least 44px high (Apple's minimum); Home clock button 56px; bottom
  tabs 56px (selected: navy text + short orange bar). Inputs use 16px text so iOS does not zoom.
  Checkbox labels provide the full touch target. No hover-only controls.
  Every control has a visible focus ring.
- Under 768px, manager table records stack into labelled two-column rows.
  Names and notes get full width; time values stay together. Retain real
  tables above that breakpoint and in print. Keep mobile labels in CSS in
  sync with the table headings and preserve table semantics in markup.
- Empty states use readable text and open spacing; errors use attention
  colour and a left rule; busy controls keep legible text and stable size.
- Transitions: 160ms colour changes and handle snap-back, a 120ms press scale
  on the Home clock button, the tap nudge and the busy spinner. Reduced motion turns all of them off.
- British English throughout. Preserve existing attendance, demo, security
  and database behaviour. Do not add fonts, libraries or asset downloads.
- Before committing, run both script parse checks and click through staff
  and manager demos at phone width. Check 360/390/430px and desktop for
  overflow, all navigation, forms, dialog errors, and the Clock screen.
  Calculate WCAG contrast ratios for text/background pairs.

## Clients and per-company settings

- **Adding a client is `/platform` only** (platform.html + the `platform` Edge
  Function). It creates the company, the first manager's login
  (`must_change_password`) and a profile with role `owner`, in that order, and
  undoes each step if a later one fails. Do not go back to pasting company ids
  into SQL: a wrong id puts staff in the wrong company.
- **Pause.** `/platform` pauses a client: `companies.suspended` is set by the
  platform function only (it is NOT in the manager grant, and the isolation test
  checks a client cannot pause or un-pause itself). `current_company_id()` and
  `is_manager()` return nothing for a paused company, so every policy and function
  goes dark at once; `my_company_paused()` lets the pages say "paused" instead of
  "not attached to a company". Nothing is deleted. Rota reminders from send-push
  can still fire for a paused company's published shifts; that is known and minor.
- **Backups.** `/platform` downloads one client's data, or all clients', as JSON
  (the `backup` action pages through every table 1,000 rows at a time and adds
  emails from the login system). It can be locked with a passphrase in the browser
  (AES-256-GCM, PBKDF2-SHA256 600,000 rounds); the same page unlocks it. Passwords
  and phone push keys are not in it. It is a COPY, not a restore: no restore tool
  exists and none has been rehearsed. Say so plainly to anyone who asks. Every new
  table with client data must be added to `TABLES` in the `backup` action.
- **Managers on /platform.** Add another manager (role `admin`) or reset the owner's
  password (they must choose their own at next sign-in).
- **Version.** `Aero Attendance v1.0 · by AeroOne` on both sign-in screens and
  under Account. Keep it in step with CHANGELOG.md.
- **Edit and Delete on /platform.** Edit changes name, brand name, time zone and
  currency. Delete is permanent: the `platform` function requires the exact
  company name typed (checked on the server, not just in the page), refuses if
  the caller or any other platform admin belongs to that company, removes the
  company in one statement (the database cascades to every table, and the
  isolation test proves it leaves nothing behind), then removes the logins.
  Every new table needs `on delete cascade` to `companies`, or Delete breaks.
  There is no undo and no backup; do not add a "soft delete" without asking.
- `platform_admins(user_id)` has row-level security on and NO policy, and
  `anon` / `authenticated` have no privileges on it, so only the service key
  (the Edge Function) can read it. Never add a policy or grant on it. The
  isolation test attacks it; it must stay unreachable from the app.
- The owner becomes a platform admin by one-time SQL (SETUP-GUIDE.txt), never
  from the app.
- Per company, in Company settings (any manager): `companies.time_zone`
  (default Europe/London: used by `send-push` for the times in notifications;
  the pages themselves show the device's own zone), `currency` (default GBP:
  `money()` in both pages uses it; changing it converts nothing) and
  `brand_name` (blank = "Aero Attendance": the privacy notice, the tab title
  and the manager board's wordmark). No accent colour per company and no
  home-screen icon or name per company: both would need a per-client address.
- **Every column a manager may change is listed in ONE grant** at the bottom
  of schema.sql (`grant update (...) on table companies`). Adding a settings
  column without adding it to that grant makes the whole Company settings
  Save fail with "permission denied": that happened once (breaks and privacy
  notice, found 19 Sep). The isolation test saves every column, so it fails.
- Pages read each new setting with its own small query and fall back to the
  default if it fails, so they keep working before the SQL is run.

## Staff accounts

- Managers add staff on the Staff tab: name, email, role (Staff or Manager)
  and a starting password they pass on in person. The login is flagged
  `must_change_password`, and both pages ask for a new password on first
  sign-in. No emails are sent.
- Logins are created, blocked and unblocked ONLY by the `manage-staff` Edge
  Function (source in supabase/functions/manage-staff; deployed in Supabase
  at the address `swift-responder`, see STAFF_FUNCTION in admin.html), which checks the caller is an active owner/admin of the same
  company and uses the service key Supabase gives it. Never create users or
  put the service key in the browser.
- **Roles.** Managers change a person between Staff and Manager on the Staff tab
  ("Make manager" / "Make staff"), straight from the page. The rules are in the
  database (`profiles_guard`, a trigger on profiles), not the page: nobody's role
  can be changed to or from `owner` from the app, nobody can change their own
  role, and nobody can remove or restore themselves or the owner. Before this
  trigger an admin could crown themselves owner from the browser console. The
  service key is exempt (it has no signed-in user); manage-staff has its own checks.
- "Remove" never deletes: it bans the login and sets `profiles.active = false`.
  Their shifts stay for payroll and UK record-keeping. `current_company_id()`
  returns null for inactive people, so an open session shows nothing.
  Nobody can remove themselves or the owner from the app.

## Phone notifications

Web push to the home-screen app (no app stores, by the owner's choice).
Android Chrome works directly; iPhone only when opened from the Home Screen
(iOS 16.4+), and the permission prompt must come straight from a tap.

- A person taps Turn on notifications (staff: Account tab; managers: the
  Notifications button). The subscription is saved with
  `save_push_subscription()`; signing out removes this device's one.
- `notification_prefs` holds per-person choices; no row means everything on.
  Managers: clock in, clock out, away from site, corrections, late/no-show
  (rota only), 13-hour shifts. Staff: correction decisions, rota published,
  reminder an hour before a shift (rota only).
- Triggers on `shifts` and `shift_corrections`, `publish_rota()`, and a
  pg_cron job every 5 minutes call `push_event()`, which posts {type, id} to
  the send-push function through pg_net. The function re-reads the records
  with the service key and claims a `push_log` key before sending, so every
  notification goes out at most once and the call needs no secret. Keep it
  that way: never trust anything else in the message.
- `push_event()` never raises. A notification must never block a clock-in.
- VAPID_PUBLIC_KEY is in both pages; VAPID_PRIVATE_KEY exists only as a
  Supabase Edge Function secret. The function address lives in `push_config`.

## Rota & availability

Optional for each company, off by default (`companies.use_rota`, switched in
Company settings). Pages treat a failed `use_rota` query as "rota off", so
they keep working before the rota SQL has been run.

- Staff keep a usual week (`availability`, one row per weekday, 0 = Monday)
  and book days off (`time_off`). They write only their own rows; managers
  read them while planning.
- Managers draft shifts in `rota_shifts` (starts_at, ends_at, worksite_id,
  note). **Staff only see the published copy** (`published_*` columns), which
  `publish_rota(from, to)` copies across for one week. Never let staff read
  drafts. Deleting a published shift sets `removed`, so staff keep seeing it
  until the next publish; a never-published draft is deleted outright.
- The manager's Rota tab: week arrows, Mon–Sun day tabs, every active person
  with that day's availability and shifts (Draft / Changed / Published /
  Removed), Add shift, Copy last week (as drafts), Publish week. Availability,
  days off and overlaps are warnings in the shift dialog, never blocks.
- A finish time earlier than the start means the shift ends the next day.
  Shifts are at most 16 hours.
- Now flags, from published shifts only: not clocked in 10+ minutes after the
  start, no clock-in for a shift that has ended (for 12 hours afterwards), and
  anyone on shift with no rota'd shift around their clock-in (from 2 hours
  before the start to the finish).
- Clock-in itself is unchanged by the rota: nobody is ever blocked from
  clocking in because they are not on it.

## Not in version 1 — do not add without the owner asking

QR-code clock-in, continuous location tracking, payroll (tax, breaks,
holiday pay, overtime). Pay is an estimate only.

## Working in this repo

- Pull the latest `main` before you start. Another AI may have changed things.
- Keep changes small, one purpose per commit, and say *why* in the message.
- Before committing, check the JavaScript still parses:
  `node -e "const h=require('fs').readFileSync('admin.html','utf8');[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach(m=>new Function(m[1]))"`
  (repeat for `index.html`), then open both pages in demo mode and click the
  thing you changed.
- A push to `main` goes live on Vercel within a minute. Do not push anything
  you have not tried in demo mode.
- Database changes go into `setup/schema.sql` and must be safe to run on a
  database that already has data (`if not exists`, `create or replace`). Tell
  the owner plainly that he has to run the new SQL in Supabase.
- The owner is not a developer. When he has to do something (Supabase,
  Vercel, GitHub), give him numbered steps saying exactly which button to click.
