// Step 4 browser -> real client/transport -> isolated SQL -> UI acceptance.
// Auth/REST are test doubles. No live Supabase, actual GPS or phone testing.
import {chromium} from 'playwright';
import {expect} from 'playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {attendanceRoot, sdkSource} from './shared-checkout.mjs';
import {testApi, apiOrigin} from './shared-test-api.mjs';
import {id} from './shared-fixture.mjs';
const base = 'http://localhost';
const staffKey = 'aero-shared-staff-auth';
let browser, journeys = 0, navigation = 0;
const api = await testApi({excludeNotifications:process.argv.includes('--no-notifications')});
const parkingBefore = await api.parkingSnapshot();
const errors = [], unexpected = [];
async function setup(width) {
  const context = await browser.newContext({viewport:{width,height:844},serviceWorkers:'block',timezoneId:'Europe/London'});
  const sentinels = {
    'aero-shared-manager-auth':JSON.stringify(api.session(id(20))),
    'aero-manager-auth':JSON.stringify(api.session(id(21))),
    'sb-ljrzcrphuepqtfrayeid-auth-token':'legacy-staff-sentinel',
    'sb-oioqjfrlwrjovnouhusp-auth-token':'parking-session-sentinel'
  };
  await context.addInitScript(values => {
    if (!sessionStorage.getItem('seeded')) {
      for (const [key,value] of Object.entries(values)) localStorage.setItem(key,value);
      sessionStorage.setItem('seeded','1');
    }
    // Deliberately no location. The test company permits unverified clocking.
    Object.defineProperty(navigator,'geolocation',{value:{
      getCurrentPosition(_ok,fail){fail({code:1,message:'Synthetic test: no location'});},
      watchPosition(_ok,fail){fail({code:1,message:'Synthetic test: no location'});return 1;},clearWatch(){}
    }});
  }, sentinels);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === apiOrigin) return api.route(route);
    if (url.href === 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js') {
      return route.fulfill({contentType:'application/javascript',body:sdkSource()});
    }
    if (url.origin === base) {
      let name = decodeURIComponent(url.pathname);
      if (name === '/') name = '/index.html';
      const file = path.resolve(attendanceRoot,'.'+name);
      if (!file.startsWith(attendanceRoot) || !fs.existsSync(file) || !['.html','.js','.webmanifest','.png','.css'].includes(path.extname(file))) {
        return route.fulfill({status:404,body:''});
      }
      let body = fs.readFileSync(file);
      if (name === '/shared-backend.js') {
        body = body.toString().replace(/url: 'https:\/\/[^']+'/,'url: '+JSON.stringify(apiOrigin)).replace(/key: '[^']+'/,'key: "test-publishable-key"');
      }
      return route.fulfill({contentType:({'.html':'text/html','.js':'application/javascript','.webmanifest':'application/manifest+json','.png':'image/png','.css':'text/css'})[path.extname(file)],body});
    }
    // Tile downloads are intentionally blocked, along with ALL other egress.
    if (!/^(api\.maptiler\.com|[abc]\.tile\.openstreetmap\.org|tile\.openstreetmap\.org)$/.test(url.hostname)) unexpected.push(url.origin+url.pathname);
    return route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', socket => { unexpected.push('WebSocket: '+socket.url()); socket.close(); });
  const page = await context.newPage();
  page.on('pageerror', error=>errors.push(error.message));
  const preserved = async () => {
    const actual = await page.evaluate(keys=>Object.fromEntries(keys.map(key=>[key,localStorage.getItem(key)])),Object.keys(sentinels));
    assert.deepEqual(actual,sentinels,'Staff actions must preserve manager, legacy and parking sessions');
  };
  return {context,page,preserved};
}
async function layout(page, label) {
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),label+' horizontal overflow');
  assert.ok(await page.evaluate(()=>[...document.querySelectorAll('button:not(.hidden),input,select,textarea')].filter(n=>n.getClientRects().length).every(n=>{
    const r=n.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1;
  })),label+' control outside viewport');
}
async function signedIn(page, user) {
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#accountName')).toHaveText('Example person '+user);
  await expect(page.locator('#company')).toHaveText('Example company 1');
  await expect(page.locator('#pwDialog')).toBeHidden();
}
const handoff = (page, token) => page.goto(base+'/?pilot=1&test_navigation='+(++navigation)+'#attendance_token='+token);
async function clock(page, out = false) {
  await page.locator('#openClock').click();
  await expect(page.locator('#clock')).toBeVisible();
  await layout(page, out ? 'Clock out' : 'Clock in');
  if (out) {
    await page.locator('#addNote').click();
    await page.locator('#shiftNote').fill('Example browser shift note');
  }
  // Exercise the supported keyboard confirmation path, not a JS function call.
  await page.locator('#action').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#clock')).toBeHidden();
  await expect(page.locator('#stateText')).toHaveText(out ? 'Not clocked in' : 'On shift');
}
try {
  browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  for (const width of [360,390,430,1440]) {
    // Each viewport starts from its own fresh synthetic staff data.
    await api.db.exec('delete from aero_shift_corrections; delete from aero_shifts; update private.attendance_testers set active=true;');
    const {context,page,preserved} = await setup(width);
    try {
      const token = api.mint(id(10));
      await handoff(page,token);
      await signedIn(page,10);
      assert.equal(new URL(page.url()).hash,'','Handoff removed from address');
      await expect(page.locator('#stateText')).toHaveText('Not clocked in');
      await layout(page,'Home '+width);
      if (width === 390) api.failNext('aero_clock_in', true);
      await clock(page);
      const open = (await api.db.query('select * from aero_shifts where user_id=$1 and clock_out_at is null',[id(10)])).rows[0];
      assert.ok(open,'Browser clock-in committed to namespaced SQL');
      await expect(page.locator('#elapsed')).toContainText('Example yard');
      await page.reload(); await signedIn(page,10);
      await expect(page.locator('#stateText')).toHaveText('On shift');
      await expect(page.locator('#elapsed')).toContainText('Example yard');
      assert.equal(api.requests.filter(r=>r.path==='/auth/v1/verify'&&r.body.token_hash===token).length,1,'Reload must not exchange token again');
      await preserved();
      await page.locator('#breakBtn').click();
      await expect(page.locator('#stateText')).toContainText('On break since');
      await api.db.query("update aero_shifts set break_started_at=now()-interval '7 minutes' where id=$1",[open.id]);
      await page.reload(); await signedIn(page,10);
      await expect(page.locator('#breakBtn')).toHaveText('End break');
      await page.locator('#breakBtn').click();
      await expect(page.locator('#stateText')).toHaveText('On shift');
      assert.equal((await api.db.query('select break_minutes from aero_shifts where id=$1',[open.id])).rows[0].break_minutes,7);
      if (width === 430) api.failNext('aero_clock_out', true);
      await clock(page,true);
      const closed = (await api.db.query('select * from aero_shifts where id=$1',[open.id])).rows[0];
      assert.ok(closed.clock_out_at);assert.equal(closed.note,'Example browser shift note');assert.equal(closed.break_minutes,7);
      assert.equal((await api.db.query('select count(*)::int n from aero_shifts where user_id=$1',[id(10)])).rows[0].n,1);
      // Use the existing shift-list entry point solely to request a correction;
      // timesheet totals, period navigation and exports belong to Step 5.
      await page.locator('#nav-sheet').click();
      await page.locator('[data-correct="'+open.id+'"]').first().click();
      await expect(page.locator('#correctionDialog')).toBeVisible();
      await layout(page,'Correction '+width);
      const start = new Date(Date.now()-7200000).toISOString().slice(0,16);
      const end = new Date(Date.now()-3600000).toISOString().slice(0,16);
      await page.locator('#correctIn').fill(end);
      await page.locator('#correctOut').fill(start);
      await page.locator('#correctReason').fill('Forgot the start time');
      await page.locator('#submitCorrection').click();
      await expect(page.locator('#correctionError')).toBeVisible();
      await page.locator('#correctIn').fill(start);
      await page.locator('#correctOut').fill(end);
      await page.locator('#submitCorrection').click();
      await expect(page.locator('#correctionDialog')).toBeHidden();
      await page.locator('#nav-inbox').click();
      await expect(page.locator('#activity')).toContainText('Awaiting manager review');
      await expect(page.locator('#activity')).toContainText('Forgot the start time');
      await layout(page,'Activity '+width);
      const request = (await api.db.query('select * from aero_shift_corrections where shift_id=$1',[open.id])).rows[0];
      assert.equal(request.user_id,id(10));assert.equal(request.status,'pending');
      await page.locator('#nav-work').click();
      // Replay with an existing session must erase it before displaying login.
      await handoff(page,token);
      await expect(page.locator('#login')).toBeVisible();
      await expect(page.locator('#loginErr')).toContainText('Expired or already used');
      await expect(page.locator('#app')).toBeHidden();
      assert.equal(await page.evaluate(key=>localStorage.getItem(key),staffKey),null);
      await preserved();
      // Password rejection must also remove an older persisted staff session.
      await page.evaluate(([key,value])=>localStorage.setItem(key,value),[staffKey,JSON.stringify(api.session(id(10)))]);
      await page.locator('#email').fill('invalid@example.test');
      await page.locator('#pw').fill('synthetic-invalid-password');
      await page.locator('#signin').click();
      await expect(page.locator('#loginErr')).toContainText('Invalid login credentials');
      assert.equal(await page.evaluate(key=>localStorage.getItem(key),staffKey),null);
      await preserved();
      // A new identity cannot inherit the previous person's shift or requests.
      await handoff(page,api.mint(id(11)));
      await signedIn(page,11);
      await expect(page.locator('#stateText')).toHaveText('Not clocked in');
      await page.locator('#nav-inbox').click();
      await expect(page.locator('#activity')).toHaveText('No correction requests yet.');
      await page.locator('#nav-account').click();
      await layout(page,'Account '+width);
      await page.locator('#signout').click();
      await expect(page.locator('#login')).toBeVisible();
      await preserved();
      // Finish-only: revoke an already clocked-in staff member on a break.
      await handoff(page,api.mint(id(10)));
      await signedIn(page,10);await clock(page);
      await page.locator('#breakBtn').click();
      await expect(page.locator('#breakBtn')).toHaveText('End break');
      await api.db.query('update private.attendance_testers set active=false where user_id=$1',[id(10)]);
      // The in-session reload path must clear ordinary staff state and timers.
      await page.evaluate(()=>window.dispatchEvent(new Event('online')));
      await expect(page.getByRole('heading',{name:'Finish your shift'})).toBeVisible();
      await expect(page.locator('#app')).toBeHidden();
      await expect(page.locator('#attendance-finish-only')).toHaveCount(1);
      await layout(page,'Finish only '+width);
      await expect(page.getByRole('button',{name:'End break',exact:true})).toBeVisible();
      if (width === 360) api.failNext('aero_end_break', true);
      await page.getByRole('button',{name:'End break',exact:true}).click();
      await expect(page.getByRole('button',{name:'End break',exact:true})).toHaveCount(0);
      await page.reload();
      await expect(page.getByRole('heading',{name:'Finish your shift'})).toBeVisible();
      await expect(page.getByRole('button',{name:'End break',exact:true})).toHaveCount(0);
      if (width === 430) {
        api.failNext('aero_clock_out');
        await page.getByRole('button',{name:'Clock out',exact:true}).click();
        await expect(page.locator('#attendance-finish-only [role=status]')).toContainText('network response lost');
        await expect(page.getByRole('button',{name:'Clock out',exact:true})).toBeEnabled();
      }
      if (width === 390 || width === 430) api.failNext('aero_clock_out', true);
      await page.getByRole('button',{name:'Clock out',exact:true}).click();
      await expect(page.getByRole('heading',{name:'Shift finished'})).toBeVisible();
      assert.equal((await api.db.query('select count(*)::int n from aero_shifts where user_id=$1 and clock_out_at is null',[id(10)])).rows[0].n,0);
      await page.reload();
      await expect(page.locator('#login')).toBeVisible();
      await expect(page.locator('#app')).toBeHidden();
      await expect(page.getByRole('button',{name:'Clock out',exact:true})).toHaveCount(0);
      await preserved();
      journeys++;
      console.log('Shared staff browser workflow passed at '+width+'px');
    } finally { await context.close(); }
  }
  assert.deepEqual(errors,[],'No uncaught browser errors');
  assert.deepEqual(unexpected,[],'No unexpected external network attempts');
  assert.deepEqual(api.failures,[],'No unsupported test API operations');
  assert.equal(await api.parkingSnapshot(),parkingBefore,'Staff journeys do not mutate parking tables');
  console.log(`${journeys} responsive shared staff journeys passed; parking/session isolation preserved. Auth/REST/GPS are synthetic; no live services used.`);
} finally { if(browser) await browser.close(); await api.close(); }
