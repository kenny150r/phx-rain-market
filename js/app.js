'use strict';

/* Orchestration: settings + location state, fetch everything, render. */

const REFRESH_MS = 5 * 60e3;

/* ----------------------------- settings --------------------------- */

const SETTINGS_KEY = 'prm-settings';

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}

const settings = Object.assign({ theme: 'system', odds: 'betting', location: null }, loadSettings());
const systemDark = matchMedia('(prefers-color-scheme: dark)');

function activeLocation() {
  const l = settings.location;
  return l && l.lat != null && l.tz && l.stationId ? l : DEFAULT_LOCATION;
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

function applyTheme() {
  const t = settings.theme === 'system' ? (systemDark.matches ? 'dark' : 'light') : settings.theme;
  document.documentElement.dataset.theme = t;
}

let lastMarket = null;
let lastObservations = [];
let loadSeq = 0; // guards against stale renders after a location change

function rerender() {
  if (!lastMarket) return;
  renderHeader(lastMarket);
  renderChart(lastMarket);
  renderSources(lastMarket);
}

/* ------------------------- location controls ---------------------- */

function cityShortName(name) {
  return String(name).split(',')[0].trim();
}

function renderLocationStatics() {
  const loc = activeLocation();
  const city = cityShortName(loc.name);
  document.getElementById('question').textContent = `Will it rain in ${city} today?`;
  document.title = `Will it rain in ${city} today?`;
  document.getElementById('obsTitle').textContent = `Observed at ${loc.stationId}`;
  document.getElementById('locCurrent').textContent = `${loc.name} · ${loc.stationId}`;
  const miles = Math.round(loc.stationKm * 0.621);
  const distNote = loc.stationKm > 15 ? ` — the nearest major station, ~${miles} mi away` : '';
  document.getElementById('rulesLine').innerHTML =
    `Resolves <strong>YES</strong> if ${loc.stationId} (${loc.stationName}${distNote}) records ` +
    `≥ 0.01″ of rain between 12:00 AM and 11:59 PM local time today.`;
}

function setLocation(loc) {
  settings.location = loc;
  saveSettings();
  renderLocationStatics();
  lastMarket = null;
  document.getElementById('sourcesList').innerHTML =
    '<div class="loading-row">Loading forecast sources…</div>';
  document.getElementById('bigProb').textContent = '–';
  document.getElementById('obsCard').hidden = true;
  loadAndRender().catch((e) => renderError(e.message || 'unexpected error'));
}

function locHint(msg, isError) {
  const el = document.getElementById('locHint');
  el.hidden = !msg;
  el.textContent = msg || '';
  el.classList.toggle('err', !!isError);
}

function initLocationControls() {
  const btn = document.getElementById('useMyLocation');
  const input = document.getElementById('locSearch');
  const results = document.getElementById('locResults');

  btn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      locHint('Geolocation is not supported by this browser.', true);
      return;
    }
    locHint('Locating…');
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const loc = await locationFromCoords(pos.coords.latitude, pos.coords.longitude);
          locHint('');
          setLocation(loc);
        } catch (e) {
          locHint('Could not resolve your location: ' + e.message, true);
        }
      },
      (err) => locHint(err.code === 1 ? 'Location permission denied.' : 'Could not get your location.', true),
      { timeout: 12000, maximumAge: 300e3 }
    );
  });

  let searchTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 2) { results.innerHTML = ''; return; }
    searchTimer = setTimeout(async () => {
      try {
        const found = await searchCities(q);
        results.innerHTML = found.length
          ? found.map((c, i) =>
              `<button type="button" class="loc-result" data-i="${i}">${c.name}</button>`).join('')
          : '<div class="loc-hint">No US cities found.</div>';
        results.querySelectorAll('.loc-result').forEach((b) => {
          b.addEventListener('click', async () => {
            const c = found[+b.dataset.i];
            results.innerHTML = '';
            input.value = '';
            locHint('Setting location…');
            const loc = await locationFromCoords(c.lat, c.lon, c.name);
            if (!loc.tz && c.tz) loc.tz = c.tz;
            locHint('');
            setLocation(loc);
          });
        });
      } catch {
        results.innerHTML = '<div class="loc-hint err">Search failed. Try again.</div>';
      }
    }, 350);
  });
}

/* -------------------------- settings panel ------------------------ */

function initSettings() {
  applyTheme();
  const btn = document.getElementById('settingsBtn');
  const pop = document.getElementById('settingsPop');

  const sync = () => {
    document.querySelectorAll('.seg').forEach((seg) => {
      const key = seg.dataset.setting;
      seg.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('active', b.dataset.val === settings[key]);
      });
    });
  };
  sync();

  const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = pop.hidden;
    pop.hidden = !opening;
    btn.setAttribute('aria-expanded', String(opening));
  });
  document.addEventListener('click', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && e.target !== btn) close();
  });

  document.querySelectorAll('.seg button').forEach((b) => {
    b.addEventListener('click', () => {
      const key = b.closest('.seg').dataset.setting;
      if (settings[key] === b.dataset.val) return;
      settings[key] = b.dataset.val;
      saveSettings();
      sync();
      if (key === 'theme') applyTheme();
      rerender();
    });
  });

  systemDark.addEventListener('change', () => {
    if (settings.theme === 'system') {
      applyTheme();
      rerender();
    }
  });

  initLocationControls();
}

/* --------------------------- odds formats ------------------------- */

function priceCents(p) {
  return Math.min(99, Math.max(1, Math.round(p * 100)));
}

// American (moneyline) odds implied by probability p, rounded the way
// sportsbooks quote them (coarser steps for longer odds).
function americanOdds(p) {
  const q = Math.min(Math.max(p, 0.01), 0.99);
  const raw = q >= 0.5 ? (-100 * q) / (1 - q) : (100 * (1 - q)) / q;
  const mag = Math.abs(raw);
  const step = mag >= 1000 ? 50 : mag >= 300 ? 10 : 5;
  const rounded = Math.round(raw / step) * step;
  return (rounded > 0 ? '+' : '') + rounded;
}

// Yes/No display strings for one probability, in the active format.
// Cents stay complementary (yes + no = 100¢) like real contracts.
function oddsPair(p) {
  if (settings.odds === 'cents') {
    const yes = priceCents(p);
    return { yes: yes + '¢', no: (100 - yes) + '¢' };
  }
  return { yes: americanOdds(p), no: americanOdds(1 - p) };
}

/* ------------------------------ helpers --------------------------- */

function fmtTimeMs(tMs, day) {
  return fmtHour(localHour(tMs, day.dayStartUtcMs)) + ' ' + day.tzAbbr;
}

function tickerFor(day, loc) {
  const [y, m, d] = day.dateStr.split('-');
  const mon = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][+m - 1];
  return `RAIN${loc.stationId.replace(/^K/, '')}-${y.slice(2)}${mon}${d}`;
}

function mockVolume(seed) {
  let h = 0;
  for (const c of seed) h = ((h * 31 + c.charCodeAt(0)) >>> 0);
  return 5000 + (h % 45000);
}

/* ------------------------------ render ---------------------------- */

function renderHeader(market) {
  const { day, loc, finalConsensus, consensusPts, resolution } = market;
  document.getElementById('ticker').textContent = tickerFor(day, loc);
  document.getElementById('volume').textContent =
    '$' + mockVolume(day.dateStr + loc.stationId).toLocaleString('en-US') + ' Vol.';
  document.getElementById('chartRange').textContent =
    `Today · 12:00 AM – 11:59 PM ${day.tzAbbr}`;

  const bigProb = document.getElementById('bigProb');
  const changeChip = document.getElementById('changeChip');
  if (finalConsensus == null) {
    bigProb.textContent = '–';
    changeChip.hidden = true;
  } else {
    const pct = Math.round(finalConsensus * 100);
    bigProb.textContent = String(pct);
    bigProb.parentElement.style.color = resolution ? 'var(--green)' : '';
    const first = consensusPts.length ? consensusPts[0].p : finalConsensus;
    const delta = Math.round((finalConsensus - first) * 100);
    changeChip.hidden = false;
    changeChip.className = 'change-chip ' + (delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat');
    changeChip.textContent = (delta > 0 ? '▲ +' : delta < 0 ? '▼ ' : '') + delta + ' today';
  }

  const banner = document.getElementById('resolveBanner');
  if (resolution) {
    banner.hidden = false;
    banner.className = 'resolve-banner yes';
    banner.textContent =
      `Resolved YES — ${resolution.amountIn.toFixed(2)}″ of rain observed at ${loc.stationId} (` +
      `${fmtTimeMs(resolution.tMs, day)}).`;
  } else {
    banner.hidden = true;
  }

  const yesBtn = document.getElementById('yesBtn');
  const noBtn = document.getElementById('noBtn');
  if (resolution) {
    yesBtn.className = 'trade-btn resolved-yes';
    yesBtn.innerHTML = 'Yes <span class="price">Resolved ✓</span>';
    noBtn.className = 'trade-btn no';
    noBtn.innerHTML = `No <span class="price">${settings.odds === 'cents' ? '0¢' : '—'}</span>`;
  } else if (finalConsensus != null) {
    const odds = oddsPair(finalConsensus);
    yesBtn.className = 'trade-btn yes';
    yesBtn.innerHTML = `Yes <span class="price">${odds.yes}</span>`;
    noBtn.className = 'trade-btn no';
    noBtn.innerHTML = `No <span class="price">${odds.no}</span>`;
  }
}

function renderSources(market) {
  const list = document.getElementById('sourcesList');
  const { day, resolution } = market;
  list.innerHTML = market.sources
    .map((s) => {
      let odds;
      if (resolution) {
        odds = `<div class="odds-sq resolved">YES<span class="odds-side">resolved</span></div>`;
      } else if (s.p == null) {
        odds = `<div class="odds-sq err">n/a</div>`;
      } else {
        const pair = oddsPair(s.p);
        odds =
          `<div class="odds-sq yes"><span class="odds-side">Yes</span>${pair.yes}</div>` +
          `<div class="odds-sq no"><span class="odds-side">No</span>${pair.no}</div>`;
      }
      const pctText = s.p == null ? 'unavailable' : Math.round(s.p * 100) + '% implied';
      const updated = s.updatedMs
        ? (s.updatedMs === day.nowMs ? 'live' : 'run ' + fmtTimeMs(s.updatedMs, day))
        : '';
      return (
        `<div class="source-row">` +
        `<div class="source-info">` +
        `<div class="source-name"><span class="source-dot" style="background:${s.color}"></span>${s.name}</div>` +
        `<div class="source-meta">${s.desc} · ${pctText}${updated ? ' · ' + updated : ''}</div>` +
        `</div>` +
        `<div class="source-odds">${odds}</div>` +
        `</div>`
      );
    })
    .join('');
}

function renderObservations(market, observations) {
  const card = document.getElementById('obsCard');
  const el = document.getElementById('obsSummary');
  const { day, loc, resolution } = market;
  const latest = observations.length ? observations[observations.length - 1] : null;
  if (!latest) { card.hidden = true; return; }
  card.hidden = false;
  let html = '';
  if (resolution) {
    html += `<strong>Measurable rain detected</strong> at ${fmtTimeMs(resolution.tMs, day)} ` +
      `(${resolution.amountIn.toFixed(2)}″ reported).`;
    html += `<span class="metar">${resolution.raw}</span>`;
  } else {
    html += `No measurable rain reported at ${loc.stationId} so far today ` +
      `(latest ob ${fmtTimeMs(latest.tMs, day)}${latest.text ? ' · ' + latest.text : ''}).`;
    if (latest.raw) html += `<span class="metar">${latest.raw}</span>`;
  }
  el.innerHTML = html;
}

function renderError(message) {
  const list = document.getElementById('sourcesList');
  list.innerHTML = `<div class="error-row">Could not load forecast data: ${message}. Retrying automatically…</div>`;
}

/* ------------------------------- main ------------------------------ */

async function loadAndRender() {
  const seq = ++loadSeq;
  const loc = activeLocation();
  const day = dayInfoFor(loc);
  const activeSources = sourcesFor(loc);

  const obsPromise = fetchStationObservations(loc.stationId, day).catch(() => []);

  const currentEntries = await Promise.all(
    activeSources.map(async (s) => {
      try {
        return [s.id, await fetchCurrent(s, loc, day)];
      } catch (e) {
        return [s.id, { error: true, reason: e.message }];
      }
    })
  );
  const currents = Object.fromEntries(currentEntries);

  const historyEntries = await Promise.all(
    activeSources.map(async (s) => {
      try {
        return [s.id, await fetchHistory(s, loc, day)];
      } catch {
        return [s.id, []];
      }
    })
  );
  const histories = Object.fromEntries(historyEntries);

  const observations = await obsPromise;

  if (seq !== loadSeq) return; // a newer load (location change) superseded this one

  const anyData = Object.values(currents).some((c) => c && !c.error) ||
    Object.values(histories).some((h) => h.length);
  if (!anyData) {
    renderError('all sources unreachable');
    return;
  }

  const market = buildMarket({ day, activeSources, currents, histories, observations });
  market.loc = loc;
  lastMarket = market;
  lastObservations = observations;
  renderHeader(market);
  renderChart(market);
  renderSources(market);
  renderObservations(market, observations);

  document.getElementById('lastUpdated').textContent =
    'Last updated ' + fmtTimeMs(Date.now(), day) + ' · refreshes every 5 minutes.';
}

async function main() {
  cachePurgeOld();
  initSettings();
  renderLocationStatics();
  try {
    await loadAndRender();
  } catch (e) {
    renderError(e.message || 'unexpected error');
  }
  setInterval(() => {
    loadAndRender().catch(() => { /* keep last good render */ });
  }, REFRESH_MS);
}

main();
