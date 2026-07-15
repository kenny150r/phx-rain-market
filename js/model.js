'use strict';

/* ------------------------------------------------------------------ *
 * Probability model: turn hourly forecast data into a daily implied
 * probability of >= 0.01 in of rain, plus METAR-based resolution.
 * ------------------------------------------------------------------ */

// Soften deterministic QPF (mm) into per-hour confidence. A deterministic
// model painting 0.25 mm (~0.01 in) is far from a guarantee at a point,
// while several mm is close to one. Capped below 1 because deterministic
// output is never a sure thing.
const QPF_ALPHA_MM = 1.3;

function softProb(qpfMm) {
  if (qpfMm == null || qpfMm < 0.05) return 0;
  return Math.min(0.95, 1 - Math.exp(-qpfMm / QPF_ALPHA_MM));
}

// Combine per-hour probabilities into a daily probability. Full
// independence (1 - prod(1-p)) overestimates because rainy hours cluster
// in the same storm event, so interpolate between the fully-correlated
// answer (max_h p_h) and the independent one.
const CLUSTER_W = 0.4;

function dailyFromHourly(hourlyProbs) {
  const valid = hourlyProbs.filter((p) => p != null && !Number.isNaN(p));
  if (!valid.length) return null;
  const pMax = Math.max(...valid);
  let survive = 1;
  for (const p of valid) survive *= 1 - Math.min(p, 0.99);
  const pInd = 1 - survive;
  return pMax + (pInd - pMax) * CLUSTER_W;
}

// hours: probs -> value in % or null; qpf -> array of mm across the
// neighborhood or null. Returns per-hour probability fractions [0..1].
function hourlyProbFractions(kind, hours) {
  return hours.map((h) => {
    if (h == null) return null;
    if (kind === 'prob') return Math.min(Math.max(h / 100, 0), 1);
    // qpf: mean of softened values across neighborhood points blends
    // spatial coverage (fraction of points wet) with amounts.
    const soft = h.map(softProb);
    return soft.reduce((a, b) => a + b, 0) / soft.length;
  });
}

// Daily probability implied by one dataset, counting only hours from
// `fromHour` (local, fractional) to end of day.
function dailyProbFrom(kind, hours, fromHour) {
  const fracs = hourlyProbFractions(kind, hours);
  const start = Math.max(0, Math.floor(fromHour));
  const rest = fracs.slice(start);
  // Partial first hour: scale by the remaining fraction of that hour.
  if (rest.length && rest[0] != null && fromHour > start) {
    rest[0] *= 1 - (fromHour - start);
  }
  return dailyFromHourly(rest);
}

/* ----------------------- time-lagged blending --------------------- */

// Blend the most recent runs available at time t (weights favor the
// newest). Each run's daily probability is recomputed for the hours
// remaining after t, so the market naturally decays on a dry day.
const LAG_WEIGHTS = { qpf: [0.55, 0.3, 0.15], prob: [1] };

function sourceValueAt(source, runs, tMs, day) {
  const avail = runs.filter((r) => r.effMs <= tMs);
  if (!avail.length) return null;
  const fromHour = Math.min(Math.max(localHour(tMs, day.dayStartUtcMs), 0), day.hoursInDay - 0.01);
  const weights = LAG_WEIGHTS[source.histKind || source.kind] || [1];
  const recent = avail.slice(-weights.length).reverse(); // newest first
  let num = 0;
  let den = 0;
  recent.forEach((run, i) => {
    const p = dailyProbFrom(run.kind, run.hours, fromHour);
    if (p == null) return;
    num += weights[i] * p;
    den += weights[i];
  });
  return den > 0 ? num / den : null;
}

/* ---------------------------- consensus --------------------------- */

function consensusOf(entries) {
  // entries: [{weight, p}] with p a fraction or null
  let num = 0;
  let den = 0;
  for (const e of entries) {
    if (e.p == null) continue;
    num += e.weight * e.p;
    den += e.weight;
  }
  return den > 0 ? num / den : null;
}

/* ---------------------------- resolution -------------------------- */

// Measurable rain from METAR remarks: Pxxxx is hourly precip in
// hundredths of an inch (P0000 = trace, not measurable). The API's
// decoded precipitation fields have a known rounding-to-zero bug, so we
// parse the raw METAR text instead.
function detectMeasurableRain(observations, day) {
  for (const obs of observations) {
    if (obs.tMs < day.dayStartUtcMs || obs.tMs >= day.dayEndUtcMs) continue;
    const m = obs.raw.match(/(?:^|\s)P(\d{4})(?=\s|$)/);
    if (m && parseInt(m[1], 10) >= 1) {
      // The 1-hour window may reach before local midnight; require the
      // obs to be at least ~an hour into the day to avoid crediting
      // yesterday's rain.
      if (obs.tMs >= day.dayStartUtcMs + 55 * 60e3) {
        return { tMs: obs.tMs, raw: obs.raw, amountIn: parseInt(m[1], 10) / 100 };
      }
    }
    // 6-group: 3/6-hour totals (available on synoptic-hour METARs).
    const m6 = obs.raw.match(/(?:^|\s)6(\d{4})(?=\s|$)/);
    if (m6 && parseInt(m6[1], 10) >= 1 && obs.tMs >= day.dayStartUtcMs + 6 * 3600e3) {
      return { tMs: obs.tMs, raw: obs.raw, amountIn: parseInt(m6[1], 10) / 100 };
    }
  }
  return null;
}

/* --------------------------- market build ------------------------- */

// Assemble everything the UI needs: per-source current values, chart
// traces, consensus trace, and resolution state. `activeSources` is
// the location-filtered subset of SOURCES.
function buildMarket({ day, activeSources, currents, histories, observations }) {
  const resolution = detectMeasurableRain(observations, day);
  const nowHour = Math.min(localHour(day.nowMs, day.dayStartUtcMs), day.hoursInDay);

  const sources = activeSources.map((s) => {
    const cur = currents[s.id];
    const runs = histories[s.id] || [];
    let p = null;
    let updatedMs = null;
    if (runs.length) {
      p = sourceValueAt(s, runs, day.nowMs, day);
      updatedMs = runs[runs.length - 1].runMs;
    }
    if (p == null && cur && !cur.error) {
      p = dailyProbFrom(cur.kind, cur.hours, Math.max(nowHour, 0));
      updatedMs = day.nowMs;
    }
    // Prefer the live forecast value when fresher than the last archived run.
    if (cur && !cur.error && runs.length) {
      const live = dailyProbFrom(cur.kind, cur.hours, Math.max(nowHour, 0));
      if (live != null && p != null) p = 0.5 * p + 0.5 * live;
      else if (live != null) p = live;
      updatedMs = day.nowMs;
    }
    return {
      ...s,
      p,
      updatedMs,
      error: (!runs.length && (!cur || cur.error)) ? (cur && cur.reason) || 'unavailable' : null,
    };
  });

  // Chart traces: per source, a point at each run's effective time plus "now".
  const traces = {};
  for (const s of activeSources) {
    const runs = histories[s.id] || [];
    if (!runs.length) continue;
    const pts = [];
    for (const run of runs) {
      const t = Math.max(run.effMs, day.dayStartUtcMs);
      const v = sourceValueAt(s, runs, t, day);
      if (v != null) pts.push({ h: localHour(t, day.dayStartUtcMs), p: v });
    }
    const src = sources.find((x) => x.id === s.id);
    if (src && src.p != null) pts.push({ h: nowHour, p: src.p });
    if (pts.length) traces[s.id] = pts;
  }

  // Consensus trace on a half-hour grid.
  const gridStep = 0.5;
  const consensusPts = [];
  for (let h = 0; h <= nowHour + 1e-9; h += gridStep) {
    const t = day.dayStartUtcMs + Math.min(h, nowHour) * 3600e3;
    const entries = activeSources
      .filter((s) => (histories[s.id] || []).length)
      .map((s) => ({ weight: s.weight, p: sourceValueAt(s, histories[s.id], t, day) }));
    const c = consensusOf(entries);
    if (c != null) consensusPts.push({ h: Math.min(h, nowHour), p: c });
  }

  // Current consensus includes every live source (NWS, GEM, ...).
  const currentConsensus = consensusOf(sources.map((s) => ({ weight: s.weight, p: s.p })));
  if (currentConsensus != null) consensusPts.push({ h: nowHour, p: currentConsensus });

  // Resolution overrides: market pins to 100% from detection onward.
  let finalConsensus = currentConsensus;
  if (resolution) {
    const hR = Math.max(localHour(resolution.tMs, day.dayStartUtcMs), 0);
    const kept = consensusPts.filter((pt) => pt.h < hR);
    kept.push({ h: hR, p: 1 }, { h: nowHour, p: 1 });
    consensusPts.length = 0;
    consensusPts.push(...kept);
    for (const id of Object.keys(traces)) {
      traces[id] = traces[id].filter((pt) => pt.h < hR);
    }
    finalConsensus = 1;
  }

  return { day, sources, traces, consensusPts, resolution, finalConsensus, nowHour };
}
