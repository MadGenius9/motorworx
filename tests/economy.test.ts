import { beforeAll, describe, expect, it } from 'vitest';
import { BALANCE, COMPONENT_IDS, STATION_IDS } from '../src/config/balance';
import type { ComponentId } from '../src/config/balance';
import { applyCommand } from '../src/sim/commands';
import { step } from '../src/sim/engine';
import { createInitialState } from '../src/sim/initialState';
import { inventoryValue, orderProgress, receivables } from '../src/sim/selectors';
import type { ExpenseCategory, GameState, LedgerCategory } from '../src/sim/types';
import { SEED, checkInvariants, componentsFor, incoming, ledgerSum, staffLine } from './helpers';

const EXPENSES: ExpenseCategory[] = [
  'payroll',
  'utilities',
  'maintenance',
  'repair',
  'rework',
  'warranty',
  'hiring',
  'severance',
  'penalty',
];

/** A reasonable automated player: take orders, build them, keep parts stocked, fix machines. */
function botAct(s: GameState): void {
  for (const id of STATION_IDS) {
    const st = s.stations[id];
    if (st.broken && !st.service) applyCommand(s, { type: 'repair', station: id });
    else if (!st.broken && !st.service && st.condition < 45 && s.cash > 15_000)
      applyCommand(s, { type: 'scheduleMaintenance', station: id });
  }

  const accepted = s.orders.filter((o) => o.status === 'accepted');
  for (const o of accepted) {
    const p = orderProgress(s, o);
    if (p.ready) applyCommand(s, { type: 'deliverOrder', orderId: o.id });
    else if (p.shortfall > 0) applyCommand(s, { type: 'scheduleForOrder', orderId: o.id });
  }
  const open = s.orders.filter((o) => o.status === 'accepted').length;
  for (const o of s.orders.filter((x) => x.status === 'offered')) {
    if (open >= 2) break;
    if (o.deadline - s.time > 12 * 60 + o.quantity * 150) {
      if (applyCommand(s, { type: 'acceptOrder', orderId: o.id }).ok) break;
    }
  }

  // Keep a little stock for the market when there is nothing else to do.
  const unreserved = s.yard.filter((v) => s.vehicles[v].orderId === null).length;
  if (s.plan.length === 0 && unreserved < 2 && s.yard.length < 6)
    applyCommand(s, { type: 'scheduleBuild', trim: 'economy', quantity: 2 });

  // Purchasing: cover planned work plus vehicles in progress plus a small buffer.
  const need: Record<ComponentId, number> = { steel: 0, powertrain: 0, interior: 0, wheels: 0, paint: 0 };
  const add = (n: Record<ComponentId, number>) => COMPONENT_IDS.forEach((c) => (need[c] += n[c]));
  for (const j of s.plan) add(componentsFor(s, j.trim, j.quantity - j.started));
  for (const v of Object.values(s.vehicles)) {
    if (v.stage === 'stamping' || v.stage === 'body') add(componentsFor(s, v.trim, 1, ['paint', 'final']));
    else if (v.stage === 'paint') add(componentsFor(s, v.trim, 1, ['paint', 'final']));
    else if (v.stage === 'final') add(componentsFor(s, v.trim, 1, ['final']));
  }
  add(componentsFor(s, 'economy', 2));
  if (s.cash > 20_000) {
    for (const c of COMPONENT_IDS) {
      const short = need[c] - s.inventory[c].qty - incoming(s, c);
      if (short > 0) applyCommand(s, { type: 'purchase', supplierId: 'corvan', component: c, quantity: short });
    }
  }
}

function netAssets(s: GameState): number {
  return s.cash + inventoryValue(s).total + receivables(s);
}

describe('long automated run (balance bot)', () => {
  const s = createInitialState(SEED);
  let startAssets = 0;
  const violations: string[] = [];

  beforeAll(() => {
    startAssets = netAssets(s);
    staffLine(s);
    applyCommand(s, { type: 'setMarketListed', trim: 'economy', listed: true });
    for (let t = 0; t < 10 * 1440; t++) {
      if (t % 30 === 0) botAct(s);
      step(s);
      if (t % 60 === 0 && violations.length < 5) violations.push(...checkInvariants(s));
    }
  });

  it('keeps invariants throughout', () => {
    expect(violations).toEqual([]);
    expect(checkInvariants(s)).toEqual([]);
    expect(s.gameOver).toBe(false);
  });

  it('(l) ends with more cash + inventory (+ receivables) than it started (profitable)', () => {
    const end = netAssets(s);
    // Context for balance tuning when this fails.
    const ctx = JSON.stringify({ startAssets, end, cash: s.cash, stats: s.stats, finance: { ...s.finance, ledger: undefined, history: undefined } });
    expect(s.stats.ordersDelivered + s.stats.marketSold, ctx).toBeGreaterThan(5);
    expect(end, ctx).toBeGreaterThan(startAssets);
  });

  it('(i) expenses and payments reconcile with the cash ledger', () => {
    const f = s.finance;
    expect(f.startingCash + f.ledgerCarriedForward + ledgerSum(s)).toBeCloseTo(s.cash, 4);
    // Every ledger entry's running balance is consistent.
    let bal = f.startingCash + f.ledgerCarriedForward;
    for (const e of f.ledger) {
      bal += e.amount;
      expect(e.balance).toBeCloseTo(bal, 4);
    }
    if (f.ledgerCarriedForward === 0) {
      const byCat = (c: LedgerCategory) => ledgerSum(s, c);
      for (const c of EXPENSES) expect(f.opex[c], `opex.${c}`).toBeCloseTo(-byCat(c), 4);
      const opexTotal = EXPENSES.reduce((a, c) => a + f.opex[c], 0);
      const negExpenses = f.ledger
        .filter((e) => (EXPENSES as string[]).includes(e.category))
        .reduce((a, e) => a + e.amount, 0);
      expect(opexTotal).toBeCloseTo(-negExpenses, 4);
      expect(f.capex).toBeCloseTo(-byCat('upgrade'), 4);
      expect(f.materialsPurchased).toBeCloseTo(-byCat('purchase'), 4);
      // Cash received = revenue recognised − receivables still outstanding.
      expect(byCat('sales')).toBeCloseTo(f.revenue - receivables(s), 4);
      // Payroll: one entry per midnight passed.
      const midnights = Math.floor(s.time / 1440) - Math.floor(BALANCE.time.startMinute / 1440);
      expect(f.ledger.filter((e) => e.category === 'payroll').length).toBe(midnights);
    }
    // Each order is paid at most once and paid orders match sales entries.
    const paidOrders = s.orders.filter((o) => o.status === 'paid');
    expect(s.stats.ordersPaid).toBe(paidOrders.length);
    for (const o of paidOrders) expect(o.invoiceAmount).not.toBeNull();
    // Daily history sums.
    for (const d of f.history) expect(Number.isFinite(d.cashEnd)).toBe(true);
  });
});
