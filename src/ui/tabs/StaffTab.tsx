import { BALANCE, STATION_IDS, type StaffRole } from '../../config/balance';
import { dailyPayroll, freeTechnicians, stationRequiredStaff, unassignedOperators } from '../../sim/selectors';
import { ActionButton, KV, Section } from '../common';
import { formatMoney, stationName } from '../format';
import { useUi } from '../useGame';

const ROLES: StaffRole[] = ['operator', 'inspector', 'technician'];

const ROLE_HELP: Record<StaffRole, string> = {
  operator: 'Run stamping, body, paint and final assembly. Assign them to stations below.',
  inspector: 'Staff Quality Inspection. More inspectors = faster checks and higher detection.',
  technician: 'Perform maintenance and repairs (one job each at a time).',
};

export function StaffTab() {
  const { state, dispatch } = useUi();
  const unassigned = unassignedOperators(state);
  const freeTech = freeTechnicians(state);
  const payroll = dailyPayroll(state);

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
                  {formatMoney(r.dailyWage)}/day each · {formatMoney(r.dailyWage * state.staff[role])}/day total
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

      <Section title="Operator assignments" right={<span className="small num">Unassigned: {unassigned}</span>}>
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
              const required = stationRequiredStaff(state, id);
              if (id === 'inspection') {
                const n = state.staff.inspector;
                return (
                  <tr key={id}>
                    <td>{stationName(id)}</td>
                    <td className={`r num${n === 0 ? ' tone-bad' : n < required ? ' tone-warn' : ''}`}>
                      {n}/{required} inspectors
                    </td>
                    <td className="r muted small">uses all inspectors</td>
                  </tr>
                );
              }
              const a = state.stations[id].assigned;
              return (
                <tr key={id}>
                  <td>{stationName(id)}</td>
                  <td className={`r num${a === 0 ? ' tone-bad' : a < required ? ' tone-warn' : ' tone-good'}`}>
                    {a}/{required}
                  </td>
                  <td className="r">
                    <span className="stepper">
                      <ActionButton
                        small
                        disabledReason={a <= 0 ? 'None assigned' : null}
                        onClick={() => dispatch({ type: 'assignOperator', station: id, delta: -1 })}
                      >
                        −
                      </ActionButton>
                      <ActionButton
                        small
                        disabledReason={unassigned <= 0 ? 'No unassigned operators — hire more' : null}
                        onClick={() => dispatch({ type: 'assignOperator', station: id, delta: 1 })}
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
        <p className="muted small">Partial staffing runs a station at reduced speed (staff ÷ needed).</p>
      </Section>
    </div>
  );
}
