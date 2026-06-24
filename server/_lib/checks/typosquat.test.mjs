import test from 'node:test';
import assert from 'node:assert/strict';
import { levenshtein, nearestTyposquat } from './typosquat.mjs';

// ---------------------------------------------------------------------------
// levenshtein
// ---------------------------------------------------------------------------

test('levenshtein: classic known pairs', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('', 'abc'), 3);
  assert.equal(levenshtein('abc', ''), 3);
  assert.equal(levenshtein('', ''), 0);
});

test('levenshtein: equal strings are distance 0', () => {
  assert.equal(levenshtein('request', 'request'), 0);
  assert.equal(levenshtein('a', 'a'), 0);
});

test('levenshtein: single-edit cases', () => {
  assert.equal(levenshtein('request', 'reqeust'), 2); // transposition = 2 edits
  assert.equal(levenshtein('react', 'recat'), 2);
  assert.equal(levenshtein('lodash', 'lodahs'), 2);
  assert.equal(levenshtein('chalk', 'chalks'), 1); // one insertion
  assert.equal(levenshtein('express', 'expres'), 1); // one deletion
  assert.equal(levenshtein('axios', 'axois'), 2); // transposition
  assert.equal(levenshtein('flatten', 'flaten'), 1);
});

test('levenshtein: symmetric', () => {
  assert.equal(levenshtein('sitting', 'kitten'), 3);
  assert.equal(levenshtein('flaw', 'lawn'), 2);
});

test('levenshtein: defensive against non-string / garbage input', () => {
  assert.equal(levenshtein(undefined, 'abc'), 3);
  assert.equal(levenshtein('abc', undefined), 3);
  assert.equal(levenshtein(null, null), 0);
  assert.equal(levenshtein(undefined, undefined), 0);
  assert.equal(levenshtein(123, 'abc'), 3); // coerced to ''
  assert.equal(levenshtein({}, []), 0); // both coerced to ''
});

// ---------------------------------------------------------------------------
// nearestTyposquat
// ---------------------------------------------------------------------------

const POPULAR = [
  { name: 'request', downloads: 20_000_000 },
  { name: 'react', downloads: 25_000_000 },
  { name: 'lodash', downloads: 50_000_000 },
  { name: 'express', downloads: 30_000_000 },
  { name: 'chalk', downloads: 200_000_000 },
];

test('nearestTyposquat: flags reqeust -> request when request is 100x bigger', () => {
  // self downloads tiny; request is 20M >= 100 * 1000
  const r = nearestTyposquat('reqeust', 1000, POPULAR);
  assert.deepEqual(r, { of: 'request', distance: 2 });
});

test('nearestTyposquat: flags against fixed 100000 floor when self downloads is 0/undefined', () => {
  // reqeust vs request, distance 2, request has 20M >= 100000
  assert.deepEqual(nearestTyposquat('reqeust', 0, POPULAR), {
    of: 'request',
    distance: 2,
  });
  assert.deepEqual(nearestTyposquat('reqeust', undefined, POPULAR), {
    of: 'request',
    distance: 2,
  });
  assert.deepEqual(nearestTyposquat('reqeust', null, POPULAR), {
    of: 'request',
    distance: 2,
  });
});

test('nearestTyposquat: an unpopular near-name does NOT flag', () => {
  // candidate is a near-miss (distance 2) but NOT popular enough.
  const popular = [{ name: 'request', downloads: 500 }];
  // self is 0 -> floor 100000; 500 < 100000 -> no flag.
  assert.equal(nearestTyposquat('reqeust', 0, popular), null);
});

test('nearestTyposquat: relative bar — target not 100x bigger does not flag', () => {
  // self = 1,000,000 so threshold = 100,000,000. request at 20M is below it.
  const r = nearestTyposquat('reqeust', 1_000_000, POPULAR);
  // chalk is 200M (clears the bar) but distance(reqeust, chalk) is large -> not 1/2.
  // request (20M) is below the 100M bar -> excluded. So nothing qualifies.
  assert.equal(r, null);
});

test('nearestTyposquat: distance 3 does not flag', () => {
  // 'xyzrequest' -> 'request' is edit distance 3 (delete x, y, z): too far.
  assert.equal(levenshtein('xyzrequest', 'request'), 3);
  const r = nearestTyposquat('xyzrequest', 0, POPULAR);
  assert.equal(r, null);
});

test('nearestTyposquat: the package own name is skipped (distance 0)', () => {
  // name exactly matches a popular package -> not a typosquat of itself.
  const r = nearestTyposquat('request', 0, POPULAR);
  assert.equal(r, null);
});

test('nearestTyposquat: smallest distance wins over a farther candidate', () => {
  const popular = [
    // 'colours' is distance 2 from 'colorss' but has WAY more downloads...
    { name: 'colours', downloads: 900_000_000 },
    // ...yet 'colors' at distance 1 must still win on smaller distance.
    { name: 'colors', downloads: 1_000_000 },
  ];
  const r = nearestTyposquat('colorss', 0, popular);
  // 'colorss' -> 'colors' = 1; 'colorss' -> 'colours' = 2. Smaller distance wins.
  assert.equal(levenshtein('colorss', 'colors'), 1);
  assert.equal(levenshtein('colorss', 'colours'), 2);
  assert.deepEqual(r, { of: 'colors', distance: 1 });
});

test('nearestTyposquat: tie-breaking by highest downloads at equal distance', () => {
  const popular = [
    { name: 'colors', downloads: 1_000_000 },
    { name: 'colours', downloads: 5_000_000 },
  ];
  // 'colers' -> 'colors' distance 1; 'colers' -> 'colours' distance 2.
  // Different distances, so smallest wins (colors).
  assert.deepEqual(nearestTyposquat('colers', 0, popular), {
    of: 'colors',
    distance: 1,
  });

  // Now force an actual tie at the same distance.
  const tied = [
    { name: 'lodash', downloads: 10_000_000 }, // 'lodish' -> 'lodash' distance 1
    { name: 'lodish-lo', downloads: 99_000_000 }, // far away, ignore
    { name: 'lodush', downloads: 80_000_000 }, // 'lodish' -> 'lodush' distance 1
  ];
  // Both lodash and lodush are distance 1 from 'lodish'; lodush has more downloads.
  assert.deepEqual(nearestTyposquat('lodish', 0, tied), {
    of: 'lodush',
    distance: 1,
  });
});

test('nearestTyposquat: prefers higher downloads when two dist-1 candidates tie', () => {
  const popular = [
    { name: 'expres', downloads: 1_000_000 }, // 'exprss' -> 'expres' distance 1
    { name: 'express', downloads: 900_000_000 }, // 'exprss' -> 'express' distance 1
  ];
  // Both distance 1 -> tie -> highest downloads -> express.
  assert.equal(levenshtein('exprss', 'expres'), 1);
  assert.equal(levenshtein('exprss', 'express'), 1);
  assert.deepEqual(nearestTyposquat('exprss', 0, popular), {
    of: 'express',
    distance: 1,
  });
});

// ---------------------------------------------------------------------------
// null / garbage guards
// ---------------------------------------------------------------------------

test('nearestTyposquat: null guards do not throw and return null', () => {
  assert.equal(nearestTyposquat('', 0, POPULAR), null);
  assert.equal(nearestTyposquat(undefined, 0, POPULAR), null);
  assert.equal(nearestTyposquat(null, 0, POPULAR), null);
  assert.equal(nearestTyposquat(123, 0, POPULAR), null);
  assert.equal(nearestTyposquat('request', 0, []), null);
  assert.equal(nearestTyposquat('request', 0, null), null);
  assert.equal(nearestTyposquat('request', 0, undefined), null);
  assert.equal(nearestTyposquat('request', 0, 'not-an-array'), null);
});

test('nearestTyposquat: malformed candidate rows are skipped, not thrown', () => {
  const messy = [
    null,
    undefined,
    'string',
    42,
    {},
    { name: null, downloads: 9_000_000 },
    { name: '', downloads: 9_000_000 },
    { name: 'request', downloads: 'lots' }, // bad downloads -> treated as 0 -> below floor
    { name: 'reqeust' }, // missing downloads -> 0 -> below floor (and it IS the name anyway)
    { name: 'reqeusty', downloads: 9_000_000 }, // distance 1, popular -> the one valid hit
  ];
  const r = nearestTyposquat('reqeust', 0, messy);
  // 'reqeust' -> 'reqeusty' is distance 1; it's the only qualifying row.
  assert.deepEqual(r, { of: 'reqeusty', distance: 1 });
});

test('nearestTyposquat: negative / NaN self downloads fall back to fixed floor', () => {
  assert.deepEqual(nearestTyposquat('reqeust', -50, POPULAR), {
    of: 'request',
    distance: 2,
  });
  assert.deepEqual(nearestTyposquat('reqeust', NaN, POPULAR), {
    of: 'request',
    distance: 2,
  });
});

test('nearestTyposquat: exactly at the threshold qualifies (>=)', () => {
  // self = 1000 -> threshold 100000. candidate downloads exactly 100000.
  const popular = [{ name: 'request', downloads: 100_000 }];
  assert.deepEqual(nearestTyposquat('reqeust', 1000, popular), {
    of: 'request',
    distance: 2,
  });
  // one below threshold -> no flag
  const below = [{ name: 'request', downloads: 99_999 }];
  assert.equal(nearestTyposquat('reqeust', 1000, below), null);
});
