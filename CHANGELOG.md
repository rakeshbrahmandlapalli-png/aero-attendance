# Changelog

Aero Attendance, by AeroOne. Newest first. Dates are 2026. Anything that needs the owner to run SQL
or redeploy an Edge Function says so.

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
