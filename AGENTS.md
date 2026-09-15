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
    be swapped for MapTiler or Stadia before real clients use it.)

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

It must look like a serious tool a company pays for, not an AI template.

- Light theme. Use the CSS variables already in `:root`: accent `#0A6E4E`,
  warning `#9A5B0A`. No bright default colours such as `#10B981` or `#EF4444`.
- Hairline 1px borders. **No drop shadows** and no gradients.
- Font: Instrument Sans, not Inter. Slightly tight letter-spacing on headings.
- Every number that changes gets `font-variant-numeric: tabular-nums` (`.num`).
- Status = a 6px dot plus text. Never coloured pill badges.
- Green button to start a shift, near-black to end it. Never red for ending.
- Table cells never wrap. Narrow screens scroll the table sideways instead.
- British English in all text ("Clock in", "colour", dates as dd/mm/yyyy).

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
