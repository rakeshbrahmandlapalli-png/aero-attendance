// Synthetic readiness and rollback rehearsal. Never connects to a live service.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {stripTypeScriptTypes} from 'node:module';
import {bootShared,seedStaff,committed,id} from './shared-fixture.mjs';
import {readParking} from './shared-checkout.mjs';
import {PGlite} from '@electric-sql/pglite';
let checks=0;const ok=(value,message)=>{assert.ok(value,message);checks++;};
const db=await bootShared();
try {
 await seedStaff(db);
 const parking=(await db.query('select to_jsonb(s) s from staff s order by id')).rows;
 await db.query('update aero_companies set require_on_site=true where id=$1',[id(1)]);
 await assert.rejects(()=>committed(db,id(10),'select aero_clock_in($1,null,null,null)',[id(101)]),/Turn on location/);checks++;
 await assert.rejects(()=>committed(db,id(10),'select aero_clock_in($1,54,1,1)',[id(101)]),/Move inside/);checks++;
 await committed(db,id(10),'select aero_clock_in($1,51.5,-0.1,10)',[id(101)]);
 await committed(db,id(10),'select aero_start_break()');
 await db.exec(readParking('setup/rollback/136-attendance-shared-rollback.sql'));
 ok((await committed(db,id(10),'select * from aero_profiles')).length===0,'Kill switch denies reads');
 await assert.rejects(()=>committed(db,id(10),'select aero_clock_in($1,51.5,-0.1,10)',[id(101)]));checks++;
 const closed=(await committed(db,id(10),'select to_jsonb(aero_clock_out(null,null)) s'))[0].s;
 ok(closed.clock_out_at&&closed.break_started_at===null,'Kill switch retains finish-only clock-out');
 ok((await db.query('select count(*)::int n from aero_shifts')).rows[0].n===1,'Rollback retains shift records');
 assert.deepEqual((await db.query('select to_jsonb(s) s from staff s order by id')).rows,parking);checks++;
 const archive=await db.dumpDataDir();
 const restored=new PGlite({loadDataDir:archive});
 try {
  assert.deepEqual((await restored.query('select to_jsonb(s) s from staff s order by id')).rows,parking);checks++;
  ok((await restored.query('select count(*)::int n from aero_shifts')).rows[0].n===1,'Synthetic full database restore retains attendance');
 }finally{await restored.close();}
}finally{await db.close();}
const sender=readParking('supabase/functions/aero-send-push/index.ts').replace(/^import .*;\n/gm,'');
let attempts=0,expiry=false,eligible=['allowed'],eligibilityError=null,deleted=[],requested=[],handler;
const chain=table=>{let filter=[];const q={select(){return q;},in(_key,ids){filter=ids;return q;},eq(_key,id){deleted.push(id);return q;},delete(){return q;},then(resolve){requested.push({table,ids:filter});return Promise.resolve({data:table==='aero_push_subscriptions'?[{id:'device',endpoint:'https://synthetic.invalid',p256dh:'fake',auth:'fake'}]:[],error:null}).then(resolve);}};return q;};
const context={Response,Request,URL,Intl,Date,Map,Set,console:{error(){}},setTimeout:fn=>{fn();},createClient:()=>({from:chain,rpc:async()=>({data:eligible.map(user_id=>({user_id})),error:eligibilityError})}),webpush:{setVapidDetails(){},sendNotification:async()=>{attempts++;if(expiry)throw {statusCode:410};if(attempts<3)throw {statusCode:503};}},Deno:{env:{get:()=> 'synthetic'},serve:fn=>{handler=fn;}}};
vm.runInNewContext(stripTypeScriptTypes(sender)+'\nglobalThis.ready={sendWithRetry,sendTo};',context);
await context.ready.sendWithRetry({},'fake');ok(attempts===3,'Transient push retries bounded at three');
attempts=0;expiry=true;await assert.rejects(()=>context.ready.sendWithRetry({},'fake'));ok(attempts===1,'Expired push is not retried');
attempts=0;await context.ready.sendTo(['allowed','revoked'],['clock_in'],{});ok(deleted.includes('device'),'Expired subscription cleaned locally');
ok(requested.filter(r=>r.table==='aero_push_subscriptions'&&r.ids.length).every(r=>r.ids.length===1&&r.ids[0]==='allowed'),'Only server-eligible recipients reach sender');
eligible=[];requested=[];await context.ready.sendTo(['revoked'],['clock_in'],{});ok(requested.length===0,'Revoked recipients cause no subscription read/send');
eligibilityError={message:'Gate unavailable'};await assert.rejects(()=>context.ready.sendTo(['allowed'],['clock_in'],{}));checks++;
ok((await handler(new Request('http://synthetic.invalid',{method:'GET'}))).status===405,'Sender rejects wrong method');
const events={};let notification,opened;
const worker={self:{location:{origin:'https://synthetic.invalid'},skipWaiting(){},registration:{showNotification:async(_title,n)=>{notification=n;}},clients:{claim:async()=>{},matchAll:async()=>[],openWindow:async url=>{opened=url;}},addEventListener:(name,fn)=>{events[name]=fn;}},URL,Response,fetch:async()=>{throw Error('offline');}};
vm.runInNewContext(fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8'),worker);
let response;events.fetch({request:{mode:'navigate',url:'https://synthetic.invalid/'},respondWith:p=>{response=p;}});
const offline=await response;ok(offline.status===503&&offline.headers.get('cache-control')==='no-store','Offline navigation is explicit and not cached');
ok((await offline.text()).includes('No changes have been queued'),'Offline never promises queued clocking');
let intercepted=false;events.fetch({request:{mode:'cors',url:'https://synthetic.invalid/rest/v1/aero_shifts'},respondWith(){intercepted=true;}});ok(!intercepted,'Worker never caches API/auth responses');
let push;events.push({data:{json:()=>({title:'Synthetic',body:'Test',url:'/manager'})},waitUntil:p=>{push=p;}});await push;ok(notification.icon==='/icons/manager-192.png','Manager push icon');
events.notificationclick({notification:{data:{url:'/manager'},close(){}},waitUntil:p=>{push=p;}});await push;ok(opened==='https://synthetic.invalid/manager','Notification route reopens local app');
for(const name of ['manifest.webmanifest','manager.webmanifest']){const m=JSON.parse(fs.readFileSync(new URL('../'+name,import.meta.url)));ok(m.display==='standalone'&&m.icons.length>=2,'Install manifest '+name);for(const icon of m.icons)ok(fs.existsSync(new URL('..'+icon.src,import.meta.url)),'Install icon exists');}
console.log(`${checks} synthetic notification/PWA/GPS/kill-switch readiness checks passed. Physical phone delivery/install/GPS remain unverified.`);
