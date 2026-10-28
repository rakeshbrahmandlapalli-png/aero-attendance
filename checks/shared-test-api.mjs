// Developer-only HTTP adapter for browser acceptance. Real SQL/RLS/RPCs run in
// PGlite. Auth and this small REST subset are test doubles, NOT GoTrue/PostgREST.
// Playwright fulfills every request locally; this opens no network listener.
import assert from 'node:assert/strict';
import {bootShared, seedStaff, committed} from './shared-fixture.mjs';
import {createHash} from 'node:crypto';
export const apiOrigin = 'http://shared-backend.test';
const identifier = value => {
  assert.match(value, /^[a-z_][a-z_0-9]*$/);
  return '"' + value + '"';
};
export async function testApi() {
  const db = await bootShared();
  await seedStaff(db);
  const tokens = new Map(), sessions = new Map(), requests = [], failures = [];
  let sequence = 0, nextFailure = null;
  function mint(user) {
    const token = 'test-handoff-' + (++sequence);
    tokens.set(token, user);
    return token;
  }
  // A parking account's metadata must not open Attendance's legacy password UI.
  const authUser = user => ({id:user, email:user+'@example.test', aud:'authenticated', role:'authenticated', user_metadata:{must_change_password:true}});
  function session(user) {
    const key = 'test-session-' + (++sequence);
    sessions.set(key, user);
    // The SDK decodes JWT expiry; this unsigned token is accepted only here.
    const jwt = [Buffer.from(JSON.stringify({alg:'none'})).toString('base64url'),
      Buffer.from(JSON.stringify({sub:user,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600,test_session:key})).toString('base64url'), 'test'].join('.');
    sessions.set(jwt, user);
    return {access_token:jwt,refresh_token:key,token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user:authUser(user)};
  }
  async function route(route) {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.origin, apiOrigin);
    const method = request.method();
    const body = request.postDataJSON() || {};
    const bearer = request.headers().authorization?.replace(/^Bearer /i,'');
    const user = sessions.get(bearer);
    requests.push({path:url.pathname, method, user, query:url.search, body});
    const reply = (status, data) => route.fulfill({status, contentType:'application/json', body:JSON.stringify(data)});
    if (url.pathname.startsWith('/auth/v1/')) {
      const action = url.pathname.slice('/auth/v1/'.length);
      if (action === 'verify' && method === 'POST') {
        const person = tokens.get(body.token_hash);
        tokens.delete(body.token_hash);
        if (!person) return reply(403, {code:'otp_expired',msg:'Expired or already used handoff'});
        assert.equal(body.type, 'magiclink');
        return reply(200, session(person));
      }
      if (action === 'user' && method === 'GET' && user) return reply(200, authUser(user));
      if (action === 'logout' && method === 'POST') {
        assert.equal(url.searchParams.get('scope'), 'local', 'Staff must not revoke other app sessions');
        sessions.delete(bearer);
        return reply(204, null);
      }
      if (action === 'token') return reply(400, {code:'invalid_credentials',msg:'Invalid login credentials'});
      failures.push('Unexpected Auth operation: ' + method + ' ' + action);
      return reply(401, {code:'bad_jwt',msg:'Auth session missing'});
    }
    if (!user) return reply(401, {code:'PGRST301',message:'Auth session missing'});
    const name = url.pathname.replace(/^\/rest\/v1\/(?:rpc\/)?/, '');
    assert.match(name, /^aero_[a-z_]+$/, 'Shared mode must use namespaced API paths');
    const injection = nextFailure?.name === name ? nextFailure : null;
    if (injection) nextFailure = null;
    if (injection && !injection.afterCommit) return reply(503, {message:'network response lost in test'});
    try {
      let data;
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        assert.equal(method, 'POST');
        const allowed = ['aero_clock_in','aero_clock_out','aero_start_break','aero_end_break','aero_open_shift','aero_request_shift_correction','aero_my_company_paused','aero_my_handover','aero_overtime_weeks'];
        assert.ok(allowed.includes(name), 'Unexpected RPC: ' + name);
        const args = Object.entries(body);
        const call = identifier(name) + '(' + args.map(([key], i) => identifier(key)+' => $'+(i+1)).join(',') + ')';
        const rows = await committed(db, user, 'select to_jsonb('+call+') result', args.map(([,value])=>value));
        const meta = (await db.query('select proretset from pg_proc where proname=$1', [name])).rows[0];
        data = meta.proretset ? rows.map(r=>r.result) : rows[0]?.result ?? null;
      } else {
        assert.equal(method, 'GET', 'Only RPCs may write in this staff acceptance adapter');
        const allowed = ['aero_profiles','aero_companies','aero_worksites','aero_shifts','aero_shift_corrections','aero_announcements','aero_announcement_reads','aero_privacy_ack','aero_notification_prefs'];
        assert.ok(allowed.includes(name), 'Unexpected table: '+name);
        const args = [], clauses = [];
        for (const [column, filter] of url.searchParams) {
          if (['select','order','limit'].includes(column)) continue;
          const match = /^(eq|gte|lte|gt|lt|is)\.(.*)$/.exec(filter);
          assert.ok(match, 'Unsupported filter: '+filter);
          if (match[1] === 'is') { assert.equal(match[2], 'null'); clauses.push(identifier(column)+' is null'); }
          else { args.push(match[2]); clauses.push(identifier(column)+({eq:'=',gte:'>=',lte:'<=',gt:'>',lt:'<'})[match[1]]+' $'+args.length); }
        }
        let sql = 'select * from '+identifier(name)+(clauses.length ? ' where '+clauses.join(' and ') : '');
        if (url.searchParams.has('order')) {
          const [column, direction] = url.searchParams.get('order').split('.');
          assert.ok(['asc','desc'].includes(direction));
          sql += ' order by '+identifier(column)+' '+direction;
        }
        if (url.searchParams.has('limit')) {
          const limit = Number(url.searchParams.get('limit'));
          assert.ok(Number.isInteger(limit) && limit >= 0 && limit <= 1000);
          sql += ' limit '+limit;
        }
        data = await committed(db, user, sql, args);
        const select = url.searchParams.get('select') || '*';
        const embed = 'companies:aero_companies!aero_profiles_company_id_fkey(name)';
        if (select.includes('(')) {
          assert.equal(name, 'aero_profiles');
          assert.ok(select.endsWith(embed), 'Expected explicitly named companies relationship');
          for (const row of data) row.companies = (await committed(db,user,'select name from aero_companies where id=$1',[row.company_id]))[0] || null;
        }
        if (select !== '*') {
          const columns = select.replace(embed, 'companies').split(',').map(s=>s.trim());
          for (const column of columns) identifier(column);
          data = data.map(row=>Object.fromEntries(columns.map(column=>[column,row[column]])));
        }
        if (request.headers().accept?.includes('application/vnd.pgrst.object+json')) {
          if (data.length !== 1) return reply(406,{code:'PGRST116',details:'The result contains '+data.length+' rows',message:'JSON object requested, multiple (or no) rows returned'});
          data = data[0];
        }
      }
      if (injection?.afterCommit) return reply(503, {message:'network response lost in test'});
      return reply(200, data);
    } catch (error) {
      if (error instanceof assert.AssertionError) failures.push(error.message);
      return reply(400, {code:error.code || 'P0001',message:error.message});
    }
  }
  async function parkingSnapshot() {
    const rows = {};
    for (const table of ['companies','staff','activity']) rows[table] = (await db.query('select * from '+table+' order by 1')).rows;
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
  return {db, route, mint, session, requests, failures, parkingSnapshot,
    failNext(name, afterCommit = false) {nextFailure = {name,afterCommit};},
    close:()=>db.close()};
}
