/** Milestone 6: scenarios and goals, random events, loans, and the workforce (wages, morale, training). */
import { describe, expect, it } from 'vitest';
import { BALANCE, SCENARIO_IDS } from '../src/config/balance';
import { applyCommand } from '../src/sim/commands';
import { runTicks, step } from '../src/sim/engine';
import { checkGoals } from '../src/sim/events';
import { createInitialState } from '../src/sim/initialState';
import { deserialize, serialize } from '../src/sim/save';
import {
  creditLimit,
  dailyPayroll,
  detectionRate,
  goalProgress,
  loanPayment,
  netWorth,
  staffFactor,
  supplierUnitPrice,
  technicianTimeMult,
  totalDebt,
  workSpeed,
} from '../src/sim/selectors';
import type { GameState, Incident } from '../src/sim/types';
import { SAVE_VERSION } from '../src/sim/types';
import fixtureV1 from './fixtures/save-v1.json';
import { checkInvariants, growthBot, ledgerSum, mustOk } from './helpers';

const MPD = BALANCE.time.minutesPerDay;

function addIncident(s: GameState, inc: Omit<Incident, 'id' | 'startedAt'>): void {
  s.incidents.push({ id: s.nextId++, startedAt: s.time, ...inc });
}

describe('scenarios', () => {
  it('each scenario sets its own starting cash, reputation and rivals', () => {
    for (const id of SCENARIO_IDS) {
      const s = createInitialState(1, id);
      const spec = BALANCE.scenarios[id];
      expect(s.goals.scenario).toBe(id);
      expect(s.cash).toBe(spec.cash);
      expect(s.reputation).toBe(spec.reputation);
      expect(checkInvariants(s)).toEqual([]);
    }
    const std = createInitialState(1, 'standard');
    const hard = createInitialState(1, 'shoestring');
    expect(hard.plants[0].stations.paint.condition).toBeLessThan(std.plants[0].stations.paint.condition);
    const crowded = createInitialState(1, 'crowded');
    expect(crowded.market.rivals[0].reputation).toBeGreaterThan(std.market.rivals[0].reputation);
  });

  it('the crowded market brings rival launches forward', () => {
    const std = createInitialState(1, 'standard');
    const crowded = createInitialState(1, 'crowded');
    runTicks(std, 3 * MPD);
    runTicks(crowded, 3 * MPD);
    const active = (s: GameState) => s.market.rivals.reduce((n, r) => n + Number(r.segments.suv.economy.active) + Number(r.segments.pickup.economy.active), 0);
    expect(active(crowded)).toBeGreaterThan(active(std));
  });
});

describe('goals and milestones', () => {
  it('awards each milestone once, with reputation, and logs it', () => {
    const s = createInitialState();
    s.stats.vehiclesBuilt = 12;
    const rep = s.reputation;
    checkGoals(s);
    expect(s.goals.completed.tenBuilt).toBe(s.time);
    expect(s.reputation).toBe(rep + BALANCE.milestones.tenBuilt.reputation);
    expect(s.events.filter((e) => e.tag === 'milestone')).toHaveLength(1);
    checkGoals(s);
    expect(s.events.filter((e) => e.tag === 'milestone')).toHaveLength(1);
  });

  it('declares victory when net worth reaches the target and keeps the game running', () => {
    const s = createInitialState();
    const target = BALANCE.scenarios.standard.goal.netWorth;
    // Pretend the company owns a lot of equipment (capex counts toward net worth).
    s.finance.capex = target;
    expect(goalProgress(s).met).toBe(true);
    runTicks(s, 60);
    expect(s.goals.wonAt).not.toBeNull();
    expect(s.events.some((e) => e.tag === 'victory')).toBe(true);
    expect(s.gameOver).toBe(false);
    runTicks(s, 60);
    expect(s.events.filter((e) => e.tag === 'victory')).toHaveLength(1);
  });

  it('the crowded market also needs open-market share', () => {
    const s = createInitialState(1, 'crowded');
    s.finance.capex = BALANCE.scenarios.crowded.goal.netWorth;
    expect(goalProgress(s).met).toBe(false);
  });

  it('a good player reaches the standard goal', () => {
    const s = createInitialState(3);
    for (let m = 0; m < 45 * MPD && s.goals.wonAt === null && !s.gameOver; m++) {
      if (s.time % 60 === 0) {
        if (s.cash < 15_000 && s.loans.length === 0) applyCommand(s, { type: 'takeLoan', offer: 0 });
        growthBot(s);
      }
      step(s);
    }
    expect(s.gameOver).toBe(false);
    expect(s.goals.wonAt).not.toBeNull();
    expect(Object.keys(s.goals.completed).length).toBeGreaterThanOrEqual(10);
    expect(checkInvariants(s)).toEqual([]);
  }, 60_000);
});

describe('random events', () => {
  it('a supplier strike blocks orders and holds its deliveries until it ends', () => {
    const s = createInitialState();
    mustOk(s, { type: 'purchase', supplierId: 'corvan', component: 'steel', quantity: 2 });
    addIncident(s, { kind: 'supplierStrike', supplierId: 'corvan', until: s.time + 2 * MPD });
    expect(applyCommand(s, { type: 'purchase', supplierId: 'corvan', component: 'steel', quantity: 1 }).ok).toBe(false);
    expect(applyCommand(s, { type: 'purchaseKit', supplierId: 'corvan', model: 'sedan', trim: 'economy', cars: 1 }).ok).toBe(false);
    const steel = s.inventory.steel.qty;
    runTicks(s, MPD);
    expect(s.inventory.steel.qty).toBe(steel);
    runTicks(s, MPD + 5);
    expect(s.inventory.steel.qty).toBe(steel + 2);
    expect(s.incidents).toHaveLength(0);
  });

  it('a price spike raises one component price', () => {
    const s = createInitialState();
    const before = supplierUnitPrice('corvan', 'powertrain', s)!;
    addIncident(s, { kind: 'priceSpike', component: 'powertrain', until: s.time + MPD });
    expect(supplierUnitPrice('corvan', 'powertrain', s)).toBe(Math.round(before * BALANCE.incidents.priceSpike.mult));
    expect(supplierUnitPrice('corvan', 'steel', s)).toBe(supplierUnitPrice('corvan', 'steel'));
    const cash = s.cash;
    mustOk(s, { type: 'purchase', supplierId: 'corvan', component: 'powertrain', quantity: 1 });
    expect(cash - s.cash).toBe(Math.round(before * BALANCE.incidents.priceSpike.mult));
  });

  it('a labour strike stops a plant', () => {
    const s = createInitialState();
    expect(staffFactor(s, 'stamping', 0)).toBeGreaterThan(0);
    addIncident(s, { kind: 'laborStrike', plant: 0, until: s.time + 60 });
    expect(staffFactor(s, 'stamping', 0)).toBe(0);
    step(s);
    expect(s.plants[0].stations.stamping.issues.some((i) => i.text.includes('strike'))).toBe(true);
    runTicks(s, 61);
    expect(staffFactor(s, 'stamping', 0)).toBeGreaterThan(0);
  });

  it('events start after the grace period, are deterministic, and keep the books balanced', () => {
    const run = () => {
      const s = createInitialState(7);
      const kinds = new Set<string>();
      for (let m = 0; m < 40 * MPD; m++) {
        if (s.time % 60 === 0) growthBot(s);
        step(s);
        for (const i of s.incidents) kinds.add(i.kind);
        if (s.time / MPD < BALANCE.incidents.graceDays) expect(s.incidents).toHaveLength(0);
      }
      return { s, kinds };
    };
    const a = run();
    const b = run();
    expect(serialize(a.s)).toBe(serialize(b.s));
    expect(a.kinds.size).toBeGreaterThanOrEqual(2);
    expect(checkInvariants(a.s)).toEqual([]);
  }, 60_000);
});

describe('loans', () => {
  it('pays out, charges interest and repays on schedule; the ledger reconciles', () => {
    const s = createInitialState();
    // Plenty of cash so payroll never makes the company insolvent (set before any ledger entry).
    s.cash = s.finance.startingCash = s.finance.today.cashEnd = 2_000_000;
    const offer = BALANCE.loans.offers[0];
    const cash = s.cash;
    const nwBefore = netWorth(s);
    mustOk(s, { type: 'takeLoan', offer: 0 });
    expect(s.cash).toBe(cash + offer.amount);
    expect(totalDebt(s)).toBe(offer.amount);
    expect(netWorth(s)).toBe(nwBefore); // borrowing doesn't change net worth
    const payment = loanPayment(offer.amount, offer.dailyRate, offer.days);
    runTicks(s, (offer.days + 1) * MPD);
    expect(s.loans).toHaveLength(0);
    const interest = -ledgerSum(s, 'interest');
    expect(interest).toBeGreaterThan(0);
    expect(interest).toBeLessThanOrEqual(payment * offer.days - offer.amount + offer.days);
    expect(ledgerSum(s, 'loan')).toBe(0); // borrowed and repaid in full
    expect(s.finance.opex.interest).toBe(interest);
    expect(checkInvariants(s)).toEqual([]);
  });

  it('respects the credit limit and loan count, and can be repaid early', () => {
    const s = createInitialState();
    const limit = creditLimit(s);
    const big = BALANCE.loans.offers.findIndex((o) => o.amount > limit);
    if (big >= 0) expect(applyCommand(s, { type: 'takeLoan', offer: big }).ok).toBe(false);
    mustOk(s, { type: 'takeLoan', offer: 0 });
    const id = s.loans[0].id;
    mustOk(s, { type: 'repayLoan', loanId: id });
    expect(s.loans).toHaveLength(0);
    expect(applyCommand(s, { type: 'repayLoan', loanId: id }).ok).toBe(false);
    expect(checkInvariants(s)).toEqual([]);
  });
});

describe('workforce', () => {
  it('wages change payroll and pull morale toward their target', () => {
    const s = createInitialState();
    const base = dailyPayroll(s);
    mustOk(s, { type: 'setWage', level: 'high' });
    expect(dailyPayroll(s)).toBe(Math.round(base * BALANCE.workforce.wages.high.payMult));
    runTicks(s, 6 * MPD);
    expect(s.workforce.morale).toBeGreaterThan(BALANCE.workforce.moraleStart + 10);
    expect(workSpeed(s, 'body')).toBeGreaterThan(1);
  });

  it('low wages can end in a strike', () => {
    const s = createInitialState(5);
    mustOk(s, { type: 'setWage', level: 'low' });
    let struck = false;
    for (let m = 0; m < 25 * MPD && !struck; m++) {
      step(s);
      struck = s.incidents.some((i) => i.kind === 'laborStrike');
    }
    expect(struck).toBe(true);
  });

  it('dismissals hurt morale', () => {
    const s = createInitialState();
    mustOk(s, { type: 'hire', role: 'operator', count: 1 });
    const m = s.workforce.morale;
    mustOk(s, { type: 'fire', role: 'operator' });
    expect(s.workforce.morale).toBe(m - BALANCE.workforce.firingMoraleHit);
  });

  it('training costs money, takes time and improves the role', () => {
    const s = createInitialState();
    mustOk(s, { type: 'hire', role: 'inspector', count: 1 });
    const det = detectionRate(s, 0);
    const speed = workSpeed(s, 'body');
    const tech = technicianTimeMult(s);
    mustOk(s, { type: 'startTraining', role: 'inspector' });
    expect(applyCommand(s, { type: 'startTraining', role: 'operator' }).ok).toBe(false); // one course at a time
    runTicks(s, BALANCE.workforce.training.minutes[0]);
    expect(s.workforce.training.inspector).toBe(1);
    expect(detectionRate(s, 0)).toBeCloseTo(det + BALANCE.workforce.training.inspectorDetectionPerLevel, 5);
    mustOk(s, { type: 'startTraining', role: 'operator' });
    runTicks(s, BALANCE.workforce.training.minutes[0]);
    expect(workSpeed(s, 'body')).toBeGreaterThan(speed);
    mustOk(s, { type: 'startTraining', role: 'technician' });
    runTicks(s, BALANCE.workforce.training.minutes[0]);
    expect(technicianTimeMult(s)).toBeLessThan(tech);
    expect(checkInvariants(s)).toEqual([]);
  });
});

describe('saves', () => {
  it('round-trips loans, events, goals and the workforce', () => {
    const s = createInitialState(4, 'crowded');
    mustOk(s, { type: 'takeLoan', offer: 0 });
    mustOk(s, { type: 'setWage', level: 'high' });
    addIncident(s, { kind: 'recession', until: s.time + MPD });
    runTicks(s, 300);
    const copy = deserialize(serialize(s));
    runTicks(s, 2 * MPD);
    runTicks(copy, 2 * MPD);
    expect(serialize(copy)).toBe(serialize(s));
  });

  it('migrates a v5 save to the standard scenario and records reached milestones quietly', () => {
    const s = createInitialState();
    s.stats.vehiclesBuilt = 20;
    const v5 = JSON.parse(serialize(s));
    for (const k of ['goals', 'incidents', 'loans', 'workforce']) delete v5[k];
    delete v5.finance.opex.interest;
    v5.version = 5;
    const loaded = deserialize(JSON.stringify(v5));
    expect(loaded.version).toBe(SAVE_VERSION);
    expect(loaded.goals.scenario).toBe('standard');
    expect(loaded.goals.completed.tenBuilt).toBeDefined();
    expect(loaded.events.some((e) => e.tag === 'milestone')).toBe(false);
    expect(loaded.workforce.morale).toBe(BALANCE.workforce.moraleStart);
    expect(checkInvariants(loaded)).toEqual([]);
  });

  it('still migrates the version 1 fixture', () => {
    const loaded = deserialize(JSON.stringify(fixtureV1));
    runTicks(loaded, 600);
    expect(checkInvariants(loaded)).toEqual([]);
  });
});
