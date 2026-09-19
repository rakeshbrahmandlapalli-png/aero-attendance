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

### A button does nothing, or an action says the database "did not answer within 20 seconds"

The message now names the request, for example `rpc/clock_out_for`. Two different things look alike:

- **Reads work but one write hangs.** Something in the database is holding a lock, most often a
  transaction left open, for example from the SQL editor. Run this in the Supabase SQL editor
  while it is hanging:

      select pid, state, wait_event_type, wait_event,
             now() - xact_start as open_for, left(query, 100) as query
        from pg_stat_activity
       where datname = current_database() and pid <> pg_backend_pid()
         and (state <> 'idle' or xact_start is not null)
       order by xact_start;

  A row that says `idle in transaction` and has been open for minutes is the culprit. Close it
  with `select pg_terminate_backend(<its pid>);`. Then retry.
- **Everything is slow.** That is the connection, not the database: try another network, and turn
  off any VPN or browser proxy.

A timed-out clock-out is checked against the board before it is reported as failed, because a slow
answer is not a failed clock-out. A tap made while another action is still running now says so
instead of being ignored.

### Posted a notice and nobody was told

Same path and the same first check as the rota below: Verify JWT must be off for send-push, and the person has to have turned notifications on. A notice more than 10 minutes old is never sent, on purpose, so a restore cannot push old notices to phones.

### Published a rota and nobody was told

**Start with the button.** On the manager board, Notifications, **Send me a test**. It sends a real test down the same route a publish uses and tells you in a sentence what is wrong. Everything below is what it is checking.

Check in this order. The first two cause almost every case.

1. **Verify JWT must be OFF for send-push.** The database calls it with no login, so with Verify JWT on, Supabase answers 401 and the notification is dropped without a word. Redeploying from the dashboard can switch it back on: after every redeploy of send-push, open the function, Settings, and check. To see what the database got back, run this in the SQL editor straight after publishing:

       select status_code, left(content::text, 120) as answer, created
         from net._http_response order by created desc limit 5;

   200 is good. 401 means Verify JWT is on. Nothing at all means push_config has no function_url.
2. **The person has to have turned notifications on, on their own phone** (Account, Turn on notifications). Nothing on the server side can do that for them. After publishing, the rota page now says how many people can be reached and names the ones who cannot.
3. On iPhone it only works once Aero has been added to the Home Screen.
4. The company needs the rota switched on in Company settings.
5. A publish that changes nothing sends nothing.

Since 19 Sep the message names exactly who a publish affected, including somebody whose only shift was taken off the rota; the send-push function has to be redeployed for that to apply.

## Release checks

Run from the checks folder:

    npm run smoke
    npm run embeds
    npm run resilience
    npm run isolation
    npm run roundtrip

The app should not be promoted until all four pass and the phone checklist is complete.
