import '../goals.css';
import { BALANCE } from '../../config/balance';
import {
  activeIncidents,
  dayOf,
  goalProgress,
  incidentDetail,
  incidentTitle,
  medalFor,
  scenarioSpec,
} from '../../sim/selectors';
import { Bar, KV, Pill, Section } from '../common';
import { formatDuration, formatMoney, formatTime } from '../format';
import { useUi } from '../useGame';

export function GoalsTab() {
  const { state } = useUi();
  const sc = scenarioSpec(state);
  const g = goalProgress(state);
  const won = state.goals.wonAt;
  const day = dayOf(state.time);
  const par = sc.goal.parDays;
  const events = activeIncidents(state);
  const done = state.goals.completed;
  const milestones = Object.entries(BALANCE.milestones);
  const doneCount = milestones.filter(([id]) => done[id] !== undefined).length;

  return (
    <div className="tab">
      <Section
        title={`Goal · ${sc.name}`}
        right={won !== null ? <Pill tone="good">Won · {medalFor(state, dayOf(won))}</Pill> : <Pill tone="info">Day {day}</Pill>}
      >
        <p className="small muted">{sc.blurb}</p>
        <div className="goal-row">
          <KV k="Net worth" v={`${formatMoney(g.netWorth)} / ${formatMoney(g.netWorthTarget)}`} tone={g.netWorth >= g.netWorthTarget ? 'good' : undefined} />
          <Bar value={Math.max(0, g.netWorth)} max={g.netWorthTarget} height={8} color="var(--green)" />
        </div>
        {g.shareTarget > 0 && (
          <div className="goal-row">
            <KV
              k="Open-market share (7 days)"
              v={`${g.share === null ? '—' : Math.round(g.share * 100) + '%'} / ${Math.round(g.shareTarget * 100)}%`}
              tone={g.share !== null && g.share >= g.shareTarget ? 'good' : undefined}
            />
            <Bar value={g.share ?? 0} max={g.shareTarget} height={8} color="var(--accent)" />
            {state.market.history.length < 7 && (
              <p className="small muted">Share counts once the market has 7 days of history (from day {day + 7 - state.market.history.length}).</p>
            )}
          </div>
        )}
        <p className="small muted">
          Net worth = cash + parts and cars in stock + money owed to you + equipment at cost − loans.{' '}
          {won === null
            ? day <= par
              ? `Reach it by day ${par} for gold, day ${Math.round(par * 1.5)} for silver.`
              : day <= par * 1.5
                ? `Gold is gone; reach it by day ${Math.round(par * 1.5)} for silver.`
                : 'Any finish now earns bronze.'
            : `Reached on ${formatTime(won)}.`}
        </p>
      </Section>

      <Section title="Events" right={events.length ? <Pill tone="warn">{events.length} active</Pill> : <Pill tone="muted">Calm</Pill>}>
        {events.length === 0 && (
          <p className="small muted">
            Nothing unusual right now. From day {BALANCE.incidents.graceDays + 1}, supplier strikes, price spikes, recessions, booms and
            recalls can happen. Recalls only follow defects that reached customers.
          </p>
        )}
        {events.map((i) => (
          <div key={i.id} className={`card incident incident-${i.kind}`}>
            <div className="card-head">
              <b>{incidentTitle(state, i)}</b>
              <span className="small num muted">{formatDuration(i.until - state.time)} left</span>
            </div>
            <div className="small">{incidentDetail(i)}</div>
          </div>
        ))}
      </Section>

      <Section title="Milestones" right={<span className="small num">{doneCount}/{milestones.length}</span>}>
        <ul className="milestones">
          {milestones.map(([id, m]) => {
            const t = done[id];
            return (
              <li key={id} className={t !== undefined ? 'is-done' : ''}>
                <span className="milestone-check" aria-hidden="true">
                  {t !== undefined ? '✓' : ''}
                </span>
                <span className="milestone-text">
                  <b>{m.name}</b>
                  <span className="small muted">{m.description}</span>
                </span>
                <span className="small num muted">
                  {t !== undefined ? `Day ${dayOf(t)}` : m.reputation ? `+${m.reputation} rep` : ''}
                </span>
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}
