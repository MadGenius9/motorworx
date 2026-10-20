import { useEffect, useState } from 'react';
import { tutorialSteps } from '../sim/selectors';
import { useUi } from './useGame';

export function TutorialCard() {
  const { state, dispatch, runAction } = useUi();
  const steps = tutorialSteps(state);
  const allDone = steps.length > 0 && steps.every((s) => s.done);
  const [collapsed, setCollapsed] = useState(allDone);

  // Auto-collapse once everything is complete.
  useEffect(() => {
    if (allDone) setCollapsed(true);
  }, [allDone]);

  if (state.tutorial.dismissed || steps.length === 0) return null;
  const currentIdx = steps.findIndex((s) => !s.done);
  const doneCount = steps.filter((s) => s.done).length;

  if (collapsed) {
    return (
      <div className="tutorial tutorial-collapsed">
        <button type="button" className="link" onClick={() => setCollapsed(false)}>
          {allDone ? '✓ Tutorial complete' : `Tutorial ${doneCount}/${steps.length}`} — show
        </button>
        <button type="button" className="icon-btn" aria-label="Dismiss tutorial" onClick={() => dispatch({ type: 'dismissTutorial' })}>
          ✕
        </button>
      </div>
    );
  }

  return (
    <div className="tutorial" role="region" aria-label="Tutorial">
      <header className="tutorial-head">
        <b>Getting started</b>
        <span className="muted small num">
          {doneCount}/{steps.length}
        </span>
        <span className="grow" />
        <button type="button" className="icon-btn" title="Collapse" aria-label="Collapse tutorial" onClick={() => setCollapsed(true)}>
          –
        </button>
        <button type="button" className="icon-btn" title="Dismiss (reopen with ? in the top bar)" aria-label="Dismiss tutorial" onClick={() => dispatch({ type: 'dismissTutorial' })}>
          ✕
        </button>
      </header>
      <ol className="tutorial-steps">
        {steps.map((s, i) => (
          <li key={s.id} className={s.done ? 'done' : i === currentIdx ? 'current' : ''}>
            <span className="tut-check" aria-hidden="true">
              {s.done ? '✓' : i + 1}
            </span>
            <div>
              <div className="tut-title">{s.title}</div>
              {i === currentIdx && (
                <>
                  <div className="tut-text small">{s.text}</div>
                  {s.action && (
                    <button type="button" className="btn btn-sm btn-primary" onClick={() => runAction(s.action!.action)}>
                      {s.action.label}
                    </button>
                  )}
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
