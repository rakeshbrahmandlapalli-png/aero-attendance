import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../shared-backend.js',import.meta.url),'utf8');
function boot(search='?pilot=1',pathname='/') {
 const calls=[];const storage=new Map();let signouts=0;
 const auth={verifyOtp:async()=>({error:null}),getSession:async()=>({data:{session:{user:{id:'tester'}}}}),signOut:async options=>{signouts++;calls.push({signout:options});return {error:null};}};
 const client={auth,from:table=>({select:columns=>{calls.push({table,columns});return {};}}),rpc:(name,args)=>{calls.push({name,args});return {};},functions:{invoke:name=>{calls.push({invoke:name});return {};}}};
 const context={URLSearchParams,location:{search,pathname,hash:''},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},history:{replaceState:()=>{context.location.hash='';}},document:{getElementById:()=>null},APP_CONFIG:{url:'legacy'},supabase:{createClient:(url,key,opts)=>{calls.push({url,opts});return client;}}};
 context.window=context;vm.runInNewContext(source,context);return {context,calls,auth,storage,signouts:()=>signouts};
}
for(const [search,path] of [['','/'],['?pilot=1','/demo'],['?pilot=1&demo','/']]) {
 const x=boot(search,path);assert.equal(x.context.APP_CONFIG.url,'legacy');assert.equal(x.context.createAttendanceClient,undefined);
}
const x=boot();const c=x.context.createAttendanceClient(x.context.APP_CONFIG.url,'public',{auth:{storageKey:'aero-manager-auth'}});
assert.equal(x.calls[0].opts.auth.storageKey,'aero-shared-manager-auth');
const staff=boot();const staffClient=staff.context.createAttendanceClient('test','public');
assert.equal(staff.calls[0].opts.auth.storageKey,'aero-shared-staff-auth');
await staffClient.auth.signOut();assert.equal(staff.calls.at(-1).signout.scope,'local');
c.from('profiles').select('id, companies!profiles_company_id_fkey(name)');
assert.equal(x.calls.at(-1).table,'aero_profiles');
assert.equal(x.calls.at(-1).columns,'id, companies:aero_companies!aero_profiles_company_id_fkey(name)');
c.from('shifts').select('*, profiles(full_name), worksites(name)');
assert.equal(x.calls.at(-1).columns,'*, profiles:aero_profiles(full_name), worksites:aero_worksites(name)');
c.rpc('clock_in',{p_lat:51.5});assert.equal(x.calls.at(-1).name,'aero_clock_in');
c.functions.invoke('swift-responder');assert.equal(x.calls.at(-1).invoke,'aero-manage-staff');
x.context.location.hash='#attendance_token=single-use';
let received;x.auth.verifyOtp=async args=>{received=args;return {error:null};};
await x.context.attendancePilotReady(c);assert.equal(received.token_hash,'single-use');assert.equal(x.context.location.hash,'');
x.context.location.hash='#attendance_token=expired';x.auth.verifyOtp=async()=>({error:{message:'Expired token'}});
const failed=await x.context.attendancePilotReady(c);assert.equal(failed.data.session,null);assert.equal(x.signouts(),1);
const network=boot();
network.auth.verifyOtp=async()=>{throw new Error('Network exchange failed');};
network.auth.signOut=async()=>{throw new Error('Offline sign-out');};
const offline=network.context.createAttendanceClient('test','public');
network.storage.set('aero-shared-staff-auth','previous employee session');
network.storage.set('aero-shared-manager-auth','manager session');
network.context.location.hash='#attendance_token=unavailable';
const dropped=await network.context.attendancePilotReady(offline);
assert.equal(dropped.data.session,null);assert.equal(dropped.error.message,'Network exchange failed');
assert.equal(network.storage.has('aero-shared-staff-auth'),false,'A failed exchange and failed logout must still erase old staff session');
assert.equal(network.storage.get('aero-shared-manager-auth'),'manager session');
assert.equal(network.context.location.hash,'','Even a failed network exchange consumes the fragment');
const empty=boot();const emptyClient=empty.context.createAttendanceClient('test','public');
empty.context.location.hash='#attendance_token=';
const missing=await empty.context.attendancePilotReady(emptyClient);
assert.equal(missing.data.session,null,'An empty handoff must not reuse the previous session');
assert.equal(empty.context.location.hash,'');
console.log('Shared transport checks passed: legacy/demo preservation, isolated sessions, table/relationship/RPC routing, one-time handoff and failed-token session clearing');
