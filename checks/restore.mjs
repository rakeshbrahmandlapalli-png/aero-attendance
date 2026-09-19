// Turn a backup from /platform back into a database.
//
//   node restore.mjs backup.json                     # what is in it, nothing written
//   node restore.mjs backup.json --out restore.sql   # write the SQL
//   node restore.mjs locked.json --passphrase "..." --out restore.sql
//   node restore.mjs backup.json --company "247 Airport Parking" --out one.sql
//
// It writes a .sql FILE. It does not connect to anything, and it never asks for
// a key or a password to a live project: you read the SQL, then paste it into
// the Supabase SQL editor of the project you want it in. That way a restore can
// be checked before it runs, and this script can never touch live data by
// itself.
//
// WHAT IT BRINGS BACK: every company-scoped table in the backup.
// WHAT IT CANNOT: logins. Passwords are not in the backup and never should be.
// The rows in auth.users are recreated so that everything pointing at them lines
// up, but each person needs a new password afterwards (Managers → Reset owner
// password on /platform, or the manage-staff function for everybody else).
//
// Proven by `npm run roundtrip`, which builds a database from the real
// schema.sql, exports it in the backup's own shape, restores it into an empty
// one with this script, and compares every table row by row.

import { readFileSync, writeFileSync } from "node:fs";
import { webcrypto } from "node:crypto";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf("--" + name);
  return i === -1 ? null : args[i + 1];
};
const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true);
if (!file) {
  console.error("Usage: node restore.mjs <backup.json> [--passphrase <p>] [--company <name>] [--out <file.sql>]");
  process.exit(2);
}

// ── open the file, unlocking it first if it was locked ───────────────────
const unb64 = (s) => Uint8Array.from(Buffer.from(s, "base64"));

async function unlock(box, pass) {
  const base = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  const key = await webcrypto.subtle.deriveKey(
    { name: "PBKDF2", salt: unb64(box.salt), iterations: Number(box.iterations) || 600000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plain = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv) }, key, unb64(box.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

let backup = JSON.parse(readFileSync(file, "utf8"));
if (backup.format === "aero-attendance-backup-encrypted") {
  const pass = flag("passphrase");
  if (!pass) { console.error("That backup is locked. Pass --passphrase \"...\"."); process.exit(2); }
  try { backup = await unlock(backup, pass); }
  catch { console.error("Wrong passphrase, or the file is damaged. Nothing was written."); process.exit(1); }
}
if (backup.format !== "aero-attendance-backup") {
  console.error(`That is not a backup from /platform (format: ${backup.format ?? "none"}).`);
  process.exit(1);
}

let companies = backup.companies ?? [];
const only = flag("company");
if (only) {
  companies = companies.filter((c) => c.company?.name === only);
  if (!companies.length) { console.error(`No company called "${only}" in this backup.`); process.exit(1); }
}

// ── what order the rows have to go back in ───────────────────────────────
// Parents before children, or the foreign keys refuse them.
const ORDER = [
  "job_roles", "profiles", "worksites", "shifts", "shift_corrections", "pay_rates", "availability", "time_off",
  "rota_shifts", "privacy_ack", "notification_prefs", "announcements", "announcement_reads",
  "overtime_decisions", "company_features", "staff_details", "dismissed_alerts", "audit_events",
];

const q = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
};

const insert = (table, rows, skip = []) => {
  if (!rows?.length) return [];
  const cols = Object.keys(rows[0]).filter((c) => !skip.includes(c));
  return rows.map((r) =>
    `insert into ${table} (${cols.join(", ")}) values (${cols.map((c) => q(r[c])).join(", ")}) on conflict do nothing;`);
};

// ── build it ─────────────────────────────────────────────────────────────
const out = [];
const summary = [];

out.push("-- Aero Attendance restore");
out.push(`-- from a backup taken ${backup.exported_at ?? "(no date)"}`);
out.push("--");
out.push("-- Read this before running it. Paste it into the Supabase SQL editor of the");
out.push("-- project you want the data in. Run the whole schema.sql there FIRST.");
out.push("--");
out.push("-- Everything is 'on conflict do nothing', so it adds what is missing and");
out.push("-- changes nothing that is already there. It never deletes.");
out.push("--");
out.push("-- Logins: passwords are not in a backup. The auth.users rows below exist so");
out.push("-- that profiles, shifts and audit entries still point at a real person. Give");
out.push("-- everyone a new password afterwards before they can sign in.");
out.push("");
out.push("begin;");
out.push("");
// Putting rows back must not run the app's own triggers. Two kinds matter:
//
//   audit    a restored shift correction or rota shift would write a fresh audit
//            entry dated TODAY for something that happened weeks ago, on top of
//            the real ones coming out of the backup. An audit trail that invents
//            its own history is worse than none.
//   push     restored shifts, corrections and notices would each queue a phone
//            notification, so every manager would be told everyone "just clocked
//            in" and every member of staff would be sent last month's notices.
//
// So every user-defined trigger on the tables being filled is held off while the
// rows go back, exactly as pg_restore --disable-triggers does, and put back after.
// Only USER triggers: the ones that enforce foreign keys stay on.
const TRIGGER_TABLES = ["companies", ...ORDER];
const triggerBlock = (verb) => [
  "do $$ declare t text; begin",
  `  foreach t in array array[${TRIGGER_TABLES.map((t) => `'${t}'`).join(", ")}] loop`,
  "    if to_regclass('public.' || t) is not null then",
  `      execute format('alter table %I ${verb} trigger user', t);`,
  "    end if;",
  "  end loop;",
  "end $$;",
  "",
];
out.push("-- Hold off the app's triggers: restoring history must not write new history or send notifications.");
out.push(...triggerBlock("disable"));

for (const entry of companies) {
  const c = entry.company;
  const tables = entry.tables ?? {};
  out.push(`-- ── ${c.name} ──────────────────────────────────────────`);
  out.push(...insert("companies", [c]));

  // auth.users first: profiles point at them.
  const people = tables.profiles ?? [];
  const withEmail = people.filter((p) => p.email);
  if (withEmail.length) {
    out.push("");
    out.push("-- logins (no passwords: everyone needs a new one set afterwards)");
    out.push(...withEmail.map((p) =>
      `insert into auth.users (id, email) values (${q(p.id)}, ${q(p.email)}) on conflict do nothing;`));
  }

  const counts = { companies: 1 };
  for (const t of ORDER) {
    const rows = tables[t] ?? [];
    if (!rows.length) continue;
    out.push("");
    out.push(`-- ${t}: ${rows.length}`);
    // `email` is stitched on by the backup for convenience; it is not a column.
    out.push(...insert(t, rows, t === "profiles" ? ["email"] : []));
    counts[t] = rows.length;
  }

  // Anything in the backup this script does not know about, said out loud
  // rather than dropped in silence.
  const unknown = Object.keys(tables).filter((t) => !ORDER.includes(t) && (tables[t] ?? []).length);
  if (unknown.length) {
    out.push("");
    out.push(`-- !! NOT RESTORED, this script does not know these tables: ${unknown.join(", ")}`);
    console.error(`WARNING  ${c.name}: the backup has tables this script does not know: ${unknown.join(", ")}`);
    console.error("         Add them to ORDER in restore.mjs, in an order the foreign keys allow.");
  }

  out.push("");
  summary.push({ name: c.name, counts });
}

out.push("-- ...and on again, so the app keeps recording and notifying from here on.");
out.push(...triggerBlock("enable"));
out.push("commit;");
out.push("");

// ── say what it found, and write only if asked ───────────────────────────
for (const s of summary) {
  const total = Object.values(s.counts).reduce((a, b) => a + b, 0);
  console.log(`${s.name}: ${total} rows`);
  for (const [t, n] of Object.entries(s.counts)) if (t !== "companies") console.log(`  ${String(n).padStart(6)}  ${t}`);
}

const outFile = flag("out");
if (!outFile) {
  console.log("\nNothing written. Add --out restore.sql to write the SQL.");
} else {
  writeFileSync(outFile, out.join("\n"), "utf8");
  console.log(`\nWritten to ${outFile}. Read it, then paste it into the Supabase SQL editor.`);
  console.log("Run schema.sql in that project first, and set everyone a new password afterwards.");
}
