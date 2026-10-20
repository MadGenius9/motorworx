import { useState } from 'react';
import { TRIM_IDS } from '../../config/balance';
import {
  estimatedProfitPerVehicle,
  financeSummary,
  inventoryValue,
  ledgerReconciliation,
  outstandingOrderValue,
  projectedDailyCosts,
  receivables,
} from '../../sim/selectors';
import type { ExpenseCategory, LedgerCategory } from '../../sim/types';
import { KV, Pill, Section } from '../common';
import { clockOf, dayOf, formatMoney, trimName } from '../format';
import { useUi } from '../useGame';

const OPEX_LABEL: Record<ExpenseCategory, string> = {
  payroll: 'Payroll',
  utilities: 'Utilities & energy',
  maintenance: 'Maintenance',
  repair: 'Repairs',
  rework: 'Rework',
  warranty: 'Warranty claims',
  hiring: 'Hiring fees',
  severance: 'Severance',
  penalty: 'Penalties',
};

const LEDGER_CATS: LedgerCategory[] = [
  'sales',
  'purchase',
  'payroll',
  'utilities',
  'maintenance',
  'repair',
  'rework',
  'warranty',
  'hiring',
  'severance',
  'penalty',
  'upgrade',
];

const r = (n: number) => formatMoney(Math.round(n));

export function FinancesTab() {
  const { state } = useUi();
  const [filter, setFilter] = useState<LedgerCategory | 'all'>('all');
  const [limit, setLimit] = useState(100);
  const fs = financeSummary(state);
  const inv = inventoryValue(state);
  const proj = projectedDailyCosts(state);
  const rec = ledgerReconciliation(state);
  const opex = state.finance.opex;

  const ledger = state.finance.ledger.filter((e) => filter === 'all' || e.category === filter);
  const shown = ledger.slice(-limit).reverse();
  const history = [...state.finance.history].reverse();
  const today = state.finance.today;

  return (
    <div className="tab">
      <Section title="Profit & loss (since start)">
        <KV k="Cash" v={r(state.cash)} tone={state.cash < 0 ? 'bad' : undefined} />
        <KV k="Revenue" v={r(fs.revenue)} />
        <KV k="Cost of goods sold (materials)" v={r(-fs.cogs)} />
        <KV k={<b>Gross profit</b>} v={r(fs.grossProfit)} tone={fs.grossProfit >= 0 ? 'good' : 'bad'} />
        <div className="indent">
          {(Object.keys(OPEX_LABEL) as ExpenseCategory[]).map((c) => (
            <KV key={c} k={OPEX_LABEL[c]} v={r(-(opex[c] ?? 0))} tone={opex[c] ? undefined : 'muted'} />
          ))}
        </div>
        <KV k="Operating expenses" v={r(-fs.opexTotal)} />
        <KV k={<b>Operating profit</b>} v={r(fs.operatingProfit)} tone={fs.operatingProfit >= 0 ? 'good' : 'bad'} />
        <KV k="Capital spending (upgrades)" v={r(fs.capex)} />
        <KV k="Materials purchased (to inventory)" v={r(fs.materialsPurchased)} />
      </Section>

      <Section title="Assets & receivables">
        <KV k="Raw materials" v={r(inv.raw)} />
        <KV k="Incoming (paid, in transit)" v={r(inv.incoming)} />
        <KV k="Work in progress" v={r(inv.wip)} />
        <KV k="Finished vehicles" v={r(inv.finished)} />
        <KV k={<b>Inventory total</b>} v={r(inv.total)} />
        <KV k="Receivables (delivered, unpaid)" v={r(receivables(state))} />
        <KV k="Outstanding order value" v={r(outstandingOrderValue(state))} />
      </Section>

      <Section title="Outlook" right={<Pill tone="info">Estimates</Pill>}>
        {TRIM_IDS.map((t) => {
          const p = estimatedProfitPerVehicle(state, t);
          return (
            <KV
              key={t}
              k={`Est. profit / ${trimName(t)} at ${formatMoney(state.product.price[t])}`}
              v={r(p)}
              tone={p >= 0 ? 'good' : 'bad'}
            />
          );
        })}
        <KV k="Projected payroll / day" v={r(proj.payroll)} />
        <KV k="Projected overhead / day" v={r(proj.overhead)} />
        <KV k="Projected energy / day" v={r(proj.energy)} />
        <KV k={<b>Projected daily costs</b>} v={r(proj.total)} tone={proj.total > state.cash ? 'bad' : undefined} />
      </Section>

      <Section title="Daily history">
        <table className="table">
          <thead>
            <tr>
              <th>Day</th>
              <th className="r">Revenue</th>
              <th className="r">COGS</th>
              <th className="r">Expenses</th>
              <th className="r">Built</th>
              <th className="r">Cash end</th>
            </tr>
          </thead>
          <tbody>
            <tr className="row-today">
              <td>{today.day} (today)</td>
              <td className="r num">{r(today.revenue)}</td>
              <td className="r num">{r(today.cogs)}</td>
              <td className="r num">{r(today.expenses)}</td>
              <td className="r num">{today.built}</td>
              <td className="r num muted">—</td>
            </tr>
            {history.map((d) => (
              <tr key={d.day}>
                <td>{d.day}</td>
                <td className="r num">{r(d.revenue)}</td>
                <td className="r num">{r(d.cogs)}</td>
                <td className="r num">{r(d.expenses)}</td>
                <td className="r num">{d.built}</td>
                <td className={`r num${d.cashEnd < 0 ? ' tone-bad' : ''}`}>{r(d.cashEnd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section
        title="Ledger"
        right={
          <select
            className="input input-sm"
            aria-label="Filter ledger by category"
            value={filter}
            onChange={(e) => setFilter(e.target.value as LedgerCategory | 'all')}
          >
            <option value="all">All categories</option>
            {LEDGER_CATS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        }
      >
        <div className={`recon small ${rec.ok ? 'tone-good' : 'tone-bad'}`}>
          {rec.ok ? '✓' : '✗'} Ledger reconciles: starting cash + entries = {r(rec.expected)} · cash {r(rec.actual)}
        </div>
        <table className="table ledger">
          <thead>
            <tr>
              <th>Time</th>
              <th>Category</th>
              <th>Description</th>
              <th className="r">Amount</th>
              <th className="r">Balance</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => (
              <tr key={e.id}>
                <td className="num nowrap">
                  D{dayOf(e.time)} {clockOf(e.time)}
                </td>
                <td>
                  <span className={`cat cat-${e.category}`}>{e.category}</span>
                </td>
                <td className="small">{e.description}</td>
                <td className={`r num ${e.amount >= 0 ? 'tone-good' : 'tone-bad'}`}>{r(e.amount)}</td>
                <td className="r num">{r(e.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <p className="muted small">No entries.</p>}
        {ledger.length > limit && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setLimit((l) => l + 200)}>
            Show older ({ledger.length - limit} more)
          </button>
        )}
      </Section>
    </div>
  );
}
