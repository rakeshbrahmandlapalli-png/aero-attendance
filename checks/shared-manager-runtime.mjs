// Test the actual manager functions with deterministic data/response ordering.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {cases} from './shared-manager-fixture.mjs';
const source=fs.readFileSync(new URL('../admin.html',import.meta.url),'utf8');
function extract(name) {
  const start=source.search(new RegExp('^  (async )?function '+name+'\\(', 'm'));
  assert.ok(start>=0,'Missing function '+name);
  const line=source.slice(start,source.indexOf('\n',start));
  if(line.endsWith('}'))return line;
  return source.slice(start,source.indexOf('\n  }\n',start)+5);
}
let checks=0;
const check=(value,message)=>{assert.ok(value,message);checks++;};
const cell=new Function(extract('csvCell')+';return csvCell;')();
for(const value of ['=SUM(1,2)','+Example','-Example','@Example','  =Example','\tExample','\rExample','\nExample']) check(cell(value).startsWith('"\''),'Spreadsheet formula/control prefix neutralised');
check(cell('Example, "quoted"\nline')==='"Example, ""quoted""\nline"','Commas, quotes and line breaks round-trip');
check(cell(null)==='""','Null cell');
check(cell('Example staff')==='"Example staff"','Ordinary text unchanged');
const hours=new Function(extract('shiftHours')+';return shiftHours;')();
for(const s of cases) check(hours({clock_in_at:s.start,clock_out_at:s.end,break_minutes:s.breaks}).toFixed(2)===s.hours,'Elapsed hours for overnight/DST fixture '+s.id);
check(hours({clock_in_at:'2026-10-25T00:00:00Z',clock_out_at:'2026-10-25T01:00:00Z',break_minutes:120})===0,'Excess break never makes negative hours');
function environment(fetchPage) {
  const events={renders:[],errors:[],messages:[],requests:[]};
  const controls={from:{value:'2026-10-25'},to:{value:'2026-10-25'},who:{value:''},csv:{disabled:false}};
  const sb={from(table){
    const request={table,orders:[],filters:[]};
    const builder={select(){return builder;},order(...args){request.orders.push(args);return builder;},gte(...args){request.filters.push(['gte',...args]);return builder;},lt(...args){request.filters.push(['lt',...args]);return builder;},eq(...args){request.filters.push(['eq',...args]);return builder;},range(start,end){events.requests.push({...request,start,end});return fetchPage({...request,start,end});}};
    return builder;
  }};
  const run=new Function('sb','$','events',`
    var ME={id:'manager'},DEMO=false,SHEET=[],sheetToken=0,sheetQuery=null,sheetLoading=false;
    function toast(message){events.messages.push(message);}function fail(error){events.errors.push(error.message);}
    function renderSheet(){events.renders.push(SHEET.map(row=>row.id));}function renderStats(){}
    ${extract('sheetFilterKey')}
    ${extract('runSheet')}
    return {run:runSheet,logout(){ME=null;},get rows(){return SHEET;},get query(){return sheetQuery;}};
  `)(sb,id=>controls[id],events);
  return {run,events,controls};
}
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:value=>resolve(value)};};
{
  const records=Array.from({length:1001},(_,i)=>({id:i}));
  const e=environment(async request=>({data:records.slice(request.start,request.end+1),error:null}));
  await e.run.run();
  check(e.run.rows.length===1001,'All three pages committed');
  assert.deepEqual(e.events.requests.map(r=>r.start),[0,500,1000]);checks++;
  check(e.events.renders.length===1,'Partial pages are never published');
  check(e.events.requests.every(r=>r.orders.some(([column])=>column==='id')),'Stable tie-break ordering across pages');
}
{
  const e=environment(async request=>request.start?{error:{message:'Second page failed'}}:{data:Array.from({length:500},(_,id)=>({id})),error:null});
  await e.run.run();check(e.run.query===null&&e.events.renders.length===0,'A failed later page cannot leave an exportable partial dataset');
  check(e.events.errors.includes('Second page failed'),'Pagination failure surfaced');
}
{
  const slow=deferred();let first=true;
  const e=environment(()=>{if(first){first=false;return slow.promise;}return Promise.resolve({data:[{id:'newest'}],error:null});});
  const old=e.run.run();e.controls.who.value='other staff';await e.run.run();slow.resolve({data:[{id:'old'}],error:null});await old;
  check(e.run.rows[0].id==='newest'&&e.events.renders.length===1,'Late successful response cannot replace latest staff filter');
}
{
  const slow=deferred();let first=true;
  const e=environment(()=>{if(first){first=false;return slow.promise;}return Promise.resolve({data:[{id:'newest'}],error:null});});
  const old=e.run.run();await e.run.run();slow.resolve({error:{message:'Old failure'}});await old;
  check(e.events.errors.length===0&&e.run.rows[0].id==='newest','Late failure cannot invalidate a successful newer result');
}
{
  const slow=deferred(),e=environment(()=>slow.promise);const pending=e.run.run();e.run.logout();slow.resolve({data:[{id:'previous tenant'}],error:null});await pending;
  check(e.events.renders.length===0&&e.run.query===null,'Response arriving after logout cannot repopulate data');
}
{
  const e=environment(()=>{throw Error('Invalid dates must not query');});e.controls.from.value='2026-10-26';await e.run.run();
  check(e.events.messages.some(m=>m.includes('start date'))&&e.events.requests.length===0,'Invalid range rejected before querying');
}
console.log(`${checks} manager runtime checks passed (pagination, late responses, CSV protection, overnight/DST maths).`);
