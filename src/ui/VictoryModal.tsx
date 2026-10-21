import { dayOf, medalFor, netWorth, scenarioSpec } from '../sim/selectors';
import { KV, Modal } from './common';
import { formatMoney } from './format';
import { useUi } from './useGame';

const MEDAL_LABEL = { gold: 'Gold', silver: 'Silver', bronze: 'Bronze' } as const;

/** Shown once when the scenario goal is reached; the game keeps running afterwards. */
export function VictoryModal({ onClose }: { onClose: () => void }) {
  const { state } = useUi();
  const wonAt = state.goals.wonAt ?? state.time;
  const days = dayOf(wonAt);
  const medal = medalFor(state, days);
  const sc = scenarioSpec(state);
  const s = state.stats;
  return (
    <Modal
      title="Goal reached!"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" data-autofocus onClick={onClose}>
          Keep playing
        </button>
      }
    >
      <div className={`medal medal-${medal}`}>
        <span className="medal-disc" aria-hidden="true" />
        <div>
          <b>{MEDAL_LABEL[medal]} rating</b>
          <div className="small muted">
            {sc.name} won on day {days} (gold is day {sc.goal.parDays} or sooner, silver by day {Math.round(sc.goal.parDays * 1.5)}).
          </div>
        </div>
      </div>
      <div className="stats-grid">
        <KV k="Net worth" v={formatMoney(netWorth(state))} tone="good" />
        <KV k="Plants" v={state.plants.length} />
        <KV k="Vehicles built" v={s.vehiclesBuilt} />
        <KV k="Orders delivered" v={s.ordersDelivered} />
        <KV k="Reputation" v={Math.round(state.reputation)} />
        <KV k="Milestones" v={Object.keys(state.goals.completed).length} />
      </div>
      <p className="muted small">The factory keeps running. Start a new scenario from the menu when you're ready.</p>
    </Modal>
  );
}
