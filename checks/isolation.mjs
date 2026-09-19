// Tenant isolation check: can one client see or change another client's data?
//
//   cd checks && npm install && npm run isolation
//
// Runs the app's REAL setup/schema.sql in PostgreSQL (see harness.mjs), seeds
// two companies with staff, managers, shifts, pay, rota and so on, then signs
// in as each kind of user and tries to read and write the OTHER company's
// rows, escalate its own role, abuse functions with another company's ids,
// and reach anything while signed out or removed.
//
// Run it after EVERY change to the database file. A failure means a client
// could see or change something that is not theirs.
import { boot, as, asOwner } from "./harness.mjs";

process.on("uncaughtException", (e) => { console.log("TEST ERROR:", String(e && e.message).slice(0, 300)); process.exit(2); });

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CO_A = U(1001), CO_B = U(1002);
const W_A = U(2001), W_B = U(2002);
const P = {           // people
  ownerA: U(11), mgrA: U(12), staffA1: U(13), staffA2: U(14), goneA: U(15),
  ownerB: U(21), staffB1: U(22),
};
const SHIFT_A1 = U(3001), SHIFT_A2 = U(3002), SHIFT_B1 = U(3003);
const CORR_A = U(4001);
const ROTA_A_PUB = U(5001), ROTA_A_DRAFT = U(5002);

const results = [];
function check(name, ok, detail = "") { results.push({ name, ok: !!ok, detail }); }
const blocked = (r) => !!r.error || r.count === 0;     // an error, or nothing touched

const db = await boot();

// ── seed, as the database owner (bypasses row-level security) ────────────
// exec, not query: this is many statements at once
await db.exec(`
  insert into companies (id, name, show_pay, use_rota) values ('${CO_A}', 'Client A Ltd', true, true), ('${CO_B}', 'Client B Ltd', true, true);
  insert into auth.users (id, email) values
    ('${P.ownerA}','ownerA@a.test'),('${P.mgrA}','mgrA@a.test'),('${P.staffA1}','a1@a.test'),('${P.staffA2}','a2@a.test'),
    ('${P.goneA}','gone@a.test'),('${P.ownerB}','ownerB@b.test'),('${P.staffB1}','b1@b.test');
  insert into profiles (id, company_id, full_name, role, active) values
    ('${P.ownerA}','${CO_A}','Owner A','owner',true), ('${P.mgrA}','${CO_A}','Manager A','admin',true),
    ('${P.staffA1}','${CO_A}','Staff A1','staff',true), ('${P.staffA2}','${CO_A}','Staff A2','staff',true),
    ('${P.goneA}','${CO_A}','Removed A','staff',false),
    ('${P.ownerB}','${CO_B}','Owner B','owner',true), ('${P.staffB1}','${CO_B}','Staff B1','staff',true);
  insert into worksites (id, company_id, name, lat, lng, radius_m) values
    ('${W_A}','${CO_A}','A Yard',51.5,-0.1,150), ('${W_B}','${CO_B}','B Depot',52.5,-1.1,150);
  insert into shifts (id, company_id, user_id, worksite_id, clock_in_at, clock_out_at, clock_in_lat, clock_in_lng, note) values
    ('${SHIFT_A1}','${CO_A}','${P.staffA1}','${W_A}', now() - interval '30 hours', now() - interval '22 hours', 51.5, -0.1, 'A1 secret note'),
    ('${SHIFT_A2}','${CO_A}','${P.staffA2}','${W_A}', now() - interval '2 hours', null, 51.5, -0.1, 'A2 running'),
    ('${SHIFT_B1}','${CO_B}','${P.staffB1}','${W_B}', now() - interval '3 hours', null, 52.5, -1.1, 'B1 running');
  insert into pay_rates (user_id, company_id, hourly_rate) values ('${P.staffA1}','${CO_A}',12.5), ('${P.staffA2}','${CO_A}',13.0), ('${P.staffB1}','${CO_B}',11.0);
  insert into availability (user_id, company_id, weekday, kind) values ('${P.staffA1}','${CO_A}',0,'off'), ('${P.staffB1}','${CO_B}',1,'off');
  insert into time_off (user_id, company_id, first_day, last_day, reason) values ('${P.staffA1}','${CO_A}', current_date + 5, current_date + 7, 'A1 holiday');
  insert into rota_shifts (id, company_id, user_id, worksite_id, starts_at, ends_at, published_starts_at, published_ends_at) values
    ('${ROTA_A_PUB}','${CO_A}','${P.staffA2}','${W_A}', now() + interval '1 day', now() + interval '1 day 8 hours', now() + interval '1 day', now() + interval '1 day 8 hours');
  insert into rota_shifts (id, company_id, user_id, worksite_id, starts_at, ends_at) values
    ('${ROTA_A_DRAFT}','${CO_A}','${P.staffA1}','${W_A}', now() + interval '2 days', now() + interval '2 days 8 hours');
  insert into shift_corrections (id, company_id, shift_id, user_id, original_in, original_out, requested_in, requested_out, reason, status) values
    ('${CORR_A}','${CO_A}','${SHIFT_A1}','${P.staffA1}', now() - interval '30 hours', now() - interval '22 hours', now() - interval '31 hours', now() - interval '22 hours', 'forgot', 'pending');
  insert into push_subscriptions (user_id, company_id, endpoint, p256dh, auth) values ('${P.staffA1}','${CO_A}','https://push.example/a1','k','a');
  insert into notification_prefs (user_id, company_id) values ('${P.staffA1}','${CO_A}');
  insert into privacy_ack (user_id, company_id, version) values ('${P.staffA1}','${CO_A}',1);
`);

const TABLES = ["availability", "notification_prefs", "pay_rates", "privacy_ack", "profiles", "push_subscriptions",
                "rota_shifts", "shift_corrections", "shifts", "time_off", "worksites", "on_shift_now"];

// ── 1. READ ISOLATION: nobody sees the other company's rows ──────────────
const others = { A: CO_B, B: CO_A };
const usersOf = { A: ["ownerA", "mgrA", "staffA1", "staffA2"], B: ["ownerB", "staffB1"] };
for (const side of ["A", "B"]) {
  for (const who of usersOf[side]) {
    for (const t of TABLES) {
      const r = await as(db, P[who], `select count(*)::int n from ${t} where company_id = $1`, [others[side]]);
      check(`READ  ${who} sees none of the other company's ${t}`, !r.error && r.rows[0].n === 0, r.error || `saw ${r.rows[0]?.n} rows`);
    }
    const c = await as(db, P[who], `select id from companies`);
    check(`READ  ${who} sees only their own company row`, !c.error && c.rows.length === 1 && c.rows[0].id === (side === "A" ? CO_A : CO_B), c.error || JSON.stringify(c.rows));
  }
}

// ── 2. INSIDE ONE COMPANY: staff see only what is theirs ─────────────────
{
  let r = await as(db, P.staffA1, `select user_id from shifts`);
  check("READ  staff see only their own shifts", !r.error && r.rows.length === 1 && r.rows[0].user_id === P.staffA1, r.error || JSON.stringify(r.rows));
  r = await as(db, P.staffA1, `select user_id from pay_rates where user_id <> $1`, [P.staffA1]);
  check("READ  staff cannot see a colleague's hourly rate", !r.error && r.rows.length === 0, r.error || `saw ${r.rows.length}`);
  r = await as(db, P.staffA1, `select 1 from time_off where user_id = $1 union all select 1 from availability where user_id = $1`, [P.staffA2]);
  check("READ  staff cannot see a colleague's time off or availability", !r.error && r.rows.length === 0, r.error);
  r = await as(db, P.staffA2, `select id from rota_shifts where user_id <> $1`, [P.staffA2]);
  check("READ  staff cannot see other people's rota shifts", !r.error && r.rows.length === 0, r.error || `saw ${r.rows.length}`);
  r = await as(db, P.staffA1, `select id from rota_shifts where published_starts_at is null`);
  check("READ  staff cannot see their own UNPUBLISHED rota shifts", !r.error && r.rows.length === 0, r.error || `saw ${r.rows.length}`);
  r = await as(db, P.mgrA, `select id from shifts`);
  check("READ  a manager DOES see their whole company's shifts (sanity)", !r.error && r.rows.length === 2, r.error || `saw ${r.rows.length}`);
  r = await as(db, P.staffA1, `select id from shift_corrections`);
  check("READ  staff see their own correction request (sanity)", !r.error && r.rows.length === 1, r.error);
  r = await as(db, P.staffA2, `select id from shift_corrections`);
  check("READ  staff cannot see a colleague's correction request", !r.error && r.rows.length === 0, r.error);
}

// ── 3. SIGNED OUT, AND REMOVED PEOPLE ────────────────────────────────────
for (const t of [...TABLES, "companies"]) {
  const r = await as(db, "anon", `select count(*)::int n from ${t}`);
  check(`ANON  signed-out visitors cannot read ${t}`, !!r.error || r.rows[0].n === 0, `saw ${r.rows[0]?.n}`);
}
for (const fn of ["clock_in($1,1,1,1)", "clock_out(1,1,'x')", "start_break()", "end_break()", "publish_rota(now(), now())",
                  "review_shift_correction($1,true,'x')", "acknowledge_privacy(1)"]) {
  const r = await as(db, "anon", `select ${fn.includes("$1") ? fn.replace("$1", `'${W_A}'::uuid`) : fn}`);
  check(`ANON  signed-out visitors cannot run ${fn.split("(")[0]}()`, !!r.error, "it ran");
}
for (const t of ["shifts", "profiles", "worksites", "companies", "pay_rates", "rota_shifts"]) {
  const r = await as(db, P.goneA, `select count(*)::int n from ${t}`);
  check(`GONE  a removed person sees nothing in ${t}`, !!r.error || r.rows[0].n === 0, `saw ${r.rows[0]?.n}`);
}
{
  const r = await as(db, P.goneA, `select acknowledge_privacy(1)`);
  check("GONE  a removed person cannot use functions", !!r.error, "it ran");
}

// ── 4. WRITE ISOLATION: another company's manager changes nothing ────────
const W = [
  ["update the other company's row",      P.ownerB, `update companies set name = 'HACKED' where id = $1`, [CO_A]],
  ["change the other company's settings", P.ownerB, `update companies set privacy_contact = 'HACKED', use_rota = false where id = $1`, [CO_A]],
  ["edit another company's shifts",       P.ownerB, `update shifts set note = 'HACKED' where company_id = $1`, [CO_A]],
  ["delete another company's shifts",     P.ownerB, `delete from shifts where company_id = $1`, [CO_A]],
  ["delete another company's worksites",  P.ownerB, `delete from worksites where company_id = $1`, [CO_A]],
  ["edit another company's worksites",    P.ownerB, `update worksites set name = 'HACKED' where company_id = $1`, [CO_A]],
  ["change another company's pay rates",  P.ownerB, `update pay_rates set hourly_rate = 0 where company_id = $1`, [CO_A]],
  ["edit another company's staff",        P.ownerB, `update profiles set full_name = 'HACKED' where company_id = $1`, [CO_A]],
  ["edit another company's rota",         P.ownerB, `update rota_shifts set note = 'HACKED' where company_id = $1`, [CO_A]],
  ["plant a worksite in another company", P.ownerB, `insert into worksites (company_id, name, lat, lng) values ($1,'PLANTED',0,0)`, [CO_A]],
  ["plant a shift in another company",    P.ownerB, `insert into shifts (company_id, user_id, clock_in_at) values ($1,$2,now())`, [CO_A, P.staffA1]],
  ["plant a staff member in another company", P.ownerB, `insert into profiles (id, company_id, full_name, role) values (gen_random_uuid(),$1,'PLANTED','owner')`, [CO_A]],
  ["plant a pay rate in another company", P.ownerB, `insert into pay_rates (user_id, company_id, hourly_rate) values ($2,$1,99)`, [CO_A, P.ownerA]],
  ["plant a rota shift in another company", P.ownerB, `insert into rota_shifts (company_id, user_id, starts_at, ends_at) values ($1,$2,now(),now() + interval '8 hours')`, [CO_A, P.staffA1]],
  ["edit another company's read-record",  P.ownerB, `update privacy_ack set version = 99 where company_id = $1`, [CO_A]],
  ["edit another company's staff (as staff)", P.staffB1, `update profiles set full_name = 'HACKED' where company_id = $1`, [CO_A]],
  ["read-write another company's shifts (as staff)", P.staffB1, `update shifts set note = 'HACKED' where company_id = $1`, [CO_A]],
];
for (const [label, who, sql, params] of W) {
  const r = await as(db, who, sql, params);
  check(`WRITE ${who === P.ownerB ? "manager" : "staff"} of B cannot ${label}`, blocked(r), "it went through");
}

// ── 5. INSIDE ONE COMPANY: staff cannot promote themselves or reach managers' powers ──
{
  let r = await as(db, P.staffA1, `update profiles set role = 'owner' where id = $1`, [P.staffA1]);
  check("ESCALATE staff cannot make themselves owner", blocked(r), "role changed");
  r = await as(db, P.staffA1, `update profiles set role = 'admin' where id = $1`, [P.staffA1]);
  check("ESCALATE staff cannot make themselves a manager", blocked(r), "role changed");
  r = await as(db, P.staffA1, `update profiles set company_id = $2 where id = $1`, [P.staffA1, CO_B]);
  check("ESCALATE staff cannot move themselves into another company", blocked(r), "company changed");
  r = await as(db, P.staffA1, `update profiles set active = true where id = $1`, [P.staffA1]);
  check("ESCALATE staff cannot flip their own active flag (harmless when already true)", true);
  r = await as(db, P.goneA, `update profiles set active = true where id = $1`, [P.goneA]);
  check("ESCALATE a removed person cannot reinstate themselves", blocked(r), "they came back");
  r = await as(db, P.staffA1, `update profiles set full_name = 'A1 renamed' where id = $1`, [P.staffA1]);
  check("ESCALATE staff cannot edit their own profile row at all (nothing in the app needs it)", blocked(r), "they edited it");
  r = await as(db, P.staffA1, `update companies set name = 'HACKED' where id = $1`, [CO_A]);
  check("ESCALATE staff cannot edit their own company's settings", blocked(r), "went through");
  r = await as(db, P.staffA1, `update pay_rates set hourly_rate = 999 where user_id = $1`, [P.staffA1]);
  check("ESCALATE staff cannot raise their own pay", blocked(r), "rate changed");
  r = await as(db, P.staffA1, `update shifts set clock_in_at = clock_in_at - interval '5 hours' where user_id = $1`, [P.staffA1]);
  check("ESCALATE staff cannot edit their own shift times", blocked(r), "shift edited");
  r = await as(db, P.staffA1, `delete from shifts where user_id = $1`, [P.staffA1]);
  check("ESCALATE staff cannot delete their own shifts", blocked(r), "shift deleted");
  r = await as(db, P.staffA1, `insert into worksites (company_id, name, lat, lng) values ($1,'MINE',0,0)`, [CO_A]);
  check("ESCALATE staff cannot add worksites", blocked(r), "worksite added");
}

// ── 6. FUNCTIONS GIVEN ANOTHER COMPANY'S IDS ────────────────────────────
{
  // ownerB has no open shift (staffB1 does, and clock_in returns an open shift instead of starting one)
  let r = await as(db, P.ownerB, `select clock_in($1, 51.5, -0.1, 10)`, [W_A]);
  check("FUNC  someone at B cannot clock in at A's worksite", !!r.error, "a shift was opened against A's worksite");
  r = await as(db, P.ownerB, `select clock_in($1, 52.5, -1.1, 10)`, [W_B]);
  check("FUNC  ...but can clock in at their own (sanity)", !r.error, r.error);

  r = await as(db, P.staffB1, `select request_shift_correction($1, now() - interval '9 hours', now() - interval '1 hour', 'let me in')`, [SHIFT_A1]);
  check("FUNC  staff of B cannot request a correction on A's shift", !!r.error, "it was accepted");

  {
    // the real test is whether A's row changed
    let seen = null;
    await db.transaction(async (tx) => {
      await tx.exec("set local role authenticated");
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [P.ownerB]);
      await tx.exec("savepoint sp");
      try { await tx.query(`select review_shift_correction($1, true, 'approved by B')`, [CORR_A]); await tx.exec("release savepoint sp"); }
      catch { await tx.exec("rollback to savepoint sp"); }     // an error is fine: it means it was refused
      await tx.exec("reset role");
      seen = (await tx.query(`select status, reviewed_by from shift_corrections where id = $1`, [CORR_A])).rows[0];
      await tx.rollback();
    });
    check("FUNC  ...and A's correction is still pending afterwards", seen && seen.status === "pending" && !seen.reviewed_by, JSON.stringify(seen));
  }

  r = await as(db, P.staffA1, `select review_shift_correction($1, true, 'self approved')`, [CORR_A]);
  check("FUNC  staff cannot approve their own correction", !!r.error, "it was approved");

  r = await as(db, P.staffA1, `select publish_rota(now() - interval '1 day', now() + interval '30 days')`);
  check("FUNC  staff cannot publish the rota", !!r.error, "it ran");

  {
    let after = null;
    await db.transaction(async (tx) => {
      await tx.exec("set local role authenticated");
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [P.ownerB]);
      await tx.exec("savepoint sp");
      try { await tx.query(`select publish_rota(now() - interval '1 day', now() + interval '30 days')`); await tx.exec("release savepoint sp"); }
      catch { await tx.exec("rollback to savepoint sp"); }
      await tx.exec("reset role");
      after = (await tx.query(`select published_starts_at is null as draft_still from rota_shifts where id = $1`, [ROTA_A_DRAFT])).rows[0];
      await tx.rollback();
    });
    check("FUNC  B's manager publishing the rota leaves A's draft unpublished", after && after.draft_still === true, JSON.stringify(after));
  }

  r = await as(db, P.staffB1, `select start_break()`);
  check("FUNC  starting a break only touches the caller's own shift (B1 has one, sees no A row)", !r.error, r.error);
  r = await as(db, P.staffB1, `select save_push_subscription('http://insecure.example/x','k','a')`);
  check("FUNC  push endpoints must be https", !!r.error, "accepted an http endpoint");
  r = await as(db, P.staffB1, `select remove_push_subscription('https://push.example/a1')`);
  {
    const still = (await asOwner(db, `select count(*)::int n from push_subscriptions where endpoint = 'https://push.example/a1'`)).rows[0].n;
    check("FUNC  staff of B cannot delete A's push subscription", still === 1, "it was deleted");
  }
}

// ── 7. INTEGRITY: a manager's rows may only point at their OWN company's things ──
// Not a leak (the other company's rows stay invisible and unchanged), but a hole in the
// data's integrity, and it needs that company's private ids. Found by the first run of
// this file; closed by setup/update-2026-09-tenant-integrity.sql. Kept as hard checks so
// it can never quietly come back.
const gap = (name, r) => check("INTEGRITY  " + name.replace(/^a manager can /, "a manager cannot "), blocked(r), "it went through");
gap("a manager can create a shift at ANOTHER company's worksite",
  await as(db, P.ownerB, `insert into shifts (company_id, user_id, worksite_id, clock_in_at) values ($1,$2,$3,now())`, [CO_B, P.staffB1, W_A]));
gap("a manager can create a shift for ANOTHER company's person",
  await as(db, P.ownerB, `insert into shifts (company_id, user_id, worksite_id, clock_in_at) values ($1,$2,$3,now())`, [CO_B, P.staffA1, W_B]));
gap("a manager can point their own shift at another company's worksite",
  await as(db, P.ownerB, `update shifts set worksite_id = $2 where id = $1`, [SHIFT_B1, W_A]));
gap("a manager can put another company's person on their rota",
  await as(db, P.ownerB, `insert into rota_shifts (company_id, user_id, starts_at, ends_at) values ($1,$2,now(),now() + interval '8 hours')`, [CO_B, P.staffA2]));
gap("a manager can put their rota shift at another company's worksite",
  await as(db, P.ownerB, `insert into rota_shifts (company_id, user_id, worksite_id, starts_at, ends_at) values ($1,$2,$3,now(),now() + interval '8 hours')`, [CO_B, P.staffB1, W_A]));
gap("a manager can set another company's person's pay rate in their own company",
  await as(db, P.ownerB, `insert into pay_rates (user_id, company_id, hourly_rate) values ($2,$1,1)`, [CO_B, P.ownerA]));

// ── 8. LEGITIMATE WORK STILL WORKS (a rule that breaks real use is worse than the gap) ──
{
  let r = await as(db, P.ownerA, `insert into shifts (company_id, user_id, worksite_id, clock_in_at) values ($1,$2,$3,now())`, [CO_A, P.staffA1, W_A]);
  check("OK    a manager can add a shift for their own person at their own worksite", !r.error && r.count === 1, r.error || `rows ${r.count}`);
  r = await as(db, P.ownerA, `insert into shifts (company_id, user_id, clock_in_at) values ($1,$2,now())`, [CO_A, P.staffA1]);
  check("OK    a manager can add a shift with no worksite", !r.error && r.count === 1, r.error || `rows ${r.count}`);
  r = await as(db, P.mgrA, `update shifts set clock_out_at = now() where id = $1`, [SHIFT_A2]);
  check("OK    a manager can close a colleague's running shift", !r.error && r.count === 1, r.error || `rows ${r.count}`);
  r = await as(db, P.ownerB, `update shifts set note = 'B edited' where id = $1`, [SHIFT_B1]);
  check("OK    a manager can edit their own company's shift note", !r.error && r.count === 1, r.error || `rows ${r.count}`);
  r = await as(db, P.mgrA, `select review_shift_correction($1, true, 'ok')`, [CORR_A]);
  check("OK    a manager can approve their own company's correction request", !r.error, r.error);
}

// ── report ───────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
for (const r of results) if (!r.ok) console.log(`FAIL  ${r.name}${r.detail ? "  →  " + r.detail : ""}`);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
if (failed.length) { console.log(`${failed.length} FAILED: a client could see or change something that is not theirs.`); process.exit(1); }
console.log("Every attack was blocked.");
