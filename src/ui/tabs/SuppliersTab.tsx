import { useState } from 'react';
import { BALANCE, COMPONENT_IDS, TRIM_IDS, type ComponentId, type ModelId, type TrimId } from '../../config/balance';
import {
  avgQuality,
  avgUnitCost,
  componentPriceMult,
  incomingUnits,
  kitCost,
  kitShortfall,
  stockOnHand,
  supplierOnStrike,
  supplierUnitPrice,
  unlockedModels,
  vehicleLabel,
  warehouseCapacity,
} from '../../sim/selectors';
import { ActionButton, Bar, Pill, Section } from '../common';
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
  const perCar = componentsPerVehicle(helperModel, helperTrim, state.product.models[helperModel].finish[helperTrim], component, state);
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

      <KitSection />

      <Section title="Purchase single components">
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
            const unit = supplierUnitPrice(sup.id, component, state) ?? 0;
            const spiked = componentPriceMult(state, component) > 1;
            const strike = supplierOnStrike(state, sup.id);
            const total = qtyValid ? unit * qty : 0;
            const reason = strike
              ? `On strike until ${formatTime(strike.until)}`
              : !qtyValid
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
                  {strike && <Pill tone="bad">On strike</Pill>}
                </div>
                <div className="muted small">{sup.blurb}</div>
                <div className="grid2 small">
                  <span className="muted">Price / unit</span>
                  <span className={`num${spiked ? ' tone-bad' : ''}`} title={spiked ? 'Price spike in effect' : undefined}>
                    {formatMoney(unit)}
                    {spiked ? ' ▲' : ''}
                  </span>
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

/** One click buys every missing part for N cars of a model/trim from the chosen supplier. */
function KitSection() {
  const { state, dispatch } = useUi();
  const [variant, setVariant] = useState('sedan:economy');
  const [carsText, setCarsText] = useState('3');
  const [model, trim] = variant.split(':') as [ModelId, TrimId];
  const cars = Math.floor(Number(carsText));
  const carsValid = Number.isFinite(cars) && cars >= 1 && cars <= 99;
  const kit = carsValid ? kitShortfall(state, model, trim, cars) : {};
  const units = COMPONENT_IDS.reduce((n, c) => n + (kit[c] ?? 0), 0);
  const free = warehouseCapacity(state) - stockOnHand(state) - incomingUnits(state);
  return (
    <Section title="Parts kit" right={<span className="muted small">Buys only what you don't have or haven't ordered</span>}>
      <div className="qty-row small">
        Parts for
        <input
          className="input input-num input-xs"
          type="number"
          min={1}
          max={99}
          value={carsText}
          aria-label="Cars to build"
          onChange={(e) => setCarsText(e.target.value)}
        />
        <select className="input" value={variant} aria-label="Kit model and trim" onChange={(e) => setVariant(e.target.value)}>
          {unlockedModels(state).flatMap((m) =>
            TRIM_IDS.map((t) => (
              <option key={`${m}:${t}`} value={`${m}:${t}`}>
                {vehicleLabel(state, m, t)}
              </option>
            )),
          )}
        </select>
        cars
      </div>
      {!carsValid ? (
        <p className="tone-bad small">Enter 1 to 99 cars.</p>
      ) : units === 0 ? (
        <p className="tone-good small">You already have or have ordered every part for these cars.</p>
      ) : (
        <>
          <p className="small">
            Missing:{' '}
            {COMPONENT_IDS.filter((c) => kit[c])
              .map((c) => `${kit[c]} × ${BALANCE.components[c].short}`)
              .join(', ')}{' '}
            <span className="muted">({units} units)</span>
          </p>
          <div className="btn-group kit-buttons">
            {BALANCE.suppliers.map((sup) => {
              const cost = kitCost(sup.id, kit, state);
              const strike = supplierOnStrike(state, sup.id);
              const reason = strike
                ? `${sup.name} is on strike`
                : state.cash < cost
                  ? `Not enough cash (need ${formatMoney(cost)})`
                  : units > free
                    ? `Not enough warehouse space (${Math.max(0, free)} free)`
                    : null;
              return (
                <ActionButton
                  key={sup.id}
                  small
                  variant={sup.id === 'corvan' ? 'primary' : 'default'}
                  disabledReason={reason}
                  title={`${pct(sup.quality)} quality · arrives in ${formatDuration(sup.leadMinutes)}`}
                  onClick={() => dispatch({ type: 'purchaseKit', supplierId: sup.id, model, trim, cars })}
                >
                  {sup.name.split(' ')[0]} · {formatMoney(cost)} · {formatDuration(sup.leadMinutes)}
                </ActionButton>
              );
            })}
          </div>
        </>
      )}
    </Section>
  );
}
