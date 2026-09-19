// Can PostgREST still work out every embedded table in the pages?
//
//   cd checks && npm run embeds
//
// Why this exists: on 19 Sep 2026 the whole app stopped loading with
//
//   Could not embed because more than one relationship was found
//   for 'profiles' and 'companies'
//
// Both pages fetch the signed-in profile with companies(name) embedded.
// PostgREST works that out from the foreign keys, and it was unambiguous while
// profiles was the only route from a person to their company. Then tables were
// added -- announcements, announcement_reads, overtime_decisions, audit_events
// -- each carrying a foreign key to BOTH profiles and companies. PostgREST saw
// several possible paths and refused to guess. Nobody could sign in.
//
// Neither smoke nor isolation caught it: the harness is PGlite alone, so it
// tests the SQL and the policies, but nothing there is PostgREST and nothing
// knows how it reads a schema. This check fills that specific hole. It reads
// the real schema.sql, works out every way one table can reach another, and
// fails when a page embeds a table that can be reached more than one way
// without saying which to use.
//
// The fix for a failure is always the same: name the constraint, e.g.
//   companies!profiles_company_id_fkey(name)
import { boot, asOwner } from "./harness.mjs";
import { readFileSync } from "node:fs";

const PAGES = ["../index.html", "../admin.html", "../platform.html"];

// ── every foreign key in the real schema ─────────────────────────────────
const db = await boot({});
const fks = (await asOwner(db, `
  select c.conname, r.relname as src, t.relname as dst
    from pg_constraint c
    join pg_class r on r.oid = c.conrelid
    join pg_class t on t.oid = c.confrelid
   where c.contype = 'f' and r.relnamespace = 'public'::regnamespace
`)).rows;

// Which columns make up each table's primary key. This matters: PostgREST only
// reads a table as a JUNCTION (and so infers a many-to-many) when the foreign
// keys to both sides are inside its primary key. A table that merely happens to
// point at two others -- shift_corrections, with its own id as the key -- is not
// a junction and creates no ambiguity. Getting this wrong makes the check cry
// wolf, and a check that cries wolf gets ignored.
const pkCols = {};
for (const row of (await asOwner(db, `
  select r.relname as tbl, a.attname as col
    from pg_constraint c
    join pg_class r on r.oid = c.conrelid
    join unnest(c.conkey) k(att) on true
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.att
   where c.contype = 'p' and r.relnamespace = 'public'::regnamespace
`)).rows) (pkCols[row.tbl] ??= []).push(row.col);

const fkCols = (await asOwner(db, `
  select r.relname as src, t.relname as dst, a.attname as col
    from pg_constraint c
    join pg_class r on r.oid = c.conrelid
    join pg_class t on t.oid = c.confrelid
    join unnest(c.conkey) k(att) on true
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.att
   where c.contype = 'f' and r.relnamespace = 'public'::regnamespace
`)).rows;

const joinsInsideKey = (junction, target) =>
  fkCols.some((f) => f.src === junction && f.dst === target && (pkCols[junction] ?? []).includes(f.col));

// How many ways can a row in `src` reach `dst`? Directly, back up from a table
// that points at it, or through a real junction table.
function paths(src, dst) {
  const direct = fks.filter((f) => f.src === src && f.dst === dst);
  const reverse = fks.filter((f) => f.src === dst && f.dst === src);
  const viaJunction = [...new Set(
    fks.filter((f) => f.dst === src).map((f) => f.src)
       .filter((j) => fks.some((f) => f.src === j && f.dst === dst))
       .filter((j) => joinsInsideKey(j, src) && joinsInsideKey(j, dst)))];
  return { direct: direct.length, reverse: reverse.length, junctions: viaJunction,
           total: direct.length + reverse.length + viaJunction.length };
}

// ── every embed the pages actually ask for ───────────────────────────────
// sb.from("x") ... .select("a, b, y(...)") -- the select follows the from
// closely enough that a short window is safe and keeps this readable.
const found = [];
for (const page of PAGES) {
  const src = readFileSync(page, "utf8");
  for (const m of src.matchAll(/\.from\(\s*["'`]([a-z_]+)["'`]\s*\)/g)) {
    const window = src.slice(m.index, m.index + 900);
    const sel = window.match(/\.select\(\s*["'`]([^"'`]*)["'`]/);
    if (!sel) continue;
    for (const e of sel[1].matchAll(/([a-z_]+)(!([a-z_]+))?\s*\(/g)) {
      found.push({ page: page.replace("../", ""), from: m[1], embed: e[1], hint: e[3] ?? null });
    }
  }
}

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });

check("the pages embed something at all (this check is not vacuous)", found.length > 0,
      "found no .from(...).select(...) embeds, so nothing was actually checked");

const seen = new Set();
for (const f of found) {
  const key = `${f.page}:${f.from}->${f.embed}${f.hint ? "!" + f.hint : ""}`;
  if (seen.has(key)) continue;
  seen.add(key);

  const p = paths(f.from, f.embed);
  if (p.total === 0) {
    // Not a table: almost certainly a PostgREST function like count(). Skip.
    continue;
  }
  if (f.hint) {
    check(`${f.page}: ${f.from} → ${f.embed} names a real constraint (${f.hint})`,
          fks.some((x) => x.conname === f.hint), `no constraint called ${f.hint}`);
    continue;
  }
  const how = [p.direct && `${p.direct} direct`, p.reverse && `${p.reverse} reverse`,
               p.junctions.length && `via ${p.junctions.join(", ")}`].filter(Boolean).join(" + ");
  check(`${f.page}: ${f.from} → ${f.embed} can only be read one way`, p.total === 1,
        `${p.total} possible routes (${how}) and the query does not say which — name the constraint`);
}

const failed = results.filter((r) => !r.ok);
for (const r of failed) console.log(`FAIL  ${r.name}\n      ${r.detail}`);
console.log(`\n${results.length - failed.length} of ${results.length} embed checks passed.`);
if (failed.length) {
  console.log(`${failed.length} FAILED: PostgREST cannot work these out, and the page will not load.`);
  process.exit(1);
}
console.log("Every embedded table can be worked out unambiguously.");
