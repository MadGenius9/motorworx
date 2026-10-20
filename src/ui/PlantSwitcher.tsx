import { STATION_IDS } from '../config/balance';
import { stationStatus } from '../sim/selectors';
import { formatDuration } from './format';
import { useUi } from './useGame';

/** Tabs over the factory view to switch between plants. Hidden while the company has one plant. */
export function PlantSwitcher() {
  const { state, plant, selectPlant } = useUi();
  if (state.plants.length < 2) return null;
  return (
    <div className="plant-switcher" role="tablist" aria-label="Plant">
      {state.plants.map((p) => {
        const building = p.constructionRemaining > 0;
        const statuses = building ? [] : STATION_IDS.map((id) => stationStatus(state, id, p.id));
        const problem = statuses.some((x) => x === 'broken') ? 'bad' : statuses.some((x) => x === 'blocked' || x === 'understaffed') ? 'warn' : 'ok';
        return (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={p.id === plant}
            className={p.id === plant ? 'active' : ''}
            onClick={() => selectPlant(p.id)}
            title={building ? `Under construction — ${formatDuration(p.constructionRemaining)} left` : undefined}
          >
            <span className={`dot dot-${building ? 'build' : problem}`} />
            {p.name}
            {building && <span className="small"> · {formatDuration(p.constructionRemaining)}</span>}
          </button>
        );
      })}
    </div>
  );
}
