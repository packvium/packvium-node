/**
 * A shop's checkout: turn a cart into parcels.
 *
 * Run it:
 *
 *     node examples/checkout.mjs
 *
 * This is the shape most projects start from. You already have product rows and cart
 * lines in your own format; the library wants a request. So there are two small functions
 * between them: `toRequest` maps your records onto the request, and `parcels` reads the
 * result back into something your checkout page can render. Everything Packvium-specific
 * lives in those two functions, and the rest of the shop never sees a tick or a placement.
 *
 * `pack` is synchronous and takes a plain object, so it drops into an Express handler, a
 * Next.js server action or a queue worker as it is. In your project the import reads
 * `from '@packvium/engine'`; here it points at the package this file ships in.
 */

import { pack } from '../index.js';

// Your product table. Sizes in centimetres and weights in grams, as a shop usually has them.
const PRODUCTS = {
  kettle: { sizeCm: [24, 22, 26], weightG: 1300, thisSideUp: true },
  mug: { sizeCm: [12, 9, 10], weightG: 350, thisSideUp: false },
  cookbook: { sizeCm: [28, 22, 3], weightG: 900, thisSideUp: false },
  'floor-lamp': { sizeCm: [150, 30, 30], weightG: 4200, thisSideUp: false },
};

// The cartons on your packing bench, with what each one costs you in cents.
const BOXES = {
  small: { innerCm: [30, 25, 15], maxKg: 5, costCents: 45 },
  medium: { innerCm: [40, 30, 30], maxKg: 12, costCents: 80 },
  large: { innerCm: [60, 40, 40], maxKg: 20, costCents: 140 },
};

const measures = ([length, width, height]) => ({
  length: String(length), width: String(width), height: String(height),
});

/** Your cart (`{ sku: quantity }`) as a Packvium request. */
function toRequest(cart) {
  return {
    units: { length: 'cm' },
    configuration: {
      // Pay as little as possible for cartons, after packing everything that fits.
      objective: 'lowest_cost',
      // Counted work decides where the search stops, so the same cart always gets the
      // same parcels. The time limit is a fuse against a hang, not a search limit.
      effort_budget: { max_candidates_evaluated: 200000 },
      time_limit_ms: 60000,
    },
    items: Object.entries(cart).map(([sku, quantity]) => ({
      id: sku,
      quantity,
      weight: `${PRODUCTS[sku].weightG} g`,
      keep_upright: PRODUCTS[sku].thisSideUp,
      dimensions: measures(PRODUCTS[sku].sizeCm),
    })),
    containers: Object.entries(BOXES).map(([id, box]) => ({
      id,
      max_payload: `${box.maxKg} kg`,
      cost_minor: box.costCents,
      inner_dimensions: measures(box.innerCm),
    })),
  };
}

/** The parcels to ship, and the SKUs that fit no carton you stock. */
function parcels(cart) {
  const result = pack(toRequest(cart));
  const shipped = result.containers.map((container) => {
    const contents = {};
    for (const placement of container.placements) {
      contents[placement.item_type] = (contents[placement.item_type] ?? 0) + 1;
    }
    return {
      box: container.container_type,
      contents,
      // `value` is the exact weight rendered in `unit`; here that is whole grams.
      weight: `${container.gross_weight.value} ${container.gross_weight.unit}`,
    };
  });
  // An item that fits nowhere is not an error. It comes back with a reason, and the rest
  // of the cart is still packed.
  const leftOut = [...new Set(result.unpacked_items.map((entry) => entry.item_type))].sort();
  return { shipped, leftOut };
}

function show(title, cart) {
  const { shipped, leftOut } = parcels(cart);
  console.log(`\n${title}`);
  let boxCost = 0;
  for (const [index, parcel] of shipped.entries()) {
    const contents = Object.keys(parcel.contents).sort()
      .map((sku) => `${parcel.contents[sku]} x ${sku}`).join(', ');
    console.log(`  parcel ${index + 1}: ${parcel.box.padEnd(6)} ${parcel.weight.padStart(7)}  ${contents}`);
    boxCost += BOXES[parcel.box].costCents;
  }
  console.log(`  cartons cost ${boxCost} cents`);
  for (const sku of leftOut) {
    console.log(`  ${sku} fits none of our cartons: ship it in its own packaging`);
  }
}

show('a small order', { mug: 2, cookbook: 1 });
show('a bigger order', { kettle: 4, mug: 6, cookbook: 4 });
show('an order with something oversized', { 'floor-lamp': 1, mug: 4 });
