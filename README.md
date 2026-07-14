# phx-rain-market

**Will it rain in Phoenix today?** — a mock, Kalshi-style prediction-market view of
today's rain probability at Phoenix Sky Harbor (KPHX).

Live site: https://kenny150r.github.io/phx-rain-market/

## What it shows

- A market-style headline probability that KPHX records **≥ 0.01″ of rain**
  between 12:00 AM and 11:59 PM MST today.
- An intraday chart of implied probability vs. time, reconstructed from
  archived weather-model runs.
- A list of forecast sources, each priced with Yes/No "cents" like market
  contracts.
- If measurable rain is observed at KPHX (parsed from raw METARs), the market
  resolves YES and the chart pins to 100%.

## How it works

Everything runs in the browser — no backend, no database.

| Source | Type | How probability is derived |
| --- | --- | --- |
| NOAA NBM | probabilistic | native hourly `precipitation_probability` |
| NOAA GFS | ensemble | GEFS-derived hourly probability |
| NWS Phoenix | probabilistic | official hourly PoP from api.weather.gov |
| NOAA HRRR | deterministic | neighborhood + time-lag + QPF softening |
| ECMWF IFS / DWD ICON / CMC GEM | deterministic | same derived approach |

For deterministic models, hourly QPF at a 3×3 grid of points (~±16 km around
Sky Harbor) is softened with `p = 1 − exp(−q/α)`, averaged spatially, and the
last few runs are blended as a time-lagged ensemble. Hourly probabilities are
combined into a daily probability with a clustering correction between the
fully-correlated and independent limits.

Intraday history comes from the
[Open-Meteo Single Runs API](https://open-meteo.com/en/docs/single-runs-api),
which archives each model run: every run initialized today becomes a point on
the chart, priced with the same math. Archived runs are immutable and cached
in `localStorage`.

Resolution uses KPHX METARs from api.weather.gov, parsing `P####` /`6####`
precipitation groups from the raw METAR text (≥ 0.01″ resolves YES).

## Development

No build step. Serve the folder and open it:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Data & disclaimers

- Forecast data by [Open-Meteo](https://open-meteo.com/) (CC BY 4.0) and
  [NOAA/NWS](https://www.weather.gov/documentation/services-web-api).
- **This is not a real market.** Prices are derived from public weather-model
  output for fun; nothing is traded and the probabilities are heuristic, not
  calibrated forecasts.
