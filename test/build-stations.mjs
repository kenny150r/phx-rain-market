// Regenerates js/stations.js: the ASOS/AWOS ground-truth station list.
//
// CONUS stations come from the Iowa State ASOS network metadata
// (per-state *_ASOS.geojson), filtered to online 3-letter sites and
// validated against api.weather.gov (K + id). Alaska, Hawaii, and
// territory majors are curated with their real ICAO ids. Names are
// title-cased for display.
//
// Run: node test/build-stations.mjs
//
// Note: this is a build-time data script. It performs a couple thousand
// requests to api.weather.gov and takes ~1-2 minutes. It uses Node's
// global fetch; run it on a network without TLS interception, or the
// mesonet/weather.gov TLS calls may fail.

import { writeFileSync, statSync } from 'fs';

const UA = { 'User-Agent': 'phx-rain-market station build' };
const CONUS = ('AL AZ AR CA CO CT DE FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS ' +
  'MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY').split(' ');

const MANUAL = [
  ['PANC', 'Anchorage Ted Stevens', 61.1743, -149.9962],
  ['PAFA', 'Fairbanks Intl', 64.8039, -147.8761],
  ['PAJN', 'Juneau Intl', 58.3548, -134.5762],
  ['PHNL', 'Honolulu Daniel K. Inouye', 21.3187, -157.9225],
  ['PHOG', 'Kahului (Maui)', 20.8986, -156.4305],
  ['PHKO', 'Kona Intl', 19.7388, -156.0456],
  ['PHLI', 'Lihue (Kauai)', 21.976, -159.339],
  ['TJSJ', 'San Juan Luis Munoz Marin', 18.4394, -66.0018],
  ['PGUM', 'Guam Intl', 13.4834, 144.796],
];

const titleCase = (s) => s.replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

async function getJson(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

const cands = new Map();
for (const st of CONUS) {
  try {
    const d = await getJson(`https://mesonet.agron.iastate.edu/api/1/network/${st}_ASOS.geojson`);
    for (const f of d.features || []) {
      const p = f.properties; const sid = p.id || '';
      const [lon, lat] = f.geometry.coordinates || [];
      const name = (p.name || '').trim();
      if (!p.online || sid.length !== 3 || !/^[A-Za-z][A-Za-z0-9]{2}$/.test(sid) || !name) continue;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      cands.set('K' + sid, ['K' + sid, name, +lat.toFixed(4), +lon.toFixed(4)]);
    }
  } catch (e) { console.error('state', st, e.message); }
}
console.error('CONUS candidates:', cands.size);

const items = [...cands.values()];
const checks = await mapLimit(items, 16, async (c) => {
  try { const r = await fetch(`https://api.weather.gov/stations/${c[0]}`, { headers: UA }); return r.ok; }
  catch { return false; }
});
let final = items.filter((_, i) => checks[i]);
const have = new Set(final.map((c) => c[0]));
for (const m of MANUAL) if (!have.has(m[0])) final.push(m);
final.sort((a, b) => a[0].localeCompare(b[0]));

const rows = final
  .map(([id, name, lat, lon]) => `  { id: '${id}', name: '${titleCase(name).replace(/'/g, "\\'")}', lat: ${lat}, lon: ${lon} },`)
  .join('\n');

const file = `'use strict';

/* ------------------------------------------------------------------ *
 * ASOS/AWOS stations used as ground truth for market resolution.
 * The market resolves at the nearest one to the chosen location.
 * CONUS stations are auto-generated from the Iowa State ASOS network
 * metadata and validated against api.weather.gov; Alaska, Hawaii, and
 * territory majors are curated. Regenerate with test/build-stations.mjs.
 * ------------------------------------------------------------------ */

const ASOS_STATIONS = [
${rows}
];

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

function nearestStation(lat, lon) {
  let best = null;
  let bestKm = Infinity;
  for (const s of ASOS_STATIONS) {
    const km = haversineKm(lat, lon, s.lat, s.lon);
    if (km < bestKm) { best = s; bestKm = km; }
  }
  return { ...best, distanceKm: bestKm };
}
`;

writeFileSync('js/stations.js', file);
console.error(`wrote js/stations.js: ${final.length} stations, ${statSync('js/stations.js').size} bytes`);
