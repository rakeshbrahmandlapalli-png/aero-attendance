// A stand-in for Supabase that runs the app's REAL database file.
//
// PGlite is PostgreSQL 17 compiled to WebAssembly: same planner, same
// row-level security, same plpgsql, same GRANT/REVOKE rules. What it is not is
// Supabase, so this file fakes the few Supabase-only pieces the schema touches:
//
//   roles       anon / authenticated / service_role, and the default table
//               privileges Supabase gives them (the schema's own REVOKEs are
//               what make tables safe, so the defaults must match)
//   auth        auth.users and auth.uid(), reading the "signed-in" user from a
//               session setting the way PostgREST does
//   extensions  pg_cron and pg_net become no-ops (they only run timers and
//               push HTTP calls, neither of which is what is being tested)
//
// WHAT THIS PROVES: the row-level security policies and the security-definer
// functions do what they say, against the real SQL.
// WHAT IT DOES NOT PROVE: Supabase's own login, PostgREST, or Edge Functions.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(HERE, "..", "setup", "schema.sql");

const STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema extensions;
  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    raw_user_meta_data jsonb not null default '{}',
    banned_until timestamptz,
    created_at timestamptz not null default now()
  );
  -- PostgREST puts the signed-in user's id in this setting for every request.
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.role() returns text language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;

  -- pg_cron and pg_net: present, and doing nothing.
  create schema cron;
  create table cron.job (jobid bigint generated always as identity primary key, jobname text);
  create function cron.schedule(job_name text, schedule text, command text) returns bigint
    language sql as $$ insert into cron.job(jobname) values (job_name) returning jobid $$;
  create function cron.unschedule(job_id bigint) returns boolean language sql as $$ select true $$;
  create schema net;
  -- Nothing is sent, but what WOULD have been is kept, so a test can read the
  -- message a publish or a clock-in queued for the send-push function.
  create table net._calls (id bigint generated always as identity primary key, url text, body jsonb);
  -- What pg_net keeps once the function has answered. The stub always says 200.
  create table net._http_response (id bigint primary key, status_code integer, content text, timed_out boolean, error_msg text,
                                   created timestamptz not null default now());
  create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
    headers jsonb default '{}', timeout_milliseconds integer default 5000) returns bigint
    language plpgsql as $$
    declare v_id bigint;
    begin
      insert into net._calls (url, body) values (url, body) returning id into v_id;
      insert into net._http_response (id, status_code, content, timed_out, error_msg) values (v_id, 200, '{"ok":true,"sent":1}', false, null);
      return v_id;
    end $$;

  -- What a fresh Supabase project grants by default. The schema's own REVOKEs
  -- are the security; if these defaults were missing, the test would be too kind.
  grant usage on schema public, auth, extensions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  grant select on auth.users to service_role;
  create publication supabase_realtime;
`;

// Extensions the schema asks for; the stand-ins above cover what it needs.
function prepare(sql) {
  return sql.replace(/^\s*create extension[^;]*;/gim, "-- (extension provided by the harness)");
}

export async function boot({ schemaPath = SCHEMA_PATH } = {}) {
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(prepare(readFileSync(schemaPath, "utf8")));
  return db;
}

/**
 * Run one statement as a signed-in user (or "anon"), the way Supabase does:
 * switch to the restricted role, say who is calling, run it, then roll the
 * whole thing back so no test can leak into the next one.
 * Returns { rows, count, error }.
 */
export async function as(db, who, sql, params = []) {
  let out = { rows: [], count: 0, error: null };
  try {
    await db.transaction(async (tx) => {
      if (who === "anon") {
        await tx.exec("set local role anon");
      } else {
        await tx.exec("set local role authenticated");
        await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [who]);
      }
      try {
        const r = await tx.query(sql, params);
        out = { rows: r.rows, count: r.affectedRows ?? r.rows.length, error: null };
      } catch (e) {
        out = { rows: [], count: 0, error: e.message };
      }
      await tx.rollback();       // never keep anything a test did
    });
  } catch (e) {
    if (!out.error) out.error = e.message;
  }
  return out;
}

/** The same, as the database owner: for seeding and for checking nothing changed. */
export const asOwner = (db, sql, params = []) => db.query(sql, params);
