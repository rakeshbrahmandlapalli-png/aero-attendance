// Is the pay maths right, to the penny?
//
//   cd checks && npm run payroll
//
// Pulls the REAL calculation out of admin.html (not a copy) and checks it against sums
// worked out by hand. Payslips are the one place a small mistake costs somebody money,
// so this covers the awkward cases: rounding a shift, a break, overtime that is approved
// versus not, a week cut off by the pay period, no hourly rate, deductions, half pennies.
import { readFileSync } from "node:fs";

const page = readFileSync("../admin.html", "utf8").replace(/\r\n/g, "\n");
function extract(name) {
  const start = page.search(new RegExp(`\\n( *)(async )?function ${name}\\(`));
  if (start < 0) throw new Error(`could not find function ${name} in admin.html`);
  const indent = /\n( *)/.exec(page.slice(start))[1];
  const end = page.indexOf(`\n${indent}}\n`, start + 1);
  return page.slice(start + 1, end + indent.length + 2);
}
const calc = new Function(`${extract("payShiftMinutes")}\n${extract("payrollCalc")}\nreturn payrollCalc;`)();

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
const same = (a, b) => Math.abs(a - b) < 1e-9;

// a shift on 2026-09-07 (a Monday) from hh:mm to hh:mm, in UTC so the test does not depend on where it runs
const shift = (user, day, from, to, brk = 0) => ({ user_id: user, clock_in_at: `2026-09-${day}T${from}:00Z`, clock_out_at: to ? `2026-09-${day}T${to}:00Z` : null, break_minutes: brk });
const base = { round: 0, otMode: "none", otMultiplier: 1, deduct: { kind: "none", value: 0 } };
const run = (shifts, opts = {}, extra = {}) => calc({ shifts, rates: { a: 10, b: 12.5 }, overtimeWeeks: [], from: "2026-09-07", to: "2026-09-13", opts: { ...base, ...opts }, ...extra });
const one = (r, id = "a") => r.people.find((p) => p.user_id === id);

// ── hours ──
let r = run([shift("a", "07", "09:00", "17:00", 30), shift("a", "08", "09:00", "17:00", 30), shift("a", "09", "09:00", "17:00", 30)]);
check("HOURS three 8-hour shifts with a 30 minute break are 22.5 hours", same(one(r).hours, 22.5), one(r).hours);
check("HOURS ...paid at 10 an hour is 225.00 gross", same(one(r).gross, 225), one(r).gross);
check("HOURS ...across 3 shifts", one(r).shifts === 3, one(r).shifts);

r = run([shift("a", "07", "09:00", "17:00"), shift("a", "08", "09:00", null)]);
check("HOURS a shift still running is not counted", one(r).shifts === 1 && same(one(r).hours, 8), JSON.stringify(one(r)));
r = run([shift("a", "07", "09:00", "09:20", 30)]);
check("HOURS a break longer than the shift never gives negative hours", same(one(r).hours, 0) && one(r).gross === 0, JSON.stringify(one(r)));

// ── rounding each shift ──
r = run([shift("a", "07", "08:07", "16:03")], { round: 15 });
check("ROUND  7h 56m to the nearest 15 minutes is 8 hours", same(one(r).hours, 8), one(r).hours);
r = run([shift("a", "07", "08:07", "16:03")], { round: 0 });
check("ROUND  ...and left exact it is 7h 56m", same(one(r).hours, 476 / 60), one(r).hours);
r = run([shift("a", "07", "08:00", "08:07"), shift("a", "08", "08:00", "08:08")], { round: 15 });
check("ROUND  rounding is applied to each shift, not the total (7 min goes down, 8 min goes up)", same(one(r).hours, 15 / 60), one(r).hours);
r = run([shift("a", "07", "08:00", "16:30", 30)], { round: 5 });
check("ROUND  the break comes off BEFORE rounding", same(one(r).hours, 8), one(r).hours);

// ── overtime ──
const week = (user, status, overtime, start = "2026-09-07") => ({ user_id: user, week_start: start, status, overtime });
const long = [shift("a", "07", "06:00", "16:00"), shift("a", "08", "06:00", "16:00"), shift("a", "09", "06:00", "16:00"), shift("a", "10", "06:00", "16:00"), shift("a", "11", "06:00", "16:30")];
r = run(long, { otMode: "multiplier", otMultiplier: 1.5 }, { overtimeWeeks: [week("a", "approved", 5.5)] });
check("OT     50.5 hours with 5.5 approved overtime: 45 normal and 5.5 overtime", same(one(r).regularHours, 45) && same(one(r).overtimeHours, 5.5), JSON.stringify(one(r)));
check("OT     ...pays 45 x 10 + 5.5 x 10 x 1.5 = 532.50", same(one(r).gross, 532.5), one(r).gross);
r = run(long, { otMode: "none" }, { overtimeWeeks: [week("a", "approved", 5.5)] });
check("OT     approved overtime paid at the normal rate when no multiple is chosen: 505.00", same(one(r).gross, 505), one(r).gross);
r = run(long, { otMode: "multiplier", otMultiplier: 2 }, { overtimeWeeks: [week("a", "pending", 5.5), week("a", "rejected", 5.5)] });
check("OT     overtime that is not approved is never paid extra", same(one(r).overtimeHours, 0) && same(one(r).gross, 505), JSON.stringify(one(r)));
check("OT     ...and the statement says how many weeks are still waiting", r.pendingWeeks === 2, r.pendingWeeks);
r = run(long, { otMode: "multiplier", otMultiplier: 1.5 }, { overtimeWeeks: [week("a", "approved", 5.5)], from: "2026-09-09", to: "2026-09-15" });
check("OT     a week cut off by the pay period is left out, not split", same(one(r).overtimeHours, 0) && r.partialWeeks === 1, JSON.stringify([one(r).overtimeHours, r.partialWeeks]));
r = run([shift("a", "07", "09:00", "13:00")], { otMode: "multiplier", otMultiplier: 1.5 }, { overtimeWeeks: [week("a", "approved", 30)] });
check("OT     overtime can never be more than the hours actually worked", same(one(r).overtimeHours, 4) && same(one(r).regularHours, 0), JSON.stringify(one(r)));
r = run([shift("a", "07", "09:00", "17:00"), shift("b", "07", "09:00", "17:00")], { otMode: "multiplier", otMultiplier: 1.5 }, { overtimeWeeks: [week("b", "approved", 3)] });
check("OT     one person's overtime is never given to another", same(one(r, "a").overtimeHours, 0) && same(one(r, "b").overtimeHours, 3), JSON.stringify(r.people));

// ── rate ──
r = calc({ shifts: [shift("z", "07", "09:00", "17:00")], rates: {}, overtimeWeeks: [], from: "2026-09-07", to: "2026-09-13", opts: base });
check("RATE   nobody with no hourly rate is paid, and it is flagged", one(r, "z").missingRate === true && one(r, "z").gross === 0, JSON.stringify(one(r, "z")));
r = calc({ shifts: [shift("z", "07", "09:00", "17:00")], rates: { z: 0 }, overtimeWeeks: [], from: "2026-09-07", to: "2026-09-13", opts: base });
check("RATE   a rate of nought is a rate (and pays nothing), not a missing one", one(r, "z").missingRate === false && one(r, "z").gross === 0, JSON.stringify(one(r, "z")));

// ── pence ──
r = calc({ shifts: [shift("a", "07", "09:00", "09:30")], rates: { a: 10.05 }, overtimeWeeks: [], from: "2026-09-07", to: "2026-09-13", opts: base });
check("PENCE  half an hour at 10.05 is 5.025, which rounds UP to 5.03", one(r).gross === 5.03, one(r).gross);
// These two sit just BELOW the half penny once stored as floating point (1.005 * 100 is
// 100.49999999999999), so a plain Math.round would pay a penny short. The first one is the
// case that proves the rounding is doing its job.
r = calc({ shifts: [shift("a", "07", "09:00", "09:30")], rates: { a: 2.01 }, overtimeWeeks: [], from: "2026-09-07", to: "2026-09-13", opts: base });
check("PENCE  half an hour at 2.01 is 1.005, which must round UP to 1.01, not down to 1.00", one(r).gross === 1.01, one(r).gross);
r = calc({ shifts: [shift("a", "07", "09:00", "09:30")], rates: { a: 16.69 }, overtimeWeeks: [], from: "2026-09-07", to: "2026-09-13", opts: base });
check("PENCE  half an hour at 16.69 is 8.345, which must round UP to 8.35", one(r).gross === 8.35, one(r).gross);
r = calc({ shifts: [shift("a", "07", "09:00", "10:20")], rates: { a: 10.55 }, overtimeWeeks: [], from: "2026-09-07", to: "2026-09-13", opts: base });
check("PENCE  1h 20m at 10.55 is 14.0666..., which rounds to 14.07", one(r).gross === 14.07, one(r).gross);
r = run(long, { otMode: "multiplier", otMultiplier: 1.5 }, { overtimeWeeks: [week("a", "approved", 5.5)], rates: { a: 10.05 } });
check("PENCE  the lines on a statement add up to the gross: normal + overtime = gross", same(one(r).regularPay + one(r).overtimePay, one(r).gross), JSON.stringify(one(r)));

// ── deductions ──
const paid = [shift("a", "07", "09:00", "17:00"), shift("a", "08", "09:00", "17:00")];   // 16h at 10 = 160.00
r = run(paid, { deduct: { kind: "percent", value: 5 } });
check("DEDUCT 5% of 160.00 is 8.00 and net is 152.00", one(r).deduction === 8 && one(r).net === 152, JSON.stringify(one(r)));
r = run(paid, { deduct: { kind: "fixed", value: 25 } });
check("DEDUCT a fixed 25.00 leaves 135.00", one(r).deduction === 25 && one(r).net === 135, JSON.stringify(one(r)));
r = run(paid, { deduct: { kind: "fixed", value: 500 } });
check("DEDUCT a deduction bigger than the pay stops at the pay: net is never negative", one(r).deduction === 160 && one(r).net === 0, JSON.stringify(one(r)));
r = run(paid, { deduct: { kind: "percent", value: -10 } });
check("DEDUCT a negative deduction is ignored, not added to the pay", one(r).deduction === 0 && one(r).net === 160, JSON.stringify(one(r)));
r = run(paid, { deduct: { kind: "percent", value: 100 } });
check("DEDUCT 100% takes it all and no more", one(r).net === 0, JSON.stringify(one(r)));
r = run(paid, { deduct: { kind: "percent", value: 12.5 } });
check("DEDUCT 12.5% of 160.00 is 20.00", one(r).deduction === 20, JSON.stringify(one(r)));

// ── totals ──
r = run([shift("a", "07", "09:00", "17:00"), shift("b", "07", "09:00", "17:00")]);
check("TOTAL  the total is the sum of the people (80.00 + 100.00 = 180.00)", r.totals.gross === 180 && same(r.totals.hours, 16), JSON.stringify(r.totals));
check("TOTAL  nobody worked means nobody listed", run([]).people.length === 0, "");

const failed = results.filter((x) => !x.ok);
for (const x of failed) console.log(`FAIL  ${x.name}${x.detail ? "  →  " + x.detail : ""}`);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
if (failed.length) { console.log(`${failed.length} FAILED: somebody would be paid the wrong amount.`); process.exit(1); }
console.log("The pay maths is right to the penny.");
