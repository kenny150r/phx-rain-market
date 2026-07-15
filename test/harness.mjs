// Node harness: loads the browser JS and exercises history fetching +
// market math outside the browser. Run: node test/harness.mjs
import { readFileSync } from 'fs';
import vm from 'vm';

const storage = new Map();
const ctx = {
  fetch,
  console,
  Date,
  URLSearchParams,
  Intl,
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, v),
    removeItem: (k) => storage.delete(k),
    key: (i) => [...storage.keys()][i] ?? null,
    get length() { return storage.size; },
  },
};
vm.createContext(ctx);
for (const f of ['js/stations.js', 'js/sources.js', 'js/model.js']) {
  vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
}

const script = `(async () => {
  // Timezone math checks across DST/non-DST zones.
  for (const tz of ['America/Phoenix', 'America/New_York', 'America/Chicago']) {
    const day = dayInfoFor({ lat: 40, lon: -100, tz, stationId: 'X', name: 'x' });
    console.log(tz, '->', day.dateStr, 'hoursInDay:', day.hoursInDay, 'abbr:', day.tzAbbr,
      'nowHour:', ((day.nowMs - day.dayStartUtcMs) / 3600e3).toFixed(2));
  }
  // DST transition days (US spring-forward Mar 8 2026, fall-back Nov 1 2026).
  const spring = dayInfoFor({ tz: 'America/New_York' }, Date.UTC(2026, 2, 8, 17));
  const fall = dayInfoFor({ tz: 'America/New_York' }, Date.UTC(2026, 10, 1, 17));
  console.log('spring-forward hoursInDay:', spring.hoursInDay, '(want 23) | fall-back:', fall.hoursInDay, '(want 25)');

  // Nearest-station checks.
  for (const [name, lat, lon, want] of [
    ['Scottsdale', 33.49, -111.92, 'KPHX'],
    ['Brooklyn', 40.68, -73.94, 'KJFK'],
    ['Boulder CO', 40.01, -105.27, 'KDEN'],
    ['Key West-ish', 24.55, -81.78, 'KMIA'],
  ]) {
    const s = nearestStation(lat, lon);
    console.log(name, '->', s.id, Math.round(s.distanceKm) + 'km', s.id === want ? 'OK' : '(expected ' + want + ')');
  }

  // Location build for Scottsdale (uses NWS points).
  const scott = await locationFromCoords(33.4942, -111.9261);
  console.log('Scottsdale loc:', JSON.stringify(scott));

  // Full market build for Scottsdale.
  const loc = scott;
  const day = dayInfoFor(loc);
  const activeSources = sourcesFor(loc);
  console.log('active sources:', activeSources.map((s) => s.id).join(','));
  const currents = {};
  const histories = {};
  for (const s of activeSources) {
    try { currents[s.id] = await fetchCurrent(s, loc, day); }
    catch (e) { currents[s.id] = { error: true, reason: e.message }; }
    try { histories[s.id] = await fetchHistory(s, loc, day); }
    catch { histories[s.id] = []; }
  }
  const obs = await fetchStationObservations(loc.stationId, day).catch(() => []);
  const market = buildMarket({ day, activeSources, currents, histories, observations: obs });
  console.log('Scottsdale consensus:', market.finalConsensus == null ? 'null' : (market.finalConsensus * 100).toFixed(1) + '%',
    '| pts:', market.consensusPts.length,
    '| per-source:', market.sources.map((s) => s.id + '=' + (s.p == null ? 'n/a' : Math.round(s.p * 100) + '%')).join(' '));

  // Non-CONUS source filtering (Honolulu).
  const hnl = sourcesFor({ lat: 21.3, lon: -157.9 });
  console.log('Honolulu sources (no CONUS-only):', hnl.map((s) => s.id).join(','));

  // City search.
  const cities = await searchCities('Scottsdale');
  console.log('search Scottsdale:', cities.slice(0, 2).map((c) => c.name + '@' + c.tz).join(' | '));

  // Synthetic resolution still works.
  const fakeObs = [{ tMs: day.dayStartUtcMs + 14.17 * 3600e3, raw: 'KPHX 142110Z RMK AO2 P0005', text: 'Rain' }];
  const resolved = buildMarket({ day, activeSources, currents, histories, observations: fakeObs });
  console.log('resolution test:', resolved.resolution ? 'YES @ ' + resolved.resolution.amountIn + 'in' : 'FAILED');
})()`;

await vm.runInContext(script, ctx, { filename: 'harness-body' });
