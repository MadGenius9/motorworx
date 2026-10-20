/** Milestone 5: multiple plants sharing cash, warehouse, yard, plan and technicians. */
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { applyCommand } from '../src/sim/commands';
import { runTicks, step } from '../src/sim/engine';
import { createInitialState } from '../src/sim/initialState';
import { deserialize, serialize } from '../src/sim/save';
import { detectionRate, getAlerts, ledgerReconciliation, projectedDailyCosts, stationOf } from '../src/sim/selectors';
import type { GameState } from '../src/sim/types';
import { SAVE_VERSION } from '../src/sim/types';
import fixtureV1 from './fixtures/save-v1.json';
import { checkInvariants, healAll, mustOk, toV4Shape } from './helpers';

const site = BALANCE.plants.sites[1];

/** A wealthy, reputable company (set before any ledger entry so the ledger still reconciles). */
function established(seed?: number): GameState {
  const s = createInitialState(seed);
  s.cash = 900_000;
  s.finance.startingCash = 900_000;
  s.finance.today.cashEnd = 900_000;
  s.reputation = 80;
  return s;
}

function buildSecondPlant(s: GameState): void {
  mustOk(s, { type: 'buildPlant' });
  runTicks(s, BALANCE.plants.constructionMinutes);
  expect(s.plants[1].constructionRemaining).toBe(0);
}

function staffPlant(s: GameState, plant: number): void {
  const need = { stamping: 2, body: 2, paint: 1, final: 2 } as const;
  const total = Object.values(need).reduce((a, b) => a + b, 0);
  mustOk(s, { type: 'hire', role: 'operator', count: total });
  for (const [st, n] of Object.entries(need)) for (let i = 0; i < n; i++) mustOk(s, { type: 'assignOperator', station: st as never, delta: 1, plant });
}

function stock(s: GameState, n: number): void {
  for (const [c, q] of [['steel', 2 * n], ['powertrain', n], ['interior', n], ['wheels', n], ['paint', n]] as const) {
    mustOk(s, { type: 'purchase', supplierId: 'apex', component: c, quantity: q });
  }
}

describe('building a plant', () => {
  it('needs reputation and cash, costs capital once, and takes construction time', () => {
    const s = createInitialState();
    expect(applyCommand(s, { type: 'buildPlant' }).message).toMatch(/reputation/i);
    const e = established();
    const capex = e.finance.capex;
    mustOk(e, { type: 'buildPlant' });
    expect(e.plants).toHaveLength(2);
    expect(e.finance.capex - capex).toBe(site.cost);
    expect(applyCommand(e, { type: 'buildPlant' }).message).toMatch(/construction/i);
    runTicks(e, BALANCE.plants.constructionMinutes - 1);
    expect(e.plants[1].constructionRemaining).toBe(1);
    step(e);
    expect(e.plants[1].constructionRemaining).toBe(0);
    expect(ledgerReconciliation(e).ok).toBe(true);
  });

  it('a plant under construction does no work even with staff and a plan', () => {
    const s = established();
    mustOk(s, { type: 'buildPlant' });
    staffPlant(s, 1);
    stock(s, 4);
    mustOk(s, { type: 'scheduleBuild', model: 'sedan', trim: 'economy', quantity: 4 });
    for (let i = 0; i < 600; i++) {
      step(s);
      expect(checkInvariants(s)).toEqual([]);
    }
    expect(Object.values(s.vehicles).every((v) => v.plant === 0)).toBe(true);
  });

  it('adds a site overhead only once it operates', () => {
    const s = established();
    const before = projectedDailyCosts(s).overhead;
    mustOk(s, { type: 'buildPlant' });
    expect(projectedDailyCosts(s).overhead).toBe(before);
    runTicks(s, BALANCE.plants.constructionMinutes);
    expect(projectedDailyCosts(s).overhead).toBe(before * 2);
  });
});

describe('two plants producing', () => {
  it('both plants pull from the shared plan into the shared yard, with no vehicle in two places', () => {
    const s = established(4);
    buildSecondPlant(s);
    healAll(s);
    mustOk(s, { type: 'hire', role: 'operator', count: 3 });
    for (const st of ['paint', 'final', 'final'] as const) mustOk(s, { type: 'assignOperator', station: st, delta: 1 });
    staffPlant(s, 1);
    mustOk(s, { type: 'hire', role: 'inspector', count: 1 });
    expect(stationOf(s, 'inspection', 1).assigned).toBe(1); // auto-assigned to the plant without inspectors
    for (const k of ['economy'] as const) mustOk(s, { type: 'setMarketListed', model: 'sedan', trim: k, listed: false });
    stock(s, 8);
    mustOk(s, { type: 'scheduleBuild', model: 'sedan', trim: 'economy', quantity: 8 });
    for (let i = 0; i < 1.5 * 1440; i++) {
      step(s);
      healAll(s);
      expect(checkInvariants(s)).toEqual([]);
    }
    const built = Object.values(s.vehicles);
    expect(built.some((v) => v.plant === 0)).toBe(true);
    expect(built.some((v) => v.plant === 1)).toBe(true);
    expect(s.yard.length).toBeGreaterThanOrEqual(6);
  });

  it('allowed models steer jobs to the right plant', () => {
    const s = established();
    mustOk(s, { type: 'unlockModel', model: 'suv' });
    buildSecondPlant(s);
    mustOk(s, { type: 'setPlantModel', plant: 0, model: 'suv', allowed: false });
    mustOk(s, { type: 'setPlantModel', plant: 1, model: 'sedan', allowed: false });
    mustOk(s, { type: 'setPlantModel', plant: 1, model: 'pickup', allowed: false });
    expect(applyCommand(s, { type: 'setPlantModel', plant: 1, model: 'suv', allowed: false }).ok).toBe(false); // keep ≥1
    staffPlant(s, 1);
    mustOk(s, { type: 'hire', role: 'operator', count: 3 });
    for (const st of ['paint', 'final', 'final'] as const) mustOk(s, { type: 'assignOperator', station: st, delta: 1 });
    stock(s, 6);
    for (const [c, q] of [['steel', 6], ['interior', 4], ['paint', 4]] as const) mustOk(s, { type: 'purchase', supplierId: 'apex', component: c, quantity: q });
    mustOk(s, { type: 'scheduleBuild', model: 'suv', trim: 'economy', quantity: 2 });
    mustOk(s, { type: 'scheduleBuild', model: 'sedan', trim: 'economy', quantity: 2 });
    runTicks(s, 600);
    for (const v of Object.values(s.vehicles)) expect(v.plant).toBe(v.model === 'suv' ? 1 : 0);
    // Dedicated plants never retool.
    expect(s.events.some((e) => e.text.includes('retooling'))).toBe(false);
  });

  it('warns when no plant may build a planned model, with a working fix', () => {
    const s = established();
    mustOk(s, { type: 'unlockModel', model: 'suv' });
    mustOk(s, { type: 'setPlantModel', plant: 0, model: 'suv', allowed: false });
    mustOk(s, { type: 'scheduleBuild', model: 'suv', trim: 'economy', quantity: 1 });
    const alert = getAlerts(s).find((a) => a.id === 'plan-blocked-suv');
    expect(alert).toBeDefined();
    const act = alert!.actions[0].action;
    if (act.kind === 'command') mustOk(s, act.command);
    expect(s.plants[0].allowedModels).toContain('suv');
  });

  it('inspectors are per plant; detection follows each plant', () => {
    const s = established();
    buildSecondPlant(s);
    expect(detectionRate(s, 1)).toBe(0);
    mustOk(s, { type: 'hire', role: 'inspector', count: 2 });
    expect(stationOf(s, 'inspection', 1).assigned).toBeGreaterThan(0);
    expect(detectionRate(s, 1)).toBeGreaterThan(0);
    // Moving an inspector between plants.
    mustOk(s, { type: 'assignOperator', station: 'inspection', delta: -1, plant: 1 });
    mustOk(s, { type: 'assignOperator', station: 'inspection', delta: 1, plant: 0 });
    expect(checkInvariants(s)).toEqual([]);
  });

  it('per-plant commands reject unknown plants', () => {
    const s = createInitialState();
    expect(applyCommand(s, { type: 'repair', station: 'paint', plant: 3 }).ok).toBe(false);
    expect(applyCommand(s, { type: 'assignOperator', station: 'paint', delta: 1, plant: -1 }).ok).toBe(false);
  });
});

describe('saves', () => {
  it('round-trips two plants mid-production', () => {
    const s = established(2);
    buildSecondPlant(s);
    staffPlant(s, 1);
    stock(s, 4);
    mustOk(s, { type: 'scheduleBuild', model: 'sedan', trim: 'economy', quantity: 4 });
    runTicks(s, 300);
    const copy = deserialize(serialize(s));
    runTicks(s, 900);
    runTicks(copy, 900);
    expect(serialize(copy)).toBe(serialize(s));
  });

  it('migrates a v4 save: the old factory becomes plant 0 with all inspectors', () => {
    const s = createInitialState();
    mustOk(s, { type: 'hire', role: 'inspector', count: 1 });
    runTicks(s, 200);
    const v4 = toV4Shape(JSON.parse(serialize(s)));
    v4.stations.inspection.assigned = 0; // v4 inspection took every inspector implicitly
    const loaded = deserialize(JSON.stringify(v4));
    expect(loaded.version).toBe(SAVE_VERSION);
    expect(loaded.plants).toHaveLength(1);
    expect(loaded.plants[0].stations.inspection.assigned).toBe(2);
    expect(checkInvariants(loaded)).toEqual([]);
  });

  it('migrates the version 1 fixture all the way', () => {
    const loaded = deserialize(JSON.stringify(fixtureV1));
    expect(loaded.plants[0].name).toBe(BALANCE.plants.sites[0].name);
    runTicks(loaded, 600);
    expect(checkInvariants(loaded)).toEqual([]);
  });
});
