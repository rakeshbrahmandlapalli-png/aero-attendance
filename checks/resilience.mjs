// What the pages do when the network or the database is slow or drops.
//
//   cd checks && npm run resilience
//
// Two failures the owner hit on 19 Sep 2026, neither of which any other check could see
// because they only happen in a browser talking to a slow server:
//
//   1. Clocking someone out ended in "AbortError: signal is aborted without reason". That
//      is the browser's own wording for the app giving up after 20 seconds. It says nothing
//      about what happened or which request it was.
//   2. The staff rota never updated on a phone that was left open, because it was loaded
//      once at sign-in and again only when the Rota tab was tapped.
//
// This pulls the REAL functions out of the pages (not copies) and runs them against a
// request that never answers, and a connection that drops.
import { readFileSync } from "node:fs";

const admin = readFileSync("../admin.html", "utf8").replace(/\r\n/g, "\n");
const staff = readFileSync("../index.html", "utf8").replace(/\r\n/g, "\n");

// The text of one function, from its "function name" line to its closing brace at the same indent.
function extract(src, name) {
  const start = src.search(new RegExp(`\\n( *)(async )?function ${name}\\(`));
  if (start < 0) throw new Error(`could not find function ${name} in the page`);
  const indent = /\n( *)/.exec(src.slice(start))[1];
  const end = src.indexOf(`\n${indent}}\n`, start + 1);
  return src.slice(start + 1, end + indent.length + 2);
}

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });

// ── 1. a request that never answers ──────────────────────────────────────
{
  const code = `
    var REQUEST_TIMEOUT_MS = 40;
    ${extract(admin, "timedFetch")}
    ${extract(admin, "isNetworkError")}
    ${extract(admin, "problemText")}
    return { timedFetch: timedFetch, isNetworkError: isNetworkError, problemText: problemText };
  `;
  // a fetch that honours abort the way a browser's does, and otherwise never returns
  const hang = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("signal is aborted without reason", "AbortError")));
  });
  const env = new Function("fetch", "navigator", "URL", code)(hang, { onLine: true }, URL);

  let err = null;
  try { await env.timedFetch("https://x.supabase.co/rest/v1/rpc/clock_out_for", {}); } catch (e) { err = e; }
  check("HANG  a request that never answers gives up", !!err, "it hung or returned");
  check("HANG  ...saying so in plain words, not the browser's 'signal is aborted'",
        err && /did not answer within/.test(err.message) && !/signal is aborted/.test(err.message), err && err.message);
  check("HANG  ...naming which request it was", err && /rpc\/clock_out_for/.test(err.message), err && err.message);
  check("HANG  ...and telling the person it may still have gone through", err && /may not have gone through/.test(err.message), err && err.message);
  check("HANG  the app still treats it as a connection problem", err && env.isNetworkError(err), "isNetworkError said no");

  // supabase-js wraps a thrown fetch error as "<name>: <message>"; the screen must not show that prefix
  const wrapped = { message: `${err.name}: ${err.message}` };
  const shown = env.problemText(wrapped);
  check("HANG  what is shown has no 'TimeoutError:' prefix and keeps the request name",
        !/^\w*Error:/.test(shown) && /rpc\/clock_out_for/.test(shown), shown);
  check("HANG  an ordinary failure still shows its real message", env.problemText(new Error("permission denied for table x")) === "permission denied for table x", "");

  // an ordinary quick answer is untouched
  const ok = new Function("fetch", "navigator", "URL", `
    var REQUEST_TIMEOUT_MS = 40; ${extract(admin, "timedFetch")} return timedFetch;`)(async () => ({ ok: true, status: 200 }), { onLine: true }, URL);
  check("HANG  a quick answer passes straight through", (await ok("https://x/rest/v1/a", {})).status === 200, "");
}

// ── 2. the staff rota keeps itself fresh, and a dropped signal never blanks it ──
{
  const load = extract(staff, "loadRota");
  const make = (companyResult, queryResult) => {
    const fails = [], state = { ROTA: { on: true, shifts: [{ id: "keep" }], avail: {}, off: [] }, rendered: 0 };
    const q = (result) => { const p = Promise.resolve(result); const chain = new Proxy(function () {}, { get: (_, k) => (k === "then" ? p.then.bind(p) : k === "catch" ? p.catch.bind(p) : () => chain) }); return chain; };
    const sb = { from: (t) => q(t === "companies" ? companyResult : queryResult) };
    const run = new Function("DEMO", "ME", "sb", "state", "fails", "localDay", `
      var ROTA = state.ROTA; function renderRota() { state.rendered++; } function fail(e) { fails.push(e); }
      ${load}
      return { call: loadRota, get ROTA() { return ROTA; } };`)(false, { id: "u1", company_id: "c1" }, sb, state, fails, () => "2026-09-19");
    return { run, state, fails };
  };
  const good = { data: { use_rota: true }, error: null };
  const dropped = { data: null, error: { message: "TypeError: Failed to fetch" } };

  let t = make(dropped, dropped);
  await t.run.call(true);
  check("ROTA  a background refresh on a dropped signal leaves the rota on screen", t.run.ROTA.on === true && t.run.ROTA.shifts.length === 1 && !t.state.rendered, JSON.stringify(t.run.ROTA));

  t = make(good, { data: [], error: { message: "TypeError: Failed to fetch" } });
  await t.run.call(true);
  check("ROTA  ...and shows no error for a refresh nobody asked for", t.fails.length === 0, JSON.stringify(t.fails));

  t = make(good, { data: [], error: { message: "TypeError: Failed to fetch" } });
  await t.run.call(false);
  check("ROTA  but tapping the Rota tab still reports a real failure", t.fails.length === 1, JSON.stringify(t.fails));

  t = make({ data: { use_rota: false }, error: null }, good);
  await t.run.call(true);
  check("ROTA  a company that switched the rota off still has it removed on refresh", t.run.ROTA.on === false, JSON.stringify(t.run.ROTA));

  // and the refresh really is wired to time and to coming back to the app
  check("ROTA  it refreshes every 30 seconds", /setInterval\(refreshRota,\s*30000\)/.test(staff), "no interval");
  check("ROTA  ...and the moment the app comes back to the front", /addEventListener\('visibilitychange',refreshRota\)/.test(staff), "no visibilitychange");
  check("ROTA  ...and when a page is restored from the back/forward cache", /addEventListener\('pageshow',refreshRota\)/.test(staff), "no pageshow");
}

// ── 3. a slow action says so instead of silently ignoring the tap ────────
check("BUSY  a tap during another action says so instead of doing nothing",
      /if \(writing\) \{ toast\(/.test(admin), "withLock still returns silently");

const failed = results.filter((r) => !r.ok);
for (const r of failed) console.log(`FAIL  ${r.name}${r.detail ? "  →  " + r.detail : ""}`);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
if (failed.length) { console.log(`${failed.length} FAILED.`); process.exit(1); }
console.log("A slow or dropped connection is handled in plain words, and the rota stays fresh.");
