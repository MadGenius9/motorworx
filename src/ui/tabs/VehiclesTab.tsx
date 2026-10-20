import { BALANCE, COMPONENT_IDS, FINISH_IDS, STATION_IDS, TRIM_IDS, type FinishId, type TrimId } from '../../config/balance';
import {
  actualTrimResults,
  cycleMinutes,
  estimateUnitCost,
  estimatedProfitPerVehicle,
  marketDemandPerDay,
  vehiclesInStage,
} from '../../sim/selectors';
import type { VehicleStage } from '../../sim/types';
import { CommitInput, KV, Pill, Section, Swatch } from '../common';
import { formatDuration, formatMoney, num, stationName, trimName } from '../format';
import { useUi } from '../useGame';

function TrimCard({ trim }: { trim: TrimId }) {
  const { state, dispatch, notify } = useUi();
  const finish = state.product.finish[trim];
  const price = state.product.price[trim];
  const listed = state.product.marketListed[trim];
  const t = BALANCE.trims[trim];
  const est = estimateUnitCost(state, trim);
  const estMargin = estimatedProfitPerVehicle(state, trim);
  const actual = actualTrimResults(state, trim);
  const appeal = t.appeal + BALANCE.finishes[finish].appealAdd;
  const refValue = t.baseValue + BALANCE.finishes[finish].valueAdd;

  return (
    <div className="card">
      <div className="card-head">
        <b>{trimName(trim)}</b>
        <span className="muted small">Reference value {formatMoney(refValue)}</span>
      </div>
      <div className="form-grid">
        <label htmlFor={`finish-${trim}`}>Finish</label>
        <select
          id={`finish-${trim}`}
          className="input"
          value={finish}
          onChange={(e) => dispatch({ type: 'setFinish', trim, finish: e.target.value as FinishId })}
        >
          {FINISH_IDS.map((f) => (
            <option key={f} value={f}>
              {BALANCE.finishes[f].name}
              {BALANCE.finishes[f].appealAdd ? ` (+${BALANCE.finishes[f].appealAdd} appeal, ×${BALANCE.finishes[f].paintMult} paint)` : ''}
            </option>
          ))}
        </select>
        <label>Market price</label>
        <CommitInput
          type="number"
          min={0}
          step={100}
          ariaLabel={`${trimName(trim)} price`}
          value={String(price)}
          onCommit={(v) => {
            const n = Math.round(Number(v));
            if (!Number.isFinite(n) || n <= 0) {
              notify('Enter a valid price', false);
              return;
            }
            dispatch({ type: 'setPrice', trim, price: n });
          }}
        />
        <label htmlFor={`listed-${trim}`}>Sell on open market</label>
        <label className="toggle">
          <input
            id={`listed-${trim}`}
            type="checkbox"
            checked={listed}
            onChange={(e) => dispatch({ type: 'setMarketListed', trim, listed: e.target.checked })}
          />
          <span>{listed ? 'Listed — unreserved yard cars are sold' : 'Not listed'}</span>
        </label>
      </div>
      <div className="grid2 small">
        <span className="muted">Market demand</span>
        <span className="num">{marketDemandPerDay(state, trim).toFixed(2)} / day at this price</span>
        <span className="muted">Appeal</span>
        <span className="num">{appeal}</span>
        <span className="muted">Cycle times</span>
        <span className="num">
          {STATION_IDS.map((s) => `${stationName(s).split(' ')[0]} ${formatDuration(cycleMinutes(s, trim, finish))}`).join(' · ')}
        </span>
      </div>

      <div className="split">
        <div className="subcard">
          <div className="subcard-title">
            Estimate <Pill tone="info">Estimate</Pill>
          </div>
          {COMPONENT_IDS.filter((c) => est.byComponent[c]).map((c) => (
            <KV key={c} k={BALANCE.components[c].short} v={formatMoney(Math.round(est.byComponent[c] ?? 0))} />
          ))}
          <KV k="Materials" v={formatMoney(Math.round(est.materials))} />
          <KV k="Labour & overhead share" v={formatMoney(Math.round(est.laborOverhead))} />
          <KV k="Est. unit cost" v={formatMoney(Math.round(est.total))} />
          <KV k="Est. margin at price" v={formatMoney(Math.round(estMargin))} tone={estMargin >= 0 ? 'good' : 'bad'} />
        </div>
        <div className="subcard">
          <div className="subcard-title">
            Actual results <Pill tone="good">Actual</Pill>
          </div>
          {actual.unitsSold === 0 ? (
            <p className="muted small">No {trimName(trim)} vehicles delivered or sold yet.</p>
          ) : (
            <>
              <KV k="Units sold" v={num(actual.unitsSold)} />
              <KV k="Avg price" v={formatMoney(Math.round(actual.avgPrice))} />
              <KV k="Avg material cost" v={formatMoney(Math.round(actual.avgCost))} />
              <KV k="Avg margin" v={formatMoney(Math.round(actual.avgMargin))} tone={actual.avgMargin >= 0 ? 'good' : 'bad'} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ProductEditor() {
  const { state, dispatch, notify } = useUi();
  return (
    <Section title="Product">
      <div className="form-grid">
        <label>Model name</label>
        <CommitInput
          ariaLabel="Model name"
          maxLength={24}
          value={state.product.name}
          onCommit={(v) => {
            const name = v.trim();
            if (!name) {
              notify('Model name cannot be empty', false);
              return;
            }
            dispatch({ type: 'setProductName', name });
          }}
        />
        <span>Colour</span>
        <div className="swatches" role="radiogroup" aria-label="Colour">
          {BALANCE.colors.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={state.product.colorId === c.id}
              className={`swatch-btn${state.product.colorId === c.id ? ' active' : ''}`}
              style={{ background: c.hex }}
              title={c.name}
              aria-label={c.name}
              onClick={() => dispatch({ type: 'setColor', colorId: c.id })}
            />
          ))}
        </div>
      </div>
      <p className="muted small">Colour and finish apply to vehicles started from now on.</p>
      {TRIM_IDS.map((t) => (
        <TrimCard key={t} trim={t} />
      ))}
    </Section>
  );
}

const WIP: { stage: VehicleStage; label: string }[] = [
  ...STATION_IDS.map((s) => ({ stage: s as VehicleStage, label: stationName(s) })),
  { stage: 'rework', label: 'Rework bay' },
];

export function VehiclesTab() {
  const { state } = useUi();
  const yard = state.yard.map((id) => state.vehicles[String(id)]).filter(Boolean);
  const reworkVehicles = vehiclesInStage(state, 'rework');
  const orderName = (id: number) => state.orders.find((o) => o.id === id)?.dealer ?? `order #${id}`;
  return (
    <div className="tab">
      <ProductEditor />
      <Section title="Work in progress">
        <div className="wip-grid">
          {WIP.map(({ stage, label }) => (
            <div key={stage} className="wip-cell">
              <span className="num big">{vehiclesInStage(state, stage).length}</span>
              <span className="muted small">{label}</span>
            </div>
          ))}
        </div>
      </Section>
      <Section title={`Rework (${reworkVehicles.length})`}>
        {reworkVehicles.length === 0 ? (
          <p className="muted small">No vehicles waiting for rework.</p>
        ) : (
          reworkVehicles.map((v) => (
            <div key={v.id} className="row-line small">
              <Swatch hex={v.color} /> <b>{v.serial}</b> {trimName(v.trim)}
              <span className="muted grow">
                Defect from {v.defectNotes.length ? v.defectNotes.join(', ') : 'unknown station'}
                {v.reworkCount > 0 ? ` · reworked ${v.reworkCount}×` : ''}
              </span>
            </div>
          ))
        )}
      </Section>
      <Section title={`Finished yard (${yard.length})`}>
        {yard.length === 0 ? (
          <p className="muted small">No finished vehicles in the yard.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Serial</th>
                <th>Trim</th>
                <th>Reserved to</th>
                <th className="r">Cost</th>
              </tr>
            </thead>
            <tbody>
              {yard.map((v) => (
                <tr key={v.id}>
                  <td>
                    <Swatch hex={v.color} /> {v.serial}
                    {v.reworkCount > 0 && <span className="muted small"> (reworked)</span>}
                  </td>
                  <td>{trimName(v.trim)}</td>
                  <td>{v.orderId !== null ? orderName(v.orderId) : <span className="muted">Unreserved — for market</span>}</td>
                  <td className="r num">{formatMoney(Math.round(v.cost))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">
          Defects caught {state.stats.defectsCaught} · reworks done {state.stats.reworksDone} · escaped to customers{' '}
          {state.stats.defectsEscaped}
        </p>
      </Section>
    </div>
  );
}
