import { describe, expect, it } from 'vitest';
import { BALANCE, COMPONENT_IDS, STATION_IDS } from '../src/config/balance';
import { applyCommand } from '../src/sim/commands';
import { runTicks, step } from '../src/sim/engine';
import { createInitialState } from '../src/sim/initialState';
import { deserialize, serialize } from '../src/sim/save';
import {
  estimateUnitCost,
  financeSummary,
  getAlerts,
  ledgerReconciliation,
  orderProgress,
  stockOnHand,
  incomingUnits,
  warehouseCapacity,
  tutorialSteps,
} from '../src/sim/selectors';
import type { Command } from '../src/sim/commandTypes';
import type { GameState } from '../src/sim/types';

function must(state: GameState, cmd: Command) {
  const r = applyCommand(state, cmd);
  if (!r.ok) throw new Error(`${cmd.type} failed: ${r.message}`);
  return r;
}

/** Every vehicle id is in exactly one place, consistent with its stage. */
function checkInvariants(state: GameState) {
  const where = new Map<number, string>();
  const put = (id: number, loc: string) => {
    if (where.has(id)) throw new Error(`vehicle ${id} in ${where.get(id)} and ${loc} at t=${state.time}`);
    where.set(id, loc);
  };
  for (const sid of STATION_IDS) {
    const st = state.stations[sid];
    st.queue.forEach((id) => put(id, `${sid}.queue`));
    st.slots.forEach((s) => s && put(s.vehicleId, `${sid}.slot`));
    for (const id of [...st.queue, ...st.slots.filter(Boolean).map((s) => s!.vehicleId)]) {
      expect(state.vehicles[id].stage).toBe(sid);
    }
  }
  state.rework.queue.forEach((id) => put(id, 'rework.queue'));
  if (state.rework.slot) put(state.rework.slot.vehicleId, 'rework.slot');
  state.yard.forEach((id) => {
    put(id, 'yard');
    expect(state.vehicles[id].stage).toBe('finished');
  });
  for (const v of Object.values(state.vehicles)) {
    if (v.stage === 'delivered' || v.stage === 'sold') {
      expect(where.has(v.id)).toBe(false);
    } else {
      expect(where.has(v.id)).toBe(true);
    }
  }
  for (const c of COMPONENT_IDS) expect(state.inventory[c].qty).toBeGreaterThanOrEqual(0);
  expect(stockOnHand(state) + incomingUnits(state)).toBeLessThanOrEqual(warehouseCapacity(state));
  expect(ledgerReconciliation(state).ok).toBe(true);
}

describe('sim smoke', () => {
  it('plays the first order end to end', () => {
    const s = createInitialState();
    expect(tutorialSteps(s).every((t) => !t.done)).toBe(true);
    must(s, { type: 'acceptOrder', orderId: s.orders[0].id });
    for (const c of COMPONENT_IDS) must(s, { type: 'purchase', supplierId: 'corvan', component: c, quantity: 4 });
    must(s, { type: 'hire', role: 'operator', count: 3 });
    must(s, { type: 'assignOperator', station: 'paint', delta: 1 });
    must(s, { type: 'assignOperator', station: 'final', delta: 1 });
    must(s, { type: 'assignOperator', station: 'final', delta: 1 });
    must(s, { type: 'scheduleForOrder', orderId: s.orders[0].id });
    expect(applyCommand(s, { type: 'scheduleForOrder', orderId: s.orders[0].id }).ok).toBe(false);
    const cashBefore = s.cash;
    const order = s.orders[0];
    let guard = 0;
    while (!orderProgress(s, order).ready && guard++ < 3 * 1440) {
      step(s);
      if (s.time % 30 === 0) checkInvariants(s);
      // keep paint healthy so the test is about flow, not luck
      if (s.stations.paint.broken && !s.stations.paint.service) must(s, { type: 'repair', station: 'paint' });
    }
    expect(orderProgress(s, order).ready).toBe(true);
    expect(s.time).toBeLessThanOrEqual(order.deadline);
    must(s, { type: 'deliverOrder', orderId: order.id });
    expect(applyCommand(s, { type: 'deliverOrder', orderId: order.id }).ok).toBe(false);
    runTicks(s, order.paymentTermsMinutes + 1);
    expect(order.status).toBe('paid');
    const fs = financeSummary(s);
    expect(fs.grossProfit).toBeGreaterThan(15000);
    expect(ledgerReconciliation(s).ok).toBe(true);
    checkInvariants(s);
    expect(tutorialSteps(s).every((t) => t.done)).toBe(true);
    // received payment at least once
    expect(s.finance.ledger.some((e) => e.category === 'sales' && e.amount === order.invoiceAmount)).toBe(true);
    expect(s.cash).toBeGreaterThan(cashBefore - 60000);
  });

  it('is deterministic regardless of batching and survives save/load', () => {
    const a = createInitialState(42);
    const b = createInitialState(42);
    runTicks(a, 3000);
    for (let i = 0; i < 30; i++) runTicks(b, 100);
    expect(serialize(a)).toBe(serialize(b));
    const c = deserialize(serialize(a));
    runTicks(a, 500);
    runTicks(c, 500);
    expect(serialize(a)).toBe(serialize(c));
    expect(() => deserialize('{"version":999}')).toThrow(/incompatible/);
    expect(() => deserialize('nope')).toThrow(/JSON/);
  });

  it('alert actions are valid commands', () => {
    const s = createInitialState();
    for (let i = 0; i < 2000; i++) {
      step(s);
      if (i % 97 === 0) {
        for (const a of getAlerts(s)) {
          expect(a.actions.length).toBeGreaterThan(0);
          for (const act of a.actions) {
            if (act.action.kind === 'command') {
              const clone = deserialize(serialize(s));
              const r = applyCommand(clone, act.action.command);
              expect(r.ok, `${a.id}: ${r.message}`).toBe(true);
            }
          }
        }
      }
    }
  });
});

/** A diligent bot: buys parts, schedules builds for orders and market, maintains equipment. */
function botTick(s: GameState) {
  if (s.time % 30 !== 0) return;
  for (const o of s.orders) {
    if (o.status === 'offered') applyCommand(s, { type: 'acceptOrder', orderId: o.id });
  }
  for (const o of s.orders) {
    if (o.status !== 'accepted') continue;
    if (o.reserved.length >= o.quantity) applyCommand(s, { type: 'deliverOrder', orderId: o.id });
    else if (orderProgress(s, o).shortfall > 0) applyCommand(s, { type: 'scheduleForOrder', orderId: o.id });
  }
  const queued = s.plan.reduce((n, j) => n + j.quantity - j.started, 0);
  if (queued < 2 && s.yard.length < 6) applyCommand(s, { type: 'scheduleBuild', trim: 'economy', quantity: 2 });
  for (const c of COMPONENT_IDS) {
    const have = s.inventory[c].qty + s.shipments.filter((x) => x.component === c).reduce((n, x) => n + x.qty, 0);
    const target = c === 'steel' ? 12 : 6;
    if (have <= target / 3) applyCommand(s, { type: 'purchase', supplierId: 'corvan', component: c, quantity: target - have });
  }
  for (const id of STATION_IDS) {
    const st = s.stations[id];
    if (st.broken) applyCommand(s, { type: 'repair', station: id });
    else if (st.condition < 45) applyCommand(s, { type: 'scheduleMaintenance', station: id });
  }
}

describe('balance sanity', () => {
  it('a diligent bot is clearly profitable over 10 days', () => {
    const s = createInitialState();
    must(s, { type: 'hire', role: 'operator', count: 3 });
    must(s, { type: 'assignOperator', station: 'paint', delta: 1 });
    must(s, { type: 'assignOperator', station: 'final', delta: 1 });
    must(s, { type: 'assignOperator', station: 'final', delta: 1 });
    for (let i = 0; i < 10 * 1440; i++) {
      botTick(s);
      step(s);
      if (i % 240 === 0) checkInvariants(s);
    }
    const fs = financeSummary(s);
    // eslint-disable-next-line no-console
    console.log('bot', {
      cash: s.cash,
      ...fs,
      built: s.stats.vehiclesBuilt,
      delivered: s.stats.ordersDelivered,
      late: s.stats.ordersLate,
      cancelled: s.stats.ordersCancelled,
      market: s.stats.marketSold,
      breakdowns: s.stats.breakdowns,
      rep: s.reputation,
      est: estimateUnitCost(s, 'economy'),
      events: Object.keys(s.vehicles).length,
    });
    expect(s.gameOver).toBe(false);
    expect(fs.operatingProfit).toBeGreaterThan(50000);
    expect(s.cash).toBeGreaterThan(BALANCE.start.cash);
    checkInvariants(s);
  });

  it('a neglectful player can go broke', () => {
    const s = createInitialState();
    // accepts everything, hires too many people, never builds
    must(s, { type: 'hire', role: 'operator', count: 10 });
    must(s, { type: 'hire', role: 'inspector', count: 3 });
    let days = 0;
    for (let i = 0; i < 40 * 1440 && !s.gameOver; i++) {
      if (s.time % 60 === 0) for (const o of s.orders) if (o.status === 'offered') applyCommand(s, { type: 'acceptOrder', orderId: o.id });
      step(s);
      days = i / 1440;
    }
    // eslint-disable-next-line no-console
    console.log('neglect', { days: days.toFixed(1), cash: s.cash, reason: s.gameOverReason, rep: s.reputation });
    expect(s.gameOver).toBe(true);
    expect(ledgerReconciliation(s).ok).toBe(true);
  });
});
