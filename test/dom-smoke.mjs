// Runs app.js render functions against a minimal DOM stub to catch
// runtime errors in the paths changed for URL/loading/no-market work.
// Not a full browser test — just a guardrail. Run: node test/dom-smoke.mjs
import { readFileSync } from 'fs';
import vm from 'vm';

function makeEl() {
  const el = {
    _text: '', _html: '', className: '', hidden: false,
    style: { visibility: '', color: '' },
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    setAttribute() {}, addEventListener() {},
    querySelectorAll() { return []; },
    contains() { return false; },
    getContext() { return {}; },
    nextElementSibling: null,
    parentElement: null,
  };
  Object.defineProperty(el, 'textContent', { get() { return el._text; }, set(v) { el._text = String(v); } });
  Object.defineProperty(el, 'innerHTML', { get() { return el._html; }, set(v) { el._html = String(v); } });
  const pct = { style: { visibility: '' } };
  el.nextElementSibling = pct;
  el.parentElement = { style: { color: '' } };
  return el;
}

const els = {};
function getEl(id) { return (els[id] = els[id] || makeEl()); }

const storage = new Map();
const ctx = {
  console, Date, URLSearchParams, Intl, Math, JSON, setTimeout, clearTimeout,
  setInterval: () => 0,
  fetch: () => Promise.reject(new Error('no network in smoke test')),
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  navigator: {},
  history: { replaceState() {} },
  location: { pathname: '/phx-rain-market/', search: '?lat=39.74&lon=-104.99&name=Denver%2C%20CO' },
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, v),
    removeItem: (k) => storage.delete(k),
    key: (i) => [...storage.keys()][i] ?? null,
    get length() { return storage.size; },
  },
  document: {
    body: { classList: { toggle() {} } },
    documentElement: { dataset: {} },
    getElementById: getEl,
    querySelectorAll: () => [],
    addEventListener() {},
    title: '',
  },
  Chart: function () { return { update() {}, data: {}, options: {} }; },
};
ctx.window = ctx;
vm.createContext(ctx);

for (const f of ['js/stations.js', 'js/sources.js', 'js/model.js', 'js/chart.js', 'js/app.js']) {
  vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
}

// const/function bindings live in the context's lexical scope, so run
// the exercises as an in-context script (like the main harness).
const body = `
const strip = (s) => String(s).replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim();
const parsed = parseUrlLocation();
console.log('parseUrlLocation:', JSON.stringify(parsed), parsed && parsed.name === 'Denver, CO' ? 'OK' : 'FAIL');

const loc = DEFAULT_LOCATION;
const day = dayInfoFor(loc);
function fakeMarket(p) {
  return {
    day, loc,
    finalConsensus: p,
    consensusPts: p == null ? [] : [{ h: 0, p: 0.1 }, { h: day.hoursInDay, p }],
    resolution: null,
    sources: [
      { id: 'nbm', name: 'NOAA NBM', desc: 'x', color: '#000', p, updatedMs: day.nowMs },
      { id: 'gem', name: 'CMC GEM', desc: 'y', color: '#111', p: null, updatedMs: null },
    ],
    traces: {},
  };
}

const cases = [['null', null], ['no-market 0.4%', 0.004], ['normal 34%', 0.34], ['high 96%', 0.96]];
for (const [label, p] of cases) {
  for (const odds of ['betting', 'cents']) {
    settings.odds = odds;
    renderHeader(fakeMarket(p));
    renderSources(fakeMarket(p));
    const big = document.getElementById('bigProb')._text;
    const yes = strip(document.getElementById('yesBtn')._html);
    const no = strip(document.getElementById('noBtn')._html);
    const src = strip(document.getElementById('sourcesList')._html).slice(0, 48);
    console.log('[' + odds + '] ' + label + ': big="' + big + '" btn="' + yes + ' | ' + no + '" src="' + src + '"');
  }
}

settings.odds = 'betting';
const resolved = fakeMarket(0.2);
resolved.resolution = { tMs: day.dayStartUtcMs + 3600e3 * 10, amountIn: 0.05, raw: 'KDEN P0005' };
renderHeader(resolved);
console.log('resolved btn:', strip(document.getElementById('yesBtn')._html), '/', strip(document.getElementById('noBtn')._html));
console.log('DOM smoke test completed with no thrown errors.');
`;
vm.runInContext(body, ctx, { filename: 'dom-smoke-body' });
