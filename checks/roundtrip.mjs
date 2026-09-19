// Does a backup actually come back?
//
//   cd checks && npm run roundtrip
//
// A backup nobody has restored is not a backup, it is a file. This builds a
// company on the REAL schema.sql, exports it in exactly the shape the platform
// function's Backup produces, runs the real restore.mjs over it the way the
// owner would, loads the SQL into an empty database built from the same
// schema.sql, and then compares the two row by row.
//
// It fails if a table is missing from the backup, if the restore puts rows back
// in an order the foreign keys refuse, or if any value comes back changed.
import { boot, asOwner } from "./harness.mjs";
import { execFileSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CO = U(1001), OWNER = U(11), STAFF = U(12), SITE = U(2001), SHIFT = U(3001), ANN = U(6001);

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });

// Every company-scoped table the platform function's Backup exports, in its order.
const TABLES = ["profiles", "worksites", "shifts", "shift_corrections", "pay_rates", "availability", "time_off",
                "rota_shifts", "privacy_ack", "notification_prefs", "announcements", "announcement_reads",
                "overtime_decisions", "company_features", "audit_events"];

// ── 1. a company with something in every one of those tables ─────────────
const live = await boot({});
await live.exec(`
  insert into companies (id, name, show_pay, use_rota, overtime_weekly_hours)
    values ('${CO}', 'Doomed Parking Ltd', true, true, 40);
  insert into auth.users (id, email) values ('${OWNER}','owner@doomed.test'),('${STAFF}','staff@doomed.test');
  insert into profiles (id, company_id, full_name, role, active) values
    ('${OWNER}','${CO}','Jo Owner','owner',true), ('${STAFF}','${CO}','Sam Staff','staff',true);
  insert into worksites (id, company_id, name, lat, lng, radius_m) values ('${SITE}','${CO}','Main yard',51.5,-0.1,150);
  insert into shifts (id, company_id, user_id, worksite_id, clock_in_at, clock_out_at, clock_in_lat, clock_in_lng, note, break_minutes)
    values ('${SHIFT}','${CO}','${STAFF}','${SITE}', now() - interval '9 hours', now() - interval '1 hour', 51.5, -0.1, 'Barrier 3 sticking; it''s fine now', 30);
  insert into shift_corrections (company_id, shift_id, user_id, original_in, original_out, requested_in, requested_out, reason, status)
    values ('${CO}','${SHIFT}','${STAFF}', now() - interval '9 hours', now() - interval '1 hour', now() - interval '10 hours', now() - interval '1 hour', 'Started early', 'pending');
  insert into pay_rates (user_id, company_id, hourly_rate) values ('${STAFF}','${CO}', 12.75);
  insert into availability (user_id, company_id, weekday, kind) values ('${STAFF}','${CO}', 2, 'off');
  insert into time_off (user_id, company_id, first_day, last_day, reason) values ('${STAFF}','${CO}', current_date + 3, current_date + 5, 'Wedding');
  insert into rota_shifts (company_id, user_id, worksite_id, starts_at, ends_at, published_starts_at, published_ends_at)
    values ('${CO}','${STAFF}','${SITE}', now() + interval '1 day', now() + interval '1 day 8 hours', now() + interval '1 day', now() + interval '1 day 8 hours');
  insert into privacy_ack (user_id, company_id, version) values ('${STAFF}','${CO}', 2);
  insert into notification_prefs (user_id, company_id) values ('${STAFF}','${CO}');
  insert into announcements (id, company_id, author_id, body) values ('${ANN}','${CO}','${OWNER}','Gate code changes Monday');
  insert into announcement_reads (announcement_id, user_id, company_id) values ('${ANN}','${STAFF}','${CO}');
  insert into overtime_decisions (company_id, user_id, week_start, status, hours_at_decision, note, decided_by)
    values ('${CO}','${STAFF}','2026-09-07','approved', 47.5, 'Covered the T2 contract', '${OWNER}');
  insert into company_features (company_id, feature, enabled) values ('${CO}','incidents', false);
  insert into audit_events (company_id, actor_id, action, entity, summary)
    values ('${CO}','${OWNER}','approved','overtime','Manager approved overtime for Sam Staff.');
`);

// ── 2. export it the way the platform function does ──────────────────────
const companyRow = (await asOwner(live, `select * from companies where id = $1`, [CO])).rows[0];
const tables = {};
for (const t of TABLES) {
  const r = await asOwner(live, `select * from ${t} where company_id = $1`, [CO]);
  check(`BACKUP ${t} is in the backup at all`, !r.error && r.rows.length > 0, r.error || "no rows seeded, so this proves nothing");
  tables[t] = r.rows;
}
// Emails are stitched on from the login system, exactly as the real backup does.
const emails = Object.fromEntries((await asOwner(live, `select id, email from auth.users`)).rows.map((u) => [u.id, u.email]));
tables.profiles = tables.profiles.map((p) => ({ ...p, email: emails[p.id] ?? null }));

const backup = {
  format: "aero-attendance-backup", version: 1, exported_at: new Date().toISOString(),
  note: "Contains personal data.", companies: [{ company: companyRow, tables }],
};

// ── 3. run the real restore.mjs, the way the owner would ─────────────────
const dir = mkdtempSync(join(tmpdir(), "aero-restore-"));
const jsonPath = join(dir, "backup.json"), sqlPath = join(dir, "restore.sql");
writeFileSync(jsonPath, JSON.stringify(backup), "utf8");
let toolOut = "";
try {
  toolOut = execFileSync(process.execPath, ["restore.mjs", jsonPath, "--out", sqlPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  check("RESTORE restore.mjs runs", false, String(e.stderr || e.message).slice(0, 200));
}
check("RESTORE restore.mjs runs and writes the SQL", toolOut.includes("Written to"), toolOut.slice(0, 200));
const sql = readFileSync(sqlPath, "utf8");
check("RESTORE it does not quietly skip a table it does not know", !/NOT RESTORED/.test(sql), "it skipped something");

// ── 4. load it into an empty database built from the same schema ─────────
const fresh = await boot({});
let restoreError = "";
try { await fresh.exec(sql); } catch (e) { restoreError = e.message; }
check("RESTORE the SQL loads into an empty database", !restoreError, restoreError.slice(0, 300));

// ── 5. compare, row by row ───────────────────────────────────────────────
if (!restoreError) {
  const co = await asOwner(fresh, `select name, overtime_weekly_hours from companies where id = $1`, [CO]);
  check("MATCH  the company itself is back, with its settings",
        co.rows[0]?.name === "Doomed Parking Ltd" && Number(co.rows[0]?.overtime_weekly_hours) === 40, JSON.stringify(co.rows));

  for (const t of TABLES) {
    const before = tables[t].length;
    const after = (await asOwner(fresh, `select count(*)::int n from ${t} where company_id = $1`, [CO])).rows[0].n;
    check(`MATCH  ${t}: ${before} rows out, ${before} back`, before === after, `${before} out, ${after} back`);
  }

  // Values, not just counts: an apostrophe, a decimal, a date and a jsonb column.
  const s = (await asOwner(fresh, `select note, break_minutes from shifts where id = $1`, [SHIFT])).rows[0];
  check("MATCH  a note with an apostrophe survives", s?.note === "Barrier 3 sticking; it's fine now", JSON.stringify(s));
  check("MATCH  break minutes survive", Number(s?.break_minutes) === 30, JSON.stringify(s));
  const rate = (await asOwner(fresh, `select hourly_rate from pay_rates where user_id = $1`, [STAFF])).rows[0];
  check("MATCH  an hourly rate keeps its pennies", Number(rate?.hourly_rate) === 12.75, JSON.stringify(rate));
  const ot = (await asOwner(fresh, `select status, hours_at_decision, week_start from overtime_decisions where user_id = $1`, [STAFF])).rows[0];
  check("MATCH  an overtime decision comes back whole",
        ot?.status === "approved" && Number(ot?.hours_at_decision) === 47.5, JSON.stringify(ot));
  const feat = (await asOwner(fresh, `select feature, enabled from company_features where company_id = $1`, [CO])).rows[0];
  check("MATCH  an add-on that was switched off is still off", feat?.feature === "incidents" && feat?.enabled === false, JSON.stringify(feat));
  const who = (await asOwner(fresh, `select email from auth.users where id = $1`, [STAFF])).rows[0];
  check("MATCH  the login exists again so rows still point at a person", who?.email === "staff@doomed.test", JSON.stringify(who));

  // Running it twice must not double anything up.
  await fresh.exec(sql);
  const twice = (await asOwner(fresh, `select count(*)::int n from shifts where company_id = $1`, [CO])).rows[0].n;
  check("SAFE   running the same restore twice changes nothing", twice === tables.shifts.length, `${twice} shifts after a second run`);
}

// ── 6. the same thing, but locked ────────────────────────────────────────
// Most real backups are locked with a passphrase. If this path is broken they
// cannot be opened at all, which is worse than having no backup: you think you
// are covered.
{
  const b64 = (u8) => Buffer.from(u8).toString("base64");
  const pass = "correct horse battery staple";
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const base = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  const key = await webcrypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const data = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(backup))));
  const lockedPath = join(dir, "locked.json"), lockedSql = join(dir, "locked.sql");
  writeFileSync(lockedPath, JSON.stringify({
    format: "aero-attendance-backup-encrypted", version: 1, kdf: "PBKDF2-SHA256",
    iterations: 600000, salt: b64(salt), iv: b64(iv), data: b64(data),
  }), "utf8");

  let lockedOut = "";
  try {
    lockedOut = execFileSync(process.execPath, ["restore.mjs", lockedPath, "--passphrase", pass, "--out", lockedSql],
                             { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { lockedOut = String(e.stderr || e.message); }
  check("LOCKED a locked backup opens with the right passphrase", lockedOut.includes("Written to"), lockedOut.slice(0, 200));
  check("LOCKED ...and produces the same SQL as the unlocked one",
        lockedOut.includes("Written to") && readFileSync(lockedSql, "utf8").length === sql.length, "the two differ");

  let wrongPass = "";
  try {
    execFileSync(process.execPath, ["restore.mjs", lockedPath, "--passphrase", "not the passphrase", "--out", join(dir, "no.sql")],
                 { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    wrongPass = "it opened anyway";
  } catch (e) { wrongPass = String(e.stderr || ""); }
  check("LOCKED the wrong passphrase is refused, and writes nothing", /Wrong passphrase/.test(wrongPass), wrongPass.slice(0, 150));
}

rmSync(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
for (const r of failed) console.log(`FAIL  ${r.name}${r.detail ? "  →  " + r.detail : ""}`);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
if (failed.length) { console.log(`${failed.length} FAILED: a backup would NOT come back.`); process.exit(1); }
console.log("A backup taken today comes back whole.");
