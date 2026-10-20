/**
 * Money and event-log helpers. EVERY cash change in the simulation goes through `postCash`.
 */
import { BALANCE } from '../config/balance';
import type { EventLogEntry, ExpenseCategory, GameState, LedgerCategory } from './types';

const EXPENSE_CATEGORIES: ReadonlySet<LedgerCategory> = new Set<LedgerCategory>([
  'payroll',
  'utilities',
  'maintenance',
  'repair',
  'rework',
  'warranty',
  'hiring',
  'severance',
  'penalty',
  'research',
]);

export function isExpenseCategory(c: LedgerCategory): c is ExpenseCategory {
  return EXPENSE_CATEGORIES.has(c);
}

/**
 * Apply a signed cash movement (+ inflow, − outflow), append a ledger entry and update finance totals.
 * Ledger trimming keeps `startingCash + ledgerCarriedForward + Σ ledger.amount === cash`.
 */
export function postCash(state: GameState, category: LedgerCategory, description: string, amount: number): void {
  const amt = Math.round(amount);
  if (amt === 0) return;
  const f = state.finance;
  state.cash += amt;
  f.ledger.push({
    id: state.nextId++,
    time: state.time,
    category,
    description,
    amount: amt,
    balance: state.cash,
  });
  if (isExpenseCategory(category)) {
    f.opex[category] += -amt;
    f.today.expenses += -amt;
  } else if (category === 'upgrade') {
    f.capex += -amt;
  } else if (category === 'purchase') {
    f.materialsPurchased += -amt;
  }
  const max = BALANCE.finance.ledgerMaxEntries;
  if (f.ledger.length > max) {
    const removed = f.ledger.splice(0, f.ledger.length - max);
    for (const e of removed) f.ledgerCarriedForward += e.amount;
  }
}

/** Append an event-log entry (newest last); keeps at most BALANCE.events.maxLogEntries. */
export function logEvent(state: GameState, kind: EventLogEntry['kind'], text: string): void {
  state.events.push({ id: state.nextId++, time: state.time, kind, text });
  const max = BALANCE.events.maxLogEntries;
  if (state.events.length > max) state.events.splice(0, state.events.length - max);
}

export function addReputation(state: GameState, delta: number): void {
  const { min, max } = BALANCE.reputation;
  state.reputation = Math.max(min, Math.min(max, state.reputation + delta));
}
