import type { ReactNode } from 'react';
import { STATION_IDS } from '../config/balance';
import { orderProgress, rivalOnPromo, type PanelTab } from '../sim/selectors';
import type { GameState } from '../sim/types';
import { EventTicker } from './EventTicker';
import { FinancesTab } from './tabs/FinancesTab';
import { MarketTab } from './tabs/MarketTab';
import { ResearchTab } from './tabs/ResearchTab';
import { OrdersTab } from './tabs/OrdersTab';
import { StaffTab } from './tabs/StaffTab';
import { SuppliersTab } from './tabs/SuppliersTab';
import { UpgradesTab } from './tabs/UpgradesTab';
import { VehiclesTab } from './tabs/VehiclesTab';
import { useUi } from './useGame';

interface Badge {
  n: number;
  tone: 'accent' | 'good' | 'warn' | 'bad';
  title: string;
}

function badgesFor(state: GameState, tab: PanelTab): Badge[] {
  switch (tab) {
    case 'orders': {
      const offers = state.orders.filter((o) => o.status === 'offered').length;
      const accepted = state.orders.filter((o) => o.status === 'accepted');
      const ready = accepted.filter((o) => orderProgress(state, o).ready).length;
      const late = accepted.filter((o) => orderProgress(state, o).late).length;
      const out: Badge[] = [];
      if (offers) out.push({ n: offers, tone: 'accent', title: `${offers} new offer(s)` });
      if (ready) out.push({ n: ready, tone: 'good', title: `${ready} order(s) ready to deliver` });
      if (late) out.push({ n: late, tone: 'bad', title: `${late} late order(s)` });
      return out;
    }
    case 'vehicles': {
      const unreserved = state.yard.filter((id) => state.vehicles[String(id)]?.orderId === null).length;
      return unreserved ? [{ n: unreserved, tone: 'accent', title: `${unreserved} unreserved vehicle(s) in yard` }] : [];
    }
    case 'suppliers': {
      const short = state.plants.flatMap((p) => STATION_IDS.map((id) => p.stations[id])).filter((st) => st.issues.some((i) => i.kind === 'materials')).length;
      return short ? [{ n: short, tone: 'warn', title: `${short} station(s) missing materials` }] : [];
    }
    case 'staff': {
      const n = state.plants.flatMap((p) => STATION_IDS.map((id) => p.stations[id])).filter((st) => st.issues.some((i) => i.kind === 'staff')).length;
      return n ? [{ n, tone: 'warn', title: `${n} station(s) short of staff` }] : [];
    }
    case 'market': {
      const promos = state.market.rivals.reduce(
        (n, r) =>
          n +
          Object.keys(r.segments).reduce(
            (k, m) => k + (['economy', 'premium'] as const).filter((t) => rivalOnPromo(state, r, m as keyof typeof r.segments, t)).length,
            0,
          ),
        0,
      );
      return promos ? [{ n: promos, tone: 'warn', title: `${promos} rival promotion(s) running` }] : [];
    }
    case 'research':
      return state.research.active ? [{ n: 1, tone: 'accent', title: 'Research in progress' }] : [];
    case 'finances':
      return state.cash < 0 ? [{ n: 1, tone: 'bad', title: 'Cash is negative' }] : [];
    default:
      return [];
  }
}

const TABS: { id: PanelTab; label: string; render: () => ReactNode }[] = [
  { id: 'orders', label: 'Orders', render: () => <OrdersTab /> },
  { id: 'vehicles', label: 'Vehicles', render: () => <VehiclesTab /> },
  { id: 'market', label: 'Market', render: () => <MarketTab /> },
  { id: 'suppliers', label: 'Suppliers', render: () => <SuppliersTab /> },
  { id: 'staff', label: 'Staff', render: () => <StaffTab /> },
  { id: 'finances', label: 'Finances', render: () => <FinancesTab /> },
  { id: 'research', label: 'R&D', render: () => <ResearchTab /> },
  { id: 'upgrades', label: 'Upgrades', render: () => <UpgradesTab /> },
];

export function SidePanel({ tab }: { tab: PanelTab }) {
  const { state, openTab } = useUi();
  const current = TABS.find((t) => t.id === tab) ?? TABS[0];
  return (
    <aside className="sidebar">
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === tab}
            className={`tab-btn${t.id === tab ? ' active' : ''}`}
            onClick={() => openTab(t.id)}
          >
            {t.label}
            {badgesFor(state, t.id).map((b, i) => (
              <span key={i} className={`badge badge-${b.tone}`} title={b.title}>
                {b.n}
              </span>
            ))}
          </button>
        ))}
      </nav>
      <div className="tab-body" role="tabpanel" key={current.id}>
        {current.render()}
      </div>
      <EventTicker />
    </aside>
  );
}
