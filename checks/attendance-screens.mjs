// Manager board order and grouped alerts (demo data), and the way back to Parking Ops.
import { chromium } from "playwright";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = http.createServer((q, r) => { const f = path.join(root, new URL(q.url, "http://x").pathname.replace(/\/$/, "/index.html")); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { "content-type": f.endsWith(".html") ? "text/html" : f.endsWith(".js") ? "text/javascript" : "application/octet-stream" }); r.end(d); } }); });
await new Promise((ok) => server.listen(0, "localhost", ok)); const base = "http://localhost:" + server.address().port;
let pass = 0, fail = 0; const check = (n, ok, x) => { ok ? pass++ : fail++; console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " -> " + JSON.stringify(x))); };
// The Supabase SDK normally comes from a CDN; Parking Ops keeps a copy of the same file.
const SDK = [process.env.SDK_FILE, path.resolve(root, "../takeoff-ops/public/vendor/supabase-2.117.2.js"), path.resolve(root, "../Parking-Ops/public/vendor/supabase-2.117.2.js")].find((f) => f && fs.existsSync(f));
const browser = await chromium.launch(); const errs = [];

// Manager board
{
  const p = await browser.newPage({ viewport: { width: 1100, height: 900 } }); p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(base + "/admin.html?demo"); await p.waitForSelector("#flags .flag", { timeout: 8000 });
  const order = await p.evaluate(() => { const a = document.querySelector("#nowBody"), f = document.getElementById("flags"); return !!(a.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING); });
  check("On shift now comes before the alerts", order);
  const rows = await p.locator("#flags .flag").count(), txt = await p.locator("#flags").innerText();
  check("Alerts of one kind are grouped", /Working but not on the rota \(4\)/.test(txt) && rows < 6, txt);
  check("The total is still counted", /6 things need attention/.test(txt), txt);
  await p.click('[data-group="5"]');
  check("Show opens the group", (await p.locator("#flags").innerText()).includes("Sam Whitfield") && /Hide/.test(await p.locator("#flags").innerText()));
  await p.click('[data-group="5"]');
  check("Hide closes it again", !(await p.locator("#flags").innerText()).includes("Sam Whitfield"));
  await p.click('[data-clear-group="5"]'); await p.waitForTimeout(400);
  check("Clear clears the whole group and the count follows", !/not on the rota/.test(await p.locator("#flags").innerText()) && /2 things need attention/.test(await p.locator("#flags").innerText()), await p.locator("#flags").innerText());
  check("Single alerts keep their own Clear and Clock out", (await p.locator('#flags [data-clear]').count()) >= 2 && (await p.locator("#flags [data-close]").count()) === 1);
  await p.close();
}
// Way back to Parking Ops
for (const [url, want] of [["/index.html?pilot=1&back=" + encodeURIComponent("https://takeoff-ops.vercel.app"), "https://takeoff-ops.vercel.app"], ["/index.html?pilot=1&back=" + encodeURIComponent("https://evil.example"), null]]) {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 } }); const p = await c.newPage(); p.on("pageerror", (e) => errs.push(e.message));
  await p.route(/supabase\.co/, (r) => r.abort());
  await p.route(/cdn\.jsdelivr\.net.*supabase/, (r) => r.fulfill({ contentType: "application/javascript", body: fs.readFileSync(SDK, "utf8") }));
  await p.goto(base + url); await p.waitForTimeout(800);
  const vis = await p.locator("#backOps").evaluate((a) => !a.hidden), href = await p.locator("#backOps").getAttribute("href");
  check("Back link " + (want ? "shows for Parking Ops" : "hidden for an unknown address"), want ? vis && href === want : !vis, { vis, href });
  await c.close();
}
check("No page errors", errs.length === 0, errs);
await browser.close(); server.close();
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
