import test from 'node:test';
import assert from 'node:assert/strict';
import {
  idxLabel,
  reversePoints,
  buildMapsUrls,
  decodePolyline,
  nearestLegIndex,
  validateRoute,
  MAX_POINTS,
} from '../public/lib.js';

const pt = (n) => ({ lat: 35 + n / 100, lng: -78 - n / 100, label: `P${n}` });
const pts = (n) => Array.from({ length: n }, (_, i) => pt(i));

test('idxLabel', () => {
  assert.equal(idxLabel(0), 'A');
  assert.equal(idxLabel(25), 'Z');
  assert.equal(idxLabel(26), 'AA');
  assert.equal(idxLabel(27), 'AB');
});

test('reversePoints returns a reversed copy', () => {
  const a = pts(3);
  const r = reversePoints(a);
  assert.deepEqual(r.map((p) => p.label), ['P2', 'P1', 'P0']);
  assert.deepEqual(a.map((p) => p.label), ['P0', 'P1', 'P2']);
});

test('buildMapsUrls: needs two points', () => {
  assert.deepEqual(buildMapsUrls([]), []);
  assert.deepEqual(buildMapsUrls(pts(1)), []);
});

test('buildMapsUrls: single leg with waypoints', () => {
  const legs = buildMapsUrls(pts(4));
  assert.equal(legs.length, 1);
  const u = new URL(legs[0].url);
  assert.equal(u.origin + u.pathname, 'https://www.google.com/maps/dir/');
  assert.equal(u.searchParams.get('api'), '1');
  assert.equal(u.searchParams.get('travelmode'), 'driving');
  assert.equal(u.searchParams.get('origin'), '35.000000,-78.000000');
  assert.equal(u.searchParams.get('destination'), '35.030000,-78.030000');
  assert.equal(u.searchParams.get('waypoints'), '35.010000,-78.010000|35.020000,-78.020000');
});

test('buildMapsUrls: two points have no waypoints param', () => {
  const [leg] = buildMapsUrls(pts(2));
  assert.equal(new URL(leg.url).searchParams.has('waypoints'), false);
});

test('buildMapsUrls: 11 points fit in one leg (origin + 9 waypoints + destination)', () => {
  assert.equal(buildMapsUrls(pts(11)).length, 1);
});

test('buildMapsUrls: 12 points split into two legs sharing an endpoint', () => {
  const legs = buildMapsUrls(pts(12));
  assert.equal(legs.length, 2);
  assert.deepEqual([legs[0].from, legs[0].to], [0, 10]);
  assert.deepEqual([legs[1].from, legs[1].to], [10, 11]);
  const second = new URL(legs[1].url).searchParams;
  assert.equal(second.get('origin'), '35.100000,-78.100000');
});

test('buildMapsUrls: never exceeds 9 waypoints and covers every point', () => {
  const all = pts(MAX_POINTS);
  const legs = buildMapsUrls(all);
  assert.equal(legs[0].from, 0);
  assert.equal(legs.at(-1).to, all.length - 1);
  legs.forEach((l, i) => {
    const wp = new URL(l.url).searchParams.get('waypoints');
    assert.ok((wp ? wp.split('|').length : 0) <= 9);
    if (i > 0) assert.equal(l.from, legs[i - 1].to);
  });
});

test('reverse then build swaps origin and destination', () => {
  const a = pts(4);
  const fwd = new URL(buildMapsUrls(a)[0].url).searchParams;
  const back = new URL(buildMapsUrls(reversePoints(a))[0].url).searchParams;
  assert.equal(back.get('origin'), fwd.get('destination'));
  assert.equal(back.get('destination'), fwd.get('origin'));
  assert.equal(
    back.get('waypoints'),
    fwd.get('waypoints').split('|').reverse().join('|'),
  );
});

test('decodePolyline matches the documented Google example', () => {
  const out = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.deepEqual(out, [
    { lat: 38.5, lng: -120.2 },
    { lat: 40.7, lng: -120.95 },
    { lat: 43.252, lng: -126.453 },
  ]);
});

test('nearestLegIndex picks the leg closest to the click', () => {
  const legs = [
    [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }],
    [{ lat: 0, lng: 1 }, { lat: 1, lng: 1 }],
  ];
  assert.equal(nearestLegIndex(legs, { lat: 0.01, lng: 0.5 }), 0);
  assert.equal(nearestLegIndex(legs, { lat: 0.6, lng: 1.01 }), 1);
  assert.equal(nearestLegIndex([], { lat: 0, lng: 0 }), -1);
});

test('validateRoute accepts a good route and normalizes it', () => {
  const v = validateRoute({
    name: '  Home to school ',
    points: [
      { lat: 35.1234567, lng: -78.7654321, label: ' Home ' },
      { lat: 35.2, lng: -78.8 },
    ],
  });
  assert.equal(v.ok, true);
  assert.equal(v.value.name, 'Home to school');
  assert.equal(v.value.notes, '');
  assert.deepEqual(v.value.points[0], { lat: 35.123457, lng: -78.765432, label: 'Home' });
  assert.deepEqual(v.value.avoid, { highways: true, tolls: false, ferries: false });
});

test('validateRoute rejects bad input', () => {
  const bad = [
    null,
    [],
    { name: '', points: pts(2) },
    { name: 'x'.repeat(101), points: pts(2) },
    { name: 'ok', points: pts(1) },
    { name: 'ok', points: pts(MAX_POINTS + 1) },
    { name: 'ok', points: [{ lat: 91, lng: 0 }, { lat: 0, lng: 0 }] },
    { name: 'ok', points: [{ lat: '1', lng: 0 }, { lat: 0, lng: 0 }] },
    { name: 'ok', points: [{ lat: NaN, lng: 0 }, { lat: 0, lng: 0 }] },
    { name: 'ok', points: [{ lat: 0, lng: 0, label: 'x'.repeat(81) }, { lat: 0, lng: 0 }] },
    { name: 'ok', notes: 5, points: pts(2) },
    { name: 'ok', points: pts(2), avoid: [] },
  ];
  for (const input of bad) {
    assert.equal(validateRoute(input).ok, false, JSON.stringify(input)?.slice(0, 60));
  }
});
