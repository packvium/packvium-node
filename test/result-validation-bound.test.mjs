/**
 * The JavaScript port's copy of the optimality bound, held to the oracle's numbers on the
 * shared scene, and the four checks it feeds, each broken once.
 *
 * The corpus test holds the port to the reference's verdict on every pair the cover keeps; this
 * pins the formulas on every case and refusal edge of `conformance/scene/objective-bounds.json`,
 * volumes carried as decimal strings and read as `BigInt`, never through a `Number`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { lowerBound, objectiveLowerBound, smallestUnsorted } from '../result-validation/bound.js';
import { validateWith } from '../index.js';

const SCENE = new URL('../../../../conformance/scene/objective-bounds.json', import.meta.url);

const integer = (value) => BigInt(value);
const optional = (value) => (value === null ? null : BigInt(value));
const runs = (instances, field) => instances.map((instance) => [integer(instance[field]), 1n])
  .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));

function sceneInputs(scenario) {
  const containers = scenario.containers.map((container) => ({
    innerVolume: integer(container.inner),
    baseArea: integer(container.base_area),
    height: integer(container.height),
    usable: integer(container.usable),
    costMinor: integer(container.cost_minor),
    payload: optional(container.payload),
    maxItems: optional(container.max_items),
    quantity: optional(container.quantity),
  }));
  const shrinks = scenario.instances.some((instance) => instance.shrinks);
  return [runs(scenario.instances, 'volume'), runs(scenario.instances, 'weight'), shrinks, containers];
}

const sceneBound = (scenario) => lowerBound(...sceneInputs(scenario));

/** Every covered objective's vector for one scenario, `null` where a ceiling withholds it. */
function sceneObjectives(scenario) {
  const values = () => scenario.instances.map((instance) => [integer(instance.value), 1n]);
  return Object.fromEntries(Object.keys(scenario.objectives).map((objective) => {
    const { bound } = objectiveLowerBound(objective, values, ...sceneInputs(scenario));
    return [objective, bound && bound.map(Number)];
  }));
}

if (!fs.existsSync(SCENE)) {
  test('the shared scene is not part of this package', { skip: true }, () => {});
} else {
  test('the validator bound matches every case and refusal edge of the shared scene', () => {
    const scene = JSON.parse(fs.readFileSync(SCENE, 'utf8'));
    assert.equal(scene.format, 'packvium-objective-bounds/v2');
    const disagreements = [...scene.cases, ...scene.edges]
      .map((scenario) => ({ name: scenario.name || scenario.fixture, computed: sceneBound(scenario), expected: scenario.bounds }))
      .filter(({ computed, expected }) => JSON.stringify(computed && computed.map(String)) !== JSON.stringify(expected && expected.map(String)));
    assert.deepEqual(disagreements, []);
    assert.ok(scene.cases.length + scene.edges.length > 400);
  });

  test('every covered objective\'s vector matches the shared scene', () => {
    const scene = JSON.parse(fs.readFileSync(SCENE, 'utf8'));
    const covered = ['default', 'lowest_cost', 'maximum_value', 'maximum_volume', 'open_dimension_height'];
    const disagreements = [...scene.cases, ...scene.edges]
      .filter((scenario) => JSON.stringify(Object.keys(scenario.objectives).sort()) !== JSON.stringify(covered)
        || JSON.stringify(sceneObjectives(scenario)) !== JSON.stringify(scenario.objectives))
      .map((scenario) => scenario.name || scenario.fixture);
    assert.deepEqual(disagreements, []);
  });

  test('the billed objectives\' vectors match the shared scene', () => {
    const scene = JSON.parse(fs.readFileSync(SCENE, 'utf8'));
    assert.ok(scene.billed.length > 0);
    const disagreements = scene.billed.filter((scenario) => {
      const [volumes, weights, shrinks, containers] = sceneInputs(scenario);
      const billed = containers.map((container, index) => {
        const { tare, dimensional, brackets } = scenario.containers[index];
        const floor = integer(tare) > integer(dimensional) ? integer(tare) : integer(dimensional);
        return { ...container, tare: integer(tare), floor, brackets: brackets.map(([limit, charge]) => [integer(limit), optional(charge)]) };
      });
      const { bound } = objectiveLowerBound(scenario.objective, () => [], volumes, weights, shrinks, billed);
      return JSON.stringify(bound && bound.map(Number)) !== JSON.stringify(scenario.vector);
    }).map((scenario) => scenario.fixture || scenario.name);
    assert.deepEqual(disagreements, []);
  });

  test('a bound where none is stated is an optimality_bound_mismatch', async () => {
    // Every built-in objective is covered since; a made-to-measure container (D13) is
    // where no bound is stated.
    const { packFallback } = await import('../fallback.js');
    const fixture = new URL('./fixtures/feature-made-to-measure-dimensional-weight-on-outer.json', import.meta.url);
    const request = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    const packed = packFallback(request);
    packed.optimality.lower_bound = [0];
    assert.deepEqual(validateWith(null, request, packed).map(({ code, detail }) => [code, detail]), [[
      'optimality_bound_mismatch', 'lower_bound is reported where no bound is stated: a container is made to measure',
    ]]);
  });
}

test('a billed objective states the bound the validator recomputes, and one moved by one is caught', async () => {
  const { packFallback } = await import('../fallback.js');
  for (const configuration of [
    { objective: 'shipping_cost', dimensional_weight_divisor: 5000, dimensional_weight_length_unit: 'cm', dimensional_weight_weight_unit: 'kg' },
    { objective: 'lowest_landed_cost', dimensional_weight_divisor: 5000, dimensional_weight_length_unit: 'cm', dimensional_weight_weight_unit: 'kg' },
  ]) {
    const priced = { weight_brackets_g: [1, 5000], prices_minor: [900, 400], minimum_charge_minor: 450, fuel_surcharge_permille: 85 };
    const request = {
      items: [{ id: 'cube', quantity: 2, weight: '300 g', dimensions: { length: '100', width: '100', height: '100' } }],
      containers: [
        { id: 'box', tare_weight: '50 g', inner_dimensions: { length: '200', width: '100', height: '100' }, rate_table: priced },
        { id: 'bag', inner_dimensions: { length: '300', width: '100', height: '100' }, deformable_boundary: { kind: 'flat_bag' }, rate_table: priced },
        { id: 'walled', inner_dimensions: { length: '200', width: '100', height: '100' }, outer_dimensions: { length: '210', width: '110', height: '120' },
          rate_table: { weight_brackets_g: [100], prices_minor: [1] } },
      ],
      configuration,
    };
    const packed = packFallback(request);
    assert.ok(Array.isArray(packed.optimality.lower_bound), configuration.objective);
    assert.deepEqual(validateWith(null, request, packed), [], configuration.objective);
    packed.optimality.lower_bound[1] -= 1;
    assert.ok(validateWith(null, request, packed).some((found) => found.code === 'optimality_bound_mismatch'), configuration.objective);
  }
});

test('a billed key is withheld where nothing can price it or no divisor bills it', () => {
  const box = {
    innerVolume: 1000n, baseArea: 100n, height: 10n, usable: 1000n, costMinor: 0n, payload: null, maxItems: 1n, quantity: null,
    tare: 0n, floor: 10n, brackets: [[5n, 100n]],
  };
  const unpriceable = 'no priceable inventory carries a packing that attains the count bound';
  const landed = (containers, priced = true) => objectiveLowerBound('lowest_landed_cost', () => [], [[1n, 2n]], [[1n, 2n]], false, containers, priced);
  assert.deepEqual(landed([box]), { bound: null, withheld: unpriceable });
  // One item per container opens two, each paying the one charge it can reach.
  assert.deepEqual(landed([{ ...box, floor: 0n }]).bound.slice(0, 2), [0n, 200n]);
  assert.deepEqual(landed([{ ...box, floor: 0n }], false), { bound: null, withheld: unpriceable });
  // The one cheap single-item container is taken whole, then the dear one covers the other
  // item at half its charge: 10 + ceil(100 / 2).
  const capped = { ...box, floor: 0n, brackets: [[5n, 10n]], quantity: 1n };
  const unlimited = { ...box, floor: 0n, brackets: [[5n, 100n]], maxItems: null };
  assert.deepEqual(landed([capped, unlimited]).bound.slice(0, 2), [0n, 60n]);
  // Shrinking instances drop the volume terms; one opened container still bills its floor.
  const shipping = (containers) => objectiveLowerBound('shipping_cost', () => [], [[1n, 2n]], [[1n, 2n]], true, containers);
  assert.deepEqual(shipping([{ ...box, maxItems: null, quantity: 1n }]).bound.slice(0, 2), [0n, 10n]);
});

test('an unlimited capacity, a negative one and zero-volume instances are read as the reference reads them', () => {
  const container = {
    innerVolume: 1000n, baseArea: 100n, height: 10n, usable: -1n, costMinor: 3n, payload: 5n, maxItems: null, quantity: 1n,
  };
  assert.deepEqual(lowerBound([[0n, 2n]], [[1n, 2n]], false, [container]), [2n, 0n, 0n, 0n, 0n]);
  assert.deepEqual(lowerBound([[0n, 2n]], [[1n, 2n]], false, [{ ...container, quantity: null }]), [0n, 1n, 3n, 1000000n, 0n]);
  assert.deepEqual(lowerBound([[1n, 1n]], [[0n, 1n]], false, []), [1n, 0n, 0n, 0n, 0n]);
});

test('each objective-only key is withheld or zero exactly where the reference says', () => {
  const box = {
    innerVolume: 1000n, baseArea: 100n, height: 10n, usable: 1000n, costMinor: 0n, payload: null, maxItems: null, quantity: 1n,
  };
  const three = [[600n, 3n]];
  const valued = (values) => () => values;
  const vector = (objective, volumes, shrinks, containers, values = valued([[0n, 3n]])) => (
    objectiveLowerBound(objective, values, volumes, [[0n, 3n]], shrinks, containers));
  assert.deepEqual(vector('maximum_value', three, false, [box], valued([[10n, 1n], [50n, 1n], [90n, 1n]])).bound, [2n, 60n, 1n, 0n, 400000n]);
  assert.deepEqual(vector('maximum_value', three, false, [box], valued([[1n, 1n], [2n ** 53n - 1n, 2n]])),
    { bound: null, withheld: 'the maximum_value key is past the portable ceiling' });
  assert.deepEqual(vector('open_dimension_height', three, false, [box]).bound, [2n, 6n, 1n, 0n, 400000n]);
  assert.deepEqual(vector('open_dimension_height', three, false, [{ ...box, baseArea: 0n }]).bound[1], 0n);
  assert.deepEqual(vector('open_dimension_height', three, false, [{ ...box, usable: 0n }]).bound[1], 0n);
  assert.deepEqual(vector('open_dimension_height', three, true, [box]).bound[1], 0n);
  assert.deepEqual(vector('maximum_volume', three, false, [box]).bound, [444445n, 2n, 1n, 0n, 400000n]);
  assert.deepEqual(vector('maximum_volume', three, false, [{ ...box, quantity: null }]).bound[0], 0n);
  assert.deepEqual(vector('maximum_volume', [[0n, 3n]], false, [box]).bound[0], 0n);
  assert.deepEqual(vector('maximum_volume', three, true, [box]).bound[0], 0n);
  assert.deepEqual(vector('maximum_volume', [[10n ** 30n, 3n]], false, [box]),
    { bound: null, withheld: 'the request is past a declared ceiling' });
});

test('the smallest values are selected from unsorted runs exactly as a sort would take them', () => {
  const runsList = [[5n, 2n], [1n, 3n], [9n, 1n], [1n, 0n], [3n, 2n], [5n, 1n], [0n, 1n]];
  const flat = runsList.flatMap(([value, count]) => Array.from({ length: Number(count) }, () => value))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  for (let count = 0; count <= flat.length + 1; count += 1) {
    const expected = flat.slice(0, count).reduce((total, value) => total + value, 0n);
    assert.equal(smallestUnsorted(runsList, BigInt(count)), expected, `count ${count}`);
    assert.equal(smallestUnsorted(runsList.slice().reverse(), BigInt(count)), expected, `reversed, count ${count}`);
  }
});

test('maximum_value reads each item type\'s declared value from the request', () => {
  const request = {
    items: [
      { id: 'cheap', quantity: 2, value: 3, dimensions: { length: '10', width: '10', height: '10' } },
      { id: 'dear', value: 7, dimensions: { length: '10', width: '10', height: '10' } },
      { id: 'free', dimensions: { length: '10', width: '10', height: '10' } },
    ],
    containers: [{ id: 'box', quantity: 1, inner_dimensions: { length: '20', width: '10', height: '10' } }],
    configuration: { objective: 'maximum_value' },
  };
  const packed = validateWith(null, request, { ...result({ code: 'not_proven', lower_bound: [2, 3] }), score: [2, 3, 1, 0, 1000000] })
    .map((found) => found.code);
  assert.ok(!packed.includes('optimality_bound_mismatch'), packed.join());
  const forged = validateWith(null, request, { ...result({ code: 'not_proven', lower_bound: [2, 4] }), score: [2, 4, 1, 0, 1000000] })
    .map((found) => found.code);
  assert.ok(forged.includes('optimality_bound_mismatch'), forged.join());
});

/** One cube in a box for two: attains every position but the height, 1000000 against 500000. */
const REQUEST = {
  items: [{ id: 'cube', quantity: 1, dimensions: { length: '10', width: '10', height: '10' } }],
  containers: [{ id: 'box', inner_dimensions: { length: '20', width: '10', height: '10' } }],
};

const MM3 = 16000 ** 3;

function result(optimality) {
  const tick = (mm) => ({ ticks: mm * 16000, value: String(mm), unit: 'mm' });
  return {
    status: 'feasible',
    feasibility: { code: 'feasible' },
    termination: {
      code: 'complete',
      any_start_truncated: false,
      all_required_starts_completed: true,
      winning_start_truncated: false,
      global_deadline_reached: false,
      starts: [{ id: 'test', started: true, completed: true, truncated: false, selected: true, global_deadline_reached: false }],
    },
    optimality,
    complete: true,
    algorithm: {
      solver: 'test',
      time_limit_reached: false,
      effort_limit_reached: false,
      candidates_evaluated: 1,
      placements_attempted: 1,
      metrics: {
        candidate_points_considered: 1,
        orientations_considered: 1,
        feasible_candidates: 1,
        collision_checks: 0,
        support_checks: 0,
        space_partitions: 0,
        search_nodes_expanded: 0,
      },
    },
    score: [0, 1, 0, 500000, 1000000],
    summary: { container_count: 1, packed_item_count: 1, unpacked_item_count: 0 },
    containers: [{
      id: 'box#1',
      container_type: 'box',
      payload_weight: { ticks: 0 },
      used_volume_ticks3: String(1000 * MM3),
      centre_of_mass_offset_ppm: 0,
      placements: [{
        placement_id: '["box#1",0,0,0,"cube","LWH"]',
        item_id: 'cube#1',
        item_type: 'cube',
        orientation: 'LWH',
        position: { x: tick(0), y: tick(0), z: tick(0) },
        dimensions: { length: tick(10), width: tick(10), height: tick(10) },
      }],
    }],
    unpacked_items: [],
  };
}

const GAP = {
  code: 'not_proven',
  lower_bound: [0, 1, 0, 500000, 500000],
  gap_key: 4,
  absolute_gap: 500000,
  relative_gap: { numerator: 500000, denominator: 500000 },
};

const issuesOf = (optimality, change = () => {}) => {
  const broken = result(JSON.parse(JSON.stringify(optimality)));
  change(broken);
  return validateWith(null, REQUEST, broken).map((found) => found.code);
};

test('a stated bound and gap are valid, and so is their absence', () => {
  assert.deepEqual(issuesOf(GAP), []);
  assert.deepEqual(issuesOf({ code: 'not_proven' }), []);
});

test('each of the four checks fires on its own mutation', () => {
  assert.deepEqual(issuesOf(GAP, (broken) => { broken.optimality.lower_bound[1] = 2; }), ['optimality_bound_mismatch']);
  assert.deepEqual(issuesOf(GAP, (broken) => { broken.optimality.absolute_gap = 1; }), ['optimality_gap_mismatch']);
  assert.deepEqual(issuesOf(GAP, (broken) => { broken.score[3] = 0; }),
    ['score_mismatch', 'score_below_bound', 'optimality_bound_mismatch']);
  assert.deepEqual(issuesOf(GAP, (broken) => {
    broken.status = 'optimal';
    broken.optimality.code = 'proven_optimal';
  }), ['result_fact_mismatch', 'unproven_optimality_claim']);
});

for (const cheapCost of [0, 1]) {
  test(`an unrepresentable gap is withheld and rejected when forged (lower cost ${cheapCost})`, async () => {
    const { packFallback } = await import('../fallback.js');
    const request = {
      items: [{ id: 'i', quantity: 2, dimensions: { length: '10', width: '10', height: '10' } }],
      containers: [
        { id: 'cheap', inner_dimensions: { length: '1', width: '1', height: '1' }, cost_minor: cheapCost, max_items: 1 },
        { id: 'big', inner_dimensions: { length: '10', width: '10', height: '10' }, cost_minor: Number.MAX_SAFE_INTEGER, max_items: 1 },
      ],
    };
    const packed = packFallback(request);
    assert.deepEqual(packed.optimality, { code: 'not_proven' });
    assert.deepEqual(validateWith(null, request, packed), []);
    const absolute = 2 * Number.MAX_SAFE_INTEGER - 2 * cheapCost;
    packed.optimality = { code: 'not_proven', lower_bound: [0, 2, 2 * cheapCost], gap_key: 2, absolute_gap: absolute };
    if (cheapCost) packed.optimality.relative_gap = { numerator: absolute, denominator: 2 * cheapCost };
    assert.ok(validateWith(null, request, packed).some(issue => issue.code === 'optimality_gap_mismatch'));
  });
}

test('a gap at the portable ceiling is still stated', async () => {
  const { packFallback } = await import('../fallback.js');
  const request = {
    items: [{ id: 'i', dimensions: { length: '10', width: '10', height: '10' } }],
    containers: [
      { id: 'cheap', inner_dimensions: { length: '1', width: '1', height: '1' }, cost_minor: 0 },
      { id: 'big', inner_dimensions: { length: '10', width: '10', height: '10' }, cost_minor: Number.MAX_SAFE_INTEGER },
    ],
  };
  const packed = packFallback(request);
  assert.equal(packed.optimality.absolute_gap, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(validateWith(null, request, packed), []);
});
