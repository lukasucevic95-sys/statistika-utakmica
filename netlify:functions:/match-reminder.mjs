// netlify/functions/match-reminder.mjs
//
// Netlify SCHEDULED FUNCTION — budi se sama svakih 15 minuta (vidi "config.schedule"
// na dnu ovog fajla), provjeri raspored u Firebase bazi, i pošalje push notifikaciju
// preko ntfy.sh kad je sljedeća utakmica ~1h daleko. Ne treba je nitko ručno pozivati.
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

async function handler() {
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
      return new Response("No schedule data", { status: 200 });
    }

    const now = Date.now();
    let sentCount = 0;

    for (const m of schedule) {
      if (!m || !m.datum) continue;
      const [y, mo, d] = m.datum.split('-').map(Number);
      const [hh, mm] = (m.time || '20:00').split(':').map(Number);
      const matchTime = new Date(y, mo - 1, d, hh || 20, mm || 0).getTime();
      const diffMin = (matchTime - now) / 60000;

      // Prozor 50-75 min (širi od 15-min ciklusa provjere, da se sigurno uhvati)
      if (diffMin <= 50 || diffMin >= 75) continue;

      const flagUrl = `${DB_URL}/pushRemindersSent/${m.id}.json?auth=${DB_SECRET}`;
      const flagRes = await fetch(flagUrl);
      const alreadySent = await flagRes.json();
      if (alreadySent) continue; // već poslano za ovu utakmicu

      const oppName = m.opp || 'protivnik';
      const title = m.home
        ? `Dinamo Zagreb vs ${oppName}`
        : `${oppName} vs Dinamo Zagreb`;
      const venue = m.home ? 'Stadion Maksimir' : 'Gostovanje';

      const pushRes = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
        method: 'POST',
        headers: {
          'Title': `⚽ ${title} za sat vremena!`,
          'Priority': 'high',
          'Tags': 'soccer,alarm_clock'
        },
        body: `Počinje u ${m.time || '20:00'} · ${m.natjecanje || ''} · ${venue}`
      });

      if (pushRes.ok) {
        await fetch(flagUrl, { method: 'PUT', body: JSON.stringify(true) });
        sentCount++;
      } else {
        console.error("ntfy error:", await pushRes.text());
      }
    }

    return new Response(`OK — poslano: ${sentCount}`, { status: 200 });
  } catch (e) {
    console.error("match-reminder error:", e);
    return new Response("Error: " + e.message, { status: 500 });
  }
}

export default handler;

// Netlify Scheduled Function config — pokreće se svakih 15 minuta, non-stop.
export const config = {
  schedule: "*/15 * * * *"
};
