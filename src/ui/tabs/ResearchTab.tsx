import { useState } from 'react';
import { BALANCE, type ResearchProject } from '../../config/balance';
import { describeEffect, researchBlocker, researchStatus, type ResearchStatus } from '../../sim/selectors';
import { ActionButton, Bar, ConfirmDialog, Pill, Section } from '../common';
import { formatDuration, formatMoney } from '../format';
import { useUi } from '../useGame';

const BRANCHES = Object.keys(BALANCE.research.branches) as ResearchProject['branch'][];

const STATUS_PILL: Record<ResearchStatus, { tone: 'good' | 'info' | 'accent' | 'muted'; label: string }> = {
  done: { tone: 'good', label: 'Done' },
  active: { tone: 'info', label: 'In progress' },
  available: { tone: 'accent', label: 'Available' },
  locked: { tone: 'muted', label: 'Locked' },
};

function ProjectCard({ id }: { id: string }) {
  const { state, dispatch } = useUi();
  const p = BALANCE.research.projects[id];
  const status = researchStatus(state, id);
  const blocker = researchBlocker(state, id);
  const pill = STATUS_PILL[status];
  return (
    <div className={`card research-card research-${status}`}>
      <div className="card-head">
        <b>{p.name}</b>
        <Pill tone={pill.tone}>{pill.label}</Pill>
      </div>
      <p className="small">{p.blurb}</p>
      <ul className="small effect-list">
        {describeEffect(p.effect).map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      {p.requires.length > 0 && (
        <p className="muted small">
          Requires {p.requires.map((r) => BALANCE.research.projects[r]?.name ?? r).join(' + ')}
        </p>
      )}
      {status !== 'done' && status !== 'active' && (
        <div className="card-foot">
          <span className="small num muted">
            {formatMoney(p.cost)} · {formatDuration(p.minutes)}
          </span>
          {status === 'available' && (
            <ActionButton small variant="primary" disabledReason={blocker} onClick={() => dispatch({ type: 'startResearch', project: id })}>
              Research
            </ActionButton>
          )}
        </div>
      )}
    </div>
  );
}

export function ResearchTab() {
  const { state, dispatch } = useUi();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const active = state.research.active;
  const activeProject = active ? BALANCE.research.projects[active.id] : null;
  const total = Object.keys(BALANCE.research.projects).length;
  return (
    <div className="tab">
      <Section title="R&D lab" right={<span className="muted small num">{state.research.completed.length}/{total} researched</span>}>
        {active && activeProject ? (
          <div className="card">
            <div className="card-head">
              <b>{activeProject.name}</b>
              <span className="small num">{formatDuration(active.remaining)} left</span>
            </div>
            <Bar value={active.total - active.remaining} max={active.total} color="var(--blue)" height={8} />
            <ul className="small effect-list">
              {describeEffect(activeProject.effect).map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
            <div className="card-foot">
              <span className="muted small">Paid {formatMoney(activeProject.cost)} up front.</span>
              <ActionButton small variant="danger" onClick={() => setConfirmCancel(true)}>
                Cancel project
              </ActionButton>
            </div>
          </div>
        ) : (
          <p className="muted small">The lab is idle. Pick an available project below — one runs at a time, paid up front.</p>
        )}
        <p className="muted small">Research runs in game time alongside production, and its effects are permanent.</p>
      </Section>
      {BRANCHES.map((b) => (
        <Section key={b} title={BALANCE.research.branches[b]}>
          {Object.entries(BALANCE.research.projects)
            .filter(([, p]) => p.branch === b)
            .map(([id]) => (
              <ProjectCard key={id} id={id} />
            ))}
        </Section>
      ))}
      {confirmCancel && activeProject && (
        <ConfirmDialog
          title={`Cancel ${activeProject.name}?`}
          message={`The ${formatMoney(activeProject.cost)} already spent is lost, and so is the progress.`}
          confirmLabel="Cancel project"
          danger
          onConfirm={() => {
            setConfirmCancel(false);
            dispatch({ type: 'cancelResearch' });
          }}
          onCancel={() => setConfirmCancel(false)}
        />
      )}
    </div>
  );
}
