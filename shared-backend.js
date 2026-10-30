// Opt-in pilot transport. Legacy and demo pages keep their existing backend.
(function () {
  'use strict';
  var query = new URLSearchParams(location.search);
  var enabled = !!window.STAGING_CONFIG || query.get('pilot') === '1';
  try {
    if (query.get('legacy') === '1') localStorage.removeItem('aero-shared-pilot');
    if (enabled) localStorage.setItem('aero-shared-pilot', '1');
    enabled = enabled || localStorage.getItem('aero-shared-pilot') === '1';
  } catch (_) {}
  if (!enabled || /\/demo(?:\/|$)/.test(location.pathname) || query.has('demo')) return;
  window.APP_CONFIG = window.STAGING_CONFIG ? window.STAGING_CONFIG.client() : {
    url: 'https://oioqjfrlwrjovnouhusp.supabase.co',
    key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9pb3FqZnJsd3Jqb3Zub3VodXNwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2Mjk3MDQsImV4cCI6MjEwNTIwNTcwNH0.09ddpfS4_KwZN7QWJoAiwaIl02wQLaw6yJWEltNMQ2U',
    shared: true
  };
  // The way back to Parking Ops. Parking Ops adds &back=<its own address>; only these
  // addresses are trusted, so a made-up link can't send staff somewhere else.
  // Add the address of any new Parking Ops site here.
  var PARKING_OPS = ['https://takeoff-ops.vercel.app', 'https://parkingbay-ops.vercel.app'];
  try {
    var back = query.get('back');
    if (back && PARKING_OPS.indexOf(back) !== -1) localStorage.setItem('aero-back-to', back);
  } catch (_) {}
  window.attendanceBackUrl = function () {
    try { var url = localStorage.getItem('aero-back-to'); return PARKING_OPS.indexOf(url) !== -1 ? url : ''; } catch (_) { return ''; }
  };
  var create = window.supabase.createClient;
  function selection(value) {
    return value.replace(/\b(companies|profiles|worksites)(![a-zA-Z0-9_]+)?\(/g, function (_, table, constraint) {
      return table + ':aero_' + table + (constraint ? '!aero_' + constraint.slice(1) : '') + '(';
    });
  }
  window.createAttendanceClient = function (url, key, options) {
    options = Object.assign({}, options, {auth: Object.assign({}, options && options.auth, {
      storageKey: options && options.auth && options.auth.storageKey === 'aero-manager-auth' ? 'aero-shared-manager-auth' : 'aero-shared-staff-auth'
    })});
    var client = create(url, key, options);
    // A staff sign-out must not revoke the manager/parking app's sessions.
    // Erase this client's persisted session even if logout cannot reach Auth.
    var signOut = client.auth.signOut.bind(client.auth);
    client.auth.signOut = async function (opts) {
      try { return await signOut(Object.assign({}, opts, {scope: 'local'})); }
      catch (error) { return {error: error}; }
      finally {
        var storage = options.auth.storage || window.localStorage;
        for (var suffix of ['', '-user', '-code-verifier']) {
          try { await storage.removeItem(options.auth.storageKey + suffix); } catch (_) {}
        }
      }
    };
    var from = client.from.bind(client), rpc = client.rpc.bind(client);
    client.from = function (table) {
      var builder = from('aero_' + table);
      var select = builder.select.bind(builder);
      builder.select = function (columns, opts) { return select(selection(columns || '*'), opts); };
      return builder;
    };
    client.rpc = function (name, args, opts) { return rpc('aero_' + name, args, opts); };
    var functions = client.functions;
    var invoke = functions.invoke.bind(functions);
    functions.invoke = function (name, options) {
      return invoke(name === 'swift-responder' ? 'aero-manage-staff' : 'aero-' + name, options);
    };
    Object.defineProperty(client, 'functions', {value: functions});
    return client;
  };
  window.attendancePilotReady = async function (client) {
    var fragment = new URLSearchParams(location.hash.slice(1));
    var token = fragment.get('attendance_token');
    if (fragment.has('attendance_token')) {
      history.replaceState(null, '', location.pathname + location.search);
      try {
        if (!token) throw new Error('This sign-in link is empty. Open Attendance from Parking Ops again.');
        var result = await client.auth.verifyOtp({type: 'magiclink', token_hash: token});
        if (result.error) throw result.error;
      } catch (error) {
        await client.auth.signOut({scope: 'local'});
        var message = document.getElementById('loginErr');
        if (message) { message.textContent = error.message; message.classList.remove('hidden'); }
        return {data: {session: null}, error: error};
      }
    }
    return client.auth.getSession();
  };
  window.attendanceFinishOnly = async function (client) {
    var result = await client.rpc('open_shift');
    if (result.error || !result.data) return false;
    var previous = document.getElementById('attendance-finish-only');
    if (previous) previous.remove();
    var section = document.createElement('section');
    section.id = 'attendance-finish-only';
    section.style.cssText = 'box-sizing:border-box;max-width:560px;margin:0 auto;padding:48px 16px 24px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0E1420';
    var heading = document.createElement('h1'); heading.textContent = 'Finish your shift'; heading.style.cssText = 'font-size:24px;line-height:1.2;font-weight:600;margin:0 0 12px';
    var text = document.createElement('p');
    text.textContent = 'Attendance access has ended. You can still clock out of your open shift. Location will be marked unverified.';
    text.style.cssText = 'font-size:16px;line-height:1.5;color:#4A5363;margin:0 0 24px';
    var button = document.createElement('button'); button.className = 'btn'; button.textContent = 'Clock out'; button.style.cssText = 'width:100%;min-height:56px;margin:0 0 12px';
    var error = document.createElement('p'); error.setAttribute('role', 'status'); error.style.cssText = 'font-size:14px;color:#B42318;margin:8px 0 0';
    var endBreak = document.createElement('button'); endBreak.className = 'btn g'; endBreak.textContent = 'End break'; endBreak.style.cssText = 'width:100%;min-height:56px;margin:0 0 12px';
    endBreak.onclick = async function () {
      endBreak.disabled = button.disabled = true; error.textContent = '';
      var ended = await client.rpc('end_break');
      if (ended.error) {
        var current = await client.rpc('open_shift');
        if (current.error || !current.data || current.data.break_started_at) {
          error.textContent = ended.error.message; endBreak.disabled = button.disabled = false; return;
        }
      }
      endBreak.remove(); button.disabled = false; error.textContent = 'Break ended.';
    };
    button.onclick = async function () {
      button.disabled = endBreak.disabled = true; error.textContent = '';
      var closed = await client.rpc('clock_out', {p_lat: null, p_lng: null, p_note: ''});
      if (closed.error) {
        // A timeout can follow a committed write: check before asking to retry.
        var confirmation = await client.rpc('open_shift');
        if (confirmation.error || confirmation.data) {
          error.textContent = closed.error.message; button.disabled = endBreak.disabled = false; return;
        }
      }
      heading.textContent = 'Shift finished';
      text.textContent = 'Your clock-out has been recorded.';button.remove();endBreak.remove();
    };
    section.append(heading, text);
    if (result.data.break_started_at) section.append(endBreak);
    section.append(button, error);
    document.body.prepend(section);
    ['login','app'].forEach(function (id) { var node = document.getElementById(id); if (node) node.classList.add('hidden'); });
    var boot = document.querySelector('.boot-status'); if (boot) boot.style.display = 'none';
    return true;
  };
})();
