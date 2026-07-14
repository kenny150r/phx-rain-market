'use strict';

/* Chart rendering with Chart.js: consensus line plus faint per-source traces. */

let probChart = null;

function fmtHour(h) {
  const clamped = Math.min(Math.max(h, 0), 24);
  let hh = Math.floor(clamped) % 24;
  const mm = Math.round((clamped % 1) * 60);
  const ampm = hh < 12 ? 'AM' : 'PM';
  hh = hh % 12 || 12;
  return mm ? `${hh}:${String(mm).padStart(2, '0')} ${ampm}` : `${hh} ${ampm}`;
}

function renderChart(market) {
  const ctx = document.getElementById('probChart').getContext('2d');

  const sourceDatasets = SOURCES
    .filter((s) => market.traces[s.id] && market.traces[s.id].length > 1)
    .map((s) => ({
      label: s.name,
      data: market.traces[s.id].map((pt) => ({ x: pt.h, y: pt.p * 100 })),
      borderColor: s.color + '55',
      borderWidth: 1.25,
      pointRadius: 0,
      pointHitRadius: 6,
      tension: 0,
      fill: false,
    }));

  const gradient = ctx.createLinearGradient(0, 0, 0, 240);
  gradient.addColorStop(0, 'rgba(0, 176, 114, 0.16)');
  gradient.addColorStop(1, 'rgba(0, 176, 114, 0)');

  const consensusDataset = {
    label: 'Market (consensus)',
    data: market.consensusPts.map((pt) => ({ x: pt.h, y: pt.p * 100 })),
    borderColor: '#00b072',
    backgroundColor: gradient,
    borderWidth: 2.5,
    pointRadius: 0,
    pointHitRadius: 8,
    tension: 0,
    fill: true,
  };

  const data = { datasets: [...sourceDatasets, consensusDataset] };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    interaction: { mode: 'nearest', intersect: false },
    scales: {
      x: {
        type: 'linear',
        min: 0,
        max: 24,
        grid: { display: false },
        ticks: {
          stepSize: 4,
          color: '#98a2b3',
          font: { family: 'Inter', size: 10 },
          callback: (v) => (v === 24 ? '12 AM' : fmtHour(v)),
        },
      },
      y: {
        min: 0,
        max: 100,
        grid: { color: 'rgba(16, 24, 40, 0.05)' },
        border: { display: false },
        ticks: {
          stepSize: 25,
          color: '#98a2b3',
          font: { family: 'Inter', size: 10 },
          callback: (v) => v + '%',
        },
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#101828',
        titleFont: { family: 'Inter', size: 11 },
        bodyFont: { family: 'Inter', size: 11 },
        displayColors: false,
        callbacks: {
          title: (items) => (items.length ? fmtHour(items[0].parsed.x) + ' MST' : ''),
          label: (item) => `${item.dataset.label}: ${Math.round(item.parsed.y)}%`,
        },
      },
    },
  };

  if (probChart) {
    probChart.data = data;
    probChart.options = options;
    probChart.update();
  } else {
    probChart = new Chart(ctx, { type: 'line', data, options });
  }

  // Legend chips under the chart.
  const legend = document.getElementById('chartLegend');
  const items = [{ name: 'Market', color: '#00b072' }].concat(
    SOURCES.filter((s) => market.traces[s.id] && market.traces[s.id].length > 1)
      .map((s) => ({ name: s.name.replace(/^(NOAA|DWD|CMC)\s/, ''), color: s.color }))
  );
  legend.innerHTML = items
    .map((i) => `<span class="legend-item"><span class="legend-swatch" style="background:${i.color}"></span>${i.name}</span>`)
    .join('');
}
