# Changelog

Aero Attendance, by AeroOne. Newest first. Dates are 2026. Anything that needs the owner to run SQL
or redeploy an Edge Function says so.

## Unreleased

### Fixed (buttons that did nothing, and a staff rota that never updated)
- **The staff rota never refreshed.** It loaded once at sign-in and again only when the Rota tab was tapped, so a phone left open on Home, or on the Rota tab, or resumed from the background, showed whatever it loaded first. It now refreshes every 30 seconds, the moment the app comes back to the front (which is also what tapping a notification does), and when a page is restored from the back/forward cache. A refresh in the background never blanks the rota or shows an error because the signal dipped.
- **A tap while another action was still running did nothing at all, with no message.** A slow request holds that up for as long as 20 seconds, and during that time every button looked dead. It now says it is still working on the last action.
- **Clear said "Alert cleared" even when the clear had failed**, and that toast hid the real error. It now reports the failure and the reason, and never claims success over one.
- **A timed-out request showed the browser's own wording, "AbortError: signal is aborted without reason".** It now says the database did not answer within 20 seconds, names the request (for example rpc/clock_out_for), and that it may still have gone through. A clock-out that times out is checked against the board before it is reported as failed. The same plain wording is used in the dialogs added this week. OPS-RUNBOOK.md has what to run when the database itself is what is stuck.
- **New check, npm run resilience.** Runs the real timeout and rota-refresh code from the pages against a request that never answers and a connection that drops. Proved by putting the old code back: it fails with the exact wording that was on screen.

### Changed (rota builder, second version)
- **Build the week now edits what is already there.** The first version added shifts only and locked existing ones, so a shift added by mistake could not be taken off again. Now every cell is live: paint a shift over an existing one to change it, paint **Off** to remove it. A published shift that is removed stays on staff phones until the week is published, a draft is simply deleted, exactly as with the single-shift dialog.
- **Faster to paint.** Pick Early, Late, Night or Off once, then tap, or drag across days with the mouse. Tap a **day heading** to paint everybody that day, or a **name** to paint Monday to Friday. **Undo** goes back a step and **Reset** clears the lot. A row at the bottom counts who is on each day, in red where nobody is.
- **Save as draft, or Save and publish in one go.** Nothing is written until you save, and closing with unsaved changes asks first.
- **On a phone** each person is now one short row (it was 173px tall, with the buttons stacked under the name) and each shift's start and finish sit on one line, so the grid is on screen straight away. On touch, a cell is painted only by a real tap, never by scrolling the grid sideways.

### Added (notifications)
- **"Send me a test" under Notifications, and it tests the real path.** Every notification is sent by the database calling the send-push function with no login, and nothing anywhere reported when that failed, for example when a redeploy switched Verify JWT back on and the function started answering 401. The button sends a real test down that same route, reads back what the function answered, and says what it means in a sentence ("turn Verify JWT off", "not deployed at that address", "crashed: check the VAPID keys", "working, but this login has no phone with notifications on"). A test fired from the page itself would pass on the manager's login even when the real route is broken, so it deliberately does not do that. *Needs: setup/update-2026-09-push-check.sql and a redeploy of send-push.*

### Added (this week's requests)
- **Edit profile**, replacing the "Make manager" button on the Staff tab. One dialog for a person's name, access (staff or manager), **job role** and optional personal details: date of birth, mobile number, emergency contact and start date. Job roles (Driver, Valet, Supervisor...) are a list each company keeps and can add to from inside the dialog. A job role is only a label; access is what decides what somebody may do, and is guarded by the database exactly as before.
  - The personal details are in their own table, **not on profiles**, because every colleague can read profiles. Only managers, and the person themselves, can read them. Only one database function writes them, and the audit history records *that* a manager changed somebody's details, never *what* they were.
  - It is one add-on, "Staff profiles", which the owner switches per client on /platform. **The privacy notice is updated and NOTICE_VERSION is 3**, because the app now can hold more personal data, including an emergency contact who is a third party.
  - *Needs: setup/update-2026-09-profiles-alerts-notices.sql.*
- **Build the week.** A grid for the Rota page: people down the side, days across. Pick Early, Late or Night, then tap the days, or "Mon to Fri" for a person. Shifts somebody already has are shown and cannot be painted over. Everything is added as a draft, warns about availability without blocking, and nothing reaches staff until the week is published. "Copy last week" is still there.
- **Clear an alert.** Each flag on the Now board has a Clear button, and there is Clear all. It is shared across the company's managers and written to the audit history. Alerts still clear by themselves the moment the thing they are about is fixed. Clearing is for "I know, and it is fine".
- **Posting a notice now sends a phone notification** to everyone in the company (not the person who posted it). People can switch it off under Notifications. *Needs the same SQL, and a redeploy of send-push.*

### Fixed (this week's requests)
- **The "Needs attention" card disagreed with the list above it** (it said 0 while two things were flagged). It counted only long and off-site shifts; the list also includes people working off the rota. It now counts exactly what is listed.
- **Restoring a backup would have sent phone notifications for every restored shift and notice.** The restore only held off the audit triggers, not the ones that queue notifications. It now holds off every user trigger on the tables it fills, like pg_restore --disable-triggers. The round-trip test now fails if a restore queues any notification.
- **/platform offered add-on switches that did nothing.** Rota, pay and breaks were listed but only ever had the client's own Company settings toggle behind them. They are removed from the list until they are enforced in the database. The list is now notices, handover, overtime and staff profiles.
- **The platform page and the manager board no longer share a login with the staff app** (see below), and Company settings lost its "Name shown in the app" box: the wordmark is always "aero.".
- Backups now include job roles, staff details and cleared alerts.

### Fixed (notifications)
- **Somebody whose shift was taken off the rota was never told.** Publishing only messaged people who still had a shift, so a person whose only change was a removal heard nothing. The database now records exactly who a publish affected, removals included, and sends that list with the message. *Needs: setup/update-2026-09-rota-notify.sql, and a redeploy of the send-push function.* Until it is redeployed the function ignores the list and behaves as before.
- **The manager could not tell who a rota notification could not reach.** A phone notification needs the person to have turned notifications on, on their own phone. After publishing, the Rota page now says how many people on the week can be notified and names the ones who cannot, so it can be sorted in person. OPS-RUNBOOK.md has a checklist for "I published and nobody was told", starting with Verify JWT, which must be off for send-push.

### Fixed (sign-in and settings)
- **Signing in on the manager board also signed the staff page in as the same person.** The pages shared one login. On a shared office computer the next member of staff to open the staff app would clock in as the manager. The board now has its own login; managers sign in to it once.
- **Company settings**: the "Name shown in the app" box is gone and the wordmark is always "aero."; the grey notes and duplicate placeholders are gone.

### Fixed (sign-in was broken)
- **Nobody could sign in to either app.** Both pages load the signed-in person with
  `companies(name)` embedded, and PostgREST works that out from the foreign keys. Adding
  `overtime_decisions` with `primary key (company_id, user_id, week_start)` gave it a primary key
  holding foreign keys to both `profiles` and `companies` — the shape PostgREST reads as a junction
  table. It then saw two routes from a person to their company, refused to guess, and every load
  failed with *"more than one relationship was found"*. Both queries now name the constraint
  (`companies!profiles_company_id_fkey`).
  - **`npm run embeds` is new, and would have caught it.** It reads the real `schema.sql`, works
    out every route between the tables the pages embed, and fails when one is ambiguous — naming
    the table that caused it. Added to the release checks. Neither smoke nor isolation could ever
    have caught this: the test harness is PGlite, and nothing in it is PostgREST.

### Fixed (backups)
- **Five tables were missing from every backup.** `announcements`, `announcement_reads`,
  `overtime_decisions`, `company_features` and `audit_events` all hold a company's data and none of
  them were exported, so a restore would have come back without notices, overtime decisions, add-on
  settings or audit history — and nobody would have found out until they needed it. All five are in
  now. *Needs: a redeploy of the `platform` Edge Function.*
- **A restore would have invented audit history.** Putting shift corrections and rota shifts back
  fires the audit triggers, which wrote fresh entries dated today for things that happened weeks
  ago, on top of the real ones coming out of the backup. The restore now holds those two triggers
  off while the rows go back. An audit trail that makes up its own history is worse than none.

### Added (backups)
- **A restore tool, and proof that it works.** `checks/restore.mjs` turns a backup from `/platform`
  (locked or not) into a `.sql` file to paste into the Supabase SQL editor. It connects to nothing
  and handles no keys, so it cannot touch live data by itself and the SQL can be read before it is
  run. Everything is `on conflict do nothing` and it never deletes.
  `npm run roundtrip` builds a company on the real `schema.sql`, exports it in the backup's own
  shape, runs the real restore tool over it, loads the result into an empty database and compares
  every table row by row — including a locked backup, a wrong passphrase, and running the same
  restore twice. See OPS-RUNBOOK.md.
  - Logins still cannot be restored, and should not be: passwords are not in a backup. The
    `auth.users` rows come back so everything points at a real person, but everyone needs a new
    password set afterwards.

### Added
- **Add-ons: the owner chooses which features each client gets.** A new "Add-ons" button on each
  client in `/platform`. Untick something and it goes from that client's app — the database refuses
  it, not just the button, so it cannot be reached by reopening the browser console. This is kept
  separate from Company settings on purpose: **the owner decides whether a client has a feature at
  all; the client's own manager decides how a feature they do have behaves.** A client can never
  switch on something they were not given.
  Only what is switched OFF is stored, so running the SQL changes nothing for clients already live
  until something is unticked. Unticking hides records, it never deletes them: tick it back and
  everything is there. Currently coverable: rota, pay, breaks, notices, handover, overtime.
  *Needs: `setup/update-2026-09-add-ons.sql`, and a redeploy of the `platform` Edge Function.*

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
- **Overtime approval.** Off by default: nothing changes until a manager sets a weekly threshold
  under Company settings. Any week somebody works more than that is listed on the Review tab to
  approve or reject with a note, and the tab's badge counts those alongside correction requests.
  Staff see their own weeks and where they have got to at the top of their Timesheet. Every
  decision goes into Audit history against the manager who made it.
  The hours are worked out from the shifts each time rather than stored, so a corrected shift can
  never leave a stale figure behind, and `decide_overtime()` recomputes them again at the moment of
  the decision rather than trusting the browser. The decisions table has no insert grant: that
  function is the only way in, so every decision has an author. Weeks start Monday in the company's
  own time zone, so a Sunday night shift falls in the week the people working it would say it does.
  *Needs: `setup/update-2026-09-overtime.sql` (run the audit SQL first).*
  - Overtime has **its own CSV export**, on the Review tab, rather than a column on the timesheet
    export. Overtime is a figure for a whole week; repeating it on every shift row of that week is
    how a payroll run ends up paying it several times over.
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
