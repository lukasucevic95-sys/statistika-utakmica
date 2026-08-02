// scraper/tablica.js
// GitHub Actions pokreće ovaj script (raspored u tablica.yml — vidi komentar tamo).
//
// POVIJEST OVOG FAJLA (radi konteksta ako se opet nešto pokvari):
//   v1: cheerio + fetch() na worldfootball.net -> HTTP 403 (bot-zaštita blokira GH Actions IP)
//   v2: Puppeteer (pravi headless Chrome) na worldfootball.net -> i dalje HTTP 403
//   v3: Puppeteer + stealth plugin (sakriva automatizacijske otiske) -> i dalje HTTP 403
//       => zaključak: worldfootball.net vjerojatno blokira cijeli IP-raspon GitHub Actionsa
//          na mrežnoj/Cloudflare razini, ne prepoznavanjem preglednika. To se ne rješava
//          boljom glumom "pravog browsera".
//   v4 (OVO): tablica se sad povlači s TheSportsDB API-ja (javni, besplatni, NAMIJENJEN baš
//          ovakvom automatiziranom pristupu — hnl.com.hr koristi isti taj API za svoju
//          tablicu), pa nema bot-zaštite. Brže i pouzdanije, bez Puppeteera/Cheeria.
//
// Strijelci/asistenti: worldfootball.net i dalje blokira GH Actions IP, a TheSportsDB nema
// pouzdan javni endpoint za top-listu strijelaca/asistenata po ligi. Za sada ostaju prazni
// (frontend to lijepo prikazuje kao "Podaci još nisu dostupni.") dok se ne nađe drugi izvor.
//
// Sprema rezultat u Firebase Realtime Database:
//   tablica_hnl          -> [{club,p,w,d,l,gf,ga,form}, ...]  (jedan objekt po klubu)
//   tablica_hnl_updated  -> ISO timestamp zadnjeg uspješnog ažuriranja

const LEAGUE_ID = 4629; // Croatian First Football League (HNL) na TheSportsDB

// ── Firebase init ─────────────────────────────────────────────────────────
const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential:  admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});
const db = admin.database();

function currentSeasonString(d = new Date()) {
  // HNL sezona ide srpanj (7) -> svibanj sljedeće godine, format "2025-2026"
  const y = d.getFullYear();
  const m = d.getMonth() + 1; // 1-12
  return m >= 7 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

async function fetchHnlTable(season) {
  const url = `https://www.thesportsdb.com/api/v1/json/123/lookuptable.php?l=${LEAGUE_ID}&s=${season}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} dohvaćajući ${url}`);
  const data = await res.json();
  if (!data || !Array.isArray(data.table)) return [];

  return data.table.map(t => ({
    club: (t.strTeam || '').trim(),
    p:  parseInt(t.intPlayed, 10)  || 0,
    w:  parseInt(t.intWin, 10)     || 0,
    d:  parseInt(t.intDraw, 10)    || 0,
    l:  parseInt(t.intLoss, 10)    || 0,
    gf: parseInt(t.intGoalsFor, 10)     || 0,
    ga: parseInt(t.intGoalsAgainst, 10) || 0,
    form: t.strForm || '',
  }));
}

// ── Glavni flow ───────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 HNL tablica scraper — pokrenuto u', new Date().toISOString());

  const season = currentSeasonString();
  console.log(`📅 Sezona: ${season}`);

  let table = await fetchHnlTable(season);

  // Ako trenutna sezona još nema podataka (npr. netom prije početka), pokušaj prošlu
  // sezonu kao fallback da tablica ne bude prazna van sezone.
  if (table.length < 8) {
    const now = new Date();
    const prevSeason = currentSeasonString(new Date(now.getFullYear(), now.getMonth() - 2, now.getDate()));
    if (prevSeason !== season) {
      console.log(`⚠ Sezona ${season} ima samo ${table.length} klubova, pokušavam ${prevSeason}...`);
      table = await fetchHnlTable(prevSeason);
    }
  }

  if (table.length < 8) {
    // Manje od 8 klubova = sigurno je nešto pošlo po zlu. Ne prepisujemo postojeće
    // (dobre) podatke lošima.
    throw new Error(`Pronađeno samo ${table.length} klubova u tablici — očekivano ~10. Prekidam bez spremanja.`);
  }

  console.log(`✅ Tablica: pronađeno ${table.length} klubova`);
  table.forEach(r => console.log(`   ${r.club.padEnd(22)} U:${r.p} P:${r.w} N:${r.d} I:${r.l} G:${r.gf}:${r.ga}`));

  await db.ref('tablica_hnl').set(table);
  await db.ref('tablica_hnl_updated').set(new Date().toISOString());

  console.log('💾 Firebase ažuriran!');
  await admin.app().delete();
  console.log('✅ Završeno u', new Date().toISOString());
}

main().catch(err => {
  console.error('❌ Scraper greška:', err);
  process.exitCode = 1;
});
