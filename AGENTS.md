# Aero Attendance — instructions for AI coding assistants

Read this whole file before changing anything. It applies to every assistant
working here (ChatGPT/Codex, Claude, or anything else). More than one AI edits
this repo, so the rules below are what keeps the work from drifting.

## What this is

A staff attendance app sold to several client companies (the first two are
247 Airport Parking and A-Z). Staff clock in and out on their phone. Managers
see who is on shift, exceptions, timesheets, staff and worksites.

- Live: https://aero-attendance.vercel.app (manager board at `/admin.html`)
- Sales demo: https://aero-attendance.vercel.app/demo (manager: `/demo/admin`).
  Same files; `/demo` or `?demo` forces demo mode (rewrites in `vercel.json`).
  Demo data must use made-up names only — never a real client's company name.
- Hosting: Vercel, auto-deploys from `main`
- Database and login: Supabase

## Files

```
index.html            staff app: sign in, clock in/out, site map, shift history
admin.html            manager board: on shift now, stats, flags, timesheets, CSV, staff, sites
setup/schema.sql      the whole database: tables, row-level security, clock_in/clock_out
setup/update-2026-09-rota-and-staff.sql  the September update on its own (already inside schema.sql)
supabase/functions/manage-staff/index.ts  Edge Function: add staff logins, remove/restore leavers
supabase/functions/send-push/index.ts  Edge Function: phone notifications (web push)
setup/update-2026-09-notifications.sql  the notifications update on its own (already inside schema.sql)
sw.js                 service worker: offline page, and showing push notifications
setup/SETUP-GUIDE.txt  step-by-step Supabase setup for the owner
.vercelignore         keeps setup/, supabase/ and .env* OFF the public website — do not remove
```

There is no build step, no framework and no package.json. Each HTML file holds
its own CSS and JavaScript. The only external script is supabase-js from a CDN.

## Rules that must not be broken

1. **Do not rewrite into a framework or start a parallel copy.** No Next.js,
   React, Vite or new folders holding "a new version". Improve these files.
   A separate Next.js prototype was built once and thrown away for this reason.
2. **One app for every client (multi-tenant).** Every row belongs to a
   `company_id`. A new client is a new row in `companies`, never a copied app
   or a second deployment. Never hardcode a company name outside demo data.
3. **Security lives in the database, not the browser.** Row-level security
   decides who sees what. The distance-from-site check runs inside the
   `clock_in()` / `clock_out()` Postgres functions, so editing the page's
   JavaScript cannot fake being on site. Never move that check into the page.
4. **Keep `current_company_id()` and `is_manager()` as `security definer`.**
   They look "simplifiable". They are not: removing `security definer` makes
   the policies on `profiles` query `profiles` and recurse forever.
5. **A failed GPS reading never blocks a clock-in or clock-out.** It is saved
   as unverified and flagged for the manager. Blocking someone who has already
   driven off turns into a pay dispute.
6. **Location is recorded at clock-in and clock-out only.** Never track staff
   in between. The app is sold on exactly that promise.
7. **`clock_in()` must stay idempotent.** A double tap returns the open shift
   instead of opening a second one.
8. **Show the real error.** Display Supabase's error message as it is. Never
   replace it with a vague "not allowed".
9. **Demo mode must keep working.** With `APP_CONFIG.url` / `.key` empty,
   both pages run on sample data in memory with no network calls. Every new
   feature needs a demo-mode path too. Clients are sent the demo link.
10. **No map library.** The map is plain Web Mercator maths over image tiles.
    Do not add Leaflet, Google Maps or Mapbox. (OpenStreetMap's free tiles must
    be swapped for MapTiler or Stadia before real clients use it.) No icon
    library either: icons are small inline SVGs in the page (`icon()` helper).

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
