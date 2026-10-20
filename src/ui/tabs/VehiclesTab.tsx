import { useState } from 'react';
import {
  BALANCE,
  COMPONENT_IDS,
  FINISH_IDS,
  MODEL_IDS,
  STATION_IDS,
  TRIM_IDS,
  type FinishId,
  type ModelId,
  type TrimId,
} from '../../config/balance';
import {
  actualTrimResults,
  cycleMinutes,
  estimateUnitCost,
  estimatedProfitPerVehicle,
  marketDemandPerDay,
  modelName,
  trimSpec,
  unlockBlocker,
  vehicleLabel,
  vehiclesInStage,
} from '../../sim/selectors';
import type { VehicleStage } from '../../sim/types';
import { ActionButton, CommitInput, ConfirmDialog, KV, Pill, Section, Swatch } from '../common';
import { componentsPerVehicle, formatDuration, formatMoney, num, stationName, trimName } from '../format';
import { useUi } from '../useGame';

function TrimCard({ model, trim }: { model: ModelId; trim: TrimId }) {
  const { state, dispatch, notify } = useUi();
  const mc = state.product.models[model];
  const finish = mc.finish[trim];
  const price = mc.price[trim];
  const listed = mc.marketListed[trim];
  const t = trimSpec(model, trim);
  const label = vehicleLabel(state, model, trim);
  const est = estimateUnitCost(state, model, trim);
  const estMargin = estimatedProfitPerVehicle(state, model, trim);
  const actual = actualTrimResults(state, model, trim);
  const appeal = t.appeal + BALANCE.finishes[finish].appealAdd;
  const refValue = t.baseValue + BALANCE.finishes[finish].valueAdd;
  const key = `${model}-${trim}`;

  return (
    <div className="card">
      <div className="card-head">
        <b>{trimName(trim)}</b>
        <span className="muted small">Reference value {formatMoney(refValue)}</span>
      </div>
      <div className="form-grid">
        <label htmlFor={`finish-${key}`}>Finish</label>
        <select
          id={`finish-${key}`}
          className="input"
          value={finish}
          onChange={(e) => dispatch({ type: 'setFinish', model, trim, finish: e.target.value as FinishId })}
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
          ariaLabel={`${label} price`}
          value={String(price)}
          onCommit={(v) => {
            const n = Math.round(Number(v));
            if (!Number.isFinite(n) || n <= 0) {
              notify('Enter a valid price', false);
              return;
            }
            dispatch({ type: 'setPrice', model, trim, price: n });
          }}
        />
        <label htmlFor={`listed-${key}`}>Sell on open market</label>
        <label className="toggle">
          <input
            id={`listed-${key}`}
            type="checkbox"
            checked={listed}
            onChange={(e) => dispatch({ type: 'setMarketListed', model, trim, listed: e.target.checked })}
          />
          <span>{listed ? 'Listed — unreserved yard cars are sold' : 'Not listed'}</span>
        </label>
      </div>
      <div className="grid2 small">
        <span className="muted">Market demand</span>
        <span className="num">{marketDemandPerDay(state, model, trim).toFixed(2)} / day at this price</span>
        <span className="muted">Appeal</span>
        <span className="num">{appeal}</span>
        <span className="muted">Cycle times</span>
        <span className="num">
          {STATION_IDS.map((s) => `${stationName(s).split(' ')[0]} ${formatDuration(cycleMinutes(s, model, trim, finish))}`).join(' · ')}
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
            <p className="muted small">No {label} vehicles delivered or sold yet.</p>
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

/** Tooling offer for a model that is not in production yet. */
function LockedModel({ model }: { model: ModelId }) {
  const { state, dispatch } = useUi();
  const [confirming, setConfirming] = useState(false);
  const spec = BALANCE.models[model];
  const name = modelName(state, model);
  const blocker = unlockBlocker(state, model);
  return (
    <div className="card">
      <div className="card-head">
        <b>
          {name} {spec.className}
        </b>
        <Pill tone="muted">Not in production</Pill>
      </div>
      <p className="small">{spec.blurb}</p>
      <div className="grid2 small">
        <span className="muted">Tooling cost</span>
        <span className="num">{formatMoney(spec.unlockCost)} (one-off, counted as capital investment)</span>
        <span className="muted">Reputation needed</span>
        <span className={`num${state.reputation < spec.minReputation ? ' tone-bad' : ''}`}>
          {spec.minReputation} (you have {Math.floor(state.reputation)})
        </span>
        <span className="muted">Build time</span>
        <span className="num">×{spec.timeMult.toFixed(2)} vs. the sedan baseline</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Trim</th>
            <th className="r">Ref. value</th>
            <th className="r">Steel</th>
            <th className="r">Interior</th>
            <th className="r">Demand/day</th>
          </tr>
        </thead>
        <tbody>
          {TRIM_IDS.map((t) => {
            const ts = spec.trims[t];
            const finish = state.product.models[model].finish[t];
            return (
              <tr key={t}>
                <td>{trimName(t)}</td>
                <td className="r num">{formatMoney(ts.baseValue)}</td>
                <td className="r num">{componentsPerVehicle(model, t, finish, 'steel')}</td>
                <td className="r num">{componentsPerVehicle(model, t, finish, 'interior')}</td>
                <td className="r num">{ts.baseDemandPerDay.toFixed(1)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted small">
        Once tooled, dealers start ordering this model and you can schedule it. Stations lose time retooling whenever they
        switch between models, so batch builds of the same model.
      </p>
      <ActionButton variant="primary" disabledReason={blocker} showReason onClick={() => setConfirming(true)}>
        Buy tooling ({formatMoney(spec.unlockCost)})
      </ActionButton>
      {confirming && (
        <ConfirmDialog
          title={`Tool up for the ${name}?`}
          message={`This spends ${formatMoney(spec.unlockCost)} of your ${formatMoney(state.cash)} cash on ${spec.className} tooling.`}
          confirmLabel="Buy tooling"
          onConfirm={() => {
            setConfirming(false);
            dispatch({ type: 'unlockModel', model });
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

function ModelEditor({ model }: { model: ModelId }) {
  const { state, dispatch, notify } = useUi();
  const mc = state.product.models[model];
  const spec = BALANCE.models[model];
  return (
    <>
      <div className="form-grid">
        <label>{spec.className} name</label>
        <CommitInput
          ariaLabel={`${spec.className} name`}
          maxLength={24}
          value={mc.name}
          onCommit={(v) => {
            const name = v.trim();
            if (!name) {
              notify('Model name cannot be empty', false);
              return;
            }
            dispatch({ type: 'setProductName', model, name });
          }}
        />
        <span>Colour</span>
        <div className="swatches" role="radiogroup" aria-label={`${spec.className} colour`}>
          {BALANCE.colors.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={mc.colorId === c.id}
              className={`swatch-btn${mc.colorId === c.id ? ' active' : ''}`}
              style={{ background: c.hex }}
              title={c.name}
              aria-label={c.name}
              onClick={() => dispatch({ type: 'setColor', model, colorId: c.id })}
            />
          ))}
        </div>
      </div>
      <p className="muted small">Colour and finish apply to vehicles started from now on.</p>
      {TRIM_IDS.map((t) => (
        <TrimCard key={t} model={model} trim={t} />
      ))}
    </>
  );
}

function ProductEditor() {
  const { state } = useUi();
  const [model, setModel] = useState<ModelId>('sedan');
  const mc = state.product.models[model];
  return (
    <Section title="Product line">
      <div className="segmented model-switch" role="tablist" aria-label="Vehicle model">
        {MODEL_IDS.map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={m === model}
            className={m === model ? 'active' : ''}
            onClick={() => setModel(m)}
          >
            {modelName(state, m)} <span className="small">{BALANCE.models[m].className}</span>
            {!state.product.models[m].unlocked && ' 🔒'}
          </button>
        ))}
      </div>
      {mc.unlocked ? <ModelEditor model={model} /> : <LockedModel model={model} />}
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
              <Swatch hex={v.color} /> <b>{v.serial}</b> {vehicleLabel(state, v.model, v.trim)}
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
                <th>Model</th>
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
                  <td>{vehicleLabel(state, v.model, v.trim)}</td>
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
