import test from 'node:test';
import assert from 'node:assert/strict';

import { worldState } from '../src/core/worldState.js';
import { getRoute, normalizePath } from '../src/tools/routing.js';

worldState.init();

test('normalizePath converts GeoJSON and zone arrays into lat/lng points', () => {
  const geoJson = normalizePath({
    type: 'LineString',
    coordinates: [[77.2167, 28.6315], [77.2295, 28.6129]],
  });
  assert.deepEqual(geoJson[0], { lat: 28.6315, lng: 77.2167 });

  const zonePath = normalizePath(['CP', 'RP']);
  assert.equal(zonePath.length, 2);
  assert.equal(typeof zonePath[0].lat, 'number');
  assert.equal(zonePath[0].zone, 'CP');
});

test('getRoute returns normalized route geometry and timing metadata', async () => {
  const route = await getRoute({ origin: 'CP', destination: 'RP' });

  assert.equal(route.success, true);
  assert.equal(Array.isArray(route.zonePath), true);
  assert.equal(Array.isArray(route.path), true);
  assert.equal(route.geometry_type, 'latlng_array');
  assert.equal(typeof route.distanceMeters, 'number');
  assert.equal(typeof route.etaSeconds, 'number');
  assert.equal(typeof route.path[0].lat, 'number');
  assert.equal(typeof route.path[0].lng, 'number');
});
