'use strict';

/* ------------------------------------------------------------------ *
 * Data layer: Open-Meteo (current + archived single runs) and NWS.
 * Everything runs in the browser; archived runs are cached in
 * localStorage because they are immutable.
 * ------------------------------------------------------------------ */

const KPHX = { lat: 33.4342, lon: -112.0116 };
const TZ_OFFSET_H = 7; // America/Phoenix is UTC-7 year-round (no DST)

// 3x3 grid of points within ~±16 km of Sky Harbor, used to turn
// deterministic QPF into a neighborhood probability.
const NEIGHBORHOOD = (() => {
  const pts = [];
  for (const dLat of [-0.14, 0, 0.14]) {
    for (const dLon of [-0.17, 0, 0.17]) {
      pts.push([+(KPHX.lat + dLat).toFixed(4), +(KPHX.lon + dLon).toFixed(4)]);
    }
  }
  return pts;
})();

/*
 * kind: 'prob' -> hourly precipitation_probability used directly
 *       'qpf'  -> hourly precipitation (mm) over the neighborhood,
 *                 converted to an implied probability in model.js
 *       'nws'  -> NWS hourly forecast PoP (list-only, no history)
 * cycles: UTC init hours that the Open-Meteo single-runs archive keeps.
 * lagH: approximate hours after init before the run is publicly usable
 *       (chart points are placed at init + lag, i.e. "market time").
 */
const SOURCES = [
  { id: 'nbm',   name: 'NOAA NBM',   desc: 'National Blend of Models · 2.5 km',  kind: 'prob', model: 'ncep_nbm_conus',  cycles: [0, 3, 6, 9, 12, 15, 18, 21], lagH: 1.5, weight: 3,   color: '#00b072' },
  { id: 'nws',   name: 'NWS Phoenix', desc: 'Official NWS forecast PoP',         kind: 'nws',  weight: 2, color: '#3b82f6' },
  { id: 'gfs',   name: 'NOAA GFS',   desc: 'GEFS ensemble probability · 25 km',  kind: 'prob', model: 'gfs_seamless',    histKind: 'qpf', cycles: [0, 6, 12, 18], lagH: 5,  weight: 2,   color: '#8b5cf6' },
  { id: 'hrrr',  name: 'NOAA HRRR',  desc: 'Hi-res rapid refresh · 3 km',        kind: 'qpf',  model: 'ncep_hrrr_conus', cycles: [0, 6, 12, 18], lagH: 1.5, weight: 1.5, color: '#f59e0b' },
  { id: 'ecmwf', name: 'ECMWF IFS',  desc: 'European global model · 25 km',      kind: 'qpf',  model: 'ecmwf_ifs025',    cycles: [0, 6, 12, 18], lagH: 7,  weight: 1.5, color: '#0ea5e9' },
  { id: 'icon',  name: 'DWD ICON',   desc: 'German ICON model',                  kind: 'qpf',  model: 'icon_seamless',   cycles: [0, 6, 12, 18], lagH: 4,  weight: 1,   color: '#ec4899' },
  // GEM runs are not in the single-runs archive, so it is list-only.
  { id: 'gem',   name: 'CMC GEM',    desc: 'Canadian global model',              kind: 'qpf',  model: 'gem_seamless',    cycles: [], lagH: 4, weight: 1, color: '#ef4444' },
];

/* ----------------------------- time ------------------------------ */

function phxDayInfo(nowMs = Date.now()) {
  const shifted = new Date(nowMs - TZ_OFFSET_H * 3600e3);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  const dayStartUtcMs = Date.UTC(y, m, d, TZ_OFFSET_H);
  const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { dateStr, dayStartUtcMs, dayEndUtcMs: dayStartUtcMs + 24 * 3600e3, nowMs };
}

function localHour(tMs, dayStartUtcMs) {
  return (tMs - dayStartUtcMs) / 3600e3;
}

/* ----------------------------- cache ----------------------------- */

const CACHE_PREFIX = 'prm1:';
const MISS_TTL_MS = 15 * 60e3;      // recent runs may appear later
const OLD_RUN_AGE_MS = 8 * 3600e3;  // runs older than this and missing never appear

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function cacheSet(key, value) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value));
  } catch { /* quota exceeded: cache is an optimization only */ }
}

function cachePurgeOld(maxAgeMs = 36 * 3600e3) {
  try {
    const cutoff = Date.now() - maxAgeMs;
    const drop = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(CACHE_PREFIX)) continue;
      const v = cacheGet(k.slice(CACHE_PREFIX.length));
      if (!v || v.t < cutoff) drop.push(k);
    }
    drop.forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
}

/* ----------------------------- fetch ----------------------------- */

async function fetchJson(url) {
  const res = await fetch(url);
  let body = null;
  try { body = await res.json(); } catch { /* some errors are plain text */ }
  if (!res.ok || !body || body.error) {
    const reason = body && body.reason ? body.reason : `HTTP ${res.status}`;
    throw new Error(reason);
  }
  return body;
}

async function pMap(items, fn, limit = 6) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/* ------------------------- open-meteo urls ----------------------- */

function omUrl(base, source, forHistory, runIso) {
  const kind = forHistory ? (source.histKind || source.kind) : source.kind;
  const multi = kind === 'qpf';
  const lats = multi ? NEIGHBORHOOD.map((p) => p[0]).join(',') : String(KPHX.lat);
  const lons = multi ? NEIGHBORHOOD.map((p) => p[1]).join(',') : String(KPHX.lon);
  const hourlyVar = kind === 'qpf' ? 'precipitation' : 'precipitation_probability';
  const params = new URLSearchParams({
    latitude: lats,
    longitude: lons,
    hourly: hourlyVar,
    models: source.model,
    timezone: 'America/Phoenix',
  });
  if (runIso) params.set('run', runIso);
  else { // live forecast API supports date bounds; single-runs API rejects them
    const { dateStr } = phxDayInfo();
    params.set('start_date', dateStr);
    params.set('end_date', dateStr);
  }
  return `${base}?${params.toString()}`;
}

// Normalize a response into probs[24] (%) or qpf[24][nLoc] (mm) for `dateStr`.
function parseHourly(json, dateStr, kind) {
  const items = Array.isArray(json) ? json : [json];
  const varName = kind === 'qpf' ? 'precipitation' : 'precipitation_probability';
  const times = items[0].hourly.time;
  const out = Array.from({ length: 24 }, () => (kind === 'qpf' ? [] : null));
  for (let i = 0; i < times.length; i++) {
    if (!times[i].startsWith(dateStr)) continue;
    const h = parseInt(times[i].slice(11, 13), 10);
    if (kind === 'qpf') {
      for (const item of items) out[h].push(item.hourly[varName][i]);
    } else {
      out[h] = items[0].hourly[varName][i];
    }
  }
  if (kind === 'qpf') {
    return out.map((vals) => (vals.length && vals.some((v) => v != null) ? vals : null));
  }
  return out;
}

/* --------------------------- live values -------------------------- */

async function fetchCurrent(source, dateStr) {
  if (source.kind === 'nws') return fetchNwsHourly(dateStr);
  const url = omUrl('https://api.open-meteo.com/v1/forecast', source, false, null);
  const json = await fetchJson(url);
  return { kind: source.kind, hours: parseHourly(json, dateStr, source.kind) };
}

/* ------------------------- archived runs -------------------------- */

// Candidate UTC init times covering today's Phoenix day.
function candidateRuns(source, day) {
  if (!source.cycles || !source.cycles.length) return [];
  const runs = [];
  const firstMs = day.dayStartUtcMs - 12 * 3600e3;
  for (let ms = firstMs; ms <= day.nowMs; ms += 3600e3) {
    const dt = new Date(ms);
    if (dt.getUTCMinutes() !== 0 || !source.cycles.includes(dt.getUTCHours())) continue;
    if (ms + source.lagH * 3600e3 > day.nowMs) continue; // not published yet
    runs.push(ms);
  }
  return runs;
}

function runIsoUtc(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:00`;
}

async function fetchRun(source, runMs, day) {
  const kind = source.histKind || source.kind;
  const url = omUrl('https://single-runs-api.open-meteo.com/v1/forecast', source, true, runIsoUtc(runMs));
  const cacheKey = `run:${source.id}:${runIsoUtc(runMs)}:${day.dateStr}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    if (cached.ok) return { runMs, kind, hours: cached.hours };
    const permanentMiss = day.nowMs - runMs > OLD_RUN_AGE_MS;
    if (permanentMiss || Date.now() - cached.t < MISS_TTL_MS) return null;
  }
  try {
    const json = await fetchJson(url);
    const hours = parseHourly(json, day.dateStr, kind);
    cacheSet(cacheKey, { t: Date.now(), ok: true, hours });
    return { runMs, kind, hours };
  } catch {
    cacheSet(cacheKey, { t: Date.now(), ok: false });
    return null;
  }
}

async function fetchHistory(source, day) {
  const runs = candidateRuns(source, day);
  const results = await pMap(runs, (runMs) => fetchRun(source, runMs, day), 4);
  return results
    .filter(Boolean)
    .map((r) => ({ ...r, effMs: r.runMs + source.lagH * 3600e3 }))
    .sort((a, b) => a.effMs - b.effMs);
}

/* ------------------------------ NWS ------------------------------- */

async function nwsHourlyUrl() {
  const cached = cacheGet('nws-hourly-url');
  if (cached && cached.url) return cached.url;
  const points = await fetchJson(`https://api.weather.gov/points/${KPHX.lat},${KPHX.lon}`);
  const url = points.properties.forecastHourly;
  cacheSet('nws-hourly-url', { t: Date.now(), url });
  return url;
}

async function fetchNwsHourly(dateStr) {
  const url = await nwsHourlyUrl();
  const json = await fetchJson(url);
  const hours = Array.from({ length: 24 }, () => null);
  for (const period of json.properties.periods) {
    // startTime carries the local offset, e.g. 2026-07-14T15:00:00-07:00
    if (!period.startTime.startsWith(dateStr)) continue;
    const h = parseInt(period.startTime.slice(11, 13), 10);
    const v = period.probabilityOfPrecipitation && period.probabilityOfPrecipitation.value;
    hours[h] = v == null ? 0 : v;
  }
  return { kind: 'prob', hours };
}

/* -------------------------- observations -------------------------- */

async function fetchKphxObservations(day) {
  const startIso = new Date(day.dayStartUtcMs).toISOString().split('.')[0] + 'Z';
  const url = `https://api.weather.gov/stations/KPHX/observations?start=${encodeURIComponent(startIso)}`;
  const json = await fetchJson(url);
  return (json.features || [])
    .map((f) => ({
      tMs: Date.parse(f.properties.timestamp),
      raw: f.properties.rawMessage || '',
      text: f.properties.textDescription || '',
    }))
    .filter((o) => Number.isFinite(o.tMs))
    .sort((a, b) => a.tMs - b.tMs);
}
