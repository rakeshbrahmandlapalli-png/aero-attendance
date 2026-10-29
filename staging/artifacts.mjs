// Staging-only transformations. Production files are never overwritten.
export function attendanceArtifact(text) {
  text=text.replace('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js','/vendor/supabase-2.117.2.js');
  text=text.replace(/(["'])\/(shared-backend\.js|sw\.js|manifest\.webmanifest|manager\.webmanifest|icons\/[^"']+)\1/g,(_,q,p)=>q+'/attendance/'+p+q);
  text=text.replace('var MAP_KEY = "XVEMgKJvG23BOfRYp8KQ";','var MAP_KEY = "";');
  // No CDN or remote map credentials in generated staging pages.
  text=text.replace(/var MAP_KEY = "[^"]*";/g,'var MAP_KEY = "";');
  text=text.replace(/var VAPID_PUBLIC_KEY = "[^"]*";/g,'var VAPID_PUBLIC_KEY = "staging-local-notifications-only";');
  text=text.replace('<head>','<head><script src="/staging-config.js"></script>');
  text=text.replace('<script src="/attendance/shared-backend.js"></script>','<script src="/staging-sdk-guard.js"></script><script src="/attendance/shared-backend.js"></script>');
  return text;
}
