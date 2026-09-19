# Operations runbook

## Backups

Platform owners should create an encrypted full backup at least weekly and after major staff or settings changes. Store the downloaded file and passphrase separately. The Platform page warns when the last full backup is older than seven days.

## Restoring one

A backup nobody has restored is not a backup, it is a file. `npm run roundtrip`
proves the current code can take a backup and put it back; do a real one against
a scratch Supabase project at least once a quarter, and after any change to the
tables.

    cd checks
    node restore.mjs ~/Downloads/backup.json                       # what is in it
    node restore.mjs ~/Downloads/backup.json --passphrase "..." --out restore.sql

It writes a `.sql` file and connects to nothing, so nothing can go wrong by
accident: read the SQL, then paste it into the Supabase SQL editor of the
project you want it in. Run `setup/schema.sql` in that project first. Everything
is `on conflict do nothing` and it never deletes, so running it twice is safe.

**Logins are not in a backup**, and should not be: passwords are not ours to
export. The rows in `auth.users` are recreated so profiles, shifts and audit
entries still point at a real person, but everyone needs a new password before
they can sign in — Managers → Reset owner password on `/platform` for the owner,
and the manage-staff function for everybody else.

**Restoring does not rewrite history.** The audit triggers are held off while the
rows go back, so a restore cannot invent audit entries dated today for things
that happened weeks ago.

**Every new company-scoped table must be added to `TABLES` in the backup action
of `supabase/functions/platform/index.ts`,** or it is silently missing from
every backup taken afterwards and nobody finds out until they need it.
`npm run roundtrip` fails if a table in the backup has no rows, which is the
cheapest way to notice.

## Notifications

The send-push function retries transient push errors twice with short backoff. Expired subscriptions (404/410) are removed automatically. Check Edge Function logs for repeated failures and confirm VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are present.

## Release checks

Run from the checks folder:

    npm run smoke
    npm run embeds
    npm run isolation
    npm run roundtrip

The app should not be promoted until all four pass and the phone checklist is complete.
