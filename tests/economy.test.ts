import { beforeAll, describe, expect, it } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { applyCommand } from '../src/sim/commands';
import { step } from '../src/sim/engine';
import { createInitialState } from '../src/sim/initialState';
import { inventoryValue, receivables } from '../src/sim/selectors';
import type { ExpenseCategory, GameState, LedgerCategory } from '../src/sim/types';
import { SEED, checkInvariants, competentBot, ledgerSum, staffLine } from './helpers';

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
    applyCommand(s, { type: 'setMarketListed', model: 'sedan', trim: 'economy', listed: true });
    for (let t = 0; t < 10 * 1440; t++) {
      if (t % 30 === 0) competentBot(s);
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
