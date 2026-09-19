# Operations runbook

## Backups

Platform owners should create an encrypted full backup at least weekly and after major staff or settings changes. Store the downloaded file and passphrase separately. The Platform page warns when the last full backup is older than seven days.

## Notifications

The send-push function retries transient push errors twice with short backoff. Expired subscriptions (404/410) are removed automatically. Check Edge Function logs for repeated failures and confirm VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are present.

## Release checks

Run from the checks folder:

    npm run smoke
    npm run isolation

The app should not be promoted until both pass and the phone checklist is complete.
