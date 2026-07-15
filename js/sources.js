'use strict';

/* ------------------------------------------------------------------ *
 * Data layer: Open-Meteo (current + archived single runs) and NWS.
 * Everything runs in the browser; archived runs are immutable and
 * cached in localStorage. All fetchers take a `loc` (location) object:
 *   { lat, lon, name, tz, stationId, stationName, stationKm }
 * ------------------------------------------------------------------ */

const DEFAULT_LOCATION = {
  lat: 33.4484,
  lon: -112.074,
  name: 'Phoenix, AZ',
  tz: 'America/Phoenix',
  stationId: 'KPHX',
  stationName: 'Phoenix Sky Harbor',
  stationKm: 5,
};

// 3x3 neighborhood grid (~±16 km) used to turn deterministic QPF into
// a spatial probability. Longitude spacing scales with latitude.
function neighborhoodOf(loc) {
  const dLat = 0.14;
  const dLon = 0.14 / Math.max(Math.cos((loc.lat * Math.PI) / 180), 0.3);
  const pts = [];
  for (const a of [-dLat, 0, dLat]) {
    for (const b of [-dLon, 0, dLon]) {
      pts.push([+(loc.lat + a).toFixed(4), +(loc.lon + b).toFixed(4)]);
    }
  }
  return pts;
}

// Short key identifying a location for cache entries.
function locKey(loc) {
  return `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}`;
}

/*
 * kind: 'prob' -> hourly precipitation_probability used directly
 *       'qpf'  -> hourly precipitation (mm) over the neighborhood,
 *                 converted to an implied probability in model.js
 *       'nws'  -> NWS hourly forecast PoP (list-only, no history)
 * cycles: UTC init hours that the Open-Meteo single-runs archive keeps.
 * lagH: approximate hours after init before the run is publicly usable
 *       (chart points are placed at init + lag, i.e. "market time").
 * conusOnly: model has no data outside the continental US.
 */
const SOURCES = [
  { id: 'nbm',   name: 'NOAA NBM',   desc: 'National Blend of Models · 2.5 km',  kind: 'prob', model: 'ncep_nbm_conus',  cycles: [0, 3, 6, 9, 12, 15, 18, 21], lagH: 1.5, weight: 3,   color: '#00b072', conusOnly: true },
  { id: 'nws',   name: 'NWS',        desc: 'Official NWS forecast PoP',          kind: 'nws',  weight: 2, color: '#3b82f6', conusOnly: true },
  { id: 'gfs',   name: 'NOAA GFS',   desc: 'GEFS ensemble probability · 25 km',  kind: 'prob', model: 'gfs_seamless',    histKind: 'qpf', cycles: [0, 6, 12, 18], lagH: 5,  weight: 2,   color: '#8b5cf6' },
  { id: 'hrrr',  name: 'NOAA HRRR',  desc: 'Hi-res rapid refresh · 3 km',        kind: 'qpf',  model: 'ncep_hrrr_conus', cycles: [0, 6, 12, 18], lagH: 1.5, weight: 1.5, color: '#f59e0b', conusOnly: true },
  { id: 'ecmwf', name: 'ECMWF IFS',  desc: 'European global model · 25 km',      kind: 'qpf',  model: 'ecmwf_ifs025',    cycles: [0, 6, 12, 18], lagH: 7,  weight: 1.5, color: '#0ea5e9' },
  { id: 'icon',  name: 'DWD ICON',   desc: 'German ICON model',                  kind: 'qpf',  model: 'icon_seamless',   cycles: [0, 6, 12, 18], lagH: 4,  weight: 1,   color: '#ec4899' },
  // GEM runs are not in the single-runs archive, so it is list-only.
  { id: 'gem',   name: 'CMC GEM',    desc: 'Canadian global model',              kind: 'qpf',  model: 'gem_seamless',    cycles: [], lagH: 4, weight: 1, color: '#ef4444' },
];

/* ----------------------------- time ------------------------------ */

// Offset (ms) of an IANA timezone from UTC at a given instant.
const _dtfCache = {};
function tzOffsetMs(tz, utcMs) {
  const dtf = _dtfCache[tz] || (_dtfCache[tz] = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }));
  const p = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - utcMs;
}

function tzAbbr(tz, utcMs) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(new Date(utcMs));
    const name = parts.find((x) => x.type === 'timeZoneName');
    return name ? name.value : tz;
  } catch { return tz; }
}

// UTC instant of local midnight for the local date containing `utcMs`
// plus `dayShift` days. Two-pass offset lookup handles DST transitions.
function localMidnightUtc(tz, utcMs, dayShift = 0) {
  const local = new Date(utcMs + tzOffsetMs(tz, utcMs));
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate() + dayShift;
  let guess = Date.UTC(y, m, d) - tzOffsetMs(tz, Date.UTC(y, m, d));
  guess = Date.UTC(y, m, d) - tzOffsetMs(tz, guess);
  return guess;
}

// Today's calendar-day window for a location. `hoursInDay` is 23/24/25
// depending on DST transitions.
function dayInfoFor(loc, nowMs = Date.now()) {
  const dayStartUtcMs = localMidnightUtc(loc.tz, nowMs, 0);
  const dayEndUtcMs = localMidnightUtc(loc.tz, nowMs, 1);
  const local = new Date(nowMs + tzOffsetMs(loc.tz, nowMs));
  const p = (n) => String(n).padStart(2, '0');
  const dateStr = `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}`;
  return {
    dateStr,
    dayStartUtcMs,
    dayEndUtcMs,
    nowMs,
    hoursInDay: Math.round((dayEndUtcMs - dayStartUtcMs) / 3600e3),
    tz: loc.tz,
    tzAbbr: tzAbbr(loc.tz, nowMs),
  };
}

function localHour(tMs, dayStartUtcMs) {
  return (tMs - dayStartUtcMs) / 3600e3;
}

// Continental US bounding box (HRRR/NBM/NWS coverage check).
function inConus(lat, lon) {
  return lat >= 24 && lat <= 50 && lon >= -125 && lon <= -66;
}

function sourcesFor(loc) {
  return SOURCES.filter((s) => !s.conusOnly || inConus(loc.lat, loc.lon));
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

function omUrl(base, source, loc, day, forHistory, runIso) {
  const kind = forHistory ? (source.histKind || source.kind) : source.kind;
  const multi = kind === 'qpf';
  const nbhd = multi ? neighborhoodOf(loc) : null;
  const lats = multi ? nbhd.map((p) => p[0]).join(',') : String(loc.lat);
  const lons = multi ? nbhd.map((p) => p[1]).join(',') : String(loc.lon);
  const hourlyVar = kind === 'qpf' ? 'precipitation' : 'precipitation_probability';
  const params = new URLSearchParams({
    latitude: lats,
    longitude: lons,
    hourly: hourlyVar,
    models: source.model,
    timezone: loc.tz,
  });
  if (runIso) params.set('run', runIso);
  else { // live forecast API supports date bounds; single-runs API rejects them
    params.set('start_date', day.dateStr);
    params.set('end_date', day.dateStr);
  }
  return `${base}?${params.toString()}`;
}

// Normalize a response into hours[hoursInDay]: probability (%) or
// qpf sample arrays (mm) for `day.dateStr`. Indexed by local hour label.
function parseHourly(json, day, kind) {
  const items = Array.isArray(json) ? json : [json];
  const varName = kind === 'qpf' ? 'precipitation' : 'precipitation_probability';
  const times = items[0].hourly.time;
  const n = Math.max(day.hoursInDay, 24);
  const out = Array.from({ length: n }, () => (kind === 'qpf' ? [] : null));
  for (let i = 0; i < times.length; i++) {
    if (!times[i].startsWith(day.dateStr)) continue;
    const h = parseInt(times[i].slice(11, 13), 10);
    if (h >= n) continue;
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

async function fetchCurrent(source, loc, day) {
  if (source.kind === 'nws') return fetchNwsHourly(loc, day);
  const url = omUrl('https://api.open-meteo.com/v1/forecast', source, loc, day, false, null);
  const json = await fetchJson(url);
  return { kind: source.kind, hours: parseHourly(json, day, source.kind) };
}

/* ------------------------- archived runs -------------------------- */

// Candidate UTC init times covering today's local day.
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

async function fetchRun(source, loc, runMs, day) {
  const kind = source.histKind || source.kind;
  const url = omUrl('https://single-runs-api.open-meteo.com/v1/forecast', source, loc, day, true, runIsoUtc(runMs));
  const cacheKey = `run:${source.id}:${runIsoUtc(runMs)}:${day.dateStr}:${locKey(loc)}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    if (cached.ok) return { runMs, kind, hours: cached.hours };
    const permanentMiss = day.nowMs - runMs > OLD_RUN_AGE_MS;
    if (permanentMiss || Date.now() - cached.t < MISS_TTL_MS) return null;
  }
  try {
    const json = await fetchJson(url);
    const hours = parseHourly(json, day, kind);
    cacheSet(cacheKey, { t: Date.now(), ok: true, hours });
    return { runMs, kind, hours };
  } catch {
    cacheSet(cacheKey, { t: Date.now(), ok: false });
    return null;
  }
}

async function fetchHistory(source, loc, day) {
  const runs = candidateRuns(source, day);
  const results = await pMap(runs, (runMs) => fetchRun(source, loc, runMs, day), 4);
  return results
    .filter(Boolean)
    .map((r) => ({ ...r, effMs: r.runMs + source.lagH * 3600e3 }))
    .sort((a, b) => a.effMs - b.effMs);
}

/* ------------------------------ NWS ------------------------------- */

// Points metadata: hourly forecast URL, nearest-city name, IANA tz.
async function fetchNwsPoints(lat, lon) {
  const key = `nws-points:${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = cacheGet(key);
  if (cached && cached.data) return cached.data;
  const json = await fetchJson(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
  const props = json.properties;
  const rel = props.relativeLocation && props.relativeLocation.properties;
  const data = {
    forecastHourly: props.forecastHourly,
    timeZone: props.timeZone,
    city: rel ? `${rel.city}, ${rel.state}` : null,
  };
  cacheSet(key, { t: Date.now(), data });
  return data;
}

async function fetchNwsHourly(loc, day) {
  const points = await fetchNwsPoints(loc.lat, loc.lon);
  const json = await fetchJson(points.forecastHourly);
  const hours = Array.from({ length: Math.max(day.hoursInDay, 24) }, () => null);
  for (const period of json.properties.periods) {
    // startTime carries the local offset, e.g. 2026-07-14T15:00:00-07:00
    if (!period.startTime.startsWith(day.dateStr)) continue;
    const h = parseInt(period.startTime.slice(11, 13), 10);
    if (h >= hours.length) continue;
    const v = period.probabilityOfPrecipitation && period.probabilityOfPrecipitation.value;
    hours[h] = v == null ? 0 : v;
  }
  return { kind: 'prob', hours };
}

/* -------------------------- observations -------------------------- */

async function fetchStationObservations(stationId, day) {
  const startIso = new Date(day.dayStartUtcMs).toISOString().split('.')[0] + 'Z';
  const url = `https://api.weather.gov/stations/${stationId}/observations?start=${encodeURIComponent(startIso)}`;
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

/* --------------------------- geocoding ---------------------------- */

// City search via Open-Meteo's geocoding API (CORS-friendly, no key).
async function searchCities(query) {
  const params = new URLSearchParams({ name: query, count: '6', language: 'en', format: 'json' });
  const json = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?${params}`);
  return (json.results || [])
    .filter((r) => r.country_code === 'US')
    .map((r) => ({
      lat: r.latitude,
      lon: r.longitude,
      tz: r.timezone,
      name: `${r.name}${r.admin1 ? ', ' + abbrevState(r.admin1) : ''}`,
    }));
}

const STATE_ABBR = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
  Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', Florida: 'FL', Georgia: 'GA',
  Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA',
  Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD',
  Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS',
  Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV',
  'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK',
  Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT',
  Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI',
  Wyoming: 'WY', 'District of Columbia': 'DC',
};

function abbrevState(admin1) {
  return STATE_ABBR[admin1] || admin1;
}

// Build a full location object from coordinates: nearest major ASOS
// station plus (best effort) NWS city name and timezone.
async function locationFromCoords(lat, lon, fallbackName) {
  const station = nearestStation(lat, lon);
  let name = fallbackName || null;
  let tz = null;
  try {
    const points = await fetchNwsPoints(lat, lon);
    if (!name && points.city) name = points.city;
    tz = points.timeZone;
  } catch { /* outside NWS coverage or API down */ }
  if (!tz) {
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { tz = 'America/Phoenix'; }
  }
  return {
    lat: +lat.toFixed(4),
    lon: +lon.toFixed(4),
    name: name || `${lat.toFixed(2)}, ${lon.toFixed(2)}`,
    tz,
    stationId: station.id,
    stationName: station.name,
    stationKm: Math.round(station.distanceKm),
  };
}
