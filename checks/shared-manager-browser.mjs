// Step 5: real manager page/client + actual shared SQL through test Auth/REST.
// All network is intercepted. No notification, phone or GPS workflows.
import {chromium} from 'playwright';
import {expect} from 'playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {attendanceRoot,sdkSource} from './shared-checkout.mjs';
import {testApi,apiOrigin} from './shared-test-api.mjs';
import {seedManager,manager,otherManager,id} from './shared-manager-fixture.mjs';
const base='http://localhost', managerKey='aero-shared-manager-auth';
let browser,navigation=0,journeys=0;
function csv(text) {
  const rows=[];let row=[],cell='',quoted=false;
  text=text.replace(/^\uFEFF/,'');
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(c==='"') {if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
    else if(c===','&&!quoted){row.push(cell);cell='';}
    else if((c==='\r'||c==='\n')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';}
    else cell+=c;
  }
  assert.equal(quoted,false,'CSV quotes closed');
  if(row.length||cell){row.push(cell);rows.push(row);}
  return rows.slice(1).map(row=>{assert.equal(row.length,rows[0].length,'CSV column count');return Object.fromEntries(rows[0].map((key,i)=>[key,row[i]]));});
}
async function download(page,selector) {
  const pending=page.waitForEvent('download');await page.locator(selector).click();
  const file=await pending,stream=await file.createReadStream(),chunks=[];
  for await(const chunk of stream) chunks.push(chunk);
  return {name:file.suggestedFilename(),rows:csv(Buffer.concat(chunks).toString('utf8'))};
}
async function layout(page,label) {
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),label+' page overflow');
  const outside=await page.evaluate(()=>[...document.querySelectorAll('button,input,select,textarea')].filter(n=>n.getClientRects().length).filter(n=>{const r=n.getBoundingClientRect();return r.left < -1||r.right>innerWidth+1;}).map(n=>n.id||n.textContent));
  assert.deepEqual(outside,[],label+' controls outside viewport');
}
async function loaded(page,company='Example company 1') {
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#company')).toHaveText(company);
  await expect(page.locator('#pwDialog')).toBeHidden();
  await expect(page.locator('#staffBody tr')).not.toHaveCount(0);
}
async function range(page,from,to=from,who='',timeout=5000) {
  await page.locator('[data-tab=sheets]').click();
  await page.locator('#from').fill(from);await page.locator('#to').fill(to);await page.locator('#who').selectOption(who);
  const done=page.waitForResponse(response=>response.url().startsWith(apiOrigin+'/rest/v1/aero_shifts?')&&new URL(response.url()).searchParams.get('select')?.includes('profiles:'));
  await page.locator('#run').click();await done;
  await expect(page.locator('#csv')).toBeEnabled({timeout});
}
async function setup(api,width) {
  const context=await browser.newContext({viewport:{width,height:844},serviceWorkers:'block',timezoneId:'Europe/London',acceptDownloads:true});
  const sentinels={
    'aero-shared-staff-auth':JSON.stringify(api.session(id(10))),
    'aero-manager-auth':'legacy-manager-sentinel',
    'sb-ljrzcrphuepqtfrayeid-auth-token':'legacy-staff-sentinel',
    'sb-oioqjfrlwrjovnouhusp-auth-token':'parking-sentinel'
  };
  await context.addInitScript(values=>{
    if(!sessionStorage.getItem('seeded')){for(const [key,value] of Object.entries(values))localStorage.setItem(key,value);sessionStorage.setItem('seeded','1');}
    window.excludedCalls=[];
    Object.defineProperty(navigator,'geolocation',{value:{getCurrentPosition(){window.excludedCalls.push('GPS');throw Error('GPS excluded');},watchPosition(){window.excludedCalls.push('GPS');throw Error('GPS excluded');},clearWatch(){}}});
  },sentinels);
  const unexpected=[],errors=[];
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin===apiOrigin)return api.route(route);
    if(url.href==='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js')return route.fulfill({contentType:'application/javascript',body:sdkSource()});
    if(url.origin===base){
      let name=decodeURIComponent(url.pathname);if(name==='/manager')name='/admin.html';
      const file=path.resolve(attendanceRoot,'.'+name);
      if(!file.startsWith(attendanceRoot)||!fs.existsSync(file)||!['.html','.js','.webmanifest','.png','.css'].includes(path.extname(file)))return route.fulfill({status:404,body:''});
      let body=fs.readFileSync(file);
      if(name==='/shared-backend.js')body=body.toString().replace(/url: 'https:\/\/[^']+'/,'url: '+JSON.stringify(apiOrigin)).replace(/key: '[^']+'/,'key: "test-publishable-key"');
      return route.fulfill({contentType:({'.html':'text/html','.js':'application/javascript','.webmanifest':'application/manifest+json','.png':'image/png','.css':'text/css'})[path.extname(file)],body});
    }
    unexpected.push(url.origin+url.pathname);return route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*',socket=>{unexpected.push('WebSocket');socket.close();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  const preserved=async()=>assert.deepEqual(await page.evaluate(keys=>Object.fromEntries(keys.map(key=>[key,localStorage.getItem(key)])),Object.keys(sentinels)),sentinels,'Manager must preserve staff/legacy/parking sessions');
  const handoff=token=>page.goto(base+'/manager?pilot=1&test_navigation='+(++navigation)+'#attendance_token='+token);
  return {context,page,preserved,handoff,unexpected,errors};
}
try {
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  for(const width of [360,390,430,1440]) {
    const api=await testApi({seed:seedManager,excludeNotifications:true});
    const before=await api.parkingSnapshot();
    const {context,page,preserved,handoff,unexpected,errors}=await setup(api,width);
    try {
      const token=api.mint(manager);await handoff(token);await loaded(page);
      assert.equal(new URL(page.url()).hash,'','Manager handoff removed');
      await layout(page,'Overview '+width);await preserved();
      await expect(page.locator('#nowBody tr')).toHaveCount(2);
      await page.locator('#nowSearch').fill('staff 11');await expect(page.locator('#nowBody tr')).toHaveCount(1);
      await page.locator('#nowSearch').fill('');await page.locator('#nowSite').selectOption('Example yard');await expect(page.locator('#nowBody tr')).toHaveCount(1);
      await page.locator('#nowSite').selectOption('');
      await page.locator('[data-tab=staff]').click();await layout(page,'Staff '+width);
      await expect(page.locator('#addStaff')).toBeHidden();
      await expect(page.locator('#staffBody [data-pw],#staffBody [data-toggle],#staffBody [data-profile]')).toHaveCount(0);
      await expect(page.locator('#staffBody b'),'Typed markup must remain text').toHaveCount(0);
      await page.locator('#staffStatus').selectOption('');
      await page.locator('#staffSearch').fill('person 17');await expect(page.locator('#staffBody tr')).toHaveCount(1);
      await page.locator('#staffStatus').selectOption('active');await expect(page.locator('#staffEmpty')).toBeVisible();
      await page.locator('#staffStatus').selectOption('inactive');await expect(page.locator('#staffBody tr')).toHaveCount(1);
      await page.locator('#staffSearch').fill('');await page.locator('#staffStatus').selectOption('');

      await range(page,'2026-10-25');await expect(page.locator('#sheetBody tr')).toHaveCount(4);await layout(page,'Autumn timesheet '+width);
      const fall=await download(page,'#csv');assert.equal(fall.rows.length,4);
      assert.equal(fall.rows.find(r=>r.Note==='Repeated hour').In,'01:30');assert.equal(fall.rows.find(r=>r.Note==='Repeated hour').Out,'01:30');assert.equal(fall.rows.find(r=>r.Note==='Repeated hour').Hours,'1.00');
      assert.equal(fall.rows.find(r=>r.Note==='Removed staff history')['End date'],'26/10/2026');
      assert.equal(fall.rows.reduce((n,r)=>n+Number(r.Hours),0),3);
      assert.equal(fall.rows.some(r=>r.Note==='After autumn day boundary'),false);
      await range(page,'2026-03-29');await expect(page.locator('#sheetBody tr')).toHaveCount(2);
      const spring=await download(page,'#csv');assert.equal(spring.rows.find(r=>r.Note==='Skipped hour').In,'00:30');assert.equal(spring.rows.find(r=>r.Note==='Skipped hour').Out,'02:30');assert.equal(spring.rows.reduce((n,r)=>n+Number(r.Hours),0),2);
      await range(page,'2026-03-28');const overnight=await download(page,'#csv');assert.equal(overnight.rows[0].Hours,'6.50');assert.equal(overnight.rows[0]['End date'],'29/03/2026');
      await range(page,'2026-10-24');const escaped=await download(page,'#csv');assert.equal(escaped.rows.length,1);assert.ok(escaped.rows[0].Name.startsWith("'=Example"));assert.equal(escaped.rows[0].Note,"'=SUM(1,2)\n\"Example\"");assert.equal(escaped.rows[0].Hours,'8.50');assert.equal(escaped.rows[0]['Break (mins)'],'30');
      // Edited filters cannot silently label old data with a new export range.
      await page.locator('#from').fill('2026-10-25');await page.locator('#to').fill('2026-10-25');
      await page.locator('#csv').click();await expect(page.getByRole('status').filter({hasText:'Show'})).toBeVisible();
      await range(page,'2026-10-24','2026-10-25',id(11));await expect(page.locator('#sheetBody tr')).toHaveCount(3);
      const runningDays=await page.evaluate(()=>{
        const key=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
        const end=new Date(),start=new Date(end);start.setDate(start.getDate()-1);return [key(start),key(end)];
      });
      await range(page,...runningDays);await expect(page.locator('#sheetEmpty')).toBeVisible();
      await page.locator('#completedOnly').uncheck();await expect(page.locator('#sheetBody tr')).toHaveCount(2);assert.ok((await download(page,'#csv')).rows.every(r=>r.Status==='Running'));
      await page.locator('#completedOnly').check();

      // The most recent query wins even if an older response arrives last.
      const hold=api.holdNext('aero_shifts',url=>url.searchParams.get('select')?.includes('profiles:'));
      await page.locator('#from').fill('2026-10-24');await page.locator('#to').fill('2026-10-24');await page.locator('#run').click();
      const oldUrl=await hold.received;
      await range(page,'2026-03-29');await expect(page.locator('#sheetBody tr')).toHaveCount(2);
      const oldResponse=page.waitForResponse(oldUrl);hold.release();await oldResponse;
      await expect(page.locator('#sheetBody tr')).toHaveCount(2);assert.equal((await download(page,'#csv')).rows.length,2);

      await page.locator('[data-tab=reviews]').click();await layout(page,'Reviews '+width);
      await expect(page.getByText('Another manager must review your correction.',{exact:true})).toBeVisible();
      const approval=(await api.db.query("select id from aero_shift_corrections where reason='Example approval'")).rows[0].id;
      const rejection=(await api.db.query("select id from aero_shift_corrections where reason='Example rejection'")).rows[0].id;
      let oldReview;
      if(width===360) {
        oldReview=api.holdNext('aero_shift_corrections',()=>true,{afterRead:true});
        await page.locator('[data-tab=reviews]').click();await oldReview.received;
      }
      await page.locator('#review-note-'+approval).fill('Example checked');
      if(width===390)api.failNext('aero_review_shift_correction',true);
      await page.locator('[data-review="'+approval+'"][data-approve=true]').click();
      await expect(page.locator('[data-review="'+approval+'"]')).toHaveCount(0);
      if(oldReview) {
        const response=page.waitForResponse(r=>r.url().startsWith(apiOrigin+'/rest/v1/aero_shift_corrections?')&&new URL(r.url()).searchParams.get('select')?.includes('profiles:'));
        oldReview.release();await response;
        await expect(page.locator('[data-review="'+approval+'"]')).toHaveCount(0);
      }
      assert.equal((await api.db.query('select status from aero_shift_corrections where id=$1',[approval])).rows[0].status,'approved');
      await page.locator('#review-note-'+rejection).fill('Example rejected');
      await page.locator('[data-review="'+rejection+'"][data-approve=false]').click();
      await expect(page.locator('[data-review="'+rejection+'"]')).toHaveCount(0);
      await page.locator('#reviewFilter').selectOption('approved');await expect(page.locator('#reviews .review-item')).toHaveCount(1);
      await page.locator('#reviewFilter').selectOption('rejected');await expect(page.locator('#reviews .review-item')).toHaveCount(1);
      await page.locator('#reviewFilter').selectOption('all');
      await range(page,'2026-10-24');assert.equal((await download(page,'#csv')).rows[0].Hours,'9.50');

      await page.locator('[data-tab=audit]').click();await expect(page.locator('#auditEvents')).toContainText('Manager approved a shift correction.');await layout(page,'Audit '+width);
      await page.locator('#auditFilter').selectOption('approved');await expect(page.locator('#auditEvents .review-item')).toHaveCount(1);
      assert.equal((await download(page,'#exportAudit')).rows.length,1);
      let oldAudit;
      if(width===360){oldAudit=api.holdNext('aero_audit_events',()=>true,{afterRead:true});await page.locator('#refreshAudit').click();await oldAudit.received;}
      await api.db.query("update aero_audit_events set summary=$1 where action='approved' and company_id=$2",['=Example formula, "quoted"\nnew line',id(1)]);
      await page.locator('#refreshAudit').click();await expect(page.locator('#auditEvents')).toContainText('=Example formula');
      if(oldAudit){const response=page.waitForResponse(r=>r.url().startsWith(apiOrigin+'/rest/v1/aero_audit_events?'));oldAudit.release();await response;await expect(page.locator('#auditEvents')).toContainText('=Example formula');}
      assert.equal((await download(page,'#exportAudit')).rows[0].Summary,"'=Example formula, \"quoted\"\nnew line");

      if(width===1440) {
        await api.db.exec(`insert into aero_shifts(company_id,user_id,worksite_id,clock_in_at,clock_out_at,note)
select '${id(1)}','${id(10)}','${id(101)}','2026-10-20T00:00:00Z'::timestamptz+n*interval '1 minute','2026-10-20T00:00:00Z'::timestamptz+(n+1)*interval '1 minute','Bulk example '||n from generate_series(1,1001) n`);
        // The SQL stand-in resolves embedded profiles/sites per row; allow all three
        // real pagination requests to finish under load. Ordinary ranges keep 5s.
        await range(page,'2026-10-20','2026-10-20','',30000);await expect(page.locator('#sheetBody tr')).toHaveCount(1001);
        assert.equal((await download(page,'#csv')).rows.length,1001,'Export must include more than the API row limit');
      }
      // A late audit response after logout cannot repopulate hidden manager data.
      await page.locator('[data-tab=audit]').click();
      const auditHold=api.holdNext('aero_audit_events');await page.locator('#refreshAudit').click();const auditUrl=await auditHold.received;
      await page.locator('#signout').click();await expect(page.locator('#login')).toBeVisible();
      const auditResponse=page.waitForResponse(auditUrl);auditHold.release();await auditResponse;
      await expect(page.locator('#auditEvents')).toBeEmpty();await preserved();
      assert.equal(await page.evaluate(key=>localStorage.getItem(key),managerKey),null);
      await handoff(token);await expect(page.locator('#loginErr')).toContainText('Expired or already used');await preserved();
      await page.evaluate(([key,value])=>localStorage.setItem(key,value),[managerKey,JSON.stringify(api.session(manager))]);
      await page.locator('#email').fill('invalid@example.test');await page.locator('#pw').fill('synthetic-invalid-password');await page.locator('#signin').click();
      await expect(page.locator('#loginErr')).toContainText('Invalid login credentials');assert.equal(await page.evaluate(key=>localStorage.getItem(key),managerKey),null);
      await handoff(api.mint(id(10)));await expect(page.locator('#loginErr')).toContainText('for managers');await expect(page.locator('#app')).toBeHidden();
      await handoff(api.mint(id(16)));await expect(page.locator('#login')).toBeVisible();await expect(page.locator('#app')).toBeHidden();
      await handoff(api.mint(otherManager));await loaded(page,'Example company 2');
      await page.locator('[data-tab=staff]').click();await expect(page.locator('#staffBody')).not.toContainText('Example person 13');
      await page.locator('[data-tab=audit]').click();await expect(page.locator('#auditEvents')).not.toContainText('=Example formula');
      await preserved();
      assert.deepEqual(errors,[],'Uncaught errors');assert.deepEqual(unexpected,[],'External requests');assert.deepEqual(api.failures,[],'Unsupported API operations');
      assert.deepEqual(await page.evaluate(()=>window.excludedCalls),[],'No GPS access');
      assert.equal(await api.parkingSnapshot(),before,'Manager workflows preserve parking data');
      journeys++;console.log('Shared manager browser workflow passed at '+width+'px');
    } catch(error) {console.error('API failures:',api.failures);console.error('Browser errors:',errors);throw error;}
    finally {await context.close();await api.close();}
  }
  console.log(`${journeys} responsive manager journeys passed (synthetic Auth/REST; no notifications, phones or GPS).`);
} finally {if(browser)await browser.close();}
