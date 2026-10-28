// Opt-in pilot transport. Legacy and demo pages keep their existing backend.
(function () {
  'use strict';
  var query = new URLSearchParams(location.search);
  var enabled = query.get('pilot') === '1';
  try {
    if (query.get('legacy') === '1') localStorage.removeItem('aero-shared-pilot');
    if (enabled) localStorage.setItem('aero-shared-pilot', '1');
    enabled = enabled || localStorage.getItem('aero-shared-pilot') === '1';
  } catch (_) {}
  if (!enabled || /\/demo(?:\/|$)/.test(location.pathname) || query.has('demo')) return;
  window.APP_CONFIG = {
    url: 'https://oioqjfrlwrjovnouhusp.supabase.co',
    key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9pb3FqZnJsd3Jqb3Zub3VodXNwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2Mjk3MDQsImV4cCI6MjEwNTIwNTcwNH0.09ddpfS4_KwZN7QWJoAiwaIl02wQLaw6yJWEltNMQ2U',
    shared: true
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
    if (token) {
      history.replaceState(null, '', location.pathname + location.search);
      var result = await client.auth.verifyOtp({type: 'magiclink', token_hash: token});
      if (result.error) {
        await client.auth.signOut({scope: 'local'});
        var message = document.getElementById('loginErr');
        if (message) { message.textContent = result.error.message; message.classList.remove('hidden'); }
        return {data: {session: null}, error: result.error};
      }
    }
    return client.auth.getSession();
  };
  window.attendanceFinishOnly = async function (client) {
    var result = await client.rpc('open_shift');
    if (result.error || !result.data) return false;
    var section = document.createElement('section');
    section.style.cssText = 'max-width:560px;margin:48px auto;padding:24px';
    var heading = document.createElement('h1'); heading.textContent = 'Finish your shift';
    var text = document.createElement('p');
    text.textContent = 'Attendance access has ended. You can still clock out of your open shift. Location will be marked unverified.';
    var button = document.createElement('button'); button.className = 'btn'; button.textContent = 'Clock out';
    var error = document.createElement('p'); error.setAttribute('role', 'status');
    button.onclick = async function () {
      button.disabled = true;
      var closed = await client.rpc('clock_out', {p_lat: null, p_lng: null, p_note: ''});
      if (closed.error) {
        // A timeout can follow a committed write: check before asking to retry.
        var confirmation = await client.rpc('open_shift');
        if (confirmation.error || confirmation.data) {
          error.textContent = closed.error.message; button.disabled = false; return;
        }
      }
      heading.textContent = 'Shift finished';
      text.textContent = 'Your clock-out has been recorded.';button.remove();
    };
    section.append(heading, text, button, error);
    document.body.prepend(section);
    ['login','app'].forEach(function (id) { var node = document.getElementById(id); if (node) node.classList.add('hidden'); });
    var boot = document.querySelector('.boot-status'); if (boot) boot.style.display = 'none';
    return true;
  };
})();
