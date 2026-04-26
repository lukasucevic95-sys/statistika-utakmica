// scraper/index.js
// GitHub Actions pokreće ovaj script svakih sat vremena.
// Puppeteer otvara zona-karata.live, scrapa slobodna mjesta po tribinama,
// i sprema rezultate u Firebase Realtime Database.

const puppeteer  = require('puppeteer');
const admin      = require('firebase-admin');

// ── Firebase init ─────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential:  admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});
const db = admin.database();

// ── Konstante ─────────────────────────────────────────────────────────────
const ZONA_KARATA_URL = 'https://zona-karata.live';

const CAPACITIES = {
  zap_d: 5526, zap_g: 4826,
  sj_d:  4971, sj_g:  4510,
  jug:   1480,
};

const ZONE_MAP = [
  { kw: ['zapad dolje', 'zapad - dolje', 'west lower'], id: 'zap_d' },
  { kw: ['zapad gore',  'zapad - gore',  'west upper'], id: 'zap_g' },
  { kw: ['sjever dolje','sjever - dolje','north lower'], id: 'sj_d'  },
  { kw: ['sjever gore', 'sjever - gore', 'north upper'], id: 'sj_g'  },
  { kw: ['jug', 'south', 'bad blue', 'bbb'           ], id: 'jug'   },
  { kw: ['zapad', 'west' ], id: 'zap_d' },
  { kw: ['sjever','north'], id: 'sj_d'  },
];

function matchZone(text) {
  const t = (text || '').toLowerCase().trim();
  for (const z of ZONE_MAP) {
    if (z.kw.some(k => t.includes(k))) return z.id;
  }
  return null;
}

function parseHrNumber(text) {
  if (!text) return null;
  const cleaned = String(text).trim().replace(/\s/g,'').replace(/\./g,'').replace(/,/g,'');
  const m = cleaned.match(/^\d+/);
  return m ? parseInt(m[0]) : null;
}

function extractOpponent(text) {
  if (!text) return '';
  const patterns = [
    /dinamo\s*[-–—]\s*(.+)/i,
    /gnk\s+dinamo\s*[-–—]\s*(.+)/i,
    /dinamo\s+vs?\.?\s+(.+)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim().replace(/\s*\(.*\)$/, '').trim();
  }
  const parts = text.split(/[-–—]/);
  if (parts.length >= 2) {
    const nd = parts.find(p => !p.toLowerCase().includes('dinamo'));
    if (nd) return nd.trim();
  }
  return '';
}

function extractDate(text) {
  const m1 = (text||'').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m1) return `${m1[3]}-${m1[2].padStart(2,'0')}-${m1[1].padStart(2,'0')}`;
  const m2 = (text||'').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return m2[0];
  return '';
}

// ── Scraping logika (ista kao Chrome extension content.js) ────────────────
async function scrapeMatch(page, matchUrl) {
  console.log(`  → Otvaram: ${matchUrl}`);
  await page.goto(matchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Čekaj da se učitaju zone (span.text-lg)
  try {
    await page.waitForSelector('span.text-lg', { timeout: 40000 });
  } catch(e) {
    console.log('  ⚠ Nema span.text-lg — stranica možda nema podatke o kartama');
    return null;
  }

  // Dodatno čekaj za animacije (overflow-hidden divovi)
  await new Promise(r => setTimeout(r, 2000));

  // Scrape u browser contextu (isti kod kao u content.js)
  const result = await page.evaluate((ZONE_MAP) => {
    function parseHrNumber(text) {
      if (!text) return null;
      const cleaned = String(text).trim().replace(/\s/g,'').replace(/\./g,'').replace(/,/g,'');
      const m = cleaned.match(/^\d+/);
      return m ? parseInt(m[0]) : null;
    }
    function matchZone(text) {
      const t = (text||'').toLowerCase().trim();
      for (const z of ZONE_MAP) {
        if (z.kw.some(k => t.includes(k))) return z.id;
      }
      return null;
    }

    const zones = {};
    const raw   = {};
    const IGNORE = ['slobodno','zauzeto','ukupno','available','sold','total',
                    'free','prodano','kapacitet','mjesta','sjedala'];

    const allSpans = [...document.querySelectorAll('span')];

    for (const labelSpan of allSpans) {
      const labelText = (labelSpan.textContent||'').trim().toLowerCase();
      if (labelText !== 'slobodno' && labelText !== 'available' && labelText !== 'free') continue;

      const rowDiv = labelSpan.parentElement;
      if (!rowDiv) continue;

      const valueSpan = [...rowDiv.querySelectorAll('span')]
        .find(s => s !== labelSpan && /\d/.test(s.textContent));
      if (!valueSpan) continue;

      const free = parseHrNumber(valueSpan.textContent);
      if (free === null || free < 0 || free > 20000) continue;

      // Idi gore i traži naziv tribine
      let name = '';
      let node = rowDiv.parentElement;
      for (let depth = 0; depth < 6 && node; depth++) {
        const candidates = [...node.querySelectorAll('span,h1,h2,h3,h4,strong,p')]
          .filter(el => {
            const t = el.textContent.trim();
            return t.length > 1 && t.length < 80 &&
              el.children.length === 0 &&
              !IGNORE.includes(t.toLowerCase()) &&
              !/^\d/.test(t) && !/^\s*$/.test(t);
          });
        if (candidates.length > 0) { name = candidates[0].textContent.trim(); break; }
        node = node.parentElement;
      }

      const zid = matchZone(name);
      if (zid) {
        zones[zid] = (zones[zid] != null) ? zones[zid] + free : free;
        if (!raw[name]) raw[name] = { slobodno: 0, zid };
        raw[name].slobodno += free;
      }
    }

    return { zones, raw };
  }, ZONE_MAP);

  return result;
}

// ── Pronađi nadolazeće utakmice na zona-karata.live ──────────────────────
async function scrapeAllMatches(page) {
  console.log('📋 Dohvaćam listu utakmica...');
  await page.goto(ZONA_KARATA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Čekaj da se React SPA potpuno učita (do 45 sekundi)
  console.log('  ⏳ Čekam učitavanje stranice (React SPA)...');
  let loaded = false;
  for (let i = 0; i < 45; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const hasData = await page.evaluate(() => {
      return document.querySelectorAll('span.text-lg').length > 0;
    });
    if (hasData) {
      console.log(`  ✓ Podaci pronađeni nakon ${i+1}s`);
      loaded = true;
      break;
    }
  }
  if (!loaded) console.log('  ⚠ span.text-lg nije pronađen nakon 45s, pokušavam svejedno...');
  await new Promise(r => setTimeout(r, 2000));

  // Pronađi sve linkove na utakmice
  const matchLinks = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href]')]
      .map(a => ({ href: a.href, text: a.textContent.trim() }))
      .filter(l =>
        l.href.includes('zona-karata.live') &&
        !l.href.endsWith('/') &&
        l.href !== window.location.href &&
        l.href.split('/').length > 4
      );
    return [...new Map(links.map(l => [l.href, l])).values()]; // deduplicate
  });

  // Pronađi protivnika i datum iz aria-label sekcija
  const matchSections = await page.evaluate(() => {
    return [...document.querySelectorAll('section[aria-label], [data-id]')]
      .map(s => ({
        label: s.getAttribute('aria-label') || '',
        dataId: s.dataset?.id || '',
        text: (s.innerText || '').slice(0, 200),
      }))
      .filter(s => s.label.toLowerCase().includes('dinamo') || s.dataId);
  });

  console.log(`  Pronađeno ${matchLinks.length} linkova, ${matchSections.length} sekcija`);
  return { matchLinks, matchSections };
}

// ── Glavni flow ───────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Dinamo Karte Scraper — pokrenuto u', new Date().toISOString());

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 800 });

    // 1. Dohvati listu utakmica
    const { matchLinks, matchSections } = await scrapeAllMatches(page);

    const results = {};
    let scraped = 0;

    // 2. Ako ima direktnih linkova — scrape svaki
    if (matchLinks.length > 0) {
      for (const link of matchLinks.slice(0, 10)) { // max 10 utakmica
        try {
          const matchResult = await scrapeMatch(page, link.href);
          if (!matchResult || !Object.keys(matchResult.zones).length) continue;

          // Izvuci naziv/datum s trenutne stranice
          const pageInfo = await page.evaluate(() => {
            const sec = document.querySelector('section[aria-label]');
            const label = sec?.getAttribute('aria-label') || document.title || '';
            const dm = (document.body.innerText||'').match(/\d{1,2}\.\d{1,2}\.\d{4}/);
            return { label, date: dm ? dm[0] : '' };
          });

          const opponent = extractOpponent(pageInfo.label) || link.text.slice(0,50);
          const datum    = extractDate(pageInfo.date);
          const key      = (datum || new Date().toISOString().split('T')[0])
            + '_' + (opponent.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'') || 'unknown');

          results[key] = {
            datum:      datum || new Date().toISOString().split('T')[0],
            protivnik:  opponent,
            natjecanje: 'HNL',
            zones:      matchResult.zones,
            updated:    new Date().toISOString(),
            source:     'github-actions',
            raw:        matchResult.raw,
          };

          console.log(`  ✅ ${key}:`, matchResult.zones);
          scraped++;
        } catch(e) {
          console.warn(`  ⚠ Greška za ${link.href}:`, e.message);
        }
      }
    }

    // 3. Ako nema linkova — pokušaj scrape direktno glavne stranice
    if (scraped === 0 && matchSections.length > 0) {
      console.log('  Nema linkova, scrapam glavnu stranicu...');
      const mainResult = await page.evaluate((ZONE_MAP) => {
        function parseHrNumber(t) {
          if(!t) return null;
          const c = String(t).trim().replace(/\s/g,'').replace(/\./g,'').replace(/,/g,'');
          const m = c.match(/^\d+/);
          return m ? parseInt(m[0]) : null;
        }
        function matchZone(text) {
          const t=(text||'').toLowerCase().trim();
          for(const z of ZONE_MAP) if(z.kw.some(k=>t.includes(k))) return z.id;
          return null;
        }
        const zones={}, raw={};
        const IGNORE=['slobodno','zauzeto','ukupno','available','sold','total','free','prodano','kapacitet','mjesta','sjedala'];
        for(const labelSpan of [...document.querySelectorAll('span')]) {
          const lt=(labelSpan.textContent||'').trim().toLowerCase();
          if(lt!=='slobodno'&&lt!=='available'&&lt!=='free') continue;
          const rowDiv=labelSpan.parentElement; if(!rowDiv) continue;
          const valueSpan=[...rowDiv.querySelectorAll('span')].find(s=>s!==labelSpan&&/\d/.test(s.textContent));
          if(!valueSpan) continue;
          const free=parseHrNumber(valueSpan.textContent);
          if(free===null||free<0||free>20000) continue;
          let name='', node=rowDiv.parentElement;
          for(let d=0;d<6&&node;d++){
            const c=[...node.querySelectorAll('span,h1,h2,h3,h4,strong,p')].filter(el=>{
              const t=el.textContent.trim();
              return t.length>1&&t.length<80&&el.children.length===0&&!IGNORE.includes(t.toLowerCase())&&!/^\d/.test(t)&&!/^\s*$/.test(t);
            });
            if(c.length>0){name=c[0].textContent.trim();break;}
            node=node.parentElement;
          }
          const zid=matchZone(name);
          if(zid){zones[zid]=(zones[zid]!=null)?zones[zid]+free:free;if(!raw[name])raw[name]={slobodno:0,zid};raw[name].slobodno+=free;}
        }
        const sec=document.querySelector('section[aria-label]');
        const label=sec?.getAttribute('aria-label')||'';
        const dm=(document.body.innerText||'').match(/\d{1,2}\.\d{1,2}\.\d{4}/);
        return {zones,raw,label,date:dm?dm[0]:''};
      }, ZONE_MAP);

      if (Object.keys(mainResult.zones).length > 0) {
        const opponent = extractOpponent(mainResult.label);
        const datum    = extractDate(mainResult.date);
        const key      = (datum || new Date().toISOString().split('T')[0])
          + '_' + (opponent.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'') || 'unknown');

        results[key] = {
          datum:     datum || new Date().toISOString().split('T')[0],
          protivnik: opponent,
          natjecanje:'HNL',
          zones:     mainResult.zones,
          updated:   new Date().toISOString(),
          source:    'github-actions',
        };
        console.log(`  ✅ Glavna stranica: ${key}`, mainResult.zones);
        scraped++;
      }
    }

    // 4. Spremi u Firebase
    if (scraped > 0) {
      console.log(`\n💾 Sprema ${scraped} utakmica u Firebase...`);

      const existing = (await db.ref('karte_manual').once('value')).val() || {};
      const merged = { ...existing };

      for (const [key, data] of Object.entries(results)) {
        // Traži postojeći unos po protivniku — da ažurira isti unos svaki sat
        const oppSlug = (data.protivnik||'').toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'');
        const existingKey = Object.keys(merged).find(k => oppSlug && k.includes(oppSlug));

        if (existingKey) {
          console.log(`  🔄 Ažuriram: ${existingKey}`);
          merged[existingKey] = { ...merged[existingKey], zones: data.zones, updated: data.updated, source: data.source };
        } else {
          console.log(`  ➕ Novi unos: ${key}`);
          merged[key] = data;
        }
      }

      await db.ref('karte_manual').set(merged);
      console.log('✅ Firebase ažuriran!');
    } else {
      console.log('⚠ Nema podataka — zona-karata.live nema aktivnih utakmica u prodaji');
    }

  } finally {
    await browser.close();
    await admin.app().delete();
  }

  console.log('✅ Završeno u', new Date().toISOString());
}

main().catch(err => {
  console.error('❌ Scraper greška:', err);
  process.exit(1);
});
