import { describe, expect, it } from 'vitest';
import { BALANCE, STATION_IDS } from '../src/config/balance';
import { applyCommand } from '../src/sim/commands';
import { step } from '../src/sim/engine';
import { createInitialState } from '../src/sim/initialState';
import { queueCapacity } from '../src/sim/selectors';
import type { GameState } from '../src/sim/types';
import {
  SEED,
  buildFirstOrder,
  buyShortfall,
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

function assertInvariants(s: GameState) {
  const errs = checkInvariants(s);
  if (errs.length) throw new Error(`Invariant violation at time ${s.time}:\n${errs.join('\n')}`);
}

describe('(a) complete profitable order', () => {
  it('accept → buy → staff → schedule → build → deliver → paid, with reconciled books', () => {
    const s = createInitialState(SEED);
    const startCash = s.cash;
    const id = buildFirstOrder(s);
    assertInvariants(s);
    const o0 = order(s, id);
    const qty = o0.quantity;
    expect(o0.reserved.length).toBe(qty);

    const revenueBefore = s.finance.revenue;
    const cogsBefore = s.finance.cogs;
    const r = mustOk(s, { type: 'deliverOrder', orderId: id });
    expect(r.ok).toBe(true);
    const o = order(s, id);
    expect(o.status).toBe('delivered');
    expect(o.lateDays).toBe(0);
    expect(o.invoiceAmount).toBe(qty * o.unitPrice);

    const delivered = vehicles(s).filter((v) => v.stage === 'delivered');
    expect(delivered.length).toBe(qty);
    expect(s.yard.length).toBe(0);
    const cogs = delivered.reduce((a, v) => a + v.cost, 0);
    expect(s.finance.cogs - cogsBefore).toBeCloseTo(cogs, 6);
    expect(s.finance.revenue - revenueBefore).toBe(o.invoiceAmount);
    expect(o.invoiceAmount! - cogs).toBeGreaterThan(0);
    expect(s.stats.ordersDelivered).toBe(1);

    runUntil(s, (st) => order(st, id).status === 'paid', o.paymentTermsMinutes + 5, undefined, 'payment');
    const paid = order(s, id);
    expect(paid.status).toBe('paid');
    expect(paid.paidAt).not.toBeNull();
    expect(ledgerSum(s, 'sales')).toBe(paid.invoiceAmount);
    expect(s.stats.ordersPaid).toBe(1);
    assertInvariants(s);
    // Cash moved by exactly the ledger.
    expect(s.cash).toBeCloseTo(startCash + ledgerSum(s), 6);
  });
});

describe('(b) missing materials stop the correct station', () => {
  it('no powertrain: Final Assembly reports materials naming Powertrain; upstream unaffected', () => {
    const s = createInitialState(SEED);
    healAll(s);
    staffLine(s);
    buyShortfall(s, 'economy', 1, ['powertrain']);
    expect(s.inventory.powertrain.qty).toBe(0);
    mustOk(s, { type: 'scheduleBuild', trim: 'economy', quantity: 1 });
    // Parts arrive after the Corvan lead time; vehicle needs ~225 min to reach final.
    ticks(s, 600, (st) => {
      healAll(st);
      assertInvariants(st);
    });
    const fin = s.stations.final;
    const mat = fin.issues.find((i) => i.kind === 'materials');
    expect(mat, JSON.stringify(fin.issues)).toBeDefined();
    expect(mat!.text).toMatch(/Powertrain/);
    expect(mat!.components).toEqual(['powertrain']);
    expect(fin.slots.every((sl) => sl === null)).toBe(true);
    expect(fin.queue.length).toBe(1);
    for (const id of ['stamping', 'body', 'paint', 'inspection'] as const) {
      expect(s.stations[id].issues.some((i) => i.kind === 'materials')).toBe(false);
    }
    // Nothing consumed at final and no vehicle passed it.
    expect(s.inventory.interior.qty).toBe(1);
    expect(s.inventory.wheels.qty).toBe(1);
    expect(vehicles(s).filter((v) => ['inspection', 'rework', 'finished'].includes(v.stage)).length).toBe(0);
    expect(s.stats.vehiclesBuilt).toBe(0);

    // Buying the powertrain resolves it.
    mustOk(s, { type: 'purchase', supplierId: 'apex', component: 'powertrain', quantity: 1 });
    runUntil(s, (st) => st.stats.vehiclesBuilt === 1 || st.rework.queue.length + (st.rework.slot ? 1 : 0) > 0, 600, healAll, 'build');
    expect(s.inventory.powertrain.qty).toBe(0);
  });
});

describe('(c) equipment failure', () => {
  it('broken station freezes its work, downstream continues, repair costs money and time, then resumes', () => {
    const s = createInitialState(SEED);
    healAll(s);
    staffLine(s);
    mustOk(s, { type: 'scheduleBuild', trim: 'economy', quantity: 2 });
    const activeSlot = (st: GameState, id: 'body' | 'paint') => st.stations[id].slots.find((sl) => sl && !sl.done && sl.progress > 0) ?? null;
    runUntil(s, (st) => activeSlot(st, 'body') !== null && activeSlot(st, 'paint') !== null, 400, healAll, 'body+paint active');

    const body = s.stations.body;
    body.broken = true;
    const bodySlot = activeSlot(s, 'body')!;
    const frozenVehicle = bodySlot.vehicleId;
    const frozenProgress = bodySlot.progress;
    const paintSlot = activeSlot(s, 'paint')!;
    const paintVehicle = paintSlot.vehicleId;
    const paintProgress = paintSlot.progress;

    ticks(s, 30, (st) => {
      st.stations.paint.condition = 100;
      assertInvariants(st);
    });
    expect(body.issues.some((i) => i.kind === 'broken')).toBe(true);
    const bs = body.slots.find((sl) => sl && sl.vehicleId === frozenVehicle)!;
    expect(bs).toBeTruthy();
    expect(bs.progress).toBe(frozenProgress);
    // Downstream (paint) kept working on its vehicle.
    const pv = s.vehicles[paintVehicle];
    const ps = s.stations.paint.slots.find((sl) => sl && sl.vehicleId === paintVehicle);
    expect(pv.stage !== 'paint' || (ps && ps.progress > paintProgress)).toBe(true);

    // Repair on a healthy station is refused.
    expect(applyCommand(s, { type: 'repair', station: 'paint' }).ok).toBe(false);

    const cash = s.cash;
    const repairCount = s.finance.ledger.filter((e) => e.category === 'repair').length;
    mustOk(s, { type: 'repair', station: 'body' });
    expect(s.cash).toBe(cash - BALANCE.equipment.repair.cost);
    const repairs = s.finance.ledger.filter((e) => e.category === 'repair');
    expect(repairs.length).toBe(repairCount + 1);
    expect(repairs[repairs.length - 1].amount).toBe(-BALANCE.equipment.repair.cost);
    expect(s.finance.opex.repair).toBe(BALANCE.equipment.repair.cost);
    // A second repair while one is underway is refused (and not charged).
    expect(applyCommand(s, { type: 'repair', station: 'body' }).ok).toBe(false);
    expect(s.cash).toBe(cash - BALANCE.equipment.repair.cost);

    ticks(s, BALANCE.equipment.repair.minutes - 1);
    expect(body.service).not.toBeNull();
    expect(body.slots.find((sl) => sl && sl.vehicleId === frozenVehicle)!.progress).toBe(frozenProgress);
    ticks(s, 2);
    expect(body.service).toBeNull();
    expect(body.broken).toBe(false);
    expect(body.condition).toBeGreaterThanOrEqual(BALANCE.equipment.repair.restoreCondition);
    ticks(s, 5);
    const after = body.slots.find((sl) => sl && sl.vehicleId === frozenVehicle);
    expect(!after || after.progress > frozenProgress).toBe(true);
    assertInvariants(s);
  });
});

describe('(d) rework does not duplicate vehicles', () => {
  it('defective vehicles go to rework and back to inspection, ending in the yard once', () => {
    const s = createInitialState(SEED);
    healAll(s);
    staffLine(s);
    mustOk(s, { type: 'hire', role: 'inspector', count: 2 });
    // Keep finished cars in the yard (no market sales) so we can count them.
    mustOk(s, { type: 'setMarketListed', trim: 'economy', listed: false });
    buyShortfall(s, 'economy', 3);
    mustOk(s, { type: 'scheduleBuild', trim: 'economy', quantity: 3 });

    const flagged = new Set<number>();
    const reworked = new Set<number>();
    const yardEntries = new Map<number, number>();
    let prevYard = new Set<number>();
    const watch = (st: GameState) => {
      healAll(st);
      for (const v of Object.values(st.vehicles)) {
        if (v.stage === 'inspection' && !flagged.has(v.id)) {
          v.defect = true;
          v.defectNotes = ['Test'];
          flagged.add(v.id);
        }
        if (v.stage === 'rework') reworked.add(v.id);
      }
      for (const id of st.yard) if (!prevYard.has(id)) yardEntries.set(id, (yardEntries.get(id) ?? 0) + 1);
      prevYard = new Set(st.yard);
      assertInvariants(st);
    };
    runUntil(
      s,
      (st) => st.yard.length === 3 && !st.rework.slot && st.rework.queue.length === 0,
      2 * 1440,
      watch,
      '3 vehicles finished',
    );
    const all = vehicles(s);
    expect(all.length).toBe(3);
    expect(s.stats.vehiclesStarted).toBe(3);
    expect(new Set(all.map((v) => v.id)).size).toBe(3);
    expect(new Set(all.map((v) => v.serial)).size).toBe(3);
    expect(new Set(s.yard).size).toBe(3);
    expect(s.stats.vehiclesBuilt).toBe(3);
    for (const [, n] of yardEntries) expect(n).toBe(1);

    expect(reworked.size).toBeGreaterThan(0);
    for (const id of reworked) {
      const v = s.vehicles[id];
      expect(v.stage).toBe('finished');
      expect(v.reworkCount).toBeGreaterThanOrEqual(1);
      expect(v.defect).toBe(false);
      expect(v.defectDetected).toBe(false);
    }
    const totalReworks = all.reduce((a, v) => a + v.reworkCount, 0);
    const reworkEntries = s.finance.ledger.filter((e) => e.category === 'rework');
    expect(reworkEntries.length).toBe(totalReworks);
    expect(s.stats.reworksDone).toBe(totalReworks);
    for (const e of reworkEntries) expect(e.amount).toBe(-BALANCE.quality.reworkCost);
    expect(s.finance.opex.rework).toBe(totalReworks * BALANCE.quality.reworkCost);
  });
});

describe('(e) deliveries cannot pay twice', () => {
  it('second deliver fails and the invoice is collected exactly once', () => {
    const s = createInitialState(SEED);
    const id = buildFirstOrder(s);
    const salesBefore = ledgerSum(s, 'sales');
    mustOk(s, { type: 'deliverOrder', orderId: id });
    const invoice = order(s, id).invoiceAmount!;
    const revenue = s.finance.revenue;
    const second = applyCommand(s, { type: 'deliverOrder', orderId: id });
    expect(second.ok).toBe(false);
    expect(second.message).toBeTruthy();
    expect(s.finance.revenue).toBe(revenue);

    ticks(s, 2 * 1440, (st) => {
      if (st.time % 60 === 0) expect(applyCommand(st, { type: 'deliverOrder', orderId: id }).ok).toBe(false);
    });
    expect(order(s, id).status).toBe('paid');
    expect(ledgerSum(s, 'sales') - salesBefore).toBe(invoice);
    expect(s.finance.ledger.filter((e) => e.category === 'sales').length).toBe(1);
    expect(s.finance.revenue).toBe(revenue);
    expect(s.stats.ordersPaid).toBe(1);
    expect(applyCommand(s, { type: 'deliverOrder', orderId: id }).ok).toBe(false);
    expect(checkInvariants(s)).toEqual([]);
  });
});

describe('(j) full downstream queue blocks upstream', () => {
  it('paint unstaffed: paint queue fills, body holds its done vehicle with a downstream issue', () => {
    const s = createInitialState(SEED);
    healAll(s);
    expect(s.stations.paint.assigned).toBe(0);
    mustOk(s, { type: 'scheduleBuild', trim: 'economy', quantity: 3 });
    ticks(s, 500, (st) => {
      healAll(st);
      assertInvariants(st);
    });
    const paint = s.stations.paint;
    const body = s.stations.body;
    expect(paint.queue.length).toBe(queueCapacity(s, 'paint'));
    expect(paint.issues.some((i) => i.kind === 'staff')).toBe(true);
    const doneSlot = body.slots.find((sl) => sl && sl.done);
    expect(doneSlot, JSON.stringify(body.slots)).toBeTruthy();
    expect(paint.queue).not.toContain(doneSlot!.vehicleId);
    expect(s.vehicles[doneSlot!.vehicleId].stage).toBe('body');
    const ds = body.issues.find((i) => i.kind === 'downstream');
    expect(ds).toBeDefined();
    expect(ds!.text).toMatch(/Paint/);
    const progressFrozen = paint.queue.length;

    // Staffing paint releases the jam; vehicles flow, still no duplicates.
    mustOk(s, { type: 'hire', role: 'operator', count: 1 });
    mustOk(s, { type: 'assignOperator', station: 'paint', delta: 1 });
    runUntil(s, (st) => !st.stations.body.slots.some((sl) => sl && sl.done), 200, (st) => {
      healAll(st);
      assertInvariants(st);
    });
    expect(progressFrozen).toBe(2);
    expect(s.stations.body.issues.some((i) => i.kind === 'downstream')).toBe(false);
  });
});

describe('(k) insolvency', () => {
  it('negative cash beyond the grace period ends the game; step is then a no-op', () => {
    const s = createInitialState(SEED);
    s.cash = -5000; // forced for the test (bypasses the ledger)
    step(s);
    expect(s.insolventSince).toBe(s.time);
    const since = s.insolventSince!;
    ticks(s, BALANCE.finance.insolvencyGraceMinutes - 1);
    expect(s.time - since).toBe(BALANCE.finance.insolvencyGraceMinutes - 1);
    expect(s.gameOver).toBe(false);
    step(s);
    expect(s.gameOver).toBe(true);
    expect(s.gameOverReason).toBeTruthy();
    const snap = JSON.stringify(s);
    ticks(s, 200);
    expect(JSON.stringify(s)).toBe(snap);
  });

  it('recovering above zero clears the insolvency timer', () => {
    const s = createInitialState(SEED);
    s.cash = -100;
    ticks(s, 10);
    expect(s.insolventSince).not.toBeNull();
    s.cash = 50_000;
    step(s);
    expect(s.insolventSince).toBeNull();
    expect(s.gameOver).toBe(false);
  });
});

describe('initial state', () => {
  it('matches the balance sheet and has one offer', () => {
    const s = createInitialState(SEED);
    expect(s.cash).toBe(BALANCE.start.cash);
    expect(s.time).toBe(BALANCE.time.startMinute);
    expect(s.orders.filter((o) => o.status === 'offered').length).toBe(1);
    expect(s.orders[0].quantity).toBe(BALANCE.start.firstOrder.quantity);
    for (const id of STATION_IDS) expect(s.stations[id].condition).toBe(BALANCE.start.stationCondition[id]);
    expect(checkInvariants(s)).toEqual([]);
    expect(JSON.stringify(createInitialState(SEED))).toBe(JSON.stringify(s));
  });
});
