import './goals.css';
import { useState } from 'react';
import { BALANCE, SCENARIO_IDS, type ScenarioId } from '../config/balance';
import { Modal } from './common';
import { formatMoney } from './format';

/** Scenario picker shown before a new game starts. */
export function NewGameDialog({
  onStart,
  onCancel,
  warning = true,
}: {
  onStart: (scenario: ScenarioId) => void;
  onCancel?: () => void;
  /** Mention that the current game will be replaced. */
  warning?: boolean;
}) {
  const [pick, setPick] = useState<ScenarioId>('standard');
  return (
    <Modal
      title="New game"
      onClose={onCancel}
      wide
      footer={
        <>
          {onCancel && (
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="button" className="btn btn-primary" data-autofocus onClick={() => onStart(pick)}>
            Start: {BALANCE.scenarios[pick].name}
          </button>
        </>
      }
    >
      {warning && <p className="muted small">Your current factory will be replaced. Save first if you want to keep it.</p>}
      <div className="scenario-grid" role="radiogroup" aria-label="Scenario">
        {SCENARIO_IDS.map((id) => {
          const sc = BALANCE.scenarios[id];
          const g = sc.goal;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={pick === id}
              className={`scenario-card${pick === id ? ' is-picked' : ''}`}
              onClick={() => setPick(id)}
            >
              <b>{sc.name}</b>
              <span className="small">{sc.blurb}</span>
              <span className="scenario-facts small num">
                <span>Cash {formatMoney(sc.cash)}</span>
                <span>Reputation {sc.reputation}</span>
                <span>
                  Goal {formatMoney(g.netWorth)}
                  {g.marketShare > 0 ? ` + ${Math.round(g.marketShare * 100)}% share` : ''}
                </span>
                <span>Gold in {g.parDays} days</span>
              </span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
