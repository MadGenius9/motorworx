import { useState } from 'react';
import { BALANCE, COMPONENT_IDS, TRIM_IDS, type ComponentId, type ModelId, type TrimId } from '../../config/balance';
import {
  avgQuality,
  avgUnitCost,
  incomingUnits,
  stockOnHand,
  unlockedModels,
  vehicleLabel,
  warehouseCapacity,
} from '../../sim/selectors';
import { ActionButton, Bar, Section } from '../common';
import { componentName, componentsPerVehicle, formatDuration, formatMoney, formatTime, pct } from '../format';
import { useUi } from '../useGame';

export function SuppliersTab() {
  const { state, dispatch } = useUi();
  const [component, setComponent] = useState<ComponentId>('powertrain');
  const [qtyText, setQtyText] = useState('3');
  const [helperVariant, setHelperVariant] = useState('sedan:economy');
  const [helperModel, helperTrim] = helperVariant.split(':') as [ModelId, TrimId];
  const [helperCars, setHelperCars] = useState('3');

  const cap = warehouseCapacity(state);
  const onHand = stockOnHand(state);
  const incoming = incomingUnits(state);
  const used = onHand + incoming;
  const qty = Math.floor(Number(qtyText));
  const qtyValid = Number.isFinite(qty) && qty >= 1 && qty <= 999;
  const incomingBy = (c: ComponentId) => state.shipments.filter((s) => s.component === c).reduce((a, s) => a + s.qty, 0);

  const bump = (n: number) => setQtyText(String(Math.min(999, Math.max(1, (qtyValid ? qty : 0) + n))));
  const helperN = Math.floor(Number(helperCars));
  const perCar = componentsPerVehicle(helperModel, helperTrim, state.product.models[helperModel].finish[helperTrim], component);
  const helperQty = Number.isFinite(helperN) && helperN > 0 ? perCar * helperN : 0;

  return (
    <div className="tab">
      <Section
        title="Warehouse"
        right={
          <span className="num small">
            {used}/{cap} units
          </span>
        }
      >
        <Bar value={used} max={cap} color={used / cap > 0.9 ? 'var(--red)' : used / cap > 0.75 ? 'var(--amber)' : 'var(--accent)'} height={8} />
        <div className="muted small num">
          On hand {onHand} · incoming {incoming} · free {Math.max(0, cap - used)}
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Component</th>
              <th className="r">On hand</th>
              <th className="r">Quality</th>
              <th className="r">Avg cost</th>
              <th className="r">Value</th>
              <th className="r">Incoming</th>
            </tr>
          </thead>
          <tbody>
            {COMPONENT_IDS.map((c) => {
              const s = state.inventory[c];
              const inc = incomingBy(c);
              return (
                <tr key={c} className={c === component ? 'row-selected' : ''} onClick={() => setComponent(c)}>
                  <td>{componentName(c)}</td>
                  <td className={`r num${s.qty === 0 ? ' tone-bad' : ''}`}>{s.qty}</td>
                  <td className="r num">{s.qty > 0 ? pct(avgQuality(state, c)) : '—'}</td>
                  <td className="r num">{formatMoney(Math.round(avgUnitCost(state, c)))}</td>
                  <td className="r num">{formatMoney(Math.round(s.value))}</td>
                  <td className="r num">{inc > 0 ? `+${inc}` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>

      <Section title="Purchase">
        <div className="form-grid">
          <label htmlFor="buy-component">Component</label>
          <select id="buy-component" className="input" value={component} onChange={(e) => setComponent(e.target.value as ComponentId)}>
            {COMPONENT_IDS.map((c) => (
              <option key={c} value={c}>
                {componentName(c)} (on hand {state.inventory[c].qty})
              </option>
            ))}
          </select>
          <label htmlFor="buy-qty">Quantity</label>
          <div className="qty-row">
            <input
              id="buy-qty"
              className="input input-num"
              type="number"
              min={1}
              max={999}
              value={qtyText}
              onChange={(e) => setQtyText(e.target.value)}
            />
            <button type="button" className="btn btn-sm" onClick={() => bump(1)}>
              +1
            </button>
            <button type="button" className="btn btn-sm" onClick={() => bump(5)}>
              +5
            </button>
            <button type="button" className="btn btn-sm" onClick={() => bump(10)}>
              +10
            </button>
          </div>
          <span className="small muted">Helper</span>
          <div className="qty-row small">
            for
            <input
              className="input input-num input-xs"
              type="number"
              min={1}
              max={99}
              value={helperCars}
              aria-label="Number of cars"
              onChange={(e) => setHelperCars(e.target.value)}
            />
            <select className="input" value={helperVariant} aria-label="Model and trim" onChange={(e) => setHelperVariant(e.target.value)}>
              {unlockedModels(state).flatMap((m) =>
                TRIM_IDS.map((t) => (
                  <option key={`${m}:${t}`} value={`${m}:${t}`}>
                    {vehicleLabel(state, m, t)}
                  </option>
                )),
              )}
            </select>
            cars
            <button
              type="button"
              className="btn btn-sm"
              disabled={helperQty < 1 || helperQty > 999}
              title={helperQty < 1 ? 'Enter a number of cars' : helperQty > 999 ? 'Too many (max 999 units)' : `${perCar} per car`}
              onClick={() => setQtyText(String(helperQty))}
            >
              Use {helperQty} units
            </button>
          </div>
        </div>
        {!qtyValid && <p className="tone-bad small">Enter a quantity from 1 to 999.</p>}

        <div className="supplier-grid">
          {BALANCE.suppliers.map((sup) => {
            const unit = Math.round(BALANCE.components[component].basePrice * sup.priceMult);
            const total = qtyValid ? unit * qty : 0;
            const reason = !qtyValid
              ? 'Enter a valid quantity'
              : state.cash < total
                ? `Not enough cash (need ${formatMoney(total)})`
                : used + qty > cap
                  ? `Not enough warehouse space (${Math.max(0, cap - used)} free)`
                  : null;
            return (
              <div key={sup.id} className="card supplier">
                <div className="card-head">
                  <b>{sup.name}</b>
                </div>
                <div className="muted small">{sup.blurb}</div>
                <div className="grid2 small">
                  <span className="muted">Price / unit</span>
                  <span className="num">{formatMoney(unit)}</span>
                  <span className="muted">Lead time</span>
                  <span className="num">{formatDuration(sup.leadMinutes)}</span>
                  <span className="muted">Quality</span>
                  <span className="num">{pct(sup.quality, 1)}</span>
                  <span className="muted">Total</span>
                  <span className="num">
                    <b>{qtyValid ? formatMoney(total) : '—'}</b>
                  </span>
                  <span className="muted">ETA</span>
                  <span className="num">{formatTime(state.time + sup.leadMinutes)}</span>
                </div>
                <ActionButton
                  variant="primary"
                  showReason
                  disabledReason={reason}
                  onClick={() => dispatch({ type: 'purchase', supplierId: sup.id, component, quantity: qty })}
                >
                  Buy {qtyValid ? qty : ''}
                </ActionButton>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title={`Incoming shipments (${state.shipments.length})`}>
        {state.shipments.length === 0 ? (
          <p className="muted small">Nothing on the way.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Component</th>
                <th className="r">Qty</th>
                <th>Supplier</th>
                <th className="r">Arrives</th>
              </tr>
            </thead>
            <tbody>
              {[...state.shipments]
                .sort((a, b) => a.arrivesAt - b.arrivesAt)
                .map((s) => (
                  <tr key={s.id}>
                    <td>{componentName(s.component)}</td>
                    <td className="r num">{s.qty}</td>
                    <td className="small">{BALANCE.suppliers.find((x) => x.id === s.supplierId)?.name ?? s.supplierId}</td>
                    <td className="r num">in {formatDuration(Math.max(0, s.arrivesAt - state.time))}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
