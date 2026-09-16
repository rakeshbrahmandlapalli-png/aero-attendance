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
setup/SETUP-GUIDE.txt  step-by-step Supabase setup for the owner
.vercelignore         keeps setup/ and .env* OFF the public website — do not remove
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
adapt to tablet and desktop. Keep the staff clock action in a fixed bottom
dock above the safe-area-aware navigation; make it static from 768px upwards.

- White surfaces, graphite header/ink `#171C24`, secondary text `#475467`,
  neutral surface `#F1F4F8`. Working cobalt `#1456C0`; attention amber `#805000` on
  `#FFF3D9`. Colour indicates state, not decoration. Neutral initials.
- Verified WCAG text contrast: ink on white 17.10:1, secondary on white
  7.69:1 (6.97:1 on the neutral surface), white on cobalt 6.73:1,
  amber on its attention surface 6.22:1. Recalculate after palette changes.
- Instrument Sans, weights 400/500/600 only. Six sizes: 14/16/20/24/32/48px,
  defined as `--t1` through `--t6`. Headings use 1.2 line-height, body 1.5.
  Use zero letter-spacing, sentence case, and tabular changing numbers.
- Spacing: 4/8/12/16/24/32/48px, via `--s*` tokens. Component dimensions,
  map coordinates, hairlines and safe-area offsets are not spacing tokens.
- One white surface level, open sections separated by space or hairlines.
  No nested panels, coloured pill badges, gradients or drop shadows.
  Corners at most 8px; circular location/status dots are the exception.
- Controls at least 48px high; clock action 64px. Inputs at least 16px.
  Checkbox labels provide the full touch target. No hover-only controls.
  Every control has a visible focus ring.
- Under 768px, manager table records stack into labelled two-column rows.
  Names and notes get full width; time values stay together. Retain real
  tables above that breakpoint and in print. Keep mobile labels in CSS in
  sync with the table headings and preserve table semantics in markup.
- Empty states use readable text and open spacing; errors use attention
  colour and a left rule; busy controls keep legible text and stable size.
- Transitions are 160ms colour changes only; honour reduced motion.
- British English throughout. Preserve existing attendance, demo, security
  and database behaviour. Do not add fonts, libraries or asset downloads.
- Before committing, run both script parse checks and click through staff
  and manager demos at phone width. Check 360/390/430px and desktop for
  overflow, all navigation, forms, dialog errors, and the clock dock.
  Calculate WCAG contrast ratios for text/background pairs.

## Not in version 1 — do not add without the owner asking

Estimated pay or wages, QR-code clock-in, continuous location tracking.

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
