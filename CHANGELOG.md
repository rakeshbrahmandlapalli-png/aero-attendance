# Changelog

Aero Attendance, by AeroOne. Newest first. Dates are 2026. Anything that needs the owner to run SQL
or redeploy an Edge Function says so.

## Unreleased

### Fixed
- **A manager clocking somebody out did not close a break they had left running**, so those minutes
  were never taken off the paid hours and the shift was paid for time on break. The board used a
  plain update on `shifts`, which skips `clock_out()`. It now goes through a new `clock_out_for()`
  in the database, which closes the break, counts the minutes, and refuses a shift that is not the
  manager's own company's or is already closed. *Needs:
  `setup/update-2026-09-manager-clock-out.sql` (run the audit SQL first).*
- **The audit SQL had never been folded into `setup/schema.sql`.** A client set up from that file
  alone got no `audit_events` table, so their Audit tab only ever showed an error — and because the
  isolation test runs `schema.sql`, none of its attacks had ever touched the audit history. Both are
  now covered.

### Changed
- **The Now board lists what needs attention by urgency, not by person.** Flags were built one
  member of staff at a time, so whoever sorted first had their minor notice shown above somebody
  else's forgotten clock-out, and every rota flag — including a shift nobody had turned up for —
  landed below the lot. Order is now: a shift past 13 hours, then a rota'd shift running with
  nobody on it, then an off-site clock-in, then a rota'd shift already missed, then someone working
  off-rota, then an unverified location. A count sits at the top when there is more than one, so a
  manager sees how many there are without scrolling.
- **Clocking someone out now asks properly.** Instead of a browser pop-up saying only "Clock out
  <name> now?", a dialog names the person, their worksite, when they clocked in and the time they
  will be clocked out at, and takes an optional reason. Who did it, and why, is recorded in Audit
  history — a shift somebody else ended is pay data, so it has to be attributable.

### Added
- **Handover.** Staff have always written a note when they clock out, and until now only a manager
  ever read it. Home now shows the note the last person left on the worksite you are working, under
  "Left for you". It comes from a new `my_handover()` in the database, which takes no worksite to
  ask about — it uses your own open or most recent shift — and hands back the note, the worksite and
  the time only. Never who wrote it, their hours or where they were. Nothing older than a day, never
  your own note, never another company's. *Needs: `setup/update-2026-09-handover.sql`.*
  - **Privacy notice updated and `NOTICE_VERSION` bumped to 2.** Nothing new is collected, but a
    note written by one person is now shown to another, so "who can see it" changed and everybody is
    asked to read the notice again.
  - The manager's side — handover notes grouped by worksite and day, with a way to mark one
    reviewed — is not built yet.
- **Notices.** A manager posts a short message from the Now tab; everyone in that company sees it
  on Home until they tap "Got it". Dismissing records that the person read it, so the manager sees
  a "seen by" count and can switch a notice off or let it expire after 1, 3 or 7 days. A notice
  stays on screen if the read fails to save, so it is never silently lost. *Needs:
  `setup/update-2026-09-announcements.sql`.*
  - Not yet wired to phone notifications: a notice appears the next time the app is opened. Pushing
    it needs a `send-push` change and a redeploy, so it is a separate job.

## 1.0 (19 September)

The first version sold to a client. What "1.0" means, and what it does not:

- **It means:** everything a small on-site team needs day to day works, each client's data is walled off
  from every other client's by the database (proved by `checks/isolation.mjs`, 250+ attacks), and the
  owner can add, edit, pause, back up and delete clients without touching SQL.
- **It does not mean:** automatic backups (the owner downloads them from `/platform`, and a restore has
  not been rehearsed yet), or a signed data processing agreement (each client needs one before pay is on).

### Added
- **Platform page (`/platform`)** for the owner only: add a client in one form, edit it, pause and resume
  it, add another manager, reset the owner's password, back up one client or all of them (optionally
  locked with a passphrase), and delete a client for good (exact name typed; refused if it would delete
  your own login). Server-side check against `platform_admins`. *Needs: clients-and-settings SQL,
  pause-client SQL, `platform` Edge Function.*
- **Per-company settings** (Company settings, any manager): time zone, currency, and the name shown in
  the app. Notification times use the company's time zone. *Needs: clients-and-settings SQL; redeploy
  `send-push`.*
- **Pause a client.** A paused company sees nothing and can do nothing; nothing is deleted. *Needs:
  pause-client SQL.*
- **Change a person's role** (Staff / Manager) on the Staff tab. *Needs: roles SQL.*
- Version label on both sign-in screens and under Account.

### Changed
- The privacy notice no longer pops up at first sign-in. It stays under Account, and opening it records
  that the person read it.

### Fixed
- **Company settings could not be saved** once the breaks and privacy updates had been run: managers
  were never allowed to change the columns those updates added. One grant now lists every column.
- **A manager could make themselves the owner, demote the owner or switch the owner off** by writing to
  their own company's profiles from the browser. The database now refuses it (`profiles_guard`).
- A shift could point at another company's worksite or person (no data leaked). Closed.

## 0.9 (September)
- Password reset by the manager, breaks, the privacy notice, the satellite clock-in map, error and
  offline states, on-site-only clock-in, phone notifications, the rota and availability, staff accounts
  added and removed by managers, corrections, estimated pay, two home-screen apps (staff and manager),
  and the sales demo at `/demo`.
