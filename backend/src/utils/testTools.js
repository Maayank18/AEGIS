// Run: node src/utils/testTools.js

import { worldState } from '../core/worldState.js';
import { getRoute, blockRoad } from '../tools/routing.js';
import { getAvailableUnits, dispatchUnit, returnUnit } from '../tools/resourceTracker.js';
import { getHospitalCapacity } from '../tools/hospitalApi.js';
import { getWeather } from '../tools/weatherApi.js';

function pass(label) { console.log(`   ✅ ${label}`); }
function fail(label, err) { console.error(`   ❌ ${label}: ${err}`); }

async function run() {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   AEGIS — Phase 2 Tool Verification  ║');
  console.log('╚══════════════════════════════════════╝\n');

  worldState.init();

  // [1/5] Routing
  console.log('[1/5] Routing tool');
  try {
    const r = await getRoute({ origin: 'CP', destination: 'SD' });
    if (!r.success) throw new Error(r.error);
    console.log(`   Route: ${r.pathNames.join(' → ')}`);
    console.log(`   Time:  ${r.totalTimeMinutes} min`);
    pass(`CP → SD route found (${r.hops} hops)`);
  } catch (e) { fail('getRoute', e.message); }

  try {
    await blockRoad({ edgeId: 'e5', reason: 'Test block' });
    const r2 = await getRoute({ origin: 'CP', destination: 'SD' });
    console.log(`   Rerouted: ${r2.success ? r2.pathNames.join(' → ') : 'No route available'}`);
    pass('blockRoad + rerouting works');
    worldState.unblockEdge('e5');
  } catch (e) { fail('blockRoad', e.message); }

  // [2/5] Resource tracker
  console.log('\n[2/5] Resource tracker');
  try {
    const avail = await getAvailableUnits({});
    console.log(`   Total available: ${avail.totalAvailable} units`);
    console.log(`   Police: ${avail.summary.police}, Fire: ${avail.summary.fire}, EMS: ${avail.summary.ems}, Traffic: ${avail.summary.traffic}`);
    pass('getAvailableUnits returned data');
  } catch (e) { fail('getAvailableUnits', e.message); }

  try {
    const d = await dispatchUnit({ unitId: 'P-1', destination: 'SD', incidentId: 'test-001' });
    if (!d.success) throw new Error(d.error);
    console.log(`   Dispatched: ${d.unit.name} → ${d.unit.destination}`);
    pass('dispatchUnit succeeded');

    const after = await getAvailableUnits({ type: 'police' });
    if (after.units.find(u => u.id === 'P-1')) throw new Error('P-1 still available after dispatch');
    pass('Unit removed from available pool after dispatch');

    const ret = await returnUnit({ unitId: 'P-1' });
    if (!ret.success) throw new Error(ret.error);
    pass('returnUnit succeeded');
  } catch (e) { fail('dispatch/return cycle', e.message); }

  // [3/5] Hospital API
  console.log('\n[3/5] Hospital API');
  try {
    const h = await getHospitalCapacity({});
    console.log(`   Hospitals: ${h.totalQueried}`);
    console.log(`   Best: ${h.recommendation}`);
    console.log(`   Total beds available: ${h.totalAvailableBeds}`);
    pass('getHospitalCapacity returned data');
  } catch (e) { fail('getHospitalCapacity', e.message); }

  // [4/5] Weather
  console.log('\n[4/5] Weather API');
  try {
    const w = await getWeather({ zone: 'KB' });
    const wx = w.weather;
    console.log(`   Wind: ${wx.windSpeed} km/h ${wx.windDirection}`);
    console.log(`   Fire spread risk: ${wx.fireSpreadRisk}`);
    console.log(`   Downwind zone: ${wx.downwindZone}`);
    if (wx.advisory) console.log(`   Advisory: ${wx.advisory}`);
    pass('getWeather returned data');
  } catch (e) { fail('getWeather', e.message); }

  // [5/5] WorldState snapshot
  console.log('\n[5/5] WorldState snapshot');
  try {
    const snap = worldState.getSnapshot();
    console.log(`   Units:            ${snap.units.length}`);
    console.log(`   Active incidents: ${snap.activeIncidents.length}`);
    console.log(`   Hospitals:        ${snap.hospitals.length}`);
    console.log(`   Blocked edges:    ${snap.blockedEdges.length}`);
    pass('getSnapshot works');
  } catch (e) { fail('getSnapshot', e.message); }

  console.log('\n✅ Phase 2 tool verification complete\n');
}

run().catch(err => {
  console.error('\n❌ Test runner failed:', err);
  process.exit(1);
});