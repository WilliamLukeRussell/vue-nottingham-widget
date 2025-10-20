// Scrapes myvue Nottingham and outputs JSON with next_starting, next_finishing, today_showings.
// Requires: npm i playwright
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const VUE_URL = 'https://www.myvue.com/cinema/nottingham/whats-on';

function parseTimeToMinutes(t) {
  // accepts "10:45" or "10:45 AM"/"22:10"
  const ampm = /am|pm/i.test(t) ? t.match(/am|pm/i)[0].toUpperCase() : null;
  const [hStr, mStr] = t.replace(/[^0-9:]/g, '').split(':');
  let h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (ampm) {
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
  }
  return h * 60 + m;
}
function minutesToHHMM(total) {
  total = ((total % (24 * 60)) + (24 * 60)) % (24 * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage({ locale: 'en-GB' });
  await page.goto(VUE_URL, { waitUntil: 'domcontentloaded' });

  // The site loads times dynamically; click "All Times" if present so we see *today* times.
  // We try a few common buttons/texts defensively.
  const buttons = [
    'All Times', 'Today', 'Show All', 'All showings', 'What\'s On',
  ];
  for (const label of buttons) {
    const el = await page.locator(`text="${label}"`).first();
    if (await el.count()) { try { await el.click({ timeout: 2000 }); } catch {} }
  }

  // Wait for any showtime elements to load (we try multiple possibilities)
  await page.waitForTimeout(2000);

  // Try to collect film blocks. We’ll look for containers that have a film title and a list of showtimes like "10:45 12:42 (Screen 9)"
  const html = await page.content();

  // Very tolerant regex-based extraction (layout can change).
  // Strategy:
  // 1) Find film titles (h2/h3 anchors)
  // 2) For each nearby block, find lines with times and "Screen"
  const films = [];
  const filmTitleRE = /<h[23][^>]*>\s*<a[^>]*>([^<]+)<\/a>\s*<\/h[23]>/gi;
  let m;
  while ((m = filmTitleRE.exec(html)) !== null) {
    const film = m[1].trim();
    // Get a slice of HTML following the title to find times
    const slice = html.slice(m.index, m.index + 4000);
    // Look for patterns like: 10:45 12:42 ... Screen 9
    const showRE = /(\d{1,2}:\d{2})(?:\s*[-–]\s*(\d{1,2}:\d{2}))?.{0,80}?(Screen\s+([0-9A-Za-z]+))/gi;
    const times = [];
    let s;
    while ((s = showRE.exec(slice)) !== null) {
      const start = s[1];
      const end = s[2] || null; // sometimes Vue prints both start and end
      const screen = s[4] || null;
      times.push({ film, screen: screen ? (isNaN(+screen) ? screen : +screen) : null, start, end });
    }
    // Fallback: sometimes end time is printed right after start (two times together)
    if (!times.length) {
      const pairRE = /(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2}).{0,60}?(Screen\s+([0-9A-Za-z]+))/gi;
      while ((s = pairRE.exec(slice)) !== null) {
        times.push({ film, screen: s[4] ? (isNaN(+s[4]) ? s[4] : +s[4]) : null, start: s[1], end: s[2] });
      }
    }
    if (times.length) films.push({ film, times });
  }

  // Flatten to a day list
  const today = [];
  for (const f of films) {
    for (const t of f.times) {
      today.push({
        film: f.film,
        screen: t.screen ?? null,
        start: t.start,
        end: t.end ?? null,
      });
    }
  }

  // Sort by start time
  today.sort((a, b) => parseTimeToMinutes(a.start) - parseTimeToMinutes(b.start));

  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();

  const nextStarting = today.find(s => parseTimeToMinutes(s.start) > nowMins) || null;

  // Next finishing: pick a show that already started and ends after now; if missing end, assume 120 mins
  const enriched = today.map(s => {
    const startM = parseTimeToMinutes(s.start);
    const endM = s.end ? parseTimeToMinutes(s.end) : (startM + 120);
    return { ...s, _startM: startM, _endM: endM };
  });
  const nextFinishing = enriched
    .filter(s => s._startM <= nowMins && s._endM > nowMins)
    .sort((a, b) => a._endM - b._endM)[0] || null;

  const out = {
    generated_at: new Date().toISOString(),
    next_starting: nextStarting,
    next_finishing: nextFinishing
      ? { film: nextFinishing.film, screen: nextFinishing.screen, start: minutesToHHMM(nextFinishing._startM), end: minutesToHHMM(nextFinishing._endM) }
      : null,
    today_showings: today,
  };

  await fs.mkdir('public', { recursive: true });
  await fs.writeFile(path.join('public', 'vue-nottingham.json'), JSON.stringify(out, null, 2));
  await browser.close();
})();
