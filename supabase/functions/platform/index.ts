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
//
// "create" makes the company, the manager's login (which must choose their own
// password at the first sign-in) and their profile as OWNER of that company,
// in that order, and undoes every step if a later one fails, so it can never
// leave a login that belongs to nobody or a company with nobody in it.
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
    const { data: companies, error } = await admin.from("companies")
      .select("id, name, time_zone, currency, created_at").order("created_at", { ascending: false });
    if (error) return reply(400, { error: error.message });
    const { data: owners } = await admin.from("profiles").select("company_id, full_name").eq("role", "owner").eq("active", true);
    const counts = await Promise.all((companies ?? []).map((c) =>
      admin.from("profiles").select("id", { count: "exact", head: true }).eq("company_id", c.id).eq("active", true)));
    return reply(200, {
      companies: (companies ?? []).map((c, i) => ({
        ...c,
        staff: counts[i].count ?? 0,
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

  return reply(400, { error: "Unknown action." });
});
