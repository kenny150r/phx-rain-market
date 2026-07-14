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
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, v),
    removeItem: (k) => storage.delete(k),
    key: (i) => [...storage.keys()][i] ?? null,
    get length() { return storage.size; },
  },
};
vm.createContext(ctx);
for (const f of ['js/sources.js', 'js/model.js']) {
  vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
}

const script = `(async () => {
  const day = phxDayInfo();
  const nowHour = (day.nowMs - day.dayStartUtcMs) / 3600e3;
  console.log('day:', day.dateStr, 'nowHour:', nowHour.toFixed(2));

  const histories = {};
  for (const id of ['nbm', 'hrrr', 'ecmwf', 'icon', 'gfs', 'gem', 'nws']) {
    const s = SOURCES.find((x) => x.id === id);
    const cands = candidateRuns(s, day).map(runIsoUtc);
    const runs = await fetchHistory(s, day);
    histories[id] = runs;
    const pts = runs.map((r) => {
      const t = Math.max(r.effMs, day.dayStartUtcMs);
      const v = sourceValueAt(s, runs, t, day);
      return runIsoUtc(r.runMs) + 'Z->' + (v == null ? 'null' : (v * 100).toFixed(1) + '%');
    });
    console.log(id + ': candidates=' + cands.length + ' got=' + runs.length + ' | ' + pts.join(' | '));
    try {
      const cur = await fetchCurrent(s, day.dateStr);
      const p = dailyProbFrom(cur.kind, cur.hours, nowHour);
      console.log('  current live: ' + (p == null ? 'null' : (p * 100).toFixed(1) + '%'));
    } catch (e) {
      console.log('  current ERROR: ' + e.message);
    }
  }

  // Full market build with real data + synthetic resolution check.
  const currents = {};
  for (const s of SOURCES) {
    try { currents[s.id] = await fetchCurrent(s, day.dateStr); }
    catch (e) { currents[s.id] = { error: true, reason: e.message }; }
  }
  const market = buildMarket({ day, currents, histories, observations: [] });
  console.log('consensus now:', market.finalConsensus == null ? 'null' : (market.finalConsensus * 100).toFixed(1) + '%',
    '| consensus pts:', market.consensusPts.length,
    '| traces:', Object.entries(market.traces).map(([k, v]) => k + ':' + v.length).join(','));

  // Synthetic resolution: pretend a P0005 METAR arrived at 14:10 local.
  const fakeObs = [{ tMs: day.dayStartUtcMs + 14.17 * 3600e3, raw: 'KPHX 142110Z RMK AO2 P0005', text: 'Rain' }];
  const resolved = buildMarket({ day, currents, histories, observations: fakeObs });
  console.log('resolution test:', resolved.resolution ? 'YES @ ' + resolved.resolution.amountIn + 'in' : 'FAILED',
    '| final:', resolved.finalConsensus, '| last pt:', JSON.stringify(resolved.consensusPts.at(-1)));

  // Real observations path.
  const obs = await fetchKphxObservations(day);
  console.log('real obs:', obs.length, 'resolution:', JSON.stringify(detectMeasurableRain(obs, day)));
})()`;

await vm.runInContext(script, ctx, { filename: 'harness-body' });
