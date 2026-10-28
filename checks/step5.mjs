// Full relevant Step 5 gate. Do not invoke notification/phone/GPS suites.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {attendanceRoot,parkingRoot,verifySharedCheckouts} from './shared-checkout.mjs';
verifySharedCheckouts();
function run(cwd,args) {
  console.log('\nCHECK '+args.join(' '));
  const result=spawnSync(process.execPath,args,{cwd,stdio:'inherit'});
  if(result.error)throw result.error;
  assert.equal(result.status,0,args.join(' ')+' failed');
}
for(const cwd of [attendanceRoot,parkingRoot]) {
  const config=JSON.parse(fs.readFileSync(cwd+'vercel.json','utf8'));
  assert.equal(config.git.deploymentEnabled['attendance-integration'],false,'Draft branches must not deploy');
  for(const args of [['diff','--check'],['diff','--cached','--check']])assert.equal(spawnSync('git',args,{cwd,stdio:'inherit'}).status,0,'Whitespace');
}
for(const name of ['index.html','admin.html'])for(const script of fs.readFileSync(attendanceRoot+name,'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g))new Function(script[1]);
run(attendanceRoot,['--check','shared-backend.js']);
run(parkingRoot,['src/build.mjs','--check']);
run(parkingRoot,['src/build-attendance.mjs','--check']);
run(parkingRoot,['--check','supabase/functions/aero-access/index.ts']);
const checks=attendanceRoot+'checks/';
for(const name of ['smoke','embeds','resilience','payroll','shared-transport','shared-staff','shared-manager','shared-manager-runtime'])run(checks,[name+'.mjs']);
run(parkingRoot,['checks/attendance-access.mjs']);
run(checks,['shared-browser.mjs']);
run(checks,['shared-staff-browser.mjs','--no-notifications']);
run(checks,['shared-manager-browser.mjs']);
console.log('\nStep 5 full local verification passed. Step 6 has not started. Notification-specific/mixed notification suites, phones and GPS excluded.');
