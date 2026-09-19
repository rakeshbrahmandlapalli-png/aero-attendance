import fs from "node:fs";
import assert from "node:assert/strict";

const pages = {
  staff: fs.readFileSync("../index.html", "utf8"),
  manager: fs.readFileSync("../admin.html", "utf8"),
  platform: fs.readFileSync("../platform.html", "utf8"),
};

const checks = [
  ["staff demo mode", /FORCED_DEMO/.test(pages.staff)],
  ["clock action", /id="action"/.test(pages.staff)],
  ["break action", /id="breakBtn"/.test(pages.staff)],
  ["offline state", /id="connection"/.test(pages.staff)],
  ["install action", /id="installApp"/.test(pages.staff)],
  ["availability controls", /id="saveAvail"/.test(pages.staff)],
  ["manager review", /id="tab-reviews"/.test(pages.manager)],
  ["manager export", /id="csv"/.test(pages.manager)],
  ["manager rota", /id="tab-rota"/.test(pages.manager)],
  ["manager audit", /id="tab-audit"/.test(pages.manager)],
  ["audit filtering", /id="auditFilter"/.test(pages.manager)],
  ["audit export", /id="exportAudit"/.test(pages.manager)],
  ["platform demo mode", /FORCED_DEMO/.test(pages.platform)],
  ["platform backup", /backupAll/.test(pages.platform)],
  ["safe-area support", /safe-area-inset-bottom/.test(pages.staff) && /safe-area-inset-bottom/.test(pages.manager)],
];

for (const [name, passed] of checks) assert.equal(passed, true, name);
console.log(`${checks.length} smoke checks passed.`);
