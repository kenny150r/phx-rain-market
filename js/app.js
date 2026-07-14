'use strict';

/* Orchestration: fetch everything, build the market, render the UI. */

const REFRESH_MS = 5 * 60e3;

function priceCents(p) {
  return Math.min(99, Math.max(1, Math.round(p * 100)));
}

function fmtTimeMs(tMs, day) {
  return fmtHour(localHour(tMs, day.dayStartUtcMs)) + ' MST';
}

function tickerFor(day) {
  const [y, m, d] = day.dateStr.split('-');
  const mon = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][+m - 1];
  return `RAINPHX-${y.slice(2)}${mon}${d}`;
}

function mockVolume(dateStr) {
  let h = 0;
  for (const c of dateStr) h = ((h * 31 + c.charCodeAt(0)) >>> 0);
  return 5000 + (h % 45000);
}

/* ------------------------------ render ---------------------------- */

function renderHeader(market) {
  const { day, finalConsensus, consensusPts, resolution } = market;
  document.getElementById('ticker').textContent = tickerFor(day);
  document.getElementById('volume').textContent =
    '$' + mockVolume(day.dateStr).toLocaleString('en-US') + ' Vol.';

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
      `Resolved YES — ${resolution.amountIn.toFixed(2)}″ of rain observed at KPHX (` +
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
    noBtn.innerHTML = 'No <span class="price">0¢</span>';
  } else if (finalConsensus != null) {
    const yes = priceCents(finalConsensus);
    yesBtn.className = 'trade-btn yes';
    yesBtn.innerHTML = `Yes <span class="price">${yes}¢</span>`;
    noBtn.className = 'trade-btn no';
    noBtn.innerHTML = `No <span class="price">${100 - yes}¢</span>`;
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
        const yes = priceCents(s.p);
        odds =
          `<div class="odds-sq yes"><span class="odds-side">Yes</span>${yes}¢</div>` +
          `<div class="odds-sq no"><span class="odds-side">No</span>${100 - yes}¢</div>`;
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
  const { day, resolution } = market;
  const latest = observations.length ? observations[observations.length - 1] : null;
  if (!latest) { card.hidden = true; return; }
  card.hidden = false;
  let html = '';
  if (resolution) {
    html += `<strong>Measurable rain detected</strong> at ${fmtTimeMs(resolution.tMs, day)} ` +
      `(${resolution.amountIn.toFixed(2)}″ reported).`;
    html += `<span class="metar">${resolution.raw}</span>`;
  } else {
    html += `No measurable rain reported at KPHX so far today ` +
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
  const day = phxDayInfo();

  const obsPromise = fetchKphxObservations(day).catch(() => []);

  const currentEntries = await Promise.all(
    SOURCES.map(async (s) => {
      try {
        return [s.id, await fetchCurrent(s, day.dateStr)];
      } catch (e) {
        return [s.id, { error: true, reason: e.message }];
      }
    })
  );
  const currents = Object.fromEntries(currentEntries);

  const historyEntries = await Promise.all(
    SOURCES.map(async (s) => {
      try {
        return [s.id, await fetchHistory(s, day)];
      } catch {
        return [s.id, []];
      }
    })
  );
  const histories = Object.fromEntries(historyEntries);

  const observations = await obsPromise;

  const anyData = Object.values(currents).some((c) => c && !c.error) ||
    Object.values(histories).some((h) => h.length);
  if (!anyData) {
    renderError('all sources unreachable');
    return;
  }

  const market = buildMarket({ day, currents, histories, observations });
  renderHeader(market);
  renderChart(market);
  renderSources(market);
  renderObservations(market, observations);

  document.getElementById('lastUpdated').textContent =
    'Last updated ' + fmtTimeMs(Date.now(), day) + ' · refreshes every 5 minutes.';
}

async function main() {
  cachePurgeOld();
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
