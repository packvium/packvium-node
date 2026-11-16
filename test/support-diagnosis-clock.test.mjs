/**
 * C-02: the "why unpacked" support verdict is a function of the request and the final layout.
 * The replay of a finished layout must not read the deadline clock, so a deadline that passes
 * only after the search ended cannot turn `insufficient_support` into another reason.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { packFallback } from '../fallback.js';

const cuboid = (id, quantity, length, width, height) => ({
  id, quantity, allowed_rotations: ['LWH'],
  dimensions: { length: String(length), width: String(width), height: String(height) },
});
// The support-is-the-only-blocker scene plus enough one-millimetre pebbles that the replay's
// candidate sweeps pass a clock-read boundary (the clock is read on every 64th orientation).
const request = () => ({
  units: { length: 'mm' },
  configuration: { solver_profile: 'fast', time_limit_ms: 300000, minimum_support_ratio: 0.75,
    effort_budget: { max_candidates_evaluated: 1000000, max_placement_attempts: 1000000, max_search_nodes: 1000000 } },
  items: [cuboid('post', 1, 50, 100, 100), cuboid('plank', 1, 100, 100, 40), cuboid('pebble', 40, 1, 1, 1)],
  containers: [{ id: 'box', quantity: 1, inner_dimensions: { length: '100', width: '100', height: '140' } }],
  fixed_placements: [{ item_type: 'post', container_type: 'box', orientation: 'LWH', position: { x: '0', y: '0', z: '0' } }],
});
const reasons = (result) => result.unpacked_items.map((item) => [item.item_type, item.reason]);

test('a deadline that passes after the search does not change the support verdict', () => {
  let reads = 0;
  const reference = packFallback(request(), () => { reads++; return 0; });
  const verdict = reasons(reference).find(([, reason]) => reason === 'insufficient_support');
  assert.ok(verdict);

  // Whichever clock read the deadline passes at, a run whose search finished (nothing is
  // reported as time_limit) must still give the verdict: a diagnosis that read the clock
  // itself would lose it when the deadline passes during the replay.
  for (let passesAt = 0; passesAt <= reads; passesAt++) {
    let seen = 0;
    const found = reasons(packFallback(request(), () => (seen++ < passesAt ? 0 : 1e9)));
    if (found.some(([, reason]) => reason === 'time_limit')) continue;
    assert.deepEqual(found.find(([item]) => item === verdict[0]), verdict, `deadline passes at read ${passesAt}`);
  }
});
