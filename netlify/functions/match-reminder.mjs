// netlify/functions/match-reminder.mjs
//
// Netlify SCHEDULED FUNCTION — budi se sama svaki puni sat (vidi "config.schedule"
// na dnu ovog fajla), ali SAMO između 13h i 21h po hrvatskom vremenu (izvan tog
// raspona se odmah tiho vrati bez provjere). Provjeri raspored u Firebase bazi, i
// pošalje push notifikaciju preko ntfy.sh kad je sljedeća utakmica ~1h daleko.
//
// POTREBNE ENV VARIJABLE (Netlify → Site settings → Environment variables):
//   FIREBASE_DB_SECRET   - "Database secret" iz Firebase konzole (Project settings
//                          → Service accounts → Database secrets tab). Ovo je legacy
//                          token koji zaobilazi sva pravila baze samo za ovaj server.
//   NTFY_TOPIC           - (opcionalno, zadana vrijednost "dinamo_statistika_utakmica"
//                          već postavljena u kodu ispod) ime kanala na ntfy.sh na
//                          koje su se Luka i Lovro pretplatili u ntfy appu na
//                          telefonu. Topici funkcioniraju kao lozinka — ako ikad
//                          poželiš promijeniti ime, samo dodaj NTFY_TOPIC varijablu
//                          u Netlify i ona će preglasiti zadanu vrijednost.
//
// Nema Resend, nema domene, nema DNS-a, nema registracije — ntfy.sh je potpuno
// besplatan i bez ikakvog accounta.

const DB_URL = "https://statistika-utakmica-default-rtdb.europe-west1.firebasedatabase.app";
const ZAGREB_TZ = "Europe/Zagreb";

// Netlify serveri rade u UTC vremenu, ne hrvatskom — ove dvije funkcije ispravno
// pretvaraju između hrvatskog "zidnog" vremena i UTC-a, automatski uzimajući u obzir
// ljetno/zimsko računanje vremena (CET/CEST), bez potrebe za ručnim podešavanjem.

function zagrebPartsToUTCms(y, mo, d, hh, mm) {
  const guessUTC = Date.UTC(y, mo - 1, d, hh, mm);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: ZAGREB_TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  const map = {};
  fmt.formatToParts(new Date(guessUTC)).forEach(p => { map[p.type] = p.value; });
  const zagrebAsUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute);
  const offset = zagrebAsUTC - guessUTC; // koliko je hrvatsko vrijeme "ispred" UTC-a u tom trenutku
  return guessUTC - offset;
}

function currentZagrebHour() {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: ZAGREB_TZ, hour: '2-digit', hourCycle: 'h23' });
  return parseInt(fmt.format(new Date()), 10);
}

async function handler() {
  // Provjeravamo samo preko dana (13h-21h po hrvatskom vremenu) — izvan toga
  // odmah izlazimo, bez ikakvih poziva prema Firebasi/ntfy-u.
  const hourNow = currentZagrebHour();
  if (hourNow < 13 || hourNow > 21) {
    console.log(`Izvan aktivnog prozora (13-21h), trenutno je ${hourNow}h po hrvatskom.`);
    return new Response(`Izvan aktivnog prozora (13-21h), trenutno je ${hourNow}h po hrvatskom.`, { status: 200 });
  }
  console.log(`Unutar aktivnog prozora, ${hourNow}h po hrvatskom — provjeravam raspored...`);

  const DB_SECRET = process.env.FIREBASE_DB_SECRET;
  const NTFY_TOPIC = process.env.NTFY_TOPIC || "dinamo_statistika_utakmica";

  if (!DB_SECRET || !NTFY_TOPIC) {
    console.warn("match-reminder: nedostaje env varijabla, preskačem.");
    return new Response("Missing config", { status: 200 });
  }

  try {
    const schedRes = await fetch(`${DB_URL}/raspored_2627.json?auth=${DB_SECRET}`);
    const schedule = await schedRes.json();
    if (!Array.isArray(schedule)) {
      console.log("Raspored nije niz / prazan je:", JSON.stringify(schedule).slice(0,200));
      return new Response("No schedule data", { status: 200 });
    }
    console.log(`Učitano ${schedule.length} utakmica iz rasporeda.`);

    const now = Date.now();
    let sentCount = 0;

    for (const m of schedule) {
      if (!m || !m.datum) continue;
      const [y, mo, d] = m.datum.split('-').map(Number);
      const [hh, mm] = (m.time || '20:00').split(':').map(Number);
      const matchTime = zagrebPartsToUTCms(y, mo - 1 + 1, d, hh || 20, mm || 0);
      const diffMin = (matchTime - now) / 60000;

      // Prozor širok 60 min (30-90), jer provjera sad radi jednom na sat —
      // mora pokriti CIJELI sat da se sigurno uhvati bilo koje vrijeme početka.
      if (diffMin <= 30 || diffMin >= 90) continue;

      console.log(`Utakmica ${m.opp} (${m.datum} ${m.time || '20:00'}) je za ${Math.round(diffMin)} min — u prozoru je!`);

      const flagUrl = `${DB_URL}/pushRemindersSent/${m.id}.json?auth=${DB_SECRET}`;
      const flagRes = await fetch(flagUrl);
      const alreadySent = await flagRes.json();
      if (alreadySent) { console.log("Već poslano za ovu utakmicu, preskačem."); continue; }

      const oppName = m.opp || 'protivnik';
      const title = m.home
        ? `Dinamo Zagreb vs ${oppName}`
        : `${oppName} vs Dinamo Zagreb`;
      const venue = m.home ? 'Stadion Maksimir' : 'Gostovanje';

      const pushRes = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
        method: 'POST',
        headers: {
          'Title': `Danas igra Dinamo!`,
          'Priority': 'high',
          'Tags': 'soccer,alarm_clock'
        },
        body: `💙 ${title} — počinje u ${m.time || '20:00'} · ${m.natjecanje || ''} · ${venue}`
      });

      if (pushRes.ok) {
        await fetch(flagUrl, { method: 'PUT', body: JSON.stringify(true) });
        sentCount++;
        console.log("Push poslan uspješno za:", oppName);
      } else {
        console.error("ntfy error:", await pushRes.text());
      }
    }

    console.log(`Gotovo — poslano: ${sentCount}`);
    return new Response(`OK — poslano: ${sentCount}`, { status: 200 });
  } catch (e) {
    console.error("match-reminder error:", e);
    return new Response("Error: " + e.message, { status: 500 });
  }
}

export default handler;

// Netlify Scheduled Function config — pokreće se svaki puni sat (u UTC-u, npr.
// 12:00, 13:00, 14:00 UTC...). Interna provjera (currentZagrebHour) unutar
// handlera osigurava da se stvarni posao odradi samo 13h-21h po hrvatskom
// vremenu — ostatak dana funkcija se odmah tiho zatvori.
export const config = {
  schedule: "0 * * * *"
};
