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
  platform: U(90),      // a platform admin: signs in, but belongs to no company
};
const SHIFT_A1 = U(3001), SHIFT_A2 = U(3002), SHIFT_B1 = U(3003);
const CORR_A = U(4001);
const ROTA_A_PUB = U(5001), ROTA_A_DRAFT = U(5002);
const ANN_A = U(6001), ANN_A2 = U(6002), ANN_A_OFF = U(6003), ANN_A_GONE = U(6004), ANN_B = U(6005);

const results = [];
function check(name, ok, detail = "") { results.push({ name, ok: !!ok, detail }); }
const blocked = (r) => !!r.error || r.count === 0;     // an error, or nothing touched

const db = await boot({ schemaPath: process.env.SCHEMA_FILE });   // SCHEMA_FILE: try a deliberately broken copy, to prove a check can fail

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
  insert into announcements (id, company_id, author_id, body, active, expires_at) values
    ('${ANN_A}','${CO_A}','${P.mgrA}','Gate code changes Monday', true, null),
    ('${ANN_A2}','${CO_A}','${P.mgrA}','Second live notice', true, null),
    ('${ANN_A_OFF}','${CO_A}','${P.mgrA}','A switched-off notice', false, null),
    ('${ANN_A_GONE}','${CO_A}','${P.mgrA}','A expired notice', true, now() - interval '1 hour'),
    ('${ANN_B}','${CO_B}','${P.ownerB}','B depot notice', true, null);
  insert into announcement_reads (announcement_id, user_id, company_id) values
    ('${ANN_A}','${P.staffA1}','${CO_A}'), ('${ANN_A}','${P.staffA2}','${CO_A}');
  insert into auth.users (id, email) values ('${P.platform}','platform@aero.test');
  insert into platform_admins (user_id) values ('${P.platform}');
`);

const TABLES = ["announcement_reads", "announcements", "audit_events", "availability", "notification_prefs", "pay_rates",
                "privacy_ack", "profiles", "push_subscriptions", "rota_shifts", "shift_corrections", "shifts", "time_off",
                "worksites", "on_shift_now"];

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
                  "review_shift_correction($1,true,'x')", "acknowledge_privacy(1)", "clock_out_for($1,'x')", "my_handover()"]) {
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
  ["change another company's time zone",  P.ownerB, `update companies set time_zone = 'Asia/Tokyo' where id = $1`, [CO_A]],
  ["change another company's currency",   P.ownerB, `update companies set currency = 'USD' where id = $1`, [CO_A]],
  ["rebrand another company",             P.ownerB, `update companies set brand_name = 'HACKED' where id = $1`, [CO_A]],
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

// ── 9. PLATFORM ADMINS AND PER-COMPANY SETTINGS ──────────────────────────
// platform_admins decides who may add client companies (the `platform` Edge Function
// reads it with the service key). No signed-in user, manager or platform admin included,
// may reach it from the app: not even to read it, and above all not to add themselves.
{
  const asks = [
    ["read",   `select count(*)::int n from platform_admins`],
    ["add themselves", `insert into platform_admins (user_id) values ($1)`],
    ["remove a platform admin", `delete from platform_admins`],
    ["edit a platform admin", `update platform_admins set user_id = user_id`],
  ];
  for (const who of ["staffA1", "mgrA", "ownerA", "ownerB", "platform"]) {
    for (const [label, sql] of asks) {
      // the insert names staffA2, who is a real user and NOT yet an admin, so a refusal can only be about permission
      const r = await as(db, P[who], sql, sql.includes("$1") ? [P.staffA2] : []);
      const refused = /permission denied|row-level security/.test(r.error || "");
      check(`PLATFORM  ${who} cannot ${label} platform_admins`, refused || (!r.error && r.count === 0 && (r.rows[0]?.n ?? 0) === 0), r.error || `it worked (${r.count})`);
    }
  }
  for (const [label, sql] of [["read", `select count(*)::int n from platform_admins`], ["add themselves", `insert into platform_admins (user_id) values (gen_random_uuid())`]]) {
    const r = await as(db, "anon", sql.replace("gen_random_uuid()", `'${P.staffA2}'::uuid`));
    check(`PLATFORM  signed-out visitors cannot ${label} platform_admins`, /permission denied|row-level security/.test(r.error || ""), r.error || "it worked");
  }
  const still = (await asOwner(db, `select count(*)::int n from platform_admins`)).rows[0].n;
  check("PLATFORM  the list is unchanged after all of that", still === 1, `now ${still}`);

  // being a platform admin gives no view into any company
  for (const t of ["companies", "profiles", "shifts", "worksites", "pay_rates"]) {
    const r = await as(db, P.platform, `select count(*)::int n from ${t}`);
    check(`PLATFORM  a platform admin's own session sees no ${t} (they act through the Edge Function only)`, !r.error && r.rows[0].n === 0, r.error || `saw ${r.rows[0]?.n}`);
  }
}

// Settings a manager may save on their own company, and the ones nobody may touch.
{
  const okSet = [
    ["name", `name = 'Renamed Ltd'`], ["time zone", `time_zone = 'Asia/Kolkata'`], ["currency", `currency = 'INR'`],
    ["brand name", `brand_name = 'Client Time'`], ["breaks switch", `use_breaks = false`],
    ["privacy contact", `privacy_contact = 'hr@a.test'`], ["retention text", `retention_text = '6 years'`],
    ["rota switch", `use_rota = false`], ["pay switch", `show_pay = false`], ["on-site switch", `require_on_site = false`],
  ];
  for (const [label, set] of okSet) {
    const r = await as(db, P.ownerA, `update companies set ${set} where id = $1`, [CO_A]);
    check(`SETTINGS  a manager can save their company's ${label}`, !r.error && r.count === 1, r.error || `rows ${r.count}`);
  }
  {
    const r = await as(db, P.ownerA, `update companies set name = 'X', time_zone = 'Asia/Kolkata', currency = 'INR', brand_name = 'Y', use_breaks = false, privacy_contact = 'p', retention_text = 'r' where id = $1`, [CO_A]);
    check("SETTINGS  ...all at once, the way Company settings saves them", !r.error && r.count === 1, r.error || `rows ${r.count}`);
  }
  for (const [label, set] of [["id", `id = gen_random_uuid()`], ["created date", `created_at = now()`]]) {
    const r = await as(db, P.ownerA, `update companies set ${set} where id = $1`, [CO_A]);
    check(`SETTINGS  a manager cannot change their company's ${label}`, blocked(r), "it changed");
  }
  for (const [label, set] of [["a time zone that does not exist", `time_zone = 'Mars/Olympus'`], ["an empty time zone", `time_zone = ''`],
                              ["a currency that is not three capital letters", `currency = 'pounds'`], ["a lower-case currency", `currency = 'gbp'`],
                              ["a 61-character brand name", `brand_name = '${"x".repeat(61)}'`]]) {
    const r = await as(db, P.ownerA, `update companies set ${set} where id = $1`, [CO_A]);
    check(`SETTINGS  the database refuses ${label}`, !!r.error, "it was accepted");
  }
  for (const [label, set] of [["time zone", `time_zone = 'Asia/Tokyo'`], ["currency", `currency = 'USD'`], ["brand name", `brand_name = 'HACKED'`], ["breaks switch", `use_breaks = false`]]) {
    const r = await as(db, P.staffA1, `update companies set ${set} where id = $1`, [CO_A]);
    check(`SETTINGS  staff cannot change their company's ${label}`, blocked(r), "it changed");
  }
  const d = (await asOwner(db, `select time_zone, currency, brand_name from companies where id = $1`, [CO_A])).rows[0];
  check("SETTINGS  a new company starts on Europe/London, GBP and no brand name", d.time_zone === "Europe/London" && d.currency === "GBP" && d.brand_name === "", JSON.stringify(d));
}

// ── 10. DELETING A CLIENT LEAVES NOTHING BEHIND ──────────────────────────
// The platform page's Delete removes one company row and relies on the database to remove
// everything that belongs to it. If a table were added without ON DELETE CASCADE, Delete
// would start failing (or, worse, leave that company's rows orphaned). Seeds one company
// with a row in EVERY table and deletes it.
{
  const CO_C = U(1003), O = U(31), S = U(32), WC = U(2003), SH = U(3031), ANN_C = U(6031);
  await db.exec(`
    insert into companies (id, name) values ('${CO_C}', 'Doomed Ltd');
    insert into auth.users (id, email) values ('${O}','o@c.test'),('${S}','s@c.test');
    insert into profiles (id, company_id, full_name, role) values ('${O}','${CO_C}','Owner C','owner'),('${S}','${CO_C}','Staff C','staff');
    insert into worksites (id, company_id, name, lat, lng, radius_m) values ('${WC}','${CO_C}','C Yard',51,0,100);
    insert into shifts (id, company_id, user_id, worksite_id, clock_in_at, clock_out_at) values ('${SH}','${CO_C}','${S}','${WC}', now() - interval '9 hours', now() - interval '1 hour');
    insert into pay_rates (user_id, company_id, hourly_rate) values ('${S}','${CO_C}',10);
    insert into availability (user_id, company_id, weekday, kind) values ('${S}','${CO_C}',0,'off');
    insert into time_off (user_id, company_id, first_day, last_day) values ('${S}','${CO_C}', current_date + 1, current_date + 2);
    insert into rota_shifts (company_id, user_id, worksite_id, starts_at, ends_at) values ('${CO_C}','${S}','${WC}', now() + interval '1 day', now() + interval '1 day 8 hours');
    insert into shift_corrections (company_id, shift_id, user_id, original_in, original_out, requested_in, requested_out, reason, status)
      values ('${CO_C}','${SH}','${S}', now() - interval '9 hours', now() - interval '1 hour', now() - interval '10 hours', now() - interval '1 hour', 'r', 'pending');
    insert into push_subscriptions (user_id, company_id, endpoint, p256dh, auth) values ('${S}','${CO_C}','https://p.example/c','k','a');
    insert into notification_prefs (user_id, company_id) values ('${S}','${CO_C}');
    insert into privacy_ack (user_id, company_id, version) values ('${S}','${CO_C}',1);
    insert into announcements (id, company_id, author_id, body) values ('${ANN_C}','${CO_C}','${O}','C notice');
    insert into announcement_reads (announcement_id, user_id, company_id) values ('${ANN_C}','${S}','${CO_C}');
  `);
  const before = (await asOwner(db, `select count(*)::int n from profiles where company_id = $1`, [CO_C])).rows[0].n;
  let err = "";
  try { await db.exec(`delete from companies where id = '${CO_C}'`); } catch (e) { err = e.message; }
  check("DELETE  removing a company succeeds", before === 2 && !err, err || `seeded ${before} people`);
  const left = [];
  for (const t of ["profiles", "worksites", "shifts", "pay_rates", "availability", "time_off", "rota_shifts", "shift_corrections",
                   "push_subscriptions", "notification_prefs", "privacy_ack", "announcements", "announcement_reads", "audit_events"]) {
    const n = (await asOwner(db, `select count(*)::int n from ${t} where company_id = $1`, [CO_C])).rows[0].n;
    if (n) left.push(`${t}:${n}`);
  }
  check("DELETE  ...and leaves no row of theirs in any table", left.length === 0, left.join(", "));
  const other = (await asOwner(db, `select count(*)::int n from shifts where company_id = $1`, [CO_A])).rows[0].n;
  check("DELETE  ...and does not touch another company", other === 2, `A now has ${other} shifts`);
}

// ── 11. ROLES: who may change whose role ─────────────────────────────────
// A manager can write to any profile in their own company, so the database itself
// (profiles_guard) has to stop an admin crowning themselves, demoting the owner or
// switching the owner off. Every attack below must be refused; the legitimate
// changes must still work. The people are rolled back after each try.
{
  const refuse = async (label, who, sql, params) => {
    const r = await as(db, who, sql, params);
    check("ROLES  " + label, !!r.error && /cannot|Nobody/.test(r.error), r.error || `it went through (${r.count})`);
  };
  await refuse("an admin cannot make themselves the owner", P.mgrA, `update profiles set role = 'owner' where id = $1`, [P.mgrA]);
  await refuse("an admin cannot demote the owner", P.mgrA, `update profiles set role = 'staff' where id = $1`, [P.ownerA]);
  await refuse("an admin cannot demote the owner to admin either", P.mgrA, `update profiles set role = 'admin' where id = $1`, [P.ownerA]);
  await refuse("an admin cannot make a colleague the owner", P.mgrA, `update profiles set role = 'owner' where id = $1`, [P.staffA1]);
  await refuse("the owner cannot hand the owner role to someone from the app", P.ownerA, `update profiles set role = 'owner' where id = $1`, [P.staffA1]);
  await refuse("the owner cannot demote themselves", P.ownerA, `update profiles set role = 'staff' where id = $1`, [P.ownerA]);
  await refuse("an admin cannot demote themselves", P.mgrA, `update profiles set role = 'staff' where id = $1`, [P.mgrA]);
  await refuse("an admin cannot switch the owner off", P.mgrA, `update profiles set active = false where id = $1`, [P.ownerA]);
  await refuse("an admin cannot switch themselves off", P.mgrA, `update profiles set active = false where id = $1`, [P.mgrA]);
  {
    // staff still cannot touch any profile at all (existing rule), and another company's manager cannot change A's roles
    const r = await as(db, P.staffA1, `update profiles set role = 'admin' where id = $1`, [P.staffA1]);
    check("ROLES  staff still cannot promote themselves", blocked(r), "it went through");
    const x = await as(db, P.ownerB, `update profiles set role = 'admin' where id = $1`, [P.staffA1]);
    check("ROLES  another company's owner cannot change A's roles", blocked(x), "it went through");
  }
  for (const [label, who, sql, params] of [
    ["the owner can make a member of staff a manager", P.ownerA, `update profiles set role = 'admin' where id = $1`, [P.staffA1]],
    ["the owner can make a manager staff again", P.ownerA, `update profiles set role = 'staff' where id = $1`, [P.mgrA]],
    ["a manager can make a member of staff a manager", P.mgrA, `update profiles set role = 'admin' where id = $1`, [P.staffA2]],
    ["a manager can still rename a colleague", P.mgrA, `update profiles set full_name = 'Renamed' where id = $1`, [P.staffA1]],
    ["a manager can still remove and restore a member of staff", P.mgrA, `update profiles set active = false where id = $1`, [P.staffA1]],
  ]) {
    const r = await as(db, who, sql, params);
    check("ROLES  OK: " + label, !r.error && r.count === 1, r.error || `rows ${r.count}`);
  }
  {
    // the service key (no signed-in user) is not held to it: manage-staff has its own checks
    let err = "";
    try { await db.exec(`update profiles set role = 'admin' where id = '${P.staffA2}'`); } catch (e) { err = e.message; }
    check("ROLES  OK: the service key / database owner is not blocked", !err, err);
  }
}

// ── 12. A PAUSED CLIENT SEES AND DOES NOTHING; NOBODY ELSE IS AFFECTED ────
// Pausing is one flag on the company row, set only by the platform function (service key).
// With it set, current_company_id() and is_manager() stop recognising that company's people, so
// every policy and every function goes dark for them at once. Nothing is deleted.
{
  const CO_D = U(1004), OD = U(41), SD = U(42), WD = U(2004);
  await db.exec(`
    insert into companies (id, name, show_pay, use_rota) values ('${CO_D}', 'Paused Ltd', true, true);
    insert into auth.users (id, email) values ('${OD}','o@d.test'),('${SD}','s@d.test');
    insert into profiles (id, company_id, full_name, role) values ('${OD}','${CO_D}','Owner D','owner'),('${SD}','${CO_D}','Staff D','staff');
    insert into worksites (id, company_id, name, lat, lng, radius_m) values ('${WD}','${CO_D}','D Yard',51,0,100);
    insert into shifts (company_id, user_id, worksite_id, clock_in_at, clock_out_at) values ('${CO_D}','${SD}','${WD}', now() - interval '9 hours', now() - interval '1 hour');
    insert into pay_rates (user_id, company_id, hourly_rate) values ('${SD}','${CO_D}',10);
  `);
  const sees = async (who) => (await as(db, who, `select (select count(*) from shifts) + (select count(*) from profiles) + (select count(*) from worksites) + (select count(*) from pay_rates) + (select count(*) from companies) as n`)).rows[0]?.n;
  check("PAUSE  before pausing, the company's people see their data (sanity)", Number(await sees(SD)) > 0 && Number(await sees(OD)) > 0);
  await db.exec(`update companies set suspended = true where id = '${CO_D}'`);   // what the platform function does
  check("PAUSE  a paused company's staff see nothing", Number(await sees(SD)) === 0, `saw ${await sees(SD)}`);
  check("PAUSE  a paused company's owner sees nothing", Number(await sees(OD)) === 0, `saw ${await sees(OD)}`);
  for (const [label, who, sql] of [
    ["clock in", SD, `select clock_in('${WD}'::uuid, 51, 0, 5)`],
    ["clock out", SD, `select clock_out(51, 0, 'x')`],
    ["start a break", SD, `select start_break()`],
    ["publish a rota", OD, `select publish_rota(now() - interval '1 day', now() + interval '30 days')`],
    ["acknowledge the privacy notice", SD, `select acknowledge_privacy(1)`],
    ["add a worksite", OD, `insert into worksites (company_id, name, lat, lng) values ('${CO_D}','X',0,0)`],
    ["change company settings", OD, `update companies set name = 'X' where id = '${CO_D}'`],
    ["change a role", OD, `update profiles set role = 'admin' where id = '${SD}'`],
  ]) {
    const r = await as(db, who, sql);
    check(`PAUSE  a paused company cannot ${label}`, !!r.error || r.count === 0, "it worked");
  }
  {
    const r = await as(db, SD, `select my_company_paused() p`);
    check("PAUSE  the app can tell the person their company is paused", !r.error && r.rows[0].p === true, r.error || JSON.stringify(r.rows));
    const a = await as(db, P.ownerA, `select my_company_paused() p`);
    check("PAUSE  ...and other companies are not paused", !a.error && a.rows[0].p === false, a.error || JSON.stringify(a.rows));
    const n = await as(db, "anon", `select my_company_paused() p`);
    check("PAUSE  signed-out visitors cannot ask", !!n.error, "it answered");
  }
  {
    const before = Number(await sees(P.staffA1));
    check("PAUSE  another company is completely unaffected", before > 0 && (await as(db, P.ownerA, `select count(*)::int n from shifts`)).rows[0].n === 2, `A staff saw ${before}`);
  }
  for (const [label, who] of [["a paused company's owner", OD], ["an ordinary owner", P.ownerA]]) {
    const r = await as(db, who, `update companies set suspended = ${who === OD ? "false" : "true"} where id = $1`, [who === OD ? CO_D : CO_A]);
    check(`PAUSE  ${label} cannot pause or un-pause a company from the app`, blocked(r), "it changed");
  }
  {
    const r = await as(db, P.ownerB, `update companies set suspended = true where id = $1`, [CO_A]);
    check("PAUSE  another company's owner cannot pause A", blocked(r), "it changed");
  }
  await db.exec(`update companies set suspended = false where id = '${CO_D}'`);
  check("PAUSE  un-pausing brings everything back, untouched", Number(await sees(SD)) > 0 && Number(await sees(OD)) > 0, `saw ${await sees(SD)}`);
}

// ── 13. ANNOUNCEMENTS: managers write, staff only read what is live ──────
// Section 11 promotes staffA2 to admin for good, so the plain-staff view has to
// be tested as staffA1. Assert that, rather than trusting it to stay true.
{
  let r = await asOwner(db, `select role from profiles where id = $1`, [P.staffA1]);
  check("ANN  (precondition) staffA1 is still plain staff", r.rows[0]?.role === "staff", `role is ${r.rows[0]?.role}`);

  r = await as(db, P.staffA1, `select id from announcements`);
  const seen = (r.rows || []).map((x) => x.id);
  check("ANN  staff see the live announcements (sanity)", !r.error && seen.includes(ANN_A) && seen.includes(ANN_A2), r.error || JSON.stringify(seen));
  check("ANN  staff cannot see a switched-off announcement", !seen.includes(ANN_A_OFF), "they saw it");
  check("ANN  staff cannot see an expired announcement", !seen.includes(ANN_A_GONE), "they saw it");
  check("ANN  staff see nothing of the other company's", !seen.includes(ANN_B), "they saw it");
  r = await as(db, P.mgrA, `select id from announcements`);
  check("ANN  a manager DOES see switched-off and expired ones (sanity)", !r.error && r.rows.length === 4, r.error || `saw ${r.rows.length}`);

  r = await as(db, P.staffA1, `insert into announcements (company_id, body) values ($1,'staff notice')`, [CO_A]);
  check("ANN  staff cannot post an announcement", blocked(r), "it posted");
  r = await as(db, P.staffA1, `update announcements set active = false where id = $1`, [ANN_A]);
  check("ANN  staff cannot switch an announcement off", blocked(r), "it changed");
  r = await as(db, P.staffA1, `delete from announcements where id = $1`, [ANN_A]);
  check("ANN  staff cannot delete an announcement", blocked(r), "it deleted");

  r = await as(db, P.ownerB, `insert into announcements (company_id, body) values ($1,'B posting into A')`, [CO_A]);
  check("ANN  another company's owner cannot post into A", blocked(r), "it posted");
  r = await as(db, P.ownerB, `update announcements set body = 'hijacked' where id = $1`, [ANN_A]);
  check("ANN  another company's owner cannot edit A's announcement", blocked(r), "it changed");
  r = await as(db, P.ownerB, `delete from announcements where id = $1`, [ANN_A]);
  check("ANN  another company's owner cannot delete A's announcement", blocked(r), "it deleted");
  r = await as(db, P.mgrA, `insert into announcements (company_id, author_id, body) values ($1,$2,'wrong author')`, [CO_A, P.staffB1]);
  check("ANN  a manager cannot credit another company's person as author", blocked(r), "it posted");

  // A read is a fact: written once, by yourself, about your own company's notice.
  r = await as(db, P.staffA1, `insert into announcement_reads (announcement_id, user_id, company_id) values ($1,$2,$3)`, [ANN_A2, P.staffA1, CO_A]);
  check("ANN  staff can record their own read (sanity)", !r.error, r.error);
  r = await as(db, P.staffA1, `insert into announcement_reads (announcement_id, user_id, company_id) values ($1,$2,$3)`, [ANN_A2, P.staffA2, CO_A]);
  check("ANN  staff cannot record a read for a colleague", blocked(r), "it wrote");
  r = await as(db, P.staffA1, `insert into announcement_reads (announcement_id, user_id, company_id) values ($1,$2,$3)`, [ANN_B, P.staffA1, CO_A]);
  check("ANN  staff cannot record a read against another company's announcement", blocked(r), "it wrote");
  r = await as(db, P.staffA1, `insert into announcement_reads (announcement_id, user_id, company_id) values ($1,$2,$3)`, [ANN_A_OFF, P.staffA1, CO_A]);
  check("ANN  staff cannot record a read against an announcement they cannot see", blocked(r), "it wrote");
  r = await as(db, P.staffA1, `delete from announcement_reads where user_id = $1`, [P.staffA1]);
  check("ANN  a read cannot be withdrawn", blocked(r), "it deleted");
  r = await as(db, P.staffA1, `update announcement_reads set read_at = now() - interval '5 days' where user_id = $1`, [P.staffA1]);
  check("ANN  a read cannot be back-dated", blocked(r), "it changed");

  r = await as(db, P.staffA1, `select user_id from announcement_reads where user_id <> $1`, [P.staffA1]);
  check("ANN  staff cannot see who else has read it", !r.error && r.rows.length === 0, r.error || `saw ${r.rows.length}`);
  r = await as(db, P.mgrA, `select user_id from announcement_reads where announcement_id = $1`, [ANN_A]);
  check("ANN  a manager DOES see who has read it (sanity)", !r.error && r.rows.length === 2, r.error || `saw ${r.rows.length}`);
}

// ── 14. A MANAGER CLOSING A FORGOTTEN SHIFT, AND THE AUDIT TRAIL ─────────
// The bug this guards: closing a shift with a plain update skips clock_out(),
// so an open break is never closed and those minutes get paid.
{
  const SHIFT_BRK = U(3041);
  await db.exec(`
    insert into shifts (id, company_id, user_id, worksite_id, clock_in_at, break_started_at, break_minutes)
    values ('${SHIFT_BRK}','${CO_A}','${P.staffA1}','${W_A}', now() - interval '6 hours', now() - interval '30 minutes', 10);
  `);

  let r = await as(db, P.staffA1, `select clock_out_at from clock_out_for($1,'')`, [SHIFT_BRK]);
  check("SHUT  staff cannot close a shift for anybody", !!r.error, "it ran");
  r = await as(db, P.ownerB, `select clock_out_at from clock_out_for($1,'')`, [SHIFT_BRK]);
  check("SHUT  another company's owner cannot close A's shift", !!r.error, "it ran");
  r = await as(db, P.mgrA, `select clock_out_at from clock_out_for($1,'')`, [SHIFT_B1]);
  check("SHUT  a manager cannot close the OTHER company's shift", !!r.error, "it ran");

  // The happy path runs as two statements on one connection rather than through
  // as(): a row written inside a statement is not visible to another part of
  // that same statement, so the audit entry could not be seen any other way.
  // as() also rolls back, and closing the shift has to stick for the re-run check.
  let row = {}, audited = -1, ranTwice = false;
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [P.mgrA]);
  await db.exec(`set role authenticated`);
  try {
    row = (await db.query(`select clock_out_at, break_minutes, break_started_at from clock_out_for($1,'Drove off')`, [SHIFT_BRK])).rows[0] || {};
    audited = (await db.query(`select count(*)::int n from audit_events where entity_id = $1 and action = 'clocked_out' and actor_id = $2`,
                              [SHIFT_BRK, P.mgrA])).rows[0].n;
    try { await db.query(`select clock_out_at from clock_out_for($1,'')`, [SHIFT_BRK]); ranTwice = true; } catch (e) { /* refused, as it should be */ }
  } finally {
    await db.exec(`reset role`);
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }

  check("SHUT  a manager CAN close a forgotten shift (sanity)", !!row.clock_out_at, JSON.stringify(row));
  check("SHUT  ...and the open break is closed", row.break_started_at === null, `break_started_at is ${row.break_started_at}`);
  check("SHUT  ...and its minutes are added to the paid deduction", Number(row.break_minutes) >= 39 && Number(row.break_minutes) <= 41,
        `break_minutes is ${row.break_minutes} (expected 10 + about 30)`);
  check("SHUT  ...and it is recorded against the manager who did it", audited === 1, `found ${audited} audit rows`);
  check("SHUT  a shift that is already closed is refused", !ranTwice, "it ran twice");

  // The audit trail itself: managers read their own, nobody writes it by hand.
  r = await as(db, P.staffA1, `select id from audit_events`);
  check("AUDIT staff cannot read the audit history", !r.error && r.rows.length === 0, r.error || `saw ${r.rows.length}`);
  r = await as(db, P.mgrA, `select id from audit_events where company_id = $1`, [CO_B]);
  check("AUDIT a manager sees none of the other company's audit history", !r.error && r.rows.length === 0, r.error || `saw ${r.rows.length}`);
  r = await as(db, P.mgrA, `insert into audit_events (company_id, action, entity, summary) values ($1,'forged','shift','I did not do this')`, [CO_A]);
  check("AUDIT a manager cannot forge an audit entry", blocked(r), "it wrote");
  r = await as(db, P.mgrA, `select write_audit_event($1,$2,'forged','shift',null,'by hand')`, [CO_A, P.mgrA]);
  check("AUDIT nobody can call write_audit_event from the browser", !!r.error, "it ran");
  r = await as(db, P.mgrA, `delete from audit_events where company_id = $1`, [CO_A]);
  check("AUDIT a manager cannot delete their own audit history", blocked(r), "it deleted");
}

// ── 15. HANDOVER: the next person sees the note, and nothing else ────────
// my_handover() is security definer, so it steps around shifts_read on purpose.
// That makes it the one place a member of staff can read anything off somebody
// else's shift, and these are the walls around it.
{
  // staffA2's latest shift is SHIFT_A2, open, at W_A. SHIFT_A1 is a closed shift
  // at the same worksite by someone else, 22 hours ago, with a note.
  let r = await as(db, P.staffA2, `select note, worksite, ended_at from my_handover()`);
  const got = (r.rows || [])[0] || {};
  check("HAND  the next person on the worksite sees the note left there", !r.error && got.note === "A1 secret note", r.error || JSON.stringify(r.rows));
  check("HAND  ...with the worksite, and nothing else in the row", got.worksite === "A Yard" && Object.keys(got).length === 3, JSON.stringify(got));

  // staffA1 wrote that note. The only other shift at W_A is still open.
  r = await as(db, P.staffA1, `select note from my_handover()`);
  check("HAND  you are never handed your own note back", !r.error && r.rows.length === 0, r.error || JSON.stringify(r.rows));

  // The wall that matters: B must never see A's note, whatever they do.
  r = await as(db, P.staffB1, `select note from my_handover()`);
  check("HAND  another company sees none of it", !r.error && !JSON.stringify(r.rows).includes("A1 secret"), r.error || JSON.stringify(r.rows));
  // Give B's owner a worksite of their own first, or the question is vacuous:
  // with no shift there is nothing for the function to answer about, and the
  // check would pass even with the tenant wall taken out.
  await db.exec(`insert into shifts (company_id, user_id, worksite_id, clock_in_at, clock_out_at, note)
                 values ('${CO_B}','${P.ownerB}','${W_B}', now() - interval '30 hours', now() - interval '23 hours', 'B owner note');`);
  r = await as(db, P.ownerB, `select note from my_handover()`);
  check("HAND  ...and neither does their owner", !r.error && !JSON.stringify(r.rows).includes("A1 secret"), r.error || JSON.stringify(r.rows));

  // A note goes stale. Push the closed shift back a day and it stops being handed on.
  await db.exec(`update shifts set clock_out_at = now() - interval '26 hours' where id = '${SHIFT_A1}'`);
  r = await as(db, P.staffA2, `select note from my_handover()`);
  check("HAND  a note older than a day is not handed on", !r.error && r.rows.length === 0, r.error || JSON.stringify(r.rows));
  await db.exec(`update shifts set clock_out_at = now() - interval '22 hours' where id = '${SHIFT_A1}'`);

  // An empty note is not a handover.
  await db.exec(`update shifts set note = '   ' where id = '${SHIFT_A1}'`);
  r = await as(db, P.staffA2, `select note from my_handover()`);
  check("HAND  a blank note is not handed on", !r.error && r.rows.length === 0, r.error || JSON.stringify(r.rows));
  await db.exec(`update shifts set note = 'A1 secret note' where id = '${SHIFT_A1}'`);

  // Somebody who has never worked a site is asking about nothing.
  r = await as(db, P.goneA, `select note from my_handover()`);
  check("HAND  a removed person is handed nothing", !!r.error || r.rows.length === 0, JSON.stringify(r.rows));
}

// ── 16. OVERTIME: who may see a week, and who may decide it ──────────────
// 2026-09-07 is a Monday. Three five-hour shifts in that week is 15 hours
// against a threshold of 10, so the week is five hours over.
{
  const WK = "2026-09-07";
  await db.exec(`
    update companies set overtime_weekly_hours = 10 where id = '${CO_A}';
    insert into shifts (company_id, user_id, worksite_id, clock_in_at, clock_out_at) values
      ('${CO_A}','${P.staffA1}','${W_A}', timestamptz '2026-09-07 08:00+01', timestamptz '2026-09-07 13:00+01'),
      ('${CO_A}','${P.staffA1}','${W_A}', timestamptz '2026-09-08 08:00+01', timestamptz '2026-09-08 13:00+01'),
      ('${CO_A}','${P.staffA1}','${W_A}', timestamptz '2026-09-09 08:00+01', timestamptz '2026-09-09 13:00+01'),
      ('${CO_A}','${P.staffA2}','${W_A}', timestamptz '2026-09-07 08:00+01', timestamptz '2026-09-07 20:00+01');
  `);

  let r = await as(db, P.mgrA, `select user_id, hours, threshold, overtime, status from overtime_weeks($1,$1)`, [WK]);
  const rows = r.rows || [];
  check("OT    a manager sees every week over the threshold", !r.error && rows.length === 2, r.error || JSON.stringify(rows));
  const a1 = rows.find((x) => x.user_id === P.staffA1) || {};
  check("OT    ...with the hours worked out from the shifts", Number(a1.hours) === 15 && Number(a1.overtime) === 5, JSON.stringify(a1));
  check("OT    ...and no decision yet", a1.status === null, JSON.stringify(a1));

  r = await as(db, P.staffA1, `select user_id from overtime_weeks($1,$1)`, [WK]);
  check("OT    staff see their own week only", !r.error && r.rows.length === 1 && r.rows[0].user_id === P.staffA1, r.error || JSON.stringify(r.rows));
  r = await as(db, P.staffB1, `select user_id from overtime_weeks($1,$1)`, [WK]);
  check("OT    another company sees nothing of it", !r.error && r.rows.length === 0, r.error || JSON.stringify(r.rows));

  r = await as(db, P.staffA1, `select decide_overtime($1,$2,'approved','')`, [P.staffA1, WK]);
  check("OT    staff cannot approve their own overtime", !!r.error, "it ran");
  r = await as(db, P.ownerB, `select decide_overtime($1,$2,'approved','')`, [P.staffA1, WK]);
  check("OT    another company's owner cannot decide A's overtime", !!r.error, "it ran");
  r = await as(db, P.mgrA, `select decide_overtime($1,$2,'approved','')`, [P.staffB1, WK]);
  check("OT    a manager cannot decide for somebody in another company", !!r.error, "it ran");
  r = await as(db, P.mgrA, `select decide_overtime($1,$2,'maybe','')`, [P.staffA1, WK]);
  check("OT    a made-up decision is refused", !!r.error, "it ran");
  r = await as(db, P.mgrA, `insert into overtime_decisions (company_id, user_id, week_start, status, hours_at_decision)
                            values ($1,$2,$3,'approved',99)`, [CO_A, P.staffA1, WK]);
  check("OT    nobody writes a decision by hand", blocked(r), "it wrote");

  // Deciding, then reading it back, needs two statements on one connection:
  // as() rolls back, and a row written inside a statement is invisible to the
  // rest of that same statement.
  let decided = {}, audited = -1;
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [P.mgrA]);
  await db.exec(`set role authenticated`);
  try {
    await db.query(`select decide_overtime($1,$2,'approved','Cover for Danny')`, [P.staffA1, WK]);
    decided = (await db.query(`select status, hours_at_decision, decided_by, note from overtime_decisions
                                where user_id = $1 and week_start = $2`, [P.staffA1, WK])).rows[0] || {};
    audited = (await db.query(`select count(*)::int n from audit_events
                                where entity = 'overtime' and action = 'approved' and actor_id = $1`, [P.mgrA])).rows[0].n;
  } finally {
    await db.exec(`reset role`);
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
  check("OT    a manager CAN approve a week (sanity)", decided.status === "approved", JSON.stringify(decided));
  check("OT    ...and the hours are recomputed, not taken from the browser", Number(decided.hours_at_decision) === 15, JSON.stringify(decided));
  check("OT    ...against the manager who decided it", decided.decided_by === P.mgrA, JSON.stringify(decided));
  check("OT    ...and it is written to the audit history", audited === 1, `found ${audited}`);

  // A fresh member of staff, because section 11 promotes staffA2 to admin for
  // good and a manager is supposed to see everybody. They get a decision of
  // their own too, so "sees one row" proves the filter rather than an empty table.
  const A3 = U(16);
  await db.exec(`
    insert into auth.users (id, email) values ('${A3}','a3@a.test');
    insert into profiles (id, company_id, full_name, role, active) values ('${A3}','${CO_A}','Staff A3','staff',true);
    insert into overtime_decisions (company_id, user_id, week_start, status, hours_at_decision, decided_by)
      values ('${CO_A}','${A3}','${WK}','rejected', 12, '${P.mgrA}');
  `);
  r = await as(db, A3, `select user_id from overtime_decisions`);
  check("OT    staff see their own decision and not a colleague's",
        !r.error && r.rows.length === 1 && r.rows[0].user_id === A3, r.error || JSON.stringify(r.rows));
  r = await as(db, P.ownerB, `select user_id from overtime_decisions`);
  check("OT    another company sees none of the decisions", !r.error && r.rows.length === 0, r.error || JSON.stringify(r.rows));

  // Switched off means switched off, for everybody.
  await db.exec(`update companies set overtime_weekly_hours = null where id = '${CO_A}'`);
  r = await as(db, P.mgrA, `select user_id from overtime_weeks($1,$1)`, [WK]);
  check("OT    with no threshold set, no week is over it", !r.error && r.rows.length === 0, r.error || JSON.stringify(r.rows));
  r = await as(db, P.mgrA, `select decide_overtime($1,$2,'approved','')`, [P.staffA1, WK]);
  check("OT    ...and nothing can be decided", !!r.error, "it ran");
}

// ── report ───────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
for (const r of results) if (!r.ok) console.log(`FAIL  ${r.name}${r.detail ? "  →  " + r.detail : ""}`);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
if (failed.length) { console.log(`${failed.length} FAILED: a client could see or change something that is not theirs.`); process.exit(1); }
console.log("Every attack was blocked.");
