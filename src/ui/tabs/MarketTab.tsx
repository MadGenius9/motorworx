import { BALANCE, MODEL_IDS, TRIM_IDS, type ModelId, type TrimId } from '../../config/balance';
import { recentMarketShare, rivalSpec, segmentShares, vehicleLabel } from '../../sim/selectors';
import { Bar, Pill, Section, Swatch } from '../common';
import { clockOf, dayOf, formatMoney } from '../format';
import { useUi } from '../useGame';

const PLAYER_COLOR = 'var(--accent)';

function ShareBar({ parts }: { parts: { key: string; share: number; color: string; label: string }[] }) {
  return (
    <div className="share-bar" role="img" aria-label={parts.map((p) => `${p.label} ${Math.round(p.share * 100)}%`).join(', ')}>
      {parts
        .filter((p) => p.share > 0.004)
        .map((p) => (
          <span key={p.key} style={{ width: `${p.share * 100}%`, background: p.color }} title={`${p.label}: ${Math.round(p.share * 100)}%`} />
        ))}
    </div>
  );
}

function SegmentRow({ model, trim }: { model: ModelId; trim: TrimId }) {
  const { state } = useUi();
  const mc = state.product.models[model];
  const seg = segmentShares(state, model, trim);
  const active = seg.rivals.filter((r) => r.active);
  return (
    <div className="segment">
      <div className="segment-head">
        <b>{vehicleLabel(state, model, trim)}</b>
        {!mc.marketListed[trim] && <Pill tone="muted">Not listed</Pill>}
        <span className="muted small num">{seg.demandPerDay.toFixed(1)} buyers/day for you</span>
      </div>
      <ShareBar
        parts={[
          { key: 'you', share: seg.playerShare, color: PLAYER_COLOR, label: 'You' },
          ...seg.rivals.map((r) => ({ key: r.id, share: r.share, color: r.color, label: r.name })),
          { key: 'other', share: seg.otherShare, color: 'var(--muted)', label: 'Importers' },
        ]}
      />
      <table className="table compact">
        <tbody>
          <tr>
            <td>
              <Swatch hex="#f07c1e" /> You
            </td>
            <td className="r num">{formatMoney(mc.price[trim])}</td>
            <td className="r num">{Math.round(seg.playerShare * 100)}%</td>
          </tr>
          {active.map((r) => (
            <tr key={r.id}>
              <td>
                <Swatch hex={r.color} /> {r.name} {r.promo && <Pill tone="warn">Promo</Pill>}
              </td>
              <td className={`r num${r.price < mc.price[trim] ? ' tone-bad' : ''}`}>{formatMoney(r.price)}</td>
              <td className="r num">{Math.round(r.share * 100)}%</td>
            </tr>
          ))}
          {seg.otherShare > 0.004 && (
            <tr>
              <td className="muted">Importers (no rival model yet)</td>
              <td className="r num muted">{formatMoney(BALANCE.models[model].trims[trim].baseValue)}</td>
              <td className="r num muted">{Math.round(seg.otherShare * 100)}%</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function MarketTab() {
  const { state } = useUi();
  const share = recentMarketShare(state, 7);
  const models = MODEL_IDS.filter((m) => state.product.models[m].unlocked);
  const rivalNames = BALANCE.competition.rivals.map((r) => r.name);
  const news = state.events.filter((e) => rivalNames.some((n) => e.text.startsWith(n))).slice(-8).reverse();
  const history = state.market.history.slice(-7).reverse();

  return (
    <div className="tab">
      <Section title="Market share" right={<Pill tone="info">Open market, last 7 days</Pill>}>
        {share ? (
          <>
            <ShareBar
              parts={[
                { key: 'you', share: share.player, color: PLAYER_COLOR, label: 'You' },
                ...state.market.rivals.map((r) => ({
                  key: r.id,
                  share: share.rivals[r.id] ?? 0,
                  color: rivalSpec(r.id).color,
                  label: rivalSpec(r.id).name,
                })),
              ]}
            />
            <div className="legend small">
              <span>
                <Swatch hex="#f07c1e" /> You {Math.round(share.player * 100)}%
              </span>
              {state.market.rivals.map((r) => (
                <span key={r.id}>
                  <Swatch hex={rivalSpec(r.id).color} /> {rivalSpec(r.id).name} {Math.round((share.rivals[r.id] ?? 0) * 100)}%
                </span>
              ))}
            </div>
          </>
        ) : (
          <p className="muted small">Market share appears after the first full day.</p>
        )}
        <p className="muted small">
          Open-market buyers in each segment pick between you and the rivals by appeal, reputation and price. Dealer orders
          are separate, but rivals win offers you leave waiting.
        </p>
      </Section>

      <Section title="Your segments" right={<span className="muted small">Estimated shares at today's prices</span>}>
        {models.flatMap((m) => TRIM_IDS.map((t) => <SegmentRow key={`${m}-${t}`} model={m} trim={t} />))}
      </Section>

      <Section title="Rivals">
        {state.market.rivals.map((r) => {
          const spec = rivalSpec(r.id);
          const lineup = MODEL_IDS.filter((m) => r.segments[m].economy.active).map((m) => BALANCE.models[m].className);
          const upcoming = MODEL_IDS.filter((m) => !r.segments[m].economy.active && spec.launchDay[m] !== null).map(
            (m) => `${BALANCE.models[m].className} (day ${spec.launchDay[m]})`,
          );
          return (
            <div key={r.id} className="card">
              <div className="card-head">
                <span>
                  <Swatch hex={spec.color} size={12} /> <b>{spec.name}</b>
                </span>
                <Pill tone="muted">{spec.strategy}</Pill>
              </div>
              <p className="small">{spec.blurb}</p>
              <div className="grid2 small">
                <span className="muted">Reputation</span>
                <span>
                  <Bar value={r.reputation} max={100} color={spec.color} label={`${Math.round(r.reputation)}`} />
                </span>
                <span className="muted">Builds</span>
                <span>{lineup.join(', ') || '—'}</span>
                {upcoming.length > 0 && (
                  <>
                    <span className="muted">Launching</span>
                    <span>{upcoming.join(', ')}</span>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </Section>

      <Section title="Daily open-market sales">
        {history.length === 0 ? (
          <p className="muted small">No full days yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Day</th>
                <th className="r">You</th>
                {state.market.rivals.map((r) => (
                  <th key={r.id} className="r" title={rivalSpec(r.id).name}>
                    {rivalSpec(r.id).name.split(' ')[0]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.map((d) => (
                <tr key={d.day}>
                  <td className="num">{d.day}</td>
                  <td className="r num">{d.player}</td>
                  {state.market.rivals.map((r) => (
                    <td key={r.id} className="r num">
                      {(d.rivals[r.id] ?? 0).toFixed(1)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">Rival figures are estimates from industry reports.</p>
      </Section>

      <Section title="Rival news">
        {news.length === 0 ? (
          <p className="muted small">Nothing yet.</p>
        ) : (
          news.map((e) => (
            <div key={e.id} className="row-line small">
              <span className="muted num">
                D{dayOf(e.time)} {clockOf(e.time)}
              </span>
              <span className="grow">{e.text}</span>
            </div>
          ))
        )}
      </Section>
    </div>
  );
}
