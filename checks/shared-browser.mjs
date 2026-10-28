import {chromium} from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
async function serve(route) {
 let p=new URL(route.request().url()).pathname;
 if(p==='/demo')p='/index.html';if(p==='/demo/admin')p='/admin.html';if(p==='/')p='/index.html';
 const file=path.resolve(root,'.'+p);
 if(!file.startsWith(root)||!fs.existsSync(file)||!/^\.(html|js|css|png|webmanifest)$/.test(path.extname(file)))return route.fulfill({status:404,body:''});
 return route.fulfill({contentType:({'.html':'text/html','.js':'application/javascript','.png':'image/png','.webmanifest':'application/manifest+json','.css':'text/css'})[path.extname(file)],body:fs.readFileSync(file)});
}
const base='http://localhost';
let browser;
try {
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 for(const width of [360,390,430,1440]) {
  const context=await browser.newContext({viewport:{width,height:844},serviceWorkers:'block'});
  // No external network: serve app and SDK bytes from disk; abort all other
  // requests, including production APIs, maps, analytics and push endpoints.
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin===base)return serve(route);
    if(url.href==='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js')return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(new URL('../../takeoff-ops/public/vendor/supabase-2.117.2.js',import.meta.url),'utf8')});
    return route.abort('blockedbyclient');
  });
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/demo');await page.locator('#app:not(.hidden)').waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Staff overflow '+width);
  await page.goto(base+'/demo/admin');await page.locator('#app:not(.hidden)').waitFor();
  for(const tab of ['sheets','staff','sites','reviews','audit','now'])await page.locator('[data-tab="'+tab+'"]').click();
  assert.deepEqual(errors,[],'Page errors '+width);
  await context.close();
 }
 console.log('Staff/manager demos and manager navigation passed at 360/390/430/1440px');
} finally {if(browser)await browser.close();}
