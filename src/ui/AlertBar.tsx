import { useState } from 'react';
import { getAlerts } from '../sim/selectors';
import { useUi } from './useGame';

const VISIBLE = 4;

export function AlertBar() {
  const { state, runAction } = useUi();
  const [expanded, setExpanded] = useState(false);
  const alerts = getAlerts(state);
  if (alerts.length === 0) {
    return (
      <div className="alertbar alertbar-empty">
        <span className="dot dot-good" /> No alerts — all systems nominal.
      </div>
    );
  }
  const shown = expanded ? alerts : alerts.slice(0, VISIBLE);
  const hidden = alerts.length - shown.length;
  return (
    <div className={`alertbar${expanded ? ' expanded' : ''}`} role="region" aria-label="Alerts">
      {shown.map((a) => (
        <div key={a.id} className={`alert alert-${a.severity}`}>
          <span className="alert-icon" aria-hidden="true">
            {a.severity === 'critical' ? '!' : a.severity === 'warning' ? '▲' : 'i'}
          </span>
          <div className="alert-text">
            <strong>{a.title}</strong>
            <span className="alert-cause">{a.cause}</span>
          </div>
          <div className="alert-actions">
            {a.actions.map((act, i) => (
              <button key={i} type="button" className="btn btn-sm btn-alert" onClick={() => runAction(act.action)}>
                {act.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      {(hidden > 0 || expanded) && alerts.length > VISIBLE && (
        <button type="button" className="btn btn-sm btn-ghost alert-more" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Show less' : `+${hidden} more`}
        </button>
      )}
    </div>
  );
}
