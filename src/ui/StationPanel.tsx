import { BALANCE, TRIM_IDS, type StationId } from '../config/balance';
import {
  breakdownHazardPerHour,
  breakdownRisk,
  cycleMinutes,
  detectionRate,
  freeTechnicians,
  nextUpgradeCost,
  queueCapacity,
  stationRequiredStaff,
  stationStaff,
  stationStatus,
  unassignedOperators,
  type StationStatus,
} from '../sim/selectors';
import type { GameState, StationIssue, WorkSlot } from '../sim/types';
import { ActionButton, Bar, KV, Pill, Section, Swatch } from './common';
import { NEXT_STATION, formatDuration, formatMoney, pct, stationName, trimName } from './format';
import { useUi } from './useGame';

export const STATUS_LABEL: Record<StationStatus, string> = {
  running: 'Running',
  idle: 'Idle',
  blocked: 'Blocked',
  understaffed: 'Understaffed',
  broken: 'Broken down',
  repair: 'Under repair',
  maintenance: 'Maintenance',
};

export const STATUS_TONE: Record<StationStatus, 'good' | 'muted' | 'warn' | 'bad' | 'info'> = {
  running: 'good',
  idle: 'muted',
  blocked: 'warn',
  understaffed: 'warn',
  broken: 'bad',
  repair: 'info',
  maintenance: 'info',
};

export function conditionColor(c: number): string {
  if (c < BALANCE.equipment.dangerCondition) return 'var(--red)';
  if (c < BALANCE.equipment.warnCondition) return 'var(--amber)';
  return 'var(--green)';
}

function IssueList({ issues }: { issues: StationIssue[] }) {
  if (issues.length === 0) return <p className="muted small">No issues.</p>;
  return (
    <ul className="issues">
      {issues.map((i, n) => (
        <li key={n} className={`issue issue-${i.kind}`}>
          {i.text}
        </li>
      ))}
    </ul>
  );
}

function SlotRow({ state, slot, idx, doneText }: { state: GameState; slot: WorkSlot | null; idx: number; doneText: string }) {
  if (!slot) {
    return (
      <div className="slot slot-empty">
        <span className="muted">Slot {idx + 1} — empty</span>
      </div>
    );
  }
  const v = state.vehicles[String(slot.vehicleId)];
  return (
    <div className="slot">
      <div className="slot-head">
        <span>
          {v && <Swatch hex={v.color} />} <b>{v?.serial ?? `#${slot.vehicleId}`}</b>{' '}
          <span className="muted">{v ? trimName(v.trim) : ''}</span>
        </span>
        <span className="num small">
          {slot.done
            ? doneText + (slot.outcome ? ` (${slot.outcome === 'pass' ? 'passed' : 'defect found → rework'})` : '')
            : `${Math.floor(slot.progress)}/${slot.required} min`}
        </span>
      </div>
      <Bar value={slot.done ? 1 : slot.progress} max={slot.done ? 1 : slot.required} color={slot.done ? 'var(--amber)' : 'var(--accent)'} />
    </div>
  );
}

function QueueList({ state, ids, cap }: { state: GameState; ids: number[]; cap: number }) {
  return (
    <div className="queue-list">
      <div className="small muted num">
        Queue {ids.length}/{cap}
      </div>
      {ids.length === 0 ? (
        <div className="muted small">Empty</div>
      ) : (
        <div className="chips">
          {ids.map((id) => {
            const v = state.vehicles[String(id)];
            return (
              <span key={id} className="chip">
                {v && <Swatch hex={v.color} />} {v?.serial ?? `#${id}`} <span className="muted">{v ? trimName(v.trim) : ''}</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function StationPanel({ id, onClose }: { id: StationId; onClose: () => void }) {
  const { state, dispatch, openTab } = useUi();
  const st = state.stations[id];
  const bal = BALANCE.stations[id];
  const status = stationStatus(state, id);
  const isInspection = id === 'inspection';
  const staff = stationStaff(state, id);
  const required = stationRequiredStaff(state, id);
  const freeTech = freeTechnicians(state);
  const unassigned = unassignedOperators(state);
  const risk = breakdownRisk(state, id);
  const hazard = breakdownHazardPerHour(state, id);
  const eq = BALANCE.equipment;
  const qCap = queueCapacity(state, id);
  const wage = isInspection ? BALANCE.staff.inspector.dailyWage : BALANCE.staff.operator.dailyWage;

  const serviceReason = (cost: number): string | null => {
    if (st.service) return `${st.service.kind === 'repair' ? 'Repair' : 'Maintenance'} already in progress`;
    if (freeTech <= 0) return state.staff.technician === 0 ? 'No technicians — hire one in Staff' : 'All technicians are busy';
    if (state.cash < cost) return `Not enough cash (need ${formatMoney(cost)})`;
    return null;
  };
  const maintReason = st.broken ? 'Station is broken — repair it instead' : serviceReason(eq.maintenance.cost);
  const repairReason = serviceReason(eq.repair.cost);

  const capCost = nextUpgradeCost(state, 'capacity', id);
  const relCost = nextUpgradeCost(state, 'reliability', id);
  const upgradeReason = (cost: number | null) =>
    cost === null ? 'Maximum level reached' : state.cash < cost ? `Not enough cash (need ${formatMoney(cost)})` : null;

  const rw = state.rework;

  return (
    <aside className="station-panel" aria-label={`${stationName(id)} details`}>
      <header className="sp-head">
        <div>
          <h2>{stationName(id)}</h2>
          <div className="muted small">{bal.verb}</div>
        </div>
        <div className="sp-head-right">
          <Pill tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Pill>
          <button type="button" className="icon-btn" aria-label="Close station panel (Esc)" title="Close (Esc)" onClick={onClose}>
            ✕
          </button>
        </div>
      </header>

      <div className="sp-body">
        <Section title="Status">
          <IssueList issues={st.issues} />
        </Section>

        <Section title="Capacity">
          <KV k="Work slots" v={st.slots.length} />
          {id !== 'stamping' && <KV k="Queue capacity" v={qCap} />}
          {TRIM_IDS.map((t) => (
            <KV
              key={t}
              k={`Cycle time · ${trimName(t)} (${BALANCE.finishes[state.product.finish[t]].name})`}
              v={formatDuration(cycleMinutes(id, t, state.product.finish[t]))}
            />
          ))}
        </Section>

        <Section title="Staffing">
          {isInspection ? (
            <>
              <KV
                k="Inspectors"
                v={`${staff}/${required}`}
                tone={staff === 0 ? 'bad' : staff < required ? 'warn' : undefined}
              />
              <KV k="Defect detection rate" v={pct(detectionRate(state))} />
              <p className="muted small">Inspection uses every inspector on staff. Hire more to raise speed and detection.</p>
              <ActionButton small onClick={() => openTab('staff')}>
                Open Staff tab →
              </ActionButton>
            </>
          ) : (
            <>
              <div className="staff-row">
                <span>
                  Operators <b className="num">{st.assigned}</b>
                  <span className="muted num">/{required} needed</span>
                </span>
                <span className="stepper">
                  <ActionButton
                    small
                    onClick={() => dispatch({ type: 'assignOperator', station: id, delta: -1 })}
                    disabledReason={st.assigned <= 0 ? 'No operators assigned here' : null}
                  >
                    −
                  </ActionButton>
                  <ActionButton
                    small
                    onClick={() => dispatch({ type: 'assignOperator', station: id, delta: 1 })}
                    disabledReason={unassigned <= 0 ? 'No unassigned operators — hire more in Staff' : null}
                  >
                    +
                  </ActionButton>
                </span>
              </div>
              <div className="muted small">
                {unassigned} unassigned operator{unassigned === 1 ? '' : 's'} available.{' '}
                <button type="button" className="link" onClick={() => openTab('staff')}>
                  Staff tab
                </button>
              </div>
            </>
          )}
        </Section>

        <Section title="Equipment">
          <div className="kv">
            <span className="kv-k">Condition</span>
            <span className="kv-v num">{Math.round(st.condition)}%</span>
          </div>
          <Bar value={st.condition} max={100} color={conditionColor(st.condition)} height={8} />
          <KV
            k="Breakdown risk"
            v={risk === 'high' ? 'High' : risk === 'elevated' ? 'Elevated' : 'Low'}
            tone={risk === 'high' ? 'bad' : risk === 'elevated' ? 'warn' : 'good'}
          />
          <KV k="Hazard while running" v={`${pct(hazard, 1)} / hour`} />
          <KV k="Reliability level" v={st.reliabilityLevel} />
          {st.service ? (
            <div className="service">
              <div className="kv">
                <span className="kv-k">{st.service.kind === 'repair' ? 'Repair' : 'Maintenance'} in progress</span>
                <span className="kv-v num">{formatDuration(st.service.remaining)} left</span>
              </div>
              <Bar value={st.service.total - st.service.remaining} max={st.service.total} color="var(--blue)" />
            </div>
          ) : (
            <div className="sp-actions">
              <div className="muted small num">
                Free technicians: {freeTech}/{state.staff.technician}
              </div>
              {st.broken && (
                <ActionButton
                  variant="danger"
                  showReason
                  onClick={() => dispatch({ type: 'repair', station: id })}
                  disabledReason={repairReason}
                >
                  Repair · {formatMoney(eq.repair.cost)} · {formatDuration(eq.repair.minutes)}
                </ActionButton>
              )}
              {!st.broken && (
                <ActionButton
                  showReason
                  onClick={() => dispatch({ type: 'scheduleMaintenance', station: id })}
                  disabledReason={maintReason}
                >
                  Maintenance · {formatMoney(eq.maintenance.cost)} · {formatDuration(eq.maintenance.minutes)}
                </ActionButton>
              )}
              <div className="muted small">
                {st.broken
                  ? `Repair restores condition to at least ${eq.repair.restoreCondition}%.`
                  : 'Maintenance restores condition to 100%. Station stops while serviced.'}
              </div>
            </div>
          )}
        </Section>

        <Section title="Work">
          {st.slots.map((s, i) => (
            <SlotRow key={i} state={state} slot={s} idx={i} doneText={`Done — waiting for ${NEXT_STATION[id]}`} />
          ))}
          {id !== 'stamping' && <QueueList state={state} ids={st.queue} cap={qCap} />}
        </Section>

        {isInspection && (
          <Section title="Rework bay">
            <IssueList issues={rw.issues} />
            <SlotRow state={state} slot={rw.slot} idx={0} doneText="Reworked — waiting for inspection" />
            <QueueList state={state} ids={rw.queue} cap={BALANCE.quality.reworkQueueCapacity} />
            <KV k="Rework cost" v={formatMoney(BALANCE.quality.reworkCost)} />
            <KV k="Rework time" v={formatDuration(BALANCE.quality.reworkMinutes)} />
          </Section>
        )}

        <Section title="Operating costs">
          <KV k="Energy per active hour" v={formatMoney(bal.energyPerActiveHour)} />
          <KV k={`Wages of assigned staff (${staff} × ${formatMoney(wage)})`} v={`${formatMoney(staff * wage)} / day`} />
          <KV k="Energy accrued today" v={formatMoney(Math.round(st.energyAccrued))} />
        </Section>

        <Section title="Upgrades">
          <div className="upgrade-row">
            <div>
              <b>Capacity</b> <span className="muted">level {st.capacityLevel}</span>
              <div className="muted small">+1 work slot and +1 queue space</div>
            </div>
            <ActionButton
              small
              showReason
              variant="primary"
              onClick={() => dispatch({ type: 'upgradeCapacity', station: id })}
              disabledReason={upgradeReason(capCost)}
            >
              {capCost === null ? 'Maxed' : `Upgrade · ${formatMoney(capCost)}`}
            </ActionButton>
          </div>
          <div className="upgrade-row">
            <div>
              <b>Reliability</b> <span className="muted">level {st.reliabilityLevel}</span>
              <div className="muted small">
                Wear ×{BALANCE.equipment.reliabilityWearMult}, breakdown hazard ×{BALANCE.equipment.reliabilityHazardMult} per level
              </div>
            </div>
            <ActionButton
              small
              showReason
              variant="primary"
              onClick={() => dispatch({ type: 'upgradeReliability', station: id })}
              disabledReason={upgradeReason(relCost)}
            >
              {relCost === null ? 'Maxed' : `Upgrade · ${formatMoney(relCost)}`}
            </ActionButton>
          </div>
        </Section>
      </div>
    </aside>
  );
}
