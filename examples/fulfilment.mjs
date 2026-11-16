/**
 * From a paid order to labelled parcels: eligibility, packing, a second opinion, a price.
 *
 * Run it:
 *
 *     node examples/fulfilment.mjs
 *
 * checkout.mjs maps a cart onto a request and reads the parcels back. A warehouse needs
 * more around that call, and this example wires the pieces in the order a fulfilment job
 * runs them:
 *
 * 1. `commerce.evaluatePolicy` decides which carrier service the order may use at all.
 * 2. `pack` packs it, under the rules the goods come with.
 * 3. `validate` checks the plan against the request with code that shares nothing with
 *    the solver, so a parcel is never labelled on the solver's word alone.
 * 4. `commerce.quote` prices every parcel from the tariff version you pinned.
 *
 * Two kinds of trouble are kept apart on purpose. A request that is wrong (a quantity of
 * zero from a bad import) throws `InvalidRequestError`, and the job puts the order on
 * hold. An item that fits no carton is not an error: the rest of the order ships and the
 * item is handed to freight.
 */

import { InvalidRequestError, commerce, pack, validate } from '../index.js';

// Results carry exact integers: 16 000 length ticks to the millimetre, 8 000 000 weight
// ticks to the gram. A carrier bills whole millimetres and grams, rounded up.
const TICKS_PER_MM = 16000;
const TICKS_PER_GRAM = 8000000;

// What you publish: one tariff per carrier service, and the rules that say what may ship
// how. You would load this from your own storage; a version's number is its position in
// the list, so `tariff_version: 1` below always means the same prices.
const COMMERCE = {
  tariffs: [
    {
      carrier_id: 'postway',
      service_id: 'air',
      versions: [{
        effective_at: 0,
        dimensional_weight_divisor: 5000,
        cost_per_dimensional_kg_minor: { domestic: 520, eu: 890 },
        minimum_charge_minor: 950,
        fuel_surcharge_permille: 140,
        accessorials: [],
      }],
    },
    {
      carrier_id: 'postway',
      service_id: 'ground',
      versions: [{
        effective_at: 0,
        dimensional_weight_divisor: 6000,
        cost_per_dimensional_kg_minor: { domestic: 210, eu: 380 },
        minimum_charge_minor: 590,
        fuel_surcharge_permille: 90,
        accessorials: [],
      }],
    },
  ],
  policy_rules: [{
    rule_id: 'lithium-stays-on-the-ground',
    versions: [{
      scope: 'service',
      action: 'reject',
      priority: 10,
      effective_at: 0,
      reason: 'lithium batteries do not fly with this carrier',
      predicates: [
        { scope: 'service', field: 'service', operator: 'equals', value: 'air' },
        { scope: 'service', field: 'battery', operator: 'equals', value: 'lithium' },
      ],
    }],
  }],
  catalogs: [],
};

const PRODUCTS = {
  laptop: { mm: [360, 250, 30], g: 2100, battery: 'lithium' },
  monitor: { mm: [680, 430, 140], g: 5400, keep_upright: true, stackable: false },
  bleach: { mm: [90, 90, 280], g: 1100, keep_upright: true, tags: ['chemical'], incompatible_tags: ['food'] },
  coffee: { mm: [120, 80, 220], g: 1000, tags: ['food'] },
  desk: { mm: [1600, 800, 60], g: 28000 },
};

const BOXES = [
  { id: 'S', mm: [300, 200, 300], tareG: 180, maxKg: 8, costMinor: 50 },
  { id: 'M', mm: [400, 300, 300], tareG: 260, maxKg: 15, costMinor: 85 },
  { id: 'L', mm: [700, 450, 450], tareG: 520, maxKg: 25, costMinor: 160 },
];

const measures = ([length, width, height]) => ({
  length: String(length), width: String(width), height: String(height),
});

/** The service the customer chose, or ground when a rule forbids it, and why. */
function allowedService(order) {
  for (const sku of Object.keys(order.lines)) {
    const { decision } = commerce.evaluatePolicy(COMMERCE, {
      scope: 'service',
      context: { service: order.service, battery: PRODUCTS[sku].battery ?? 'none' },
      as_of: 0,
    });
    if (!decision.allowed) {
      return { service: 'ground', why: `${sku}: ${decision.citation.reason}` };
    }
  }
  return { service: order.service, why: null };
}

function packingRequest(order) {
  const items = Object.entries(order.lines).map(([sku, quantity]) => {
    const product = PRODUCTS[sku];
    const item = { id: sku, quantity, weight: `${product.g} g`, dimensions: measures(product.mm) };
    // Only the rules a product actually has are sent; an absent field means "no rule".
    for (const rule of ['keep_upright', 'stackable', 'tags', 'incompatible_tags']) {
      if (rule in product) item[rule] = product[rule];
    }
    return item;
  });
  return {
    units: { length: 'mm' },
    configuration: {
      objective: 'lowest_cost',
      // Nothing may hang in the air: three quarters of every base must rest on something.
      minimum_support_ratio: 0.75,
      effort_budget: { max_candidates_evaluated: 200000 },
      time_limit_ms: 60000,
    },
    items,
    containers: BOXES.map((box) => ({
      id: box.id,
      inner_dimensions: measures(box.mm),
      cost_minor: box.costMinor,
      tare_weight: `${box.tareG} g`,
      max_payload: `${box.maxKg} kg`,
    })),
  };
}

/**
 * One parcel through the pinned tariff. Whole grams and millimetres, rounded up. The answer
 * is either a quote or a rejection with a code: a zone the tariff does not price is never
 * a zero.
 */
function price(container, service, zone) {
  const grams = Math.ceil(container.gross_weight.ticks / TICKS_PER_GRAM);
  let volume = 1;
  for (const edge of ['length', 'width', 'height']) {
    volume *= Math.ceil(container.outer_dimensions[edge].ticks / TICKS_PER_MM);
  }
  return commerce.quote(COMMERCE, {
    carrier_id: 'postway', service_id: service, tariff_version: 1,
    zone, actual_weight_g: grams, volume_mm3: volume,
  });
}

/** An order that cannot ship as it is stops here, with the reason for whoever picks it up. */
const hold = (why) => console.log(`  on hold: ${why}`);

function fulfil(order) {
  console.log(`\norder ${order.id} to zone ${order.zone}, customer chose ${order.service}`);
  const { service, why } = allowedService(order);
  if (why) console.log(`  moved to ${service}: ${why}`);

  const request = packingRequest(order);
  let result;
  try {
    result = pack(request);
  } catch (error) {
    if (!(error instanceof InvalidRequestError)) throw error;
    // `field` is a JSON Pointer into the request, `reason` one of a closed set.
    return hold(`${error.reason} at ${error.field} (${error.detail})`);
  }

  const issues = validate(request, result);
  const found = issues.map((issue) => `${issue.code}: ${issue.detail}`).join('; ');
  if (found) return hold(`the plan failed its check: ${found}`);
  console.log(`  plan checked: ${result.containers.length} parcel(s), no issues`);

  const answers = result.containers.map((container) => price(container, service, order.zone));
  const refused = answers.find((answer) => answer.status !== 'ok');
  if (refused) return hold(`no ${service} price for zone ${order.zone} (${refused.error.code})`);

  let total = 0;
  for (const [index, container] of result.containers.entries()) {
    const contents = {};
    for (const placement of container.placements) {
      contents[placement.item_type] = (contents[placement.item_type] ?? 0) + 1;
    }
    const listing = Object.keys(contents).sort().map((sku) => `${contents[sku]} x ${sku}`).join(', ');
    const quoted = answers[index].quote;
    total += quoted.total_minor;
    console.log(`  ${container.id.padEnd(4)} ${listing}`);
    console.log(`       ${quoted.actual_weight_g} g on the scale, billed as `
      + `${quoted.billed_weight_g} g, ${quoted.total_minor} minor units`);
  }
  console.log(`  shipping by ${service}: ${total} minor units`);

  for (const entry of result.unpacked_items) {
    console.log(`  ${entry.item_id} goes to freight: ${entry.reason}`);
  }
}

fulfil({ id: 'A-1001', zone: 'domestic', service: 'air', lines: { coffee: 6, bleach: 2 } });
fulfil({ id: 'A-1002', zone: 'eu', service: 'air', lines: { laptop: 1, monitor: 1, desk: 1 } });
fulfil({ id: 'A-1003', zone: 'domestic', service: 'ground', lines: { coffee: 0 } });
fulfil({ id: 'A-1004', zone: 'overseas', service: 'ground', lines: { coffee: 1 } });
