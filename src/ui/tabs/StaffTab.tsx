import '../goals.css';
import { BALANCE, STATION_IDS, WAGE_LEVELS, type StaffRole } from '../../config/balance';
import {
  dailyPayroll,
  freeTechnicians,
  moraleLabel,
  moraleSpeed,
  stationRequiredStaff,
  trainingBlocker,
  trainingCost,
  unassignedInspectors,
  unassignedOperators,
  workforceDefectMult,
} from '../../sim/selectors';
import { ActionButton, Bar, KV, Pill, Section } from '../common';
import { formatDuration, formatMoney, stationName } from '../format';
import { useUi } from '../useGame';

const ROLES: StaffRole[] = ['operator', 'inspector', 'technician'];

const TRAINING_EFFECT: Record<StaffRole, (level: number) => string> = {
  operator: (l) =>
    `+${Math.round(l * BALANCE.workforce.training.operatorSpeedPerLevel * 100)}% speed, −${Math.round(
      (1 - Math.pow(BALANCE.workforce.training.operatorDefectMultPerLevel, l)) * 100,
    )}% defects`,
  inspector: (l) => `+${Math.round(l * BALANCE.workforce.training.inspectorDetectionPerLevel * 100)} pts detection`,
  technician: (l) => `−${Math.round((1 - Math.pow(BALANCE.workforce.training.technicianTimeMultPerLevel, l)) * 100)}% service time`,
};

const ROLE_HELP: Record<StaffRole, string> = {
  operator: 'Run stamping, body, paint and final assembly. Assign them to stations below.',
  inspector: 'Staff Quality Inspection at each plant. More inspectors = faster checks and higher detection.',
  technician: 'Perform maintenance and repairs (one job each at a time).',
};

export function StaffTab() {
  const { state, dispatch } = useUi();
  const unassigned = unassignedOperators(state);
  const freeInspectors = unassignedInspectors(state);
  const freeTech = freeTechnicians(state);
  const payroll = dailyPayroll(state);
  const wf = state.workforce;
  const W = BALANCE.workforce;
  const mood = moraleLabel(wf.morale);
  const moodTone = wf.morale >= 75 ? 'good' : wf.morale >= 50 ? 'info' : wf.morale >= W.strike.belowMorale ? 'warn' : 'bad';
  const target = W.wages[wf.wage].moraleTarget;

  const fireReason = (role: StaffRole): string | null => {
    if (state.staff[role] <= 0) return `No ${BALANCE.staff[role].plural.toLowerCase()} to dismiss`;
    if (role === 'operator' && unassigned <= 0) return 'Unassign an operator from a station first';
    if (role === 'technician' && freeTech <= 0) return 'All technicians are on service jobs';
    const sev = BALANCE.staff[role].dailyWage * BALANCE.staff.severanceDays;
    if (state.cash < sev) return `Not enough cash for severance (${formatMoney(sev)})`;
    return null;
  };

  return (
    <div className="tab">
      <Section title="Payroll">
        <KV k="Daily payroll (billed at midnight)" v={formatMoney(payroll)} tone={payroll > state.cash ? 'bad' : undefined} />
        {payroll > state.cash && (
          <p className="warn-box">Payroll exceeds your cash. Tonight's billing will push you negative — sell vehicles or cut staff.</p>
        )}
      </Section>

      <Section title="Morale & wages" right={<Pill tone={moodTone}>{mood}</Pill>}>
        <div className="goal-row">
          <KV k="Morale" v={`${Math.round(wf.morale)} → ${target}`} />
          <Bar value={wf.morale} max={100} height={8} color={wf.morale >= 50 ? 'var(--green)' : wf.morale >= W.strike.belowMorale ? 'var(--amber)' : 'var(--red)'} />
        </div>
        <KV k="Work speed from morale" v={`${Math.round((moraleSpeed(state) - 1) * 100) >= 0 ? '+' : ''}${Math.round((moraleSpeed(state) - 1) * 100)}%`} />
        <KV k="Defect rate vs. normal" v={`×${workforceDefectMult(state).toFixed(2)}`} tone={workforceDefectMult(state) > 1 ? 'warn' : undefined} />
        <div className="seg-control" role="radiogroup" aria-label="Wage level">
          {WAGE_LEVELS.map((lvl) => (
            <button
              key={lvl}
              type="button"
              role="radio"
              aria-checked={wf.wage === lvl}
              className={`btn btn-sm${wf.wage === lvl ? ' btn-primary' : ''}`}
              onClick={() => wf.wage !== lvl && dispatch({ type: 'setWage', level: lvl })}
            >
              {W.wages[lvl].label}
            </button>
          ))}
        </div>
        <p className="small muted">
          Morale moves toward the wage level's target every night ({W.wages.low.moraleTarget} / {W.wages.standard.moraleTarget} /{' '}
          {W.wages.high.moraleTarget}). Dismissals cost {W.firingMoraleHit} points; finished training adds {W.trainingMoraleBoost}. Below{' '}
          {W.strike.belowMorale}, workers may strike and stop a plant for {Math.round(W.strike.minutes / 60)}h.
        </p>
      </Section>

      <Section title="Training">
        {wf.course && (
          <div className="card">
            <div className="card-head">
              <b>
                {BALANCE.staff[wf.course.role].plural}: level {wf.training[wf.course.role] + 1} course
              </b>
              <span className="small num muted">{formatDuration(wf.course.remaining)} left</span>
            </div>
            <Bar value={wf.course.total - wf.course.remaining} max={wf.course.total} />
          </div>
        )}
        <table className="table">
          <thead>
            <tr>
              <th>Role</th>
              <th>Level</th>
              <th>Effect</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {ROLES.map((role) => {
              const lvl = wf.training[role];
              const cost = trainingCost(state, role);
              return (
                <tr key={role}>
                  <td>{BALANCE.staff[role].plural}</td>
                  <td className="num">
                    {lvl}/{W.training.maxLevel}
                  </td>
                  <td className="small">{lvl > 0 ? TRAINING_EFFECT[role](lvl) : <span className="muted">Untrained</span>}</td>
                  <td className="r">
                    {cost !== null && (
                      <ActionButton small disabledReason={trainingBlocker(state, role)} onClick={() => dispatch({ type: 'startTraining', role })}>
                        Train · {formatMoney(cost)}
                      </ActionButton>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="small muted">Courses train everyone in the role, including later hires. One course runs at a time; the price grows with headcount.</p>
      </Section>

      <Section title="Workforce">
        {ROLES.map((role) => {
          const r = BALANCE.staff[role];
          const severance = r.dailyWage * BALANCE.staff.severanceDays;
          return (
            <div key={role} className="card staff-card">
              <div className="card-head">
                <b>
                  {r.plural} <span className="num">× {state.staff[role]}</span>
                </b>
                <span className="muted small num">
                  {formatMoney(Math.round(r.dailyWage * W.wages[wf.wage].payMult))}/day each ·{' '}
                  {formatMoney(Math.round(r.dailyWage * W.wages[wf.wage].payMult * state.staff[role]))}/day total
                </span>
              </div>
              <div className="muted small">{ROLE_HELP[role]}</div>
              {role === 'operator' && <div className="small num">Unassigned: {unassigned}</div>}
              {role === 'technician' && (
                <div className="small num">
                  Busy {state.staff.technician - freeTech} · free {freeTech}
                </div>
              )}
              <div className="card-foot">
                <ActionButton
                  small
                  variant="danger"
                  showReason
                  disabledReason={fireReason(role)}
                  onClick={() => dispatch({ type: 'fire', role })}
                >
                  Dismiss · severance {formatMoney(severance)}
                </ActionButton>
                <ActionButton
                  small
                  variant="primary"
                  showReason
                  disabledReason={state.cash < r.hireFee ? `Not enough cash (need ${formatMoney(r.hireFee)})` : null}
                  onClick={() => dispatch({ type: 'hire', role, count: 1 })}
                >
                  Hire · fee {formatMoney(r.hireFee)}
                </ActionButton>
              </div>
            </div>
          );
        })}
      </Section>

      {state.plants.map((P) => (
        <Section
          key={P.id}
          title={state.plants.length > 1 ? `Assignments · ${P.name}` : 'Assignments'}
          right={
            <span className="small num">
              Free: {unassigned} operators · {freeInspectors} inspectors
              {P.constructionRemaining > 0 ? ' · under construction' : ''}
            </span>
          }
        >
          <table className="table">
            <thead>
              <tr>
                <th>Station</th>
                <th className="r">Assigned / needed</th>
                <th className="r">Adjust</th>
              </tr>
            </thead>
            <tbody>
              {STATION_IDS.map((id) => {
                const required = stationRequiredStaff(state, id, P.id);
                const a = P.stations[id].assigned;
                const free = id === 'inspection' ? freeInspectors : unassigned;
                const word = id === 'inspection' ? 'inspectors' : 'operators';
                return (
                  <tr key={id}>
                    <td>{stationName(id)}</td>
                    <td className={`r num${a === 0 ? ' tone-bad' : a < required ? ' tone-warn' : ' tone-good'}`}>
                      {a}/{required} {id === 'inspection' ? 'inspectors' : ''}
                    </td>
                    <td className="r">
                      <span className="stepper">
                        <ActionButton
                          small
                          disabledReason={a <= 0 ? 'None assigned' : null}
                          onClick={() => dispatch({ type: 'assignOperator', station: id, delta: -1, plant: P.id })}
                        >
                          −
                        </ActionButton>
                        <ActionButton
                          small
                          disabledReason={free <= 0 ? `No unassigned ${word} — hire more` : null}
                          onClick={() => dispatch({ type: 'assignOperator', station: id, delta: 1, plant: P.id })}
                        >
                          +
                        </ActionButton>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Section>
      ))}
      <p className="muted small">
        Partial staffing runs a station at reduced speed (staff ÷ needed). New inspectors go to the inspection line that
        needs them most.
      </p>
    </div>
  );
}
