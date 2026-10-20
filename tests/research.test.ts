/** Milestone 4: R&D lab and research tree. */
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { applyCommand } from '../src/sim/commands';
import { runTicks, step } from '../src/sim/engine';
import { createInitialState } from '../src/sim/initialState';
import { deserialize, serialize } from '../src/sim/save';
import {
  changeoverMinutes,
  cycleMinutes,
  detectionRate,
  getAlerts,
  ledgerReconciliation,
  recipeFor,
  researchStatus,
  segmentShares,
} from '../src/sim/selectors';
import type { GameState } from '../src/sim/types';
import { SAVE_VERSION } from '../src/sim/types';
import { checkInvariants, mustOk } from './helpers';

const P = BALANCE.research.projects;

function finish(s: GameState, id: string): void {
  mustOk(s, { type: 'startResearch', project: id });
  runTicks(s, P[id].minutes);
  expect(s.research.completed).toContain(id);
}

/** Richer start for research tests (set before any ledger entry, so the ledger still reconciles). */
function rich(): GameState {
  const s = createInitialState();
  s.cash = 600_000;
  s.finance.startingCash = 600_000;
  s.finance.today.cashEnd = 600_000;
  s.staff.operator = 0; // nobody on payroll — keeps cash simple during long lab runs
  for (const st of Object.values(s.stations)) st.assigned = 0;
  s.staff.inspector = 1;
  return s;
}

describe('research tree', () => {
  it('every prerequisite exists and the tree has no cycles', () => {
    const seen = new Set<string>();
    const visit = (id: string, path: string[]): void => {
      expect(P[id], `unknown project ${id}`).toBeDefined();
      expect(path).not.toContain(id);
      if (seen.has(id)) return;
      for (const r of P[id].requires) visit(r, [...path, id]);
      seen.add(id);
    };
    for (const id of Object.keys(P)) visit(id, []);
  });

  it('a project costs cash once, takes its time, and is booked as an R&D expense', () => {
    const s = rich();
    const cash = s.cash;
    mustOk(s, { type: 'startResearch', project: 'leanStamping' });
    expect(s.cash).toBe(cash - P.leanStamping.cost);
    expect(s.finance.opex.research).toBe(P.leanStamping.cost);
    expect(researchStatus(s, 'leanStamping')).toBe('active');
    runTicks(s, P.leanStamping.minutes - 1);
    expect(s.research.completed).not.toContain('leanStamping');
    step(s);
    expect(s.research.completed).toEqual(['leanStamping']);
    expect(s.research.active).toBeNull();
    expect(ledgerReconciliation(s).ok).toBe(true);
  });

  it('enforces prerequisites, one project at a time, and cash', () => {
    const s = rich();
    expect(applyCommand(s, { type: 'startResearch', project: 'quickChange' }).message).toMatch(/Lean Stamping/);
    mustOk(s, { type: 'startResearch', project: 'spc' });
    expect(applyCommand(s, { type: 'startResearch', project: 'leanStamping' }).message).toMatch(/busy/);
    const poor = createInitialState();
    poor.cash = 1000;
    expect(applyCommand(poor, { type: 'startResearch', project: 'spc' }).ok).toBe(false);
  });

  it('cancelling loses progress and refunds nothing', () => {
    const s = rich();
    mustOk(s, { type: 'startResearch', project: 'spc' });
    runTicks(s, 100);
    const cash = s.cash;
    mustOk(s, { type: 'cancelResearch' });
    expect(s.cash).toBe(cash);
    expect(s.research.active).toBeNull();
    expect(s.research.completed).toEqual([]);
    expect(applyCommand(s, { type: 'cancelResearch' }).ok).toBe(false);
  });
});

describe('research effects', () => {
  it('process research speeds stations and shortens retooling', () => {
    const s = rich();
    const before = cycleMinutes('stamping', 'sedan', 'economy', 'solid', s);
    finish(s, 'leanStamping');
    expect(cycleMinutes('stamping', 'sedan', 'economy', 'solid', s)).toBeLessThan(before);
    s.stations.body.lastModel = 'sedan';
    const co = changeoverMinutes(s, 'body', 'suv');
    finish(s, 'quickChange');
    expect(changeoverMinutes(s, 'body', 'suv')).toBe(Math.round(co * 0.5));
  });

  it('quality research raises detection', () => {
    const s = rich();
    const base = detectionRate(s);
    finish(s, 'spc');
    finish(s, 'visionInspection');
    expect(detectionRate(s)).toBeCloseTo(base + 0.12, 6);
  });

  it('product research saves steel and wins market share', () => {
    const s = rich();
    const steel = recipeFor('sedan', 'economy', 'stamping', 'solid', s).steel!;
    const share = segmentShares(s, 'sedan', 'premium').playerShare;
    finish(s, 'dealerNetwork');
    finish(s, 'lightweightPlatform');
    finish(s, 'premiumInteriors');
    expect(recipeFor('sedan', 'economy', 'stamping', 'solid', s).steel).toBe(steel - 1);
    expect(segmentShares(s, 'sedan', 'premium').playerShare).toBeGreaterThan(share);
  });

  it('a researched factory keeps all invariants while producing', () => {
    const s = rich();
    finish(s, 'leanStamping');
    finish(s, 'spc');
    s.staff.operator = 7;
    s.stations.stamping.assigned = 2;
    s.stations.body.assigned = 2;
    s.stations.paint.assigned = 1;
    s.stations.final.assigned = 2;
    for (const [c, q] of [['steel', 8], ['powertrain', 4], ['interior', 4], ['wheels', 4], ['paint', 4]] as const)
      mustOk(s, { type: 'purchase', supplierId: 'apex', component: c, quantity: q });
    mustOk(s, { type: 'scheduleBuild', model: 'sedan', trim: 'economy', quantity: 4 });
    for (let i = 0; i < 2 * 1440; i++) {
      step(s);
      expect(checkInvariants(s)).toEqual([]);
    }
    expect(s.stats.vehiclesBuilt).toBeGreaterThan(0);
  });
});

describe('alerts and saves', () => {
  it('suggests R&D only when established and comfortably affordable', () => {
    const s = rich();
    expect(getAlerts(s).some((a) => a.id === 'research-idle')).toBe(false);
    s.stats.ordersPaid = 2;
    expect(getAlerts(s).some((a) => a.id === 'research-idle')).toBe(true);
    mustOk(s, { type: 'startResearch', project: 'spc' });
    expect(getAlerts(s).some((a) => a.id === 'research-idle')).toBe(false);
  });

  it('migrates a v3 save and keeps an in-progress project across save/load', () => {
    const s = rich();
    const v3 = JSON.parse(serialize(s));
    v3.version = 3;
    delete v3.research;
    delete v3.finance.opex.research;
    const loaded = deserialize(JSON.stringify(v3));
    expect(loaded.version).toBe(SAVE_VERSION);
    expect(loaded.research).toEqual({ completed: [], active: null });
    expect(loaded.finance.opex.research).toBe(0);

    mustOk(s, { type: 'startResearch', project: 'spc' });
    runTicks(s, 300);
    const copy = deserialize(serialize(s));
    runTicks(s, 2000);
    runTicks(copy, 2000);
    expect(serialize(copy)).toBe(serialize(s));
    expect(s.research.completed).toContain('spc');
  });
});
