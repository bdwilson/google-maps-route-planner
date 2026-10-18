// Pure helpers shared by the browser app, the Cloudflare Worker, and the tests.
// No DOM, no Google Maps objects, no network calls in here.

// Routes API limit: origin + 25 intermediates + destination.
export const MAX_POINTS = 27;
// Google Maps URLs accept at most 9 waypoints between origin and destination.
export const MAX_URL_WAYPOINTS = 9;
export const DEFAULT_AVOID = Object.freeze({ highways: true, tolls: false, ferries: false });

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/** 0 -> A, 25 -> Z, 26 -> AA ... */
export function idxLabel(i) {
  let n = i;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Returns a reversed copy so the same route can be driven the other way. */
export function reversePoints(points) {
  return [...points].reverse();
}

function mapsUrl(slice) {
  const ll = (p) => `${Number(p.lat).toFixed(6)},${Number(p.lng).toFixed(6)}`;
  const params = new URLSearchParams({
    api: '1',
    origin: ll(slice[0]),
    destination: ll(slice[slice.length - 1]),
    travelmode: 'driving',
    dir_action: 'navigate',
  });
  const middle = slice.slice(1, -1);
  if (middle.length) params.set('waypoints', middle.map(ll).join('|'));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/**
 * Splits a route into one or more Google Maps links. Each link holds an origin,
 * a destination, and up to `maxWaypoints` stops. Consecutive legs share an
 * endpoint (leg 2 starts where leg 1 ended).
 * Returns [{ from, to, count, url }] where from/to are indexes into `points`.
 */
export function buildMapsUrls(points, { maxWaypoints = MAX_URL_WAYPOINTS } = {}) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const perLeg = maxWaypoints + 2;
  const legs = [];
  let start = 0;
  while (start < points.length - 1) {
    const end = Math.min(start + perLeg - 1, points.length - 1);
    const slice = points.slice(start, end + 1);
    legs.push({ from: start, to: end, count: slice.length, url: mapsUrl(slice) });
    start = end;
  }
  return legs;
}

/** Decodes a Google encoded polyline (precision 5) into [{lat, lng}]. */
export function decodePolyline(str) {
  const out = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < str.length) {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    out.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return out;
}

function distToSegment(p, a, b, k) {
  const px = p.lng * k;
  const py = p.lat;
  const ax = a.lng * k;
  const ay = a.lat;
  const bx = b.lng * k;
  const by = b.lat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Given the decoded path of each leg and a clicked location, returns the index
 * of the closest leg (or -1 if there is nothing to compare). A new point should
 * be inserted at index + 1.
 */
export function nearestLegIndex(legPaths, pt) {
  let best = -1;
  let bestD = Infinity;
  const k = Math.cos((pt.lat * Math.PI) / 180);
  legPaths.forEach((path, i) => {
    for (let j = 0; j < path.length - 1; j++) {
      const d = distToSegment(pt, path[j], path[j + 1], k);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
  });
  return best;
}

/** Validates and normalizes a route submitted to the API. */
export function validateRoute(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['Body must be a JSON object.'] };
  }

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) errors.push('Name is required.');
  else if (name.length > 100) errors.push('Name must be 100 characters or fewer.');

  const notes = input.notes == null ? '' : input.notes;
  if (typeof notes !== 'string' || notes.length > 2000) {
    errors.push('Notes must be text up to 2000 characters.');
  }

  const points = [];
  const raw = input.points;
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_POINTS) {
    errors.push(`A route needs between 2 and ${MAX_POINTS} points.`);
  } else {
    raw.forEach((p, i) => {
      const lat = p?.lat;
      const lng = p?.lng;
      const okNum = (v, max) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;
      if (!okNum(lat, 90) || !okNum(lng, 180)) {
        errors.push(`Point ${i + 1} has invalid coordinates.`);
        return;
      }
      const label = p.label == null ? '' : p.label;
      if (typeof label !== 'string' || label.length > 80) {
        errors.push(`Point ${i + 1} label must be text up to 80 characters.`);
        return;
      }
      points.push({ lat: round6(lat), lng: round6(lng), label: label.trim() });
    });
  }

  const a = input.avoid == null ? {} : input.avoid;
  if (typeof a !== 'object' || Array.isArray(a)) errors.push('avoid must be an object.');
  const avoid = {
    highways: Boolean(a.highways ?? DEFAULT_AVOID.highways),
    tolls: Boolean(a.tolls ?? DEFAULT_AVOID.tolls),
    ferries: Boolean(a.ferries ?? DEFAULT_AVOID.ferries),
  };

  if (errors.length) return { ok: false, errors };
  return { ok: true, errors, value: { name, notes, points, avoid } };
}
