// Supabase Edge Function: platform
//
// The owner's own tool for adding client companies (page: /platform).
//
// Only people listed in the platform_admins table may call it, and that table
// cannot be read or written from the app or the website: only this function,
// with the service key Supabase gives it (SUPABASE_SERVICE_ROLE_KEY), looks at
// it. A client's manager, however senior, is refused here with 403.
//
// Actions (POST JSON, called by platform.html with the signed-in session):
//   { action: "list" }
//   { action: "create", company_name, time_zone, currency,
//                       manager_name, manager_email, password }
//   { action: "update", company_id, company_name, time_zone, currency, brand_name }
//   { action: "delete", company_id, confirm_name }   permanent: see below
//   { action: "suspend", company_id, suspended }     pause / un-pause a client (nothing is deleted)
//   { action: "reset_owner_password", company_id, password }
//   { action: "add_manager", company_id, manager_name, manager_email, password }
//   { action: "backup", company_id? }                everything for one client, or for all of them
//
// "create" makes the company, the manager's login (which must choose their own
// password at the first sign-in) and their profile as OWNER of that company,
// in that order, and undoes every step if a later one fails, so it can never
// leave a login that belongs to nobody or a company with nobody in it.
//
// "delete" removes a company, every row that belongs to it (the database
// cascades: staff, shifts, pay, rota, everything) and its people's logins. It
// cannot be undone, so the server, not just the page, insists that the caller
// types the company's exact name, and it refuses if the caller (or any other
// platform admin) is a member of that company, because that would delete the
// login the platform owner signs in with.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "POST only." });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  // Who is asking? Only a platform admin. Checked here, on the server, every time.
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who, error: whoError } = await admin.auth.getUser(token);
  if (whoError || !who.user) return reply(401, { error: "Your session has expired. Sign in again." });
  const { data: pa, error: paError } = await admin.from("platform_admins").select("user_id").eq("user_id", who.user.id).maybeSingle();
  if (paError) return reply(500, { error: "The platform list is not set up yet. Run the clients-and-settings SQL first." });
  if (!pa) return reply(403, { error: "This login is not a platform admin." });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply(400, { error: "Bad request." }); }

  if (body.action === "list") {
    let listed = await admin.from("companies")
      .select("id, name, brand_name, time_zone, currency, suspended, created_at").order("created_at", { ascending: false });
    // Before the pause SQL is run there is no `suspended` column: list without it.
    if (listed.error) listed = await admin.from("companies")
      .select("id, name, brand_name, time_zone, currency, created_at").order("created_at", { ascending: false });
    const { data: companies, error } = listed;
    if (error) return reply(400, { error: error.message });
    const { data: owners } = await admin.from("profiles").select("company_id, full_name").eq("role", "owner").eq("active", true);
    const counts = await Promise.all((companies ?? []).map((c) =>
      admin.from("profiles").select("id", { count: "exact", head: true }).eq("company_id", c.id).eq("active", true)));
    const shiftCounts = await Promise.all((companies ?? []).map((c) =>
      admin.from("shifts").select("id", { count: "exact", head: true }).eq("company_id", c.id)));
    return reply(200, {
      companies: (companies ?? []).map((c, i) => ({
        ...c,
        staff: counts[i].count ?? 0,
        shifts: shiftCounts[i].count ?? 0,
        owner: (owners ?? []).find((o) => o.company_id === c.id)?.full_name ?? "",
      })),
    });
  }

  if (body.action === "create") {
    const companyName = String(body.company_name ?? "").trim();
    const timeZone = String(body.time_zone ?? "Europe/London").trim();
    const currency = String(body.currency ?? "GBP").trim().toUpperCase();
    const managerName = String(body.manager_name ?? "").trim();
    const email = String(body.manager_email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");

    if (!companyName || companyName.length > 120) return reply(400, { error: "Enter the company name (up to 120 characters)." });
    try { new Intl.DateTimeFormat("en-GB", { timeZone }); } catch { return reply(400, { error: `"${timeZone}" is not a time zone. Use a name like Europe/London.` }); }
    if (!/^[A-Z]{3}$/.test(currency)) return reply(400, { error: "The currency is a three-letter code such as GBP." });
    if (!managerName || managerName.length > 120) return reply(400, { error: "Enter the first manager's name." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400, { error: "Enter a valid email address for the first manager." });
    if (password.length < 8 || password.length > 72) return reply(400, { error: "The starting password needs 8 to 72 characters." });

    const { data: company, error: companyError } = await admin.from("companies")
      .insert({ name: companyName, time_zone: timeZone, currency }).select("id").single();
    if (companyError || !company) return reply(400, { error: companyError?.message ?? "Could not create the company." });

    const undoCompany = () => admin.from("companies").delete().eq("id", company.id);

    const { data: created, error: userError } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { must_change_password: true },
    });
    if (userError || !created.user) {
      await undoCompany();
      return reply(400, { error: /already|registered|exists/i.test(userError?.message ?? "") ? "That email already has a login." : (userError?.message ?? "Could not create the login.") });
    }

    const { error: profileError } = await admin.from("profiles")
      .insert({ id: created.user.id, company_id: company.id, full_name: managerName, role: "owner" });
    if (profileError) {
      await admin.auth.admin.deleteUser(created.user.id);
      await undoCompany();
      return reply(400, { error: profileError.message });
    }
    return reply(200, { company_id: company.id, name: companyName, email });
  }

  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // What can be ticked on /platform. The check constraint on
  // company_features.feature also allows "incidents"; it is left out here until
  // that feature exists, because offering a switch for something that is not
  // built is a lie. Add it to this list in the same commit that ships it.
  const FEATURES = ["rota", "pay", "breaks", "notices", "handover", "overtime"];

  if (body.action === "update") {
    const id = String(body.company_id ?? "");
    const name = String(body.company_name ?? "").trim();
    const timeZone = String(body.time_zone ?? "").trim();
    const currency = String(body.currency ?? "").trim().toUpperCase();
    const brand = String(body.brand_name ?? "").trim();
    if (!uuid.test(id)) return reply(400, { error: "Unknown company." });
    if (!name || name.length > 120) return reply(400, { error: "Enter the company name (up to 120 characters)." });
    try { new Intl.DateTimeFormat("en-GB", { timeZone }); } catch { return reply(400, { error: `"${timeZone}" is not a time zone. Use a name like Europe/London.` }); }
    if (!/^[A-Z]{3}$/.test(currency)) return reply(400, { error: "The currency is a three-letter code such as GBP." });
    if (brand.length > 60) return reply(400, { error: "The name shown in the app can be up to 60 characters." });
    const { data, error } = await admin.from("companies")
      .update({ name, time_zone: timeZone, currency, brand_name: brand }).eq("id", id).select("id");
    if (error) return reply(400, { error: error.message });
    if (!data || data.length === 0) return reply(404, { error: "That company no longer exists." });
    return reply(200, { ok: true });
  }

  // Which add-ons a client has. Only what is switched OFF is stored: no row
  // means they have it, so a client already live is untouched until something
  // is unticked here.
  if (body.action === "features") {
    const id = String(body.company_id ?? "");
    if (!uuid.test(id)) return reply(400, { error: "Unknown company." });
    const { data, error } = await admin.from("company_features")
      .select("feature, enabled").eq("company_id", id);
    if (error) return reply(400, { error: "Add-ons are not set up yet. Run the add-ons SQL first." });
    const off = (data ?? []).filter((r) => r.enabled === false).map((r) => r.feature);
    return reply(200, { features: FEATURES, off });
  }

  if (body.action === "set_features") {
    const id = String(body.company_id ?? "");
    const off = Array.isArray(body.off) ? body.off.map(String) : null;
    if (!uuid.test(id)) return reply(400, { error: "Unknown company." });
    if (!off) return reply(400, { error: "Send the list of add-ons to switch off." });
    const unknown = off.filter((f) => !FEATURES.includes(f));
    if (unknown.length) return reply(400, { error: `Not an add-on: ${unknown.join(", ")}.` });

    const exists = await admin.from("companies").select("id").eq("id", id).maybeSingle();
    if (exists.error) return reply(400, { error: exists.error.message });
    if (!exists.data) return reply(404, { error: "That company no longer exists." });

    // Clear the lot, then write back only the ones switched off, so a feature
    // ticked back on leaves no row behind to contradict the default.
    const cleared = await admin.from("company_features").delete().eq("company_id", id);
    if (cleared.error) return reply(400, { error: "Add-ons are not set up yet. Run the add-ons SQL first." });
    if (off.length) {
      const wrote = await admin.from("company_features")
        .insert(off.map((feature) => ({ company_id: id, feature, enabled: false })));
      if (wrote.error) return reply(400, { error: wrote.error.message });
    }
    return reply(200, { ok: true, off });
  }

  if (body.action === "delete") {
    const id = String(body.company_id ?? "");
    if (!uuid.test(id)) return reply(400, { error: "Unknown company." });
    const { data: company } = await admin.from("companies").select("id, name").eq("id", id).maybeSingle();
    if (!company) return reply(404, { error: "That company no longer exists." });
    if (String(body.confirm_name ?? "").trim() !== company.name) {
      return reply(400, { error: "The name you typed does not match. Nothing was deleted." });
    }
    const { data: people } = await admin.from("profiles").select("id").eq("company_id", id);
    const ids = (people ?? []).map((p) => p.id as string);
    if (ids.includes(who.user.id)) {
      return reply(400, { error: "You are signed in as a member of this company. Deleting it would delete your own login. Nothing was deleted." });
    }
    if (ids.length) {
      const { data: admins } = await admin.from("platform_admins").select("user_id").in("user_id", ids);
      if (admins && admins.length) return reply(400, { error: "A platform admin is a member of this company. Nothing was deleted." });
    }

    // One statement: the database removes the company and everything that belongs to it, or nothing.
    const { error } = await admin.from("companies").delete().eq("id", id);
    if (error) return reply(400, { error: error.message });

    // Then the logins. The company is already gone, so a failure here only leaves an unused login behind.
    let left = 0;
    for (const userId of ids) {
      const { error: delError } = await admin.auth.admin.deleteUser(userId);
      if (delError) left++;
    }
    return reply(200, { ok: true, people: ids.length, logins_not_removed: left });
  }

  if (body.action === "suspend") {
    const id = String(body.company_id ?? "");
    if (!uuid.test(id) || typeof body.suspended !== "boolean") return reply(400, { error: "Unknown company." });
    const { data, error } = await admin.from("companies").update({ suspended: body.suspended }).eq("id", id).select("id");
    if (error) {
      return reply(400, { error: /suspended/.test(error.message) ? "Pausing is not set up yet. Run the pause-client SQL first." : error.message });
    }
    if (!data || data.length === 0) return reply(404, { error: "That company no longer exists." });
    return reply(200, { ok: true });
  }

  if (body.action === "reset_owner_password") {
    const id = String(body.company_id ?? "");
    const password = String(body.password ?? "");
    if (!uuid.test(id)) return reply(400, { error: "Unknown company." });
    if (password.length < 8 || password.length > 72) return reply(400, { error: "The new password needs 8 to 72 characters." });
    const { data: owner } = await admin.from("profiles").select("id, full_name")
      .eq("company_id", id).eq("role", "owner").eq("active", true).limit(1).maybeSingle();
    if (!owner) return reply(404, { error: "That company has no active owner." });
    const { data: login } = await admin.auth.admin.getUserById(owner.id);
    // Same as a manager resetting a member of staff: they must choose their own at the next sign-in.
    const { error } = await admin.auth.admin.updateUserById(owner.id, { password, user_metadata: { must_change_password: true } });
    if (error) return reply(400, { error: error.message });
    return reply(200, { ok: true, full_name: owner.full_name, email: login?.user?.email ?? "" });
  }

  if (body.action === "add_manager") {
    const id = String(body.company_id ?? "");
    const name = String(body.manager_name ?? "").trim();
    const email = String(body.manager_email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!uuid.test(id)) return reply(400, { error: "Unknown company." });
    if (!name || name.length > 120) return reply(400, { error: "Enter the manager's name." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400, { error: "Enter a valid email address for the manager." });
    if (password.length < 8 || password.length > 72) return reply(400, { error: "The starting password needs 8 to 72 characters." });
    const { data: company } = await admin.from("companies").select("id, name").eq("id", id).maybeSingle();
    if (!company) return reply(404, { error: "That company no longer exists." });

    const { data: created, error: userError } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { must_change_password: true },
    });
    if (userError || !created.user) {
      return reply(400, { error: /already|registered|exists/i.test(userError?.message ?? "") ? "That email already has a login." : (userError?.message ?? "Could not create the login.") });
    }
    const { error: profileError } = await admin.from("profiles")
      .insert({ id: created.user.id, company_id: id, full_name: name, role: "admin" });
    if (profileError) {
      await admin.auth.admin.deleteUser(created.user.id);      // never a login that belongs to nobody
      return reply(400, { error: profileError.message });
    }
    return reply(200, { company_id: id, name: company.name, email });
  }

  // A full copy of one client's data (or of every client's), for the owner to keep.
  // Not included: passwords (they cannot be read back), and phone push keys (a phone just
  // subscribes again). Rows come 1,000 at a time, in a fixed order, so no page repeats or skips.
  if (body.action === "backup") {
    const only = body.company_id == null ? null : String(body.company_id);
    if (only !== null && !uuid.test(only)) return reply(400, { error: "Unknown company." });
    let q = admin.from("companies").select("*").order("created_at");
    if (only) q = q.eq("id", only);
    const { data: companies, error: companyListError } = await q;
    if (companyListError) return reply(400, { error: companyListError.message });
    if (only && (!companies || companies.length === 0)) return reply(404, { error: "That company no longer exists." });

    // Every table that holds this company's data. Push subscriptions and
    // push_log are left out on purpose (device keys, and no use in a restore);
    // passwords are not ours to export at all.
    // ADD A LINE HERE WITH EVERY NEW COMPANY-SCOPED TABLE, or a restore comes
    // back missing it and nobody finds out until they need it.
    const TABLES: [string, string[]][] = [
      ["profiles", ["id"]], ["worksites", ["id"]], ["shifts", ["id"]], ["shift_corrections", ["id"]], ["pay_rates", ["user_id"]],
      ["availability", ["user_id", "weekday"]], ["time_off", ["id"]], ["rota_shifts", ["id"]], ["privacy_ack", ["user_id"]],
      ["notification_prefs", ["user_id"]], ["announcements", ["id"]], ["announcement_reads", ["announcement_id", "user_id"]],
      ["overtime_decisions", ["user_id", "week_start"]], ["company_features", ["feature"]], ["audit_events", ["id"]],
    ];
    const fetchAll = async (table: string, order: string[], companyId: string) => {
      const rows: Record<string, unknown>[] = [];
      for (let from = 0; ; from += 1000) {
        let r = admin.from(table).select("*").eq("company_id", companyId);
        for (const col of order) r = r.order(col);
        const { data, error } = await r.range(from, from + 999);
        // A table whose SQL has not been run yet is empty, not a failed backup:
        // better a backup that says so than no backup at all.
        if (error) {
          if (/does not exist|schema cache|relation/i.test(error.message)) return rows;
          throw new Error(`${table}: ${error.message}`);
        }
        rows.push(...(data ?? []));
        if (!data || data.length < 1000) return rows;
      }
    };
    // Email addresses live in the login system, not in profiles.
    const emails = new Map<string, string>();
    for (let page = 1; ; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) return reply(400, { error: error.message });
      for (const u of data?.users ?? []) if (u.email) emails.set(u.id, u.email);
      if (!data?.users || data.users.length < 1000) break;
    }

    try {
      const out = [];
      for (const c of companies ?? []) {
        const tables: Record<string, Record<string, unknown>[]> = {};
        for (const [t, order] of TABLES) tables[t] = await fetchAll(t, order, c.id);
        tables.profiles = tables.profiles.map((p) => ({ ...p, email: emails.get(String(p.id)) ?? null }));
        out.push({ company: c, tables });
      }
      return reply(200, {
        format: "aero-attendance-backup", version: 1, exported_at: new Date().toISOString(),
        note: "Contains personal data (names, emails, locations, pay rates). Keep it private.",
        companies: out,
      });
    } catch (e) {
      return reply(500, { error: String((e as Error).message ?? e) });
    }
  }

  return reply(400, { error: "Unknown action." });
});
