'use strict';

/* ------------------------------------------------------------------ *
 * Major-airport ASOS stations (large/medium US hubs plus regional
 * coverage). Markets resolve on METARs from the nearest one, so only
 * airports with reliable hourly precipitation reporting are listed.
 * Coordinates are approximate (nearest-distance selection only).
 * ------------------------------------------------------------------ */

const ASOS_STATIONS = [
  // Large hubs
  { id: 'KATL', name: 'Atlanta Hartsfield-Jackson', lat: 33.64, lon: -84.43 },
  { id: 'KAUS', name: 'Austin-Bergstrom', lat: 30.19, lon: -97.67 },
  { id: 'KBNA', name: 'Nashville Intl', lat: 36.12, lon: -86.68 },
  { id: 'KBOS', name: 'Boston Logan', lat: 42.36, lon: -71.01 },
  { id: 'KBWI', name: 'Baltimore/Washington Intl', lat: 39.18, lon: -76.67 },
  { id: 'KCLT', name: 'Charlotte Douglas', lat: 35.21, lon: -80.94 },
  { id: 'KDCA', name: 'Washington Reagan National', lat: 38.85, lon: -77.04 },
  { id: 'KDEN', name: 'Denver Intl', lat: 39.86, lon: -104.67 },
  { id: 'KDFW', name: 'Dallas/Fort Worth Intl', lat: 32.90, lon: -97.04 },
  { id: 'KDTW', name: 'Detroit Metro', lat: 42.21, lon: -83.35 },
  { id: 'KEWR', name: 'Newark Liberty', lat: 40.69, lon: -74.17 },
  { id: 'KFLL', name: 'Fort Lauderdale-Hollywood', lat: 26.07, lon: -80.15 },
  { id: 'KHNL', name: 'Honolulu Intl', lat: 21.32, lon: -157.92 },
  { id: 'KHOU', name: 'Houston Hobby', lat: 29.65, lon: -95.28 },
  { id: 'KIAD', name: 'Washington Dulles', lat: 38.94, lon: -77.46 },
  { id: 'KIAH', name: 'Houston Bush Intercontinental', lat: 29.98, lon: -95.34 },
  { id: 'KJFK', name: 'New York JFK', lat: 40.64, lon: -73.78 },
  { id: 'KLAS', name: 'Las Vegas Harry Reid', lat: 36.08, lon: -115.15 },
  { id: 'KLAX', name: 'Los Angeles Intl', lat: 33.94, lon: -118.41 },
  { id: 'KLGA', name: 'New York LaGuardia', lat: 40.78, lon: -73.87 },
  { id: 'KMCO', name: 'Orlando Intl', lat: 28.43, lon: -81.31 },
  { id: 'KMDW', name: 'Chicago Midway', lat: 41.79, lon: -87.75 },
  { id: 'KMIA', name: 'Miami Intl', lat: 25.79, lon: -80.29 },
  { id: 'KMSP', name: 'Minneapolis-St Paul', lat: 44.88, lon: -93.22 },
  { id: 'KMSY', name: 'New Orleans Louis Armstrong', lat: 29.99, lon: -90.26 },
  { id: 'KORD', name: "Chicago O'Hare", lat: 41.98, lon: -87.91 },
  { id: 'KPDX', name: 'Portland Intl', lat: 45.59, lon: -122.60 },
  { id: 'KPHL', name: 'Philadelphia Intl', lat: 39.87, lon: -75.24 },
  { id: 'KPHX', name: 'Phoenix Sky Harbor', lat: 33.43, lon: -112.01 },
  { id: 'KSAN', name: 'San Diego Intl', lat: 32.73, lon: -117.19 },
  { id: 'KSEA', name: 'Seattle-Tacoma', lat: 47.45, lon: -122.31 },
  { id: 'KSFO', name: 'San Francisco Intl', lat: 37.62, lon: -122.37 },
  { id: 'KSLC', name: 'Salt Lake City Intl', lat: 40.79, lon: -111.98 },
  { id: 'KSTL', name: 'St Louis Lambert', lat: 38.75, lon: -90.37 },
  { id: 'KTPA', name: 'Tampa Intl', lat: 27.98, lon: -82.53 },
  // Medium hubs & regional coverage
  { id: 'KABQ', name: 'Albuquerque Sunport', lat: 35.04, lon: -106.61 },
  { id: 'KANC', name: 'Anchorage Ted Stevens', lat: 61.17, lon: -149.99 },
  { id: 'KBDL', name: 'Hartford Bradley', lat: 41.94, lon: -72.68 },
  { id: 'KBHM', name: 'Birmingham-Shuttlesworth', lat: 33.56, lon: -86.75 },
  { id: 'KBIL', name: 'Billings Logan', lat: 45.81, lon: -108.54 },
  { id: 'KBIS', name: 'Bismarck Muni', lat: 46.77, lon: -100.75 },
  { id: 'KBOI', name: 'Boise Air Terminal', lat: 43.56, lon: -116.22 },
  { id: 'KBTV', name: 'Burlington Intl', lat: 44.47, lon: -73.15 },
  { id: 'KBUF', name: 'Buffalo Niagara', lat: 42.94, lon: -78.73 },
  { id: 'KBUR', name: 'Burbank Hollywood', lat: 34.20, lon: -118.36 },
  { id: 'KCHS', name: 'Charleston Intl', lat: 32.90, lon: -80.04 },
  { id: 'KCID', name: 'Cedar Rapids Eastern Iowa', lat: 41.88, lon: -91.71 },
  { id: 'KCLE', name: 'Cleveland Hopkins', lat: 41.41, lon: -81.85 },
  { id: 'KCMH', name: 'Columbus John Glenn', lat: 39.99, lon: -82.89 },
  { id: 'KCOS', name: 'Colorado Springs Muni', lat: 38.81, lon: -104.70 },
  { id: 'KCRP', name: 'Corpus Christi Intl', lat: 27.77, lon: -97.50 },
  { id: 'KCVG', name: 'Cincinnati/Northern Kentucky', lat: 39.05, lon: -84.67 },
  { id: 'KDAL', name: 'Dallas Love Field', lat: 32.85, lon: -96.85 },
  { id: 'KDAY', name: 'Dayton Intl', lat: 39.90, lon: -84.22 },
  { id: 'KDSM', name: 'Des Moines Intl', lat: 41.53, lon: -93.66 },
  { id: 'KELP', name: 'El Paso Intl', lat: 31.81, lon: -106.38 },
  { id: 'KEUG', name: 'Eugene Mahlon Sweet', lat: 44.12, lon: -123.21 },
  { id: 'KFAR', name: 'Fargo Hector Intl', lat: 46.92, lon: -96.82 },
  { id: 'KFAT', name: 'Fresno Yosemite', lat: 36.78, lon: -119.72 },
  { id: 'KFSD', name: 'Sioux Falls Regional', lat: 43.58, lon: -96.74 },
  { id: 'KGEG', name: 'Spokane Intl', lat: 47.62, lon: -117.54 },
  { id: 'KGRR', name: 'Grand Rapids Gerald Ford', lat: 42.88, lon: -85.52 },
  { id: 'KGSO', name: 'Greensboro Piedmont Triad', lat: 36.10, lon: -79.94 },
  { id: 'KGSP', name: 'Greenville-Spartanburg', lat: 34.90, lon: -82.22 },
  { id: 'KICT', name: 'Wichita Eisenhower', lat: 37.65, lon: -97.43 },
  { id: 'KIND', name: 'Indianapolis Intl', lat: 39.72, lon: -86.29 },
  { id: 'KJAN', name: 'Jackson-Medgar Evers', lat: 32.31, lon: -90.08 },
  { id: 'KJAX', name: 'Jacksonville Intl', lat: 30.49, lon: -81.69 },
  { id: 'KLBB', name: 'Lubbock Preston Smith', lat: 33.66, lon: -101.82 },
  { id: 'KLEX', name: 'Lexington Blue Grass', lat: 38.04, lon: -84.61 },
  { id: 'KLIT', name: 'Little Rock Clinton National', lat: 34.73, lon: -92.22 },
  { id: 'KMCI', name: 'Kansas City Intl', lat: 39.30, lon: -94.71 },
  { id: 'KMEM', name: 'Memphis Intl', lat: 35.04, lon: -89.98 },
  { id: 'KMHT', name: 'Manchester-Boston Regional', lat: 42.93, lon: -71.44 },
  { id: 'KMKE', name: 'Milwaukee Mitchell', lat: 42.95, lon: -87.90 },
  { id: 'KMOB', name: 'Mobile Regional', lat: 30.69, lon: -88.24 },
  { id: 'KOAK', name: 'Oakland Intl', lat: 37.72, lon: -122.22 },
  { id: 'KOKC', name: 'Oklahoma City Will Rogers', lat: 35.39, lon: -97.60 },
  { id: 'KOMA', name: 'Omaha Eppley', lat: 41.30, lon: -95.89 },
  { id: 'KONT', name: 'Ontario Intl', lat: 34.06, lon: -117.60 },
  { id: 'KORF', name: 'Norfolk Intl', lat: 36.89, lon: -76.20 },
  { id: 'KPBI', name: 'West Palm Beach Intl', lat: 26.68, lon: -80.10 },
  { id: 'KPIT', name: 'Pittsburgh Intl', lat: 40.49, lon: -80.23 },
  { id: 'KPVD', name: 'Providence T.F. Green', lat: 41.72, lon: -71.43 },
  { id: 'KPWM', name: 'Portland Intl Jetport (ME)', lat: 43.65, lon: -70.31 },
  { id: 'KRAP', name: 'Rapid City Regional', lat: 44.05, lon: -103.06 },
  { id: 'KRDU', name: 'Raleigh-Durham', lat: 35.88, lon: -78.79 },
  { id: 'KRIC', name: 'Richmond Intl', lat: 37.51, lon: -77.32 },
  { id: 'KRNO', name: 'Reno-Tahoe', lat: 39.50, lon: -119.77 },
  { id: 'KROC', name: 'Rochester Greater Intl', lat: 43.12, lon: -77.67 },
  { id: 'KRSW', name: 'Fort Myers Southwest Florida', lat: 26.54, lon: -81.76 },
  { id: 'KSAT', name: 'San Antonio Intl', lat: 29.53, lon: -98.47 },
  { id: 'KSAV', name: 'Savannah/Hilton Head', lat: 32.13, lon: -81.20 },
  { id: 'KSDF', name: 'Louisville Muhammad Ali', lat: 38.17, lon: -85.74 },
  { id: 'KSJC', name: 'San Jose Mineta', lat: 37.36, lon: -121.93 },
  { id: 'KSMF', name: 'Sacramento Intl', lat: 38.70, lon: -121.59 },
  { id: 'KSNA', name: 'Santa Ana John Wayne', lat: 33.68, lon: -117.87 },
  { id: 'KSYR', name: 'Syracuse Hancock', lat: 43.11, lon: -76.10 },
  { id: 'KTUL', name: 'Tulsa Intl', lat: 36.20, lon: -95.89 },
  { id: 'KTUS', name: 'Tucson Intl', lat: 32.12, lon: -110.94 },
  { id: 'KTYS', name: 'Knoxville McGhee Tyson', lat: 35.81, lon: -83.99 },
];

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

function nearestStation(lat, lon) {
  let best = null;
  let bestKm = Infinity;
  for (const s of ASOS_STATIONS) {
    const km = haversineKm(lat, lon, s.lat, s.lon);
    if (km < bestKm) { best = s; bestKm = km; }
  }
  return { ...best, distanceKm: bestKm };
}
