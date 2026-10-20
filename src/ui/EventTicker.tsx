import { clockOf, dayOf } from './format';
import { useUi } from './useGame';

export function EventTicker({ count = 5 }: { count?: number }) {
  const { state } = useUi();
  const events = state.events.slice(-count).reverse();
  return (
    <footer className="ticker" aria-label="Recent events" aria-live="polite">
      <div className="ticker-title">Event log</div>
      {events.length === 0 && <div className="muted small">Nothing yet.</div>}
      {events.map((e) => (
        <div key={e.id} className={`ticker-row ev-${e.kind}`}>
          <span className="num muted">
            D{dayOf(e.time)} {clockOf(e.time)}
          </span>
          <span className="ev-dot" />
          <span className="ticker-text">{e.text}</span>
        </div>
      ))}
    </footer>
  );
}
