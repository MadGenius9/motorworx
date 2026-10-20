import { BALANCE, STATION_IDS } from '../../config/balance';
import { useState } from 'react';
import {
  buildPlantBlocker,
  nextPlantSite,
  nextUpgradeCost,
  nextWarehouseCost,
  plantOf,
  warehouseCapacity,
  yardCapacity,
} from '../../sim/selectors';
import { ActionButton, ConfirmDialog, Pill, Section } from '../common';
import { formatDuration, formatMoney, stationName } from '../format';
import { useUi } from '../useGame';

export function UpgradesTab() {
  const { state, dispatch, plant, selectPlant } = useUi();
  const [confirmBuild, setConfirmBuild] = useState(false);
  const P = plantOf(state, plant);
  const site = nextPlantSite(state);
  const buildBlocker = buildPlantBlocker(state);
  const reason = (cost: number | null) =>
    cost === null ? 'Maximum level reached' : state.cash < cost ? `Not enough cash (need ${formatMoney(cost)})` : null;
  const wCost = nextWarehouseCost(state);
  const capMax = BALANCE.upgrades.capacity.costs.length;
  const relMax = BALANCE.upgrades.reliability.costs.length;
  const whMax = BALANCE.upgrades.warehouse.costs.length;

  return (
    <div className="tab">
      <p className="muted small">Upgrades and new plants are capital spending: they reduce cash but are not operating expenses.</p>
      <Section title="Plants">
        {state.plants.map((p) => (
          <div key={p.id} className="upgrade-row">
            <div>
              <b>{p.name}</b>{' '}
              {p.constructionRemaining > 0 ? (
                <Pill tone="info">Building · {formatDuration(p.constructionRemaining)}</Pill>
              ) : (
                <Pill tone="good">Operating</Pill>
              )}
              <div className="muted small">
                Overhead {formatMoney(BALANCE.overhead.dailyBase)}/day{p.constructionRemaining > 0 ? ' from opening' : ''} · builds{' '}
                {p.allowedModels.map((m) => BALANCE.models[m].className).join(', ')}
              </div>
            </div>
            {state.plants.length > 1 && (
              <ActionButton small disabledReason={p.id === plant ? 'Shown below' : null} onClick={() => selectPlant(p.id)}>
                {p.id === plant ? 'Selected' : 'Show'}
              </ActionButton>
            )}
          </div>
        ))}
        {site ? (
          <div className="upgrade-row">
            <div>
              <b>New plant: {site.name}</b>
              <div className="muted small">
                Its own five stations and rework bay; shares cash, warehouse, yard, plan and technicians. Needs reputation{' '}
                {site.minReputation}; takes {formatDuration(BALANCE.plants.constructionMinutes)} to build.
              </div>
            </div>
            <ActionButton small variant="primary" showReason disabledReason={buildBlocker} onClick={() => setConfirmBuild(true)}>
              Build · {formatMoney(site.cost)}
            </ActionButton>
          </div>
        ) : (
          <p className="muted small">All plant sites are built.</p>
        )}
      </Section>
      {STATION_IDS.map((id) => {
        const st = P.stations[id];
        const cc = nextUpgradeCost(state, 'capacity', id, plant);
        const rc = nextUpgradeCost(state, 'reliability', id, plant);
        return (
          <Section key={id} title={state.plants.length > 1 ? `${P.name} · ${stationName(id)}` : stationName(id)}>
            <div className="upgrade-row">
              <div>
                <b>Capacity</b>{' '}
                <span className="muted num">
                  level {st.capacityLevel}/{capMax}
                </span>
                <div className="muted small num">
                  {st.slots.length} slot{st.slots.length === 1 ? '' : 's'} now → next: +1 work slot, +1 queue space
                </div>
              </div>
              <ActionButton
                small
                variant="primary"
                showReason
                disabledReason={reason(cc)}
                onClick={() => dispatch({ type: 'upgradeCapacity', station: id, plant })}
              >
                {cc === null ? 'Maxed' : formatMoney(cc)}
              </ActionButton>
            </div>
            <div className="upgrade-row">
              <div>
                <b>Reliability</b>{' '}
                <span className="muted num">
                  level {st.reliabilityLevel}/{relMax}
                </span>
                <div className="muted small num">
                  Wear ×{Math.pow(BALANCE.equipment.reliabilityWearMult, st.reliabilityLevel).toFixed(2)}, hazard ×
                  {Math.pow(BALANCE.equipment.reliabilityHazardMult, st.reliabilityLevel).toFixed(2)} now
                </div>
              </div>
              <ActionButton
                small
                variant="primary"
                showReason
                disabledReason={reason(rc)}
                onClick={() => dispatch({ type: 'upgradeReliability', station: id, plant })}
              >
                {rc === null ? 'Maxed' : formatMoney(rc)}
              </ActionButton>
            </div>
          </Section>
        );
      })}
      <Section title="Warehouse">
        <div className="upgrade-row">
          <div>
            <b>Expansion</b>{' '}
            <span className="muted num">
              level {state.warehouseLevel}/{whMax}
            </span>
            <div className="muted small num">
              {warehouseCapacity(state)} component units · {yardCapacity(state)} yard spaces → next: +
              {BALANCE.upgrades.warehouse.componentAdd} units, +{BALANCE.upgrades.warehouse.yardAdd} yard spaces
            </div>
          </div>
          <ActionButton small variant="primary" showReason disabledReason={reason(wCost)} onClick={() => dispatch({ type: 'upgradeWarehouse' })}>
            {wCost === null ? 'Maxed' : formatMoney(wCost)}
          </ActionButton>
        </div>
      </Section>
      {confirmBuild && site && (
        <ConfirmDialog
          title={`Build the ${site.name} plant?`}
          message={`This spends ${formatMoney(site.cost)} of your ${formatMoney(state.cash)} cash. Once it opens it adds ${formatMoney(
            BALANCE.overhead.dailyBase,
          )}/day overhead and needs its own operators and inspectors.`}
          confirmLabel="Build plant"
          onConfirm={() => {
            setConfirmBuild(false);
            dispatch({ type: 'buildPlant' });
          }}
          onCancel={() => setConfirmBuild(false)}
        />
      )}
    </div>
  );
}
