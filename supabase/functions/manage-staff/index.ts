// Supabase Edge Function: manage-staff
//
// Creates staff logins and removes / restores leavers, for the caller's own
// company only. It runs inside Supabase because creating a login needs the
// service role key, which must never be in a web page. Supabase gives this
// function that key automatically (SUPABASE_SERVICE_ROLE_KEY); nobody pastes
// it anywhere.
//
// Actions (POST JSON, called by admin.html with the manager's own session):
//   { action: "create",  full_name, email, role: "staff" | "admin", password }
//   { action: "remove",  user_id }   can't sign in, hours kept
//   { action: "restore", user_id }
//   { action: "password", user_id, password }   forgotten password, set by the manager
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

  // Who is asking? Only an active owner/admin may manage their own company.
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who, error: whoError } = await admin.auth.getUser(token);
  if (whoError || !who.user) return reply(401, { error: "Your session has expired. Sign in again." });
  const { data: me } = await admin.from("profiles").select("id, company_id, role, active").eq("id", who.user.id).maybeSingle();
  if (!me || !me.active || !["owner", "admin"].includes(me.role)) return reply(403, { error: "Manager access required." });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply(400, { error: "Bad request." }); }

  if (body.action === "create") {
    const fullName = String(body.full_name ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const role = body.role === "admin" ? "admin" : "staff";   // nobody creates an owner from the app
    if (!fullName || fullName.length > 120) return reply(400, { error: "Enter the person's name." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400, { error: "Enter a valid email address." });
    if (password.length < 8 || password.length > 72) return reply(400, { error: "The starting password needs 8 to 72 characters." });

    const { data: created, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { must_change_password: true },
    });
    if (error || !created.user) {
      return reply(400, { error: /already|registered|exists/i.test(error?.message ?? "") ? "That email already has a login." : (error?.message ?? "Could not create the login.") });
    }
    const { error: profileError } = await admin.from("profiles")
      .insert({ id: created.user.id, company_id: me.company_id, full_name: fullName, role });
    if (profileError) {
      // Never leave a login that belongs to no company.
      await admin.auth.admin.deleteUser(created.user.id);
      return reply(400, { error: profileError.message });
    }
    return reply(200, { id: created.user.id });
  }

  // A forgotten password, fixed by the manager on the spot.
  //
  // Not an email link: plenty of staff sign in with an address they never read
  // at work, the reset mail is rate limited and lands in spam, and somebody
  // locked out at 5am needs it now. So the manager sets a new one, hands it
  // over, and the app makes the person choose their own at the next sign-in —
  // exactly how the account was created in the first place.
  if (body.action === "password") {
    const { data: target } = await admin.from("profiles").select("id, company_id, role, full_name").eq("id", String(body.user_id ?? "")).maybeSingle();
    if (!target || target.company_id !== me.company_id) return reply(404, { error: "Staff member not found." });
    if (target.role === "owner" && me.role !== "owner") return reply(403, { error: "Only the owner can change the owner's password." });
    const password = String(body.password ?? "");
    if (password.length < 8 || password.length > 72) return reply(400, { error: "The new password needs 8 to 72 characters." });

    const { error } = await admin.auth.admin.updateUserById(target.id, {
      password,
      user_metadata: { must_change_password: true },
    });
    if (error) return reply(400, { error: error.message });
    return reply(200, { ok: true, full_name: target.full_name });
  }

  if (body.action === "remove" || body.action === "restore") {
    const { data: target } = await admin.from("profiles").select("id, company_id, role").eq("id", String(body.user_id ?? "")).maybeSingle();
    if (!target || target.company_id !== me.company_id) return reply(404, { error: "Staff member not found." });
    if (target.id === me.id) return reply(400, { error: "You cannot remove yourself." });
    if (target.role === "owner") return reply(403, { error: "The company owner cannot be removed here." });

    const removing = body.action === "remove";
    // Banning the login stops new sign-ins; active = false makes the database
    // hide the company from any session they still have open.
    const { error: banError } = await admin.auth.admin.updateUserById(target.id, { ban_duration: removing ? "876000h" : "none" });
    if (banError) return reply(400, { error: banError.message });
    const { error: updateError } = await admin.from("profiles").update({ active: !removing }).eq("id", target.id);
    if (updateError) return reply(400, { error: updateError.message });
    return reply(200, { ok: true });
  }

  return reply(400, { error: "Unknown action." });
});
