import assert from 'node:assert/strict';
import test from 'node:test';

import { __additionalContainerBoundForTests as additionalContainerBound, packFallback } from '../fallback.js';

/**
 * The container-plan bound against `convex_hull` items.
 *
 * Two wedges that fill one crate between them have boxes worth two crates. Counted by box,
 * the bound said a second crate was unavoidable and ranked the plan as if it already held it.
 */

const wedge = (upper) => {
  const base = upper ? [[100, 100], [100, 0], [0, 100]] : [[0, 0], [100, 0], [0, 100]];
  return {
    d: [100, 100, 100], w: 1, nesting: null, rots: ['LWH'], shapeType: 'convex_hull',
    hullVertices: [0, 100].flatMap((z) => base.map(([x, y]) => [x, y, z])),
  };
};
const crate = { id: 'crate', d: [100, 100, 100], max: null };

test('a wedge pair needs one more crate, not two', () => {
  const plan = { remaining: [wedge(false), wedge(true)], inventory: new Map([['crate', 2]]) };
  assert.equal(additionalContainerBound(plan, [crate]), 1);
});

test('a cuboid still counts its whole box', () => {
  const cube = { d: [100, 100, 100], w: 1, nesting: null, rots: ['LWH'], shapeType: 'rigid_cuboid' };
  const plan = { remaining: [cube, cube], inventory: new Map([['crate', 2]]) };
  assert.equal(additionalContainerBound(plan, [crate]), 2);
});

/**
 * The payload half of the same bound. Weights and payloads are BigInt ticks, and the half
 * mixed them with `Math.max` and `Math.ceil`, so a `quality` solve over two container types
 * that both carry `max_payload` threw a TypeError instead of answering.
 */
const brick = (w) => ({ d: [10, 10, 10], w, nesting: null, rots: ['LWH'], shapeType: 'box' });

test('payload decides when volume does not: seven kilograms need two five-kilogram crates', () => {
  const light = { id: 'light', d: [100, 100, 100], max: 3n };
  const heavy = { id: 'heavy', d: [100, 100, 100], max: 5n };
  const plan = {
    remaining: [brick(3n), brick(4n)],
    inventory: new Map([['light', 2], ['heavy', 2]]),
  };
  assert.equal(additionalContainerBound(plan, [light, heavy]), 2);
});

test('an exact multiple of the payload is not rounded up', () => {
  const heavy = { id: 'heavy', d: [100, 100, 100], max: 5n };
  const plan = { remaining: [brick(5n), brick(5n)], inventory: new Map([['heavy', 3]]) };
  assert.equal(additionalContainerBound(plan, [heavy]), 2);
});

test('one container type without a payload limit switches the payload half off', () => {
  const heavy = { id: 'heavy', d: [100, 100, 100], max: 5n };
  const open = { id: 'open', d: [100, 100, 100], max: null };
  const plan = { remaining: [brick(9n)], inventory: new Map([['heavy', 1], ['open', 1]]) };
  assert.equal(additionalContainerBound(plan, [heavy, open]), 1);
});

test('a quality solve over two payload-limited container types answers', () => {
  const result = packFallback({
    configuration: {
      solver_profile: 'quality', time_limit_ms: 60000,
      effort_budget: { max_candidates_evaluated: 200000 },
    },
    items: [{ id: 'a', quantity: 6, weight: '1 kg', dimensions: { length: '100', width: '100', height: '100' } }],
    containers: [
      { id: 's', cost_minor: 5, max_payload: '5 kg', inner_dimensions: { length: '150', width: '150', height: '150' } },
      { id: 'm', cost_minor: 8, max_payload: '9 kg', inner_dimensions: { length: '250', width: '250', height: '150' } },
    ],
  });
  assert.equal(result.unpacked_items.length, 0);
  assert.equal(result.summary.packed_item_count, 6);
});
