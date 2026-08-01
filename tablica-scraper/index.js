// scraper/tablica.js
// GitHub Actions pokreće ovaj script (raspored u tablica.yml — vidi komentar tamo).
// Povlači HNL tablicu, listu strijelaca i listu asistenata s worldfootball.net.
//
// NAPOMENA: worldfootball.net vraća HTTP 403 na obični fetch() zahtjev s GitHub Actions
// servera (bot-zaštita), pa se stranica dohvaća pravim headless Chrome preglednikom
// (Puppeteer, isto kao scraper za karte) — HTML se zatim parsira s Cheeriom kao i prije.
//
// Sprema rezultat u Firebase Realtime Database:
//   tablica_hnl              -> [{club,p,w,d,l,gf,ga,form}, ...]  (jedan objekt po klubu)
//   tablica_hnl_strijelci    -> [{player,club,matches,goals}, ...]  (top 10, poredano)
//   tablica_hnl_asistenti    -> [{player,club,matches,assists}, ...]  (top 10, poredano)
//   tablica_hnl_updated      -> ISO timestamp zadnjeg uspješnog ažuriranja
//
// Napomena: Prednji dio aplikacije (index.html) sam sortira klubove po bodovima/gol-razlici,
// pa redoslijed u nizu tablice koji ovdje spremamo nije bitan (strijelci/asistenti se spremaju
// već poredani po rangu sa stranice).

const cheerio = require('cheerio');
const puppeteer = require('puppeteer');

const STANDINGS_URL = 'https://www.worldfootball.net/competition/co2/croatia-1-hnl/standings-calculator/';
const SCORERS_URL   = 'https://www.worldfootball.net/competition/co2/croatia-1-hnl/statistics-goals/';
const ASSISTS_URL   = 'https://www.worldfootball.net/competition/co2/croatia-1-hnl/statistics-assists/';

// ── Firebase init ─────────────────────────────────────────────────────────
const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential:  admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});
const db = admin.database();

// ── Dohvat stranice pravim headless Chromeom (zaobilazi bot-zaštitu) ──────
let _browser = null;
async function getBrowser() {
  if (!_browser) {
    _browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
  }
  return _browser;
}

async function fetchHtml(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'hr,en;q=0.8' });
    await page.setViewport({ width: 1280, height: 900 });
    const res = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    if (res && res.status() >= 400) {
      throw new Error(`HTTP ${res.status()} dohvaćajući ${url}`);
    }
    return await page.content();
  } finally {
    await page.close();
  }
}

// Zajednička logika za tablice strijelaca/asistenata (ista struktura stranice).
// statLabel npr. "Scores" (golovi) ili "Assists" (asistencije) — traži se u headeru
// da se pronađe prava tablica na stranici.
function parsePlayerStatsTable(html, statLabelRegex) {
  const $ = cheerio.load(html);
  const rows = [];

  $('table.standard_tabelle').each((_, table) => {
    if (rows.length) return;
    const headerText = $(table).find('th').map((__, th) => $(th).text().trim()).get().join('|');
    if (!statLabelRegex.test(headerText)) return;

    $(table).find('tr').each((__, tr) => {
      const $tr = $(tr);
      if ($tr.find('th').length) return;

      const tds = $tr.find('td');
      if (!tds.length) return;

      // Ime igrača: od svih linkova na /player/... uzmi tekstualno najduži (puno ime)
      const personLinks = $tr.find('td a[href*="/player/"], td a[href*="/players/"], td a[href*="/person/"]')
        .map((___, a) => $(a).text().trim()).get()
        .filter(Boolean);
      if (!personLinks.length) return;
      const player = personLinks.reduce((a, b) => (b.length > a.length ? b : a), '');

      // Ime kluba: isto, najduži tekst od linkova na /teams/...
      const teamLinks = $tr.find('td a[href*="/teams/"]')
        .map((___, a) => $(a).text().trim()).get()
        .filter(Boolean);
      const club = teamLinks.reduce((a, b) => (b.length > a.length ? b : a), '');

      // Prva dva plain-broja u retku = [odigrane utakmice, golovi/asistencije]
      const cellTexts = tds.map((___, td) => $(td).text().trim()).get();
      const plainNums = cellTexts.filter(t => /^\d+$/.test(t)).map(Number);
      if (plainNums.length < 2) return;
      const [matches, count] = plainNums;

      if (!player || !count) return;
      rows.push({ player, club, matches, count });
    });
  });

  return rows.slice(0, 10);
}

function parseStandingsTable(html) {
  const $ = cheerio.load(html);
  const rows = [];

  // worldfootball.net koristi table.standard_tabelle za više tablica na stranici
  // (poredak, strijelci...) — uzimamo onu čiji header sadrži "Pts".
  $('table.standard_tabelle').each((_, table) => {
    if (rows.length) return; // već smo našli pravu tablicu
    const headerText = $(table).find('th').map((__, th) => $(th).text().trim()).get().join('|');
    if (!/Pts/i.test(headerText)) return;

    $(table).find('tr').each((__, tr) => {
      const $tr = $(tr);
      if ($tr.find('th').length) return; // header red, preskoči

      const tds = $tr.find('td');
      if (!tds.length) return;

      // Ime kluba: prvi link koji vodi na /teams/... (puno ime, npr. "Dinamo Zagreb")
      const clubLink = $tr.find('td a[href*="/teams/"]').first();
      const club = clubLink.text().trim();
      if (!club) return;

      // Skupi sve tekstove ćelija i izvuci brojeve neovisno o točnoj poziciji stupca
      // (redak "#" zna biti prazan kad je više klubova izjednačeno na istom mjestu)
      const cellTexts = tds.map((___, td) => $(td).text().trim()).get();

      const scoreCell = cellTexts.find(t => /^\d+:\d+$/.test(t));
      if (!scoreCell) return; // sigurno nije redak podataka
      const [gf, ga] = scoreCell.split(':').map(Number);

      // Preostali plain-brojevi (bez ':') u redoslijedu M, W, D, L, Diff, Pts
      const plainNums = cellTexts
        .filter(t => /^-?\d+$/.test(t))
        .map(Number);
      if (plainNums.length < 4) return;
      const [played, win, draw, loss] = plainNums;

      rows.push({
        club,
        p: played || 0,
        w: win || 0,
        d: draw || 0,
        l: loss || 0,
        gf: gf || 0,
        ga: ga || 0,
        form: '', // worldfootball standings-calculator ne daje formu zadnjih 5; ostaje prazno
      });
    });
  });

  return rows;
}

// ── Glavni flow ───────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 HNL tablica scraper — pokrenuto u', new Date().toISOString());

  // 1. Tablica
  const standingsHtml = await fetchHtml(STANDINGS_URL);
  const table = parseStandingsTable(standingsHtml);
  if (table.length < 8) {
    // Manje od 8 klubova = sigurno je nešto pošlo po zlu (promjena strukture stranice i sl.)
    // Ne prepisujemo postojeće (dobre) podatke lošima.
    throw new Error(`Pronađeno samo ${table.length} klubova u tablici — očekivano ~10. Prekidam bez spremanja.`);
  }
  console.log(`✅ Tablica: pronađeno ${table.length} klubova`);
  table.forEach(r => console.log(`   ${r.club.padEnd(22)} U:${r.p} P:${r.w} N:${r.d} I:${r.l} G:${r.gf}:${r.ga}`));
  await db.ref('tablica_hnl').set(table);

  // 2. Strijelci (best-effort — ako padne, ne prekidamo cijeli scraper)
  try {
    const scorersHtml = await fetchHtml(SCORERS_URL);
    const scorers = parsePlayerStatsTable(scorersHtml, /Scores|Goals/i)
      .map(r => ({ player: r.player, club: r.club, matches: r.matches, goals: r.count }));
    if (scorers.length) {
      console.log(`✅ Strijelci: pronađeno ${scorers.length} (1. ${scorers[0].player} — ${scorers[0].goals} gol.)`);
      await db.ref('tablica_hnl_strijelci').set(scorers);
    } else {
      console.warn('⚠ Nema podataka o strijelcima — preskačem, ostaju stari podaci.');
    }
  } catch (e) {
    console.warn('⚠ Greška kod scrapea strijelaca:', e.message);
  }

  // 3. Asistenti (best-effort)
  try {
    const assistsHtml = await fetchHtml(ASSISTS_URL);
    const assists = parsePlayerStatsTable(assistsHtml, /Assists/i)
      .map(r => ({ player: r.player, club: r.club, matches: r.matches, assists: r.count }));
    if (assists.length) {
      console.log(`✅ Asistenti: pronađeno ${assists.length} (1. ${assists[0].player} — ${assists[0].assists} as.)`);
      await db.ref('tablica_hnl_asistenti').set(assists);
    } else {
      console.warn('⚠ Nema podataka o asistentima — preskačem, ostaju stari podaci.');
    }
  } catch (e) {
    console.warn('⚠ Greška kod scrapea asistenata:', e.message);
  }

  await db.ref('tablica_hnl_updated').set(new Date().toISOString());
  console.log('💾 Firebase ažuriran!');
  await admin.app().delete();
  console.log('✅ Završeno u', new Date().toISOString());
}

main()
  .catch(err => {
    console.error('❌ Scraper greška:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (_browser) await _browser.close();
  });
