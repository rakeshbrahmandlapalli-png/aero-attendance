// Supabase Edge Function: send-push
//
// Sends phone notifications (web push). The database calls it with a tiny
// message ({type, id}) from triggers and every 5 minutes from pg_cron; see
// setup/update-2026-09-notifications.sql. It trusts nothing in the message
// except which record to look at: it re-reads the record with the service
// key, decides who should hear about it, and writes a push_log key first, so
// each notification goes out at most once however often it is called.
//
// Secrets to set in Supabase (Edge Functions -> Secrets):
//   VAPID_PUBLIC_KEY   same value as VAPID_PUBLIC_KEY in index.html/admin.html
//   VAPID_PRIVATE_KEY  never put this in a page, a file or a chat
// "Verify JWT" must be OFF for this function: the database calls it without
// a login.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
webpush.setVapidDetails(
  "https://aero-attendance.vercel.app",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

// Clients are UK businesses; times read as the yard clock.
const TZ = "Europe/London";
const time = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const day = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));
const duration = (a: string, b: string) => {
  const m = Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};
const MIN = 60000, HOUR = 60 * MIN;

type Note = { title: string; body: string; url: string; tag: string };
type Pref = "clock_in" | "clock_out" | "away" | "corrections" | "late" | "long_shift" | "correction_decisions" | "rota" | "reminders";

// Claim a notification. False means it has already been sent.
async function once(key: string) {
  const { error } = await db.from("push_log").insert({ key });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw error;
}

// Send to these people, if any of the given preferences is on for them.
async function sendTo(userIds: string[], prefs: Pref[], note: Note) {
  const ids = [...new Set(userIds)];
  if (!ids.length) return 0;
  const { data: rows } = await db.from("notification_prefs").select("*").in("user_id", ids);
  const byUser = new Map((rows ?? []).map((r) => [r.user_id, r]));
  const wanted = ids.filter((id) => {
    const p = byUser.get(id);
    return !p || prefs.some((k) => p[k] !== false);        // no row yet = everything on
  });
  if (!wanted.length) return 0;
  const { data: subs } = await db.from("push_subscriptions").select("id, endpoint, p256dh, auth").in("user_id", wanted);
  let sent = 0;
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(note),
        { TTL: 4 * 3600, urgency: "high" },
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      // The phone unsubscribed or the app was removed: forget it.
      if (code === 404 || code === 410) await db.from("push_subscriptions").delete().eq("id", s.id);
      else console.error("push failed", code, (e as { body?: string }).body ?? String(e));
    }
  }));
  return sent;
}

async function managers(companyId: string, except?: string) {
  const { data } = await db.from("profiles").select("id")
    .eq("company_id", companyId).eq("active", true).in("role", ["owner", "admin"]);
  return (data ?? []).map((p) => p.id).filter((id) => id !== except);
}

async function onShift(id: string) {
  const { data: s } = await db.from("shifts")
    .select("id, user_id, company_id, clock_in_at, clock_out_at, clock_in_ok, clock_in_metres, profiles(full_name), worksites(name)")
    .eq("id", id).maybeSingle();
  if (!s) return;
  const name = (s.profiles as { full_name?: string } | null)?.full_name || "Someone";
  const site = (s.worksites as { name?: string } | null)?.name;
  const to = await managers(s.company_id, s.user_id);

  if (await once(`in:${s.id}`)) {
    const away = s.clock_in_ok === false;
    await sendTo(to, away ? ["clock_in", "away"] : ["clock_in"], {
      title: away ? `${name} clocked in away from site` : `${name} clocked in`,
      body: `${time(s.clock_in_at)}${site ? ` at ${site}` : ""}` +
        (away ? ` · ${s.clock_in_metres}m from the site` : s.clock_in_ok === null ? " · no location" : ""),
      url: "/admin.html", tag: `shift-${s.id}`,
    });
  }
  if (s.clock_out_at && await once(`out:${s.id}`)) {
    await sendTo(to, ["clock_out"], {
      title: `${name} clocked out`,
      body: `${time(s.clock_out_at)}${site ? ` at ${site}` : ""} · ${duration(s.clock_in_at, s.clock_out_at)}`,
      url: "/admin.html", tag: `shift-${s.id}`,
    });
  }
}

async function onCorrection(id: string) {
  const { data: c } = await db.from("shift_corrections")
    .select("id, company_id, user_id, status, requested_in, requested_out, profiles!shift_corrections_user_id_fkey(full_name)")
    .eq("id", id).maybeSingle();
  if (!c) return;
  const name = (c.profiles as { full_name?: string } | null)?.full_name || "Someone";
  if (c.status === "pending") {
    if (await once(`corr:${c.id}`)) {
      await sendTo(await managers(c.company_id, c.user_id), ["corrections"], {
        title: "Correction request",
        body: `${name} asked to change ${day(c.requested_in)} to ${time(c.requested_in)}–${time(c.requested_out)}`,
        url: "/admin.html", tag: `corr-${c.id}`,
      });
    }
  } else if (await once(`corr-done:${c.id}`)) {
    await sendTo([c.user_id], ["correction_decisions"], {
      title: c.status === "approved" ? "Correction approved" : "Correction rejected",
      body: `Your change to ${day(c.requested_in)} was ${c.status}. Open the app for details.`,
      url: "/", tag: `corr-${c.id}`,
    });
  }
}

async function onRota(companyId: string, from: string, to: string) {
  const { data: co } = await db.from("companies").select("use_rota").eq("id", companyId).maybeSingle();
  if (!co?.use_rota) return;
  const { data: rows } = await db.from("rota_shifts").select("user_id, updated_at")
    .eq("company_id", companyId).eq("removed", false)
    .gte("published_starts_at", from).lt("published_starts_at", to)
    .gte("updated_at", new Date(Date.now() - 15 * MIN).toISOString());
  const latest = new Map<string, string>();
  (rows ?? []).forEach((r) => { if (!latest.has(r.user_id) || r.updated_at > latest.get(r.user_id)!) latest.set(r.user_id, r.updated_at); });
  for (const [userId, stamp] of latest) {
    if (await once(`rota:${userId}:${stamp}`)) {
      await sendTo([userId], ["rota"], {
        title: "Your rota is out",
        body: `Your shifts for the week of ${day(from)} have been published.`,
        url: "/", tag: `rota-${from}`,
      });
    }
  }
}

async function onTick() {
  const now = Date.now();

  // Shifts still open after 13 hours: almost always a forgotten clock-out.
  const { data: long } = await db.from("shifts").select("id, user_id, company_id, clock_in_at, profiles(full_name)")
    .is("clock_out_at", null).lt("clock_in_at", new Date(now - 13 * HOUR).toISOString())
    .gt("clock_in_at", new Date(now - 72 * HOUR).toISOString());
  for (const s of long ?? []) {
    if (await once(`long:${s.id}`)) {
      const name = (s.profiles as { full_name?: string } | null)?.full_name || "Someone";
      await sendTo(await managers(s.company_id, s.user_id), ["long_shift"], {
        title: `${name} is still clocked in`,
        body: `Clocked in at ${time(s.clock_in_at)} on ${day(s.clock_in_at)}, over 13 hours ago. Check the finish time.`,
        url: "/admin.html", tag: `shift-${s.id}`,
      });
    }
  }

  // Published rota shifts from the last day and the next hour, for companies using the rota.
  const { data: rota } = await db.from("rota_shifts")
    .select("id, user_id, company_id, published_starts_at, published_ends_at, published_worksite_id, companies!inner(use_rota), profiles(full_name, active)")
    .eq("removed", false).eq("companies.use_rota", true)
    .gte("published_starts_at", new Date(now - 30 * HOUR).toISOString())
    .lte("published_starts_at", new Date(now + 65 * MIN).toISOString());
  if (rota?.length) {
    const users = [...new Set(rota.map((r) => r.user_id))];
    const { data: ins } = await db.from("shifts").select("user_id, clock_in_at")
      .in("user_id", users).gte("clock_in_at", new Date(now - 34 * HOUR).toISOString());
    const siteIds = [...new Set(rota.map((r) => r.published_worksite_id).filter(Boolean))];
    const { data: sites } = siteIds.length ? await db.from("worksites").select("id, name").in("id", siteIds) : { data: [] };
    const siteName = (id: string | null) => (sites ?? []).find((w) => w.id === id)?.name;

    for (const r of rota) {
      const person = r.profiles as { full_name?: string; active?: boolean } | null;
      if (person && person.active === false) continue;
      const start = new Date(r.published_starts_at).getTime(), end = new Date(r.published_ends_at).getTime();
      const site = siteName(r.published_worksite_id);
      const came = (ins ?? []).some((s) => {
        const t = new Date(s.clock_in_at).getTime();
        return s.user_id === r.user_id && t >= start - 2 * HOUR && t <= end;
      });
      const name = person?.full_name || "Someone";

      if (start > now) {
        if (!came && start - now <= 65 * MIN && await once(`remind:${r.id}:${r.published_starts_at}`)) {
          await sendTo([r.user_id], ["reminders"], {
            title: `Shift at ${time(r.published_starts_at)}`,
            body: `Your shift${site ? ` at ${site}` : ""} starts at ${time(r.published_starts_at)}.`,
            url: "/", tag: `remind-${r.id}`,
          });
        }
        continue;
      }
      if (came || now < start + 10 * MIN) continue;
      if (now < end) {
        if (await once(`late:${r.id}`)) {
          await sendTo(await managers(r.company_id, r.user_id), ["late"], {
            title: `${name} hasn't clocked in`,
            body: `Their shift started at ${time(r.published_starts_at)}${site ? ` at ${site}` : ""}.`,
            url: "/admin.html", tag: `rota-${r.id}`,
          });
        }
      } else if (now < end + 12 * HOUR && await once(`noshow:${r.id}`)) {
        await sendTo(await managers(r.company_id, r.user_id), ["late"], {
          title: `${name} didn't clock in`,
          body: `No clock-in for the ${time(r.published_starts_at)}–${time(r.published_ends_at)} shift on ${day(r.published_starts_at)}${site ? ` at ${site}` : ""}.`,
          url: "/admin.html", tag: `rota-${r.id}`,
        });
      }
    }
  }

  await db.from("push_log").delete().lt("sent_at", new Date(now - 45 * 24 * HOUR).toISOString());
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  let msg: Record<string, unknown>;
  try { msg = await req.json(); } catch { return new Response("Bad request", { status: 400 }); }
  const uuid = /^[0-9a-f-]{36}$/i;
  try {
    if (msg.type === "shift" && uuid.test(String(msg.id))) await onShift(String(msg.id));
    else if (msg.type === "correction" && uuid.test(String(msg.id))) await onCorrection(String(msg.id));
    else if (msg.type === "rota" && uuid.test(String(msg.company_id))) await onRota(String(msg.company_id), String(msg.from), String(msg.to));
    else if (msg.type === "tick") await onTick();
    else return new Response("Unknown message", { status: 400 });
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String((e as Error).message ?? e) }), { status: 500 });
  }
});
