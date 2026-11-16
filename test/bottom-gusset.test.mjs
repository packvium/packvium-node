/**
 * 1.11: bottom gussets, lying flat or standing, admitted by the two loops of film.
 *
 * Mirrors `packvium-python/tests/test_bottom_gusset.py`; the request error and validator texts
 * are asserted whole because they are compared across engines.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { FixedPlacementError, InvalidRequestError, packFallback, rebalanceWeight } from '../fallback.js';
import { validateDocuments } from '../result-validation/index.js';
import { girthBreach } from '../result-validation/spec.js';
import { validate } from './validate.mjs';

const MM = 16000;

const ROD = { id: 'rod', allowed_rotations: ['LWH'], dimensions: { length: '300', width: '100', height: '20' } };
const BOTTLE = { id: 'bottle', allowed_rotations: ['LWH'], dimensions: { length: '50', width: '50', height: '150' } };
const STANDING = { kind: 'gusseted_bag', bottom_gusset_depth: '60', orientation: 'standing' };

const pouch = (boundary, width = '150') => ({
  id: 'pouch', quantity: 1, deformable_boundary: boundary, inner_dimensions: { length: '300', width, height: '100' },
});
const request = (boundary, item, quantity, width = '150') => ({
  items: [{ ...item, quantity, weight: '300 g' }],
  containers: [pouch(boundary, width)],
  configuration: { solver_profile: 'fast', time_limit_ms: 60000, effort_budget: { max_search_nodes: 100000 } },
});
const sidesMm = (dimensions) => ['length', 'width', 'height'].map((side) => dimensions[side].ticks / MM);

function refusal(boundary) {
  try {
    packFallback(request(boundary, BOTTLE, 1));
  } catch (error) {
    return error;
  }
  return assert.fail('the request was accepted');
}

test('a bottom gusset admits a rod the flat length refuses, and equality fits', () => {
  // a + c = 320 > L = 300 lying flat; K = 40 makes 2L + K = 640 = 2(a + c).
  const flat = packFallback(request({ kind: 'gusseted_bag', side_gusset_depth: '10' }, ROD, 1));
  assert.equal(flat.unpacked_items[0].reason, 'no_compatible_container_dimensions');
  const block = packFallback(request({ kind: 'gusseted_bag', bottom_gusset_depth: '40' }, ROD, 1));
  assert.deepEqual(block.unpacked_items, []);
  const past = packFallback(request({ kind: 'gusseted_bag', bottom_gusset_depth: { value: String(40 * MM - 1), unit: 'ticks' } }, ROD, 1));
  assert.equal(past.unpacked_items[0].reason, 'no_compatible_container_dimensions');
});

test('a standing pouch packs in its turned frame and reports the bag as declared', () => {
  // The 300 x 150 x 100 pouch stands as a 150 x 100 x 300 frame: two bottles side by side
  // make a + b = 150 = W, a third breaks that loop and one on top 2(b + c) = 700 > 660.
  const req = request(STANDING, BOTTLE, 3);
  const result = packFallback(req);
  const [packed] = result.containers;
  assert.equal(packed.placements.length, 2);
  assert.equal(result.unpacked_items.length, 1);
  assert.deepEqual(sidesMm(packed.inner_dimensions), [300, 150, 100]);
  const [a, b, c] = sidesMm(packed.achieved_dimensions);
  assert.deepEqual([a * b, c, a + b], [5000, 150, 150]);
  assert.deepEqual(validate(req, result), []);
  assert.deepEqual(validateDocuments(req, result).issues, []);
});

test('the validator refuses a standing package past its loop, with its text', () => {
  const result = packFallback(request(STANDING, BOTTLE, 2));
  const narrower = request(STANDING, BOTTLE, 2, '149');
  const [a, b] = sidesMm(result.containers[0].achieved_dimensions);
  const issues = validateDocuments(narrower, result).issues.filter((issue) => issue.code === 'bag_girth_exceeded');
  assert.deepEqual(issues.map((issue) => issue.detail), [
    `pouch#1: b + c = ${(b + 150) * MM}, a + b = ${(a + b) * MM}, standing, length ${300 * MM}, width ${149 * MM}, bottom gusset ${60 * MM}`,
  ]);
});

test('the validator states both gussets of a flat bag it refuses', () => {
  const spec = { standing: false, inner: [300n, 150n, 100n], sideGusset: 10n, bottomGusset: 40n };
  assert.equal(girthBreach(spec, 300n, 100n, 20n), null);
  assert.equal(girthBreach(spec, 300n, 100n, 21n),
    'a + c = 321, b + c = 121, flat size 300 x 150, side gusset 10, bottom gusset 40');
});

test('the validator loops agree with the plain sums over every small package', () => {
  for (const standing of [false, true]) {
    const spec = { standing, inner: standing ? [7n, 5n, 9n] : [9n, 7n, 5n], sideGusset: 2n, bottomGusset: 3n };
    for (let a = 0n; a <= spec.inner[0]; a++) for (let b = 0n; b <= spec.inner[1]; b++) for (let c = 0n; c <= spec.inner[2]; c++) {
      const fits = standing ? 2n * (b + c) <= 21n && a + b <= 9n : 2n * (a + c) <= 21n && b + c <= 9n;
      assert.equal(girthBreach(spec, a, b, c) === null, fits, `${[a, b, c]} standing=${standing}`);
    }
  }
});

test('a fixed set in the standing frame past its loop cannot hold', () => {
  const fixed = ['0', '50'].map((y) => ({ item_type: 'bottle', container_type: 'pouch', orientation: 'LWH', position: { x: '0', y, z: '0' } }));
  assert.throws(() => packFallback({ ...request(STANDING, BOTTLE, 2, '149'), fixed_placements: fixed }), (error) => {
    assert.ok(error instanceof FixedPlacementError);
    assert.equal(error.message, 'invalid_fixed_placement: bag_girth_exceeded: pouch#1');
    return true;
  });
  const held = packFallback({ ...request(STANDING, BOTTLE, 2), fixed_placements: fixed });
  assert.deepEqual(sidesMm(held.containers[0].achieved_dimensions), [50, 100, 150]);
});

test('a weight rebalance keeps a standing pouch inside both loops', () => {
  const req = request(STANDING, BOTTLE, 3);
  const balanced = rebalanceWeight(req, packFallback(req));
  for (const container of balanced.containers) {
    const [a, b, c] = sidesMm(container.achieved_dimensions);
    assert.ok(a + b <= 150 && 2 * (b + c) <= 660, JSON.stringify(container.achieved_dimensions));
  }
});

test('a malformed gusseted bag is refused with its pointer, reason and text', () => {
  const field = '/containers/0/deformable_boundary';
  const cases = [
    [{ kind: 'gusseted_bag' }, '/side_gusset_depth', 'missing_field', 'is required'],
    [{ kind: 'gusseted_bag', bottom_gusset_depth: { value: String(600 * MM + 1), unit: 'ticks' } }, '/bottom_gusset_depth', 'invalid_value',
      'exceeds twice inner_dimensions length'],
    [{ kind: 'gusseted_bag', bottom_gusset_depth: '0' }, '/bottom_gusset_depth', 'invalid_value', 'must be positive'],
    [{ kind: 'gusseted_bag', side_gusset_depth: '151', bottom_gusset_depth: '0' }, '/side_gusset_depth', 'invalid_value',
      'exceeds inner_dimensions width'],
    [{ kind: 'gusseted_bag', side_gusset_depth: '10', orientation: 'standing' }, '/bottom_gusset_depth', 'missing_field',
      'is required when orientation is standing'],
    [{ kind: 'gusseted_bag', bottom_gusset_depth: '10', orientation: 'upright' }, '/orientation', 'not_allowed',
      'must be one of ["flat","standing"]'],
    [{ kind: 'flat_bag', orientation: 'flat' }, '/orientation', 'not_allowed', 'is not a known field'],
  ];
  for (const [boundary, pointer, reason, detail] of cases) {
    const error = refusal(boundary);
    assert.ok(error instanceof InvalidRequestError, error.message);
    assert.deepEqual([error.field, error.reason, error.detail], [field + pointer, reason, detail]);
  }
  const deepest = packFallback(request({ kind: 'gusseted_bag', bottom_gusset_depth: '600', orientation: 'flat' }, ROD, 1));
  assert.deepEqual(deepest.unpacked_items, []);
});
