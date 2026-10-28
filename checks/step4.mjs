// Complete local Step 4 gate. No CLI connected to a live backend is invoked.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {attendanceRoot,parkingRoot,verifySharedCheckouts} from './shared-checkout.mjs';
verifySharedCheckouts();
function run(cwd, args) {
  console.log('\nCHECK '+args.join(' '));
  const result = spawnSync(process.execPath,args,{cwd,stdio:'inherit'});
  if (result.error) throw result.error;
  assert.equal(result.status,0,args.join(' ')+' failed');
}
for (const cwd of [attendanceRoot,parkingRoot]) {
  const config=JSON.parse(fs.readFileSync(cwd+'vercel.json','utf8'));
  assert.equal(config.git.deploymentEnabled['attendance-integration'],false,'Draft branch must not auto-deploy');
  const diff=spawnSync('git',['diff','--check'],{cwd,stdio:'inherit'});
  assert.equal(diff.status,0,'Whitespace check');
}
for (const page of ['index.html','admin.html']) {
  const source=fs.readFileSync(attendanceRoot+page,'utf8');
  for (const script of source.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(script[1]);
}
run(attendanceRoot,['--check','shared-backend.js']);
for (const file of ['public/app.js','supabase/functions/aero-access/index.ts','supabase/functions/aero-send-push/index.ts']) run(parkingRoot,['--check',file]);
run(parkingRoot,['src/build.mjs','--check']);
run(parkingRoot,['src/build-attendance.mjs','--check']);
const checks=attendanceRoot+'checks/';
for (const file of ['smoke','embeds','resilience','payroll','isolation','roundtrip','shared-transport','shared-integration','shared-staff']) run(checks,[file+'.mjs']);
for (const file of ['attendance-access','attendance-addon','skidata-topup','call-workflow','notification-clear']) run(parkingRoot,['checks/'+file+'.mjs']);
for (const file of ['shared-browser','shared-staff-browser']) run(checks,[file+'.mjs']);
console.log('\nStep 4 full local verification passed. Synthetic data only. Steps 5–8 remain pending.');
