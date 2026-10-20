import { BALANCE, STATION_IDS } from '../../config/balance';
import { nextUpgradeCost, nextWarehouseCost, warehouseCapacity, yardCapacity } from '../../sim/selectors';
import { ActionButton, Section } from '../common';
import { formatMoney, stationName } from '../format';
import { useUi } from '../useGame';

export function UpgradesTab() {
  const { state, dispatch } = useUi();
  const reason = (cost: number | null) =>
    cost === null ? 'Maximum level reached' : state.cash < cost ? `Not enough cash (need ${formatMoney(cost)})` : null;
  const wCost = nextWarehouseCost(state);
  const capMax = BALANCE.upgrades.capacity.costs.length;
  const relMax = BALANCE.upgrades.reliability.costs.length;
  const whMax = BALANCE.upgrades.warehouse.costs.length;

  return (
    <div className="tab">
      <p className="muted small">Upgrades are capital spending: they reduce cash but are not operating expenses.</p>
      {STATION_IDS.map((id) => {
        const st = state.stations[id];
        const cc = nextUpgradeCost(state, 'capacity', id);
        const rc = nextUpgradeCost(state, 'reliability', id);
        return (
          <Section key={id} title={stationName(id)}>
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
                onClick={() => dispatch({ type: 'upgradeCapacity', station: id })}
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
                onClick={() => dispatch({ type: 'upgradeReliability', station: id })}
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
    </div>
  );
}
