/**
 * Milestone 2: vehicle models (sedan, SUV, pickup), tooling unlocks, changeovers and save migration.
 */
import { describe, expect, it } from 'vitest';
import { BALANCE, MODEL_IDS } from '../src/config/balance';
import { applyCommand } from '../src/sim/commands';
import { allocateReservations, runTicks } from '../src/sim/engine';
import { createInitialState } from '../src/sim/initialState';
import { deserialize, serialize } from '../src/sim/save';
import { cycleMinutes, getAlerts, ledgerReconciliation, orderProgress } from '../src/sim/selectors';
import type { GameState, ModelId, SalesOrder, TrimId } from '../src/sim/types';
import { SAVE_VERSION } from '../src/sim/types';
import fixtureV1 from './fixtures/save-v1.json';
import {
  autoRepair,
  checkInvariants,
  healAll,
  ledgerSum,
  mustOk,
  order,
  runUntil,
  staffLine,
  ticks,
  vehicles,
} from './helpers';

/** Adds a dealer offer for a specific model (test setup only; no cash moves). */
function injectOffer(s: GameState, model: ModelId, trim: TrimId, quantity: number, unitPrice: number): SalesOrder {
  const o: SalesOrder = {
    ...structuredClone(s.orders[0]),
    id: s.nextId++,
    dealer: 'Test Dealer',
    model,
    trim,
    quantity,
    unitPrice,
    createdAt: s.time,
    offerExpiresAt: s.time + 600,
    deadline: s.time + 4 * 1440,
    paymentTermsLabel: 'Cash on delivery',
    paymentTermsMinutes: 0,
    cancelFee: 1000,
    status: 'offered',
    priority: 0,
    reserved: [],
    acceptedAt: null,
    deliveredAt: null,
    paymentDueAt: null,
    invoiceAmount: null,
    paidAt: null,
    lateDays: 0,
    lateWarned: false,
  };
  s.orders.push(o);
  return o;
}

/** A fresh game with more starting cash (set before any ledger entry, so the ledger still reconciles). */
function richStart(seed?: number): GameState {
  const s = createInitialState(seed);
  s.cash = 400_000;
  s.finance.startingCash = 400_000;
  s.finance.today.cashEnd = 400_000;
  return s;
}

/** Buy (from Apex, fast) the combined components for a list of builds, net of stock and shipments. */
function buyFor(s: GameState, builds: [ModelId, TrimId, number][]): void {
  const need: Record<string, number> = {};
  for (const [m, t, q] of builds) {
    const finish = s.product.models[m].finish[t];
    for (const [st, parts] of Object.entries(BALANCE.models[m].trims[t].recipe)) {
      for (const [c, n] of Object.entries(parts ?? {})) {
        const mult = st === 'paint' ? BALANCE.finishes[finish].paintMult : 1;
        need[c] = (need[c] ?? 0) + (n ?? 0) * mult * q;
      }
    }
  }
  for (const [c, n] of Object.entries(need)) {
    const comp = c as keyof GameState['inventory'];
    const have = s.inventory[comp].qty + s.shipments.filter((x) => x.component === comp).reduce((a, x) => a + x.qty, 0);
    if (n > have) mustOk(s, { type: 'purchase', supplierId: 'apex', component: comp, quantity: n - have });
  }
}

function unlockSuv(s: GameState): void {
  s.reputation = Math.max(s.reputation, BALANCE.models.suv.minReputation);
  mustOk(s, { type: 'unlockModel', model: 'suv' });
}

describe('model catalogue', () => {
  it('starts with only the sedan in production', () => {
    const s = createInitialState();
    expect(MODEL_IDS.filter((m) => s.product.models[m].unlocked)).toEqual(['sedan']);
    expect(s.orders[0].model).toBe('sedan');
    // No day-1 trap: the starting reputation is below every tooling requirement.
    for (const m of ['suv', 'pickup'] as const) {
      expect(applyCommand(s, { type: 'unlockModel', model: m }).ok).toBe(false);
    }
  });

  it('every model × trim has a positive margin at its reference value', () => {
    for (const m of MODEL_IDS) {
      for (const t of ['economy', 'premium'] as const) {
        const spec = BALANCE.models[m].trims[t];
        let materials = 0;
        for (const parts of Object.values(spec.recipe)) {
          for (const [c, n] of Object.entries(parts ?? {})) {
            materials += BALANCE.components[c as keyof typeof BALANCE.components].basePrice * (n ?? 0) * 2; // ×2 covers metallic paint
          }
        }
        expect(spec.baseValue, `${m}/${t}`).toBeGreaterThan(materials * 0.6);
      }
    }
  });

  it('SUV and pickup take longer per station than the sedan', () => {
    for (const id of ['stamping', 'body', 'final'] as const) {
      const sedan = cycleMinutes(id, 'sedan', 'economy', 'solid');
      expect(cycleMinutes(id, 'suv', 'economy', 'solid')).toBeGreaterThan(sedan);
      expect(cycleMinutes(id, 'pickup', 'economy', 'solid')).toBeGreaterThan(sedan);
    }
  });
});

describe('unlocking a model', () => {
  it('needs reputation and cash, charges tooling as capital spending once', () => {
    const s = createInitialState();
    s.reputation = 40;
    const low = applyCommand(s, { type: 'unlockModel', model: 'suv' });
    expect(low.ok).toBe(false);
    expect(low.message).toMatch(/reputation/i);

    s.reputation = 60;
    const cash = s.cash;
    const capex = s.finance.capex;
    mustOk(s, { type: 'unlockModel', model: 'suv' });
    expect(s.product.models.suv.unlocked).toBe(true);
    expect(s.cash).toBe(cash - BALANCE.models.suv.unlockCost);
    expect(s.finance.capex - capex).toBe(BALANCE.models.suv.unlockCost);
    expect(applyCommand(s, { type: 'unlockModel', model: 'suv' }).ok).toBe(false);

    // Pickup costs more than the remaining cash.
    const poor = applyCommand(s, { type: 'unlockModel', model: 'pickup' });
    expect(poor.ok).toBe(false);
    expect(poor.message).toMatch(/cash/i);
    expect(ledgerReconciliation(s).ok).toBe(true);
  });

  it('locked models cannot be scheduled', () => {
    const s = createInitialState();
    const r = applyCommand(s, { type: 'scheduleBuild', model: 'pickup', trim: 'economy', quantity: 1 });
    expect(r.ok).toBe(false);
    expect(s.plan).toHaveLength(0);
  });

  it('dealers start ordering an unlocked model', () => {
    const s = createInitialState(77);
    unlockSuv(s);
    const seen = new Set<ModelId>();
    for (let i = 0; i < 6 * 1440 && seen.size < 2; i++) {
      runTicks(s, 1);
      for (const o of s.orders) if (o.status === 'offered') seen.add(o.model);
      // Decline offers so new ones keep coming.
      for (const o of s.orders) if (o.status === 'offered') applyCommand(s, { type: 'declineOrder', orderId: o.id });
    }
    expect(seen.has('suv')).toBe(true);
    expect(seen.has('pickup')).toBe(false);
  });
});

describe('changeover between models', () => {
  it('adds retooling time only when a station switches model', () => {
    const s = richStart();
    healAll(s);
    unlockSuv(s);
    staffLine(s);
    buyFor(s, [
      ['sedan', 'economy', 2],
      ['suv', 'economy', 1],
    ]);
    mustOk(s, { type: 'scheduleBuild', model: 'sedan', trim: 'economy', quantity: 2 });
    mustOk(s, { type: 'scheduleBuild', model: 'suv', trim: 'economy', quantity: 1 });
    // Steel arrives after the Corvan lead time; record each stamping job as it starts.
    const starts: { model: ModelId; changeover: number; required: number }[] = [];
    let lastVehicle = -1;
    runUntil(
      s,
      () => starts.length >= 3,
      2 * 1440,
      (st) => {
        const slot = st.plants[0].stations.stamping.slots[0];
        if (slot && slot.vehicleId !== lastVehicle) {
          lastVehicle = slot.vehicleId;
          const v = st.vehicles[String(slot.vehicleId)];
          starts.push({ model: v.model, changeover: slot.changeover, required: slot.required });
        }
        healAll(st);
      },
      'three stamping starts',
    );
    expect(starts.map((x) => x.model)).toEqual(['sedan', 'sedan', 'suv']);
    expect(starts[0].changeover).toBe(0); // first job ever: no previous model
    expect(starts[1].changeover).toBe(0); // same model back to back
    expect(starts[2].changeover).toBe(BALANCE.changeover.minutes.stamping);
    expect(starts[2].required).toBe(cycleMinutes('stamping', 'suv', 'economy', 'solid') + BALANCE.changeover.minutes.stamping);
    expect(s.plants[0].stations.stamping.lastModel).toBe('suv');
  });
});

describe('orders and market respect the model', () => {
  it('reserves only matching model + trim, and an SUV order is profitable end to end', () => {
    const s = richStart();
    healAll(s);
    unlockSuv(s);
    staffLine(s);
    mustOk(s, { type: 'setMarketListed', model: 'sedan', trim: 'economy', listed: false });
    mustOk(s, { type: 'setMarketListed', model: 'suv', trim: 'economy', listed: false });
    const price = BALANCE.models.suv.trims.economy.baseValue;
    const o = injectOffer(s, 'suv', 'economy', 2, price);
    mustOk(s, { type: 'acceptOrder', orderId: o.id });
    // A sedan built first must not be reserved to the SUV order.
    buyFor(s, [
      ['sedan', 'economy', 1],
      ['suv', 'economy', 2],
    ]);
    mustOk(s, { type: 'scheduleBuild', model: 'sedan', trim: 'economy', quantity: 1 });
    mustOk(s, { type: 'scheduleForOrder', orderId: o.id });
    // Order jobs jump ahead of stock builds; move the sedan back to the front so it finishes first.
    expect(s.plan.map((j) => j.model)).toEqual(['suv', 'sedan']);
    mustOk(s, { type: 'moveJob', jobId: s.plan[1].id, dir: -1 });
    expect(s.plan.map((j) => j.model)).toEqual(['sedan', 'suv']);
    const cash0 = s.cash;
    const sales0 = ledgerSum(s, 'sales');
    runUntil(s, (st) => orderProgress(st, order(st, o.id)).ready, 4 * 1440, (st) => {
      autoRepair(st);
      expect(checkInvariants(st)).toEqual([]);
    }, 'SUV order ready');
    const reserved = order(s, o.id).reserved.map((id) => s.vehicles[String(id)]);
    expect(reserved.every((v) => v.model === 'suv' && v.trim === 'economy')).toBe(true);
    const sedanInYard = s.yard.map((id) => s.vehicles[String(id)]).find((v) => v.model === 'sedan');
    expect(sedanInYard?.orderId ?? null).toBeNull();

    const cogs0 = s.finance.cogs;
    mustOk(s, { type: 'deliverOrder', orderId: o.id });
    expect(order(s, o.id).status).toBe('paid');
    expect(ledgerSum(s, 'sales') - sales0).toBe(2 * price);
    const cogs = s.finance.cogs - cogs0;
    expect(2 * price - cogs).toBeGreaterThan(0);
    expect(s.cash).toBeGreaterThan(cash0);
    expect(ledgerReconciliation(s).ok).toBe(true);
  });

  it('a sedan order cannot be filled by an SUV', () => {
    const s = createInitialState();
    unlockSuv(s);
    const o = s.orders[0]; // sedan economy x3
    mustOk(s, { type: 'acceptOrder', orderId: o.id });
    // Hand-place a finished SUV economy in the yard.
    const id = s.nextId++;
    s.vehicles[String(id)] = {
      ...structuredClone(Object.values(s.vehicles)[0] ?? ({} as never)),
      id,
      plant: 0,
      serial: 'MX-TEST',
      model: 'suv',
      trim: 'economy',
      finish: 'solid',
      color: '#000',
      stage: 'finished',
      cost: 1000,
      defect: false,
      defectNotes: [],
      defectDetected: false,
      reworkCount: 0,
      orderId: null,
      plannedForOrderId: null,
      startedAt: s.time,
      finishedAt: s.time,
      closedAt: null,
      salePrice: null,
    };
    s.yard.push(id);
    allocateReservations(s);
    expect(order(s, o.id).reserved).toEqual([]);
  });

  it('sells unreserved SUVs on the market at the SUV price', () => {
    const s = richStart(5);
    healAll(s);
    unlockSuv(s);
    staffLine(s);
    mustOk(s, { type: 'setMarketListed', model: 'sedan', trim: 'economy', listed: false });
    buyFor(s, [['suv', 'economy', 2]]);
    mustOk(s, { type: 'scheduleBuild', model: 'suv', trim: 'economy', quantity: 2 });
    const price = s.product.models.suv.price.economy;
    runUntil(s, (st) => st.stats.marketSold >= 1, 6 * 1440, (st) => {
      autoRepair(st);
      healAll(st);
    }, 'an SUV market sale');
    const sale = s.finance.ledger.find((e) => e.category === 'sales' && e.description.startsWith('Market sale'));
    expect(sale?.amount).toBe(price);
    expect(sale?.description).toContain(s.product.models.suv.name);
  });
});

describe('save migration', () => {
  it('loads a version 1 save mid-production as a sedan-only game and keeps running', () => {
    const json = JSON.stringify(fixtureV1);
    const raw = JSON.parse(json);
    expect(raw.version).toBe(1);
    const s = deserialize(json);
    expect(s.version).toBe(SAVE_VERSION);
    expect(s.product.models.sedan.unlocked).toBe(true);
    expect(s.product.models.sedan.name).toBe(raw.product.name);
    expect(s.product.models.sedan.price).toEqual(raw.product.price);
    expect(s.product.models.suv.unlocked).toBe(false);
    expect(vehicles(s).every((v) => v.model === 'sedan')).toBe(true);
    expect(s.orders.every((o) => o.model === 'sedan')).toBe(true);
    expect(checkInvariants(s)).toEqual([]);
    const before = vehicles(s).length;
    ticks(s, 1500, (st) => {
      autoRepair(st);
      expect(checkInvariants(st)).toEqual([]);
    });
    expect(vehicles(s).length).toBeGreaterThanOrEqual(before);
    // Round-trips at the new version.
    expect(serialize(deserialize(serialize(s)))).toBe(serialize(s));
  });

  it('rejects saves from an unknown future version', () => {
    const s = createInitialState();
    const bad = JSON.stringify({ ...JSON.parse(serialize(s)), version: SAVE_VERSION + 1 });
    expect(() => deserialize(bad)).toThrow(/incompatible/i);
  });
});

describe('alerts', () => {
  it('suggests new tooling only after the first paid order, when affordable', () => {
    const s = createInitialState();
    expect(getAlerts(s).some((a) => a.id.startsWith('unlock-'))).toBe(false);
    s.stats.ordersPaid = 1;
    s.reputation = 60;
    expect(getAlerts(s).some((a) => a.id === 'unlock-suv')).toBe(false); // $120k is not enough headroom for $90k tooling
    s.cash = 140_000;
    const alert = getAlerts(s).find((a) => a.id === 'unlock-suv');
    expect(alert?.actions[0].action).toEqual({ kind: 'openTab', tab: 'vehicles' });
    expect(getAlerts(s).some((a) => a.id === 'unlock-pickup')).toBe(false); // pickup needs reputation 55 and more cash
  });
});
