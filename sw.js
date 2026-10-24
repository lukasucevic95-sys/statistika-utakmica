/* Service worker — Dinamo fan aplikacija: rad bez mreže (app shell + runtime cache) */
const VER='dinamo-v3';
const SHELL='shell-'+VER, RUNTIME='run-'+VER, IMGS='img-'+VER;
const PRECACHE=['./','index.html','manifest.json','assets/img002.png','assets/favicon.png','assets/apple-touch-icon.png','icon-192.png','icon-512.png'];
// Što smijemo spremati s drugih domena (Firebase podaci i API-ji se NE diraju)
const CROSS_OK=[/^https:\/\/fonts\.googleapis\.com\//,/^https:\/\/fonts\.gstatic\.com\//,/^https:\/\/www\.gstatic\.com\/firebasejs\//,/^https:\/\/cdnjs\.cloudflare\.com\//];

self.addEventListener('install',e=>{
  e.waitUntil((async()=>{
    const c=await caches.open(SHELL);
    await Promise.all(PRECACHE.map(u=>c.add(u).catch(()=>{})));
    self.skipWaiting();
  })());
});
self.addEventListener('activate',e=>{
  e.waitUntil((async()=>{
    const keep=[SHELL,RUNTIME,IMGS];
    for(const k of await caches.keys()) if(!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});
async function trim(name,max){
  const c=await caches.open(name), ks=await c.keys();
  for(let i=0;i<ks.length-max;i++) await c.delete(ks[i]);
}
function withTimeout(p,ms){ return new Promise((res,rej)=>{ const t=setTimeout(()=>rej(new Error('timeout')),ms); p.then(v=>{clearTimeout(t);res(v);},er=>{clearTimeout(t);rej(er);}); }); }
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET') return;
  const url=new URL(req.url);
  const same=url.origin===self.location.origin;
  // Navigacija: najprije mreža (svježa verzija), a bez mreže spremljena stranica
  if(req.mode==='navigate'){
    e.respondWith((async()=>{
      try{
        const r=await withTimeout(fetch(req),4000);
        if(r&&r.ok){ const c=await caches.open(SHELL); c.put('index.html',r.clone()); }
        return r;
      }catch(err){
        const c=await caches.open(SHELL);
        return (await c.match('index.html',{ignoreSearch:true}))||(await c.match('./',{ignoreSearch:true}))||Response.error();
      }
    })());
    return;
  }
  // Slike s bilo koje domene (grbovi klubova): cache-first
  if(req.destination==='image'){
    e.respondWith((async()=>{
      const c=await caches.open(IMGS), hit=await c.match(req);
      if(hit) return hit;
      try{ const r=await fetch(req); if(r&&(r.ok||r.type==='opaque')){ c.put(req,r.clone()); trim(IMGS,60); } return r; }
      catch(err){ return hit||Response.error(); }
    })());
    return;
  }
  if(!same&&!CROSS_OK.some(re=>re.test(req.url))) return;   // Firebase, API-ji: prolaze mimo cachea
  // Ostalo: stale-while-revalidate
  e.respondWith((async()=>{
    const c=await caches.open(same?SHELL:RUNTIME), hit=await c.match(req);
    const net=fetch(req).then(r=>{ if(r&&r.ok) c.put(req,r.clone()); return r; }).catch(()=>null);
    return hit||(await net)||Response.error();
  })());
});
