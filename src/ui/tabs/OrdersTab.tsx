import { useState } from 'react';
import { BALANCE, TRIM_IDS, type ModelId, type TrimId } from '../../config/balance';
import { estimatedProfitPerVehicle, orderProgress, rivalName, unlockedModels, vehicleLabel } from '../../sim/selectors';
import type { SalesOrder } from '../../sim/types';
import { ActionButton, Pill, Section } from '../common';
import { formatDuration, formatMoney, formatTime, pct } from '../format';
import { useUi } from '../useGame';

function Countdown({ minutes, label }: { minutes: number; label: string }) {
  if (minutes < 0) return <span className="tone-bad num">{label} overdue by {formatDuration(-minutes)}</span>;
  return (
    <span className={`num${minutes < 6 * 60 ? ' tone-warn' : ''}`}>
      {label} in {formatDuration(minutes)}
    </span>
  );
}

function OfferCard({ o }: { o: SalesOrder }) {
  const { state, dispatch } = useUi();
  const margin = estimatedProfitPerVehicle(state, o.model, o.trim, o.unitPrice);
  return (
    <div className="card">
      <div className="card-head">
        <b>{o.dealer}</b>
        <Pill tone={o.trim === 'premium' ? 'accent' : 'muted'}>{vehicleLabel(state, o.model, o.trim)}</Pill>
      </div>
      <div className="grid2">
        <span className="muted">Quantity</span>
        <span className="num">{o.quantity}</span>
        <span className="muted">Unit price</span>
        <span className="num">{formatMoney(o.unitPrice)}</span>
        <span className="muted">Total</span>
        <span className="num">
          <b>{formatMoney(o.unitPrice * o.quantity)}</b>
        </span>
        <span className="muted">Deadline</span>
        <span className="num">
          {formatTime(o.deadline)} · <Countdown minutes={o.deadline - state.time} label="due" />
        </span>
        <span className="muted">Payment</span>
        <span>{o.paymentTermsLabel}</span>
        <span className="muted">Est. margin / vehicle</span>
        <span className={`num ${margin >= 0 ? 'tone-good' : 'tone-bad'}`} title="Estimate: price minus estimated material and labour/overhead cost">
          {formatMoney(Math.round(margin))} <small className="muted">(estimate)</small>
        </span>
      </div>
      <div className="small muted terms">
        Late: −{pct(o.latePenaltyPerDay)} of invoice per day (max −{pct(o.latePenaltyMax)}). Cancelled{' '}
        {formatDuration(o.cancelAfterLateMinutes)} after the deadline with a {formatMoney(o.cancelFee)} fee and reputation loss.
      </div>
      <div className="card-foot">
        <span className="small">
          <Countdown minutes={o.offerExpiresAt - state.time} label="Offer expires" />
          {o.contested && <div className="muted">Rivals may win it if you wait.</div>}
        </span>
        <span className="btn-group">
          <ActionButton small variant="ghost" onClick={() => dispatch({ type: 'declineOrder', orderId: o.id })}>
            Decline
          </ActionButton>
          <ActionButton small variant="primary" onClick={() => dispatch({ type: 'acceptOrder', orderId: o.id })}>
            Accept
          </ActionButton>
        </span>
      </div>
    </div>
  );
}

function AcceptedCard({ o, idx, count }: { o: SalesOrder; idx: number; count: number }) {
  const { state, dispatch } = useUi();
  const p = orderProgress(state, o);
  const seg = (n: number) => `${(n / o.quantity) * 100}%`;
  return (
    <div className={`card${p.late ? ' card-late' : ''}${p.ready ? ' card-ready' : ''}`}>
      <div className="card-head">
        <span>
          <span className="prio num" title="Priority">
            #{idx + 1}
          </span>{' '}
          <b>{o.dealer}</b>
        </span>
        <span className="btn-group">
          <Pill tone={o.trim === 'premium' ? 'accent' : 'muted'}>{vehicleLabel(state, o.model, o.trim)}</Pill>
          <ActionButton
            small
            variant="ghost"
            title="Raise priority"
            onClick={() => dispatch({ type: 'moveOrderPriority', orderId: o.id, dir: -1 })}
            disabledReason={idx === 0 ? 'Already top priority' : null}
          >
            ↑
          </ActionButton>
          <ActionButton
            small
            variant="ghost"
            title="Lower priority"
            onClick={() => dispatch({ type: 'moveOrderPriority', orderId: o.id, dir: 1 })}
            disabledReason={idx === count - 1 ? 'Already lowest priority' : null}
          >
            ↓
          </ActionButton>
        </span>
      </div>
      <div className="small num">
        {o.quantity} × {formatMoney(o.unitPrice)} = <b>{formatMoney(o.quantity * o.unitPrice)}</b> · {o.paymentTermsLabel}
      </div>
      <div className="progress-stack" title="Reserved / in production / scheduled / shortfall">
        <div className="ps-seg ps-reserved" style={{ width: seg(p.reserved) }} />
        <div className="ps-seg ps-wip" style={{ width: seg(p.inProduction) }} />
        <div className="ps-seg ps-sched" style={{ width: seg(p.scheduled) }} />
        <div className="ps-seg ps-short" style={{ width: seg(p.shortfall) }} />
      </div>
      <div className="legend small num">
        <span>
          <i className="lg lg-reserved" />
          Ready {p.reserved}
        </span>
        <span>
          <i className="lg lg-wip" />
          In production {p.inProduction}
        </span>
        <span>
          <i className="lg lg-sched" />
          Scheduled {p.scheduled}
        </span>
        <span className={p.shortfall > 0 ? 'tone-warn' : ''}>
          <i className="lg lg-short" />
          Not scheduled {p.shortfall}
        </span>
      </div>
      <div className="card-foot">
        <span className="small">
          {p.late ? (
            <span className="tone-bad num">
              LATE by {formatDuration(Math.max(0, -p.minutesLeft))} — cancels in{' '}
              {formatDuration(Math.max(0, o.deadline + o.cancelAfterLateMinutes - state.time))}
            </span>
          ) : (
            <Countdown minutes={p.minutesLeft} label="Due" />
          )}
        </span>
        <span className="btn-group">
          {p.shortfall > 0 && (
            <ActionButton small onClick={() => dispatch({ type: 'scheduleForOrder', orderId: o.id })}>
              Schedule build ({p.shortfall})
            </ActionButton>
          )}
          {p.ready && (
            <ActionButton small variant="good" onClick={() => dispatch({ type: 'deliverOrder', orderId: o.id })}>
              Deliver
            </ActionButton>
          )}
        </span>
      </div>
    </div>
  );
}

function PlanSection() {
  const { state, dispatch } = useUi();
  const [variant, setVariant] = useState('sedan:economy');
  const [model, trim] = variant.split(':') as [ModelId, TrimId];
  const [qty, setQty] = useState('1');
  const q = Math.floor(Number(qty));
  const qtyReason = !Number.isFinite(q) || q < 1 || q > 50 ? 'Enter a quantity from 1 to 50' : null;
  return (
    <Section title="Production plan" right={<span className="muted small">Stamping starts jobs top to bottom</span>}>
      {state.plan.length === 0 && <p className="muted small">Nothing scheduled. Stamping will sit idle.</p>}
      {state.plan.map((j, i) => {
        const order = j.orderId !== null ? state.orders.find((o) => o.id === j.orderId) : undefined;
        return (
          <div key={j.id} className="row-line">
            <span className="num muted">{i + 1}.</span>
            <span className="grow">
              <b>{vehicleLabel(state, j.model, j.trim)}</b>{' '}
              <span className="num">
                {j.started}/{j.quantity} started
              </span>
              {i > 0 && state.plan[i - 1].model !== j.model && (
                <span title="Stations retool when the model changes; batching the same model avoids this">
                  {' '}
                  <Pill tone="info">Retool: {BALANCE.models[j.model].className}</Pill>
                </span>
              )}
              <div className="small muted">{order ? `For ${order.dealer} (#${order.id})` : 'Stock build (unreserved)'}</div>
            </span>
            <span className="btn-group">
              <ActionButton
                small
                variant="ghost"
                onClick={() => dispatch({ type: 'moveJob', jobId: j.id, dir: -1 })}
                disabledReason={i === 0 ? 'Already first' : null}
              >
                ↑
              </ActionButton>
              <ActionButton
                small
                variant="ghost"
                onClick={() => dispatch({ type: 'moveJob', jobId: j.id, dir: 1 })}
                disabledReason={i === state.plan.length - 1 ? 'Already last' : null}
              >
                ↓
              </ActionButton>
              <ActionButton
                small
                variant="danger"
                title="Remove the unstarted remainder"
                onClick={() => dispatch({ type: 'cancelJob', jobId: j.id })}
              >
                Cancel
              </ActionButton>
            </span>
          </div>
        );
      })}
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!qtyReason) dispatch({ type: 'scheduleBuild', model, trim, quantity: q });
        }}
      >
        <span className="small muted">Stock build:</span>
        <select className="input" value={variant} onChange={(e) => setVariant(e.target.value)} aria-label="Model and trim">
          {unlockedModels(state).flatMap((m) =>
            TRIM_IDS.map((t) => (
              <option key={`${m}:${t}`} value={`${m}:${t}`}>
                {vehicleLabel(state, m, t)}
              </option>
            )),
          )}
        </select>
        <input
          className="input input-num"
          type="number"
          min={1}
          max={50}
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          aria-label="Quantity"
        />
        <button type="submit" className="btn btn-sm btn-primary" disabled={!!qtyReason} title={qtyReason ?? undefined}>
          Add to plan
        </button>
      </form>
    </Section>
  );
}

const HISTORY_STATUSES = new Set(['delivered', 'paid', 'cancelled', 'expired', 'declined', 'lost']);

export function OrdersTab() {
  const { state } = useUi();
  const offers = state.orders.filter((o) => o.status === 'offered');
  const accepted = state.orders.filter((o) => o.status === 'accepted').sort((a, b) => a.priority - b.priority);
  const history = state.orders.filter((o) => HISTORY_STATUSES.has(o.status)).slice(-25).reverse();
  return (
    <div className="tab">
      <Section title={`Offers (${offers.length})`}>
        {offers.length === 0 && <p className="muted small">No open offers. New dealer requests arrive over time — reputation attracts more.</p>}
        {offers.map((o) => (
          <OfferCard key={o.id} o={o} />
        ))}
      </Section>
      <Section title={`Accepted orders (${accepted.length})`}>
        {accepted.length === 0 && <p className="muted small">No accepted orders.</p>}
        {accepted.map((o, i) => (
          <AcceptedCard key={o.id} o={o} idx={i} count={accepted.length} />
        ))}
      </Section>
      <PlanSection />
      <Section title="History">
        {history.length === 0 ? (
          <p className="muted small">No completed orders yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Dealer</th>
                <th>Trim</th>
                <th className="r">Qty</th>
                <th className="r">Invoice</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {history.map((o) => (
                <tr key={o.id}>
                  <td>{o.dealer}</td>
                  <td>{vehicleLabel(state, o.model, o.trim)}</td>
                  <td className="r num">{o.quantity}</td>
                  <td className="r num">
                    {o.invoiceAmount !== null ? formatMoney(o.invoiceAmount) : '—'}
                    {o.lateDays > 0 && <div className="small tone-warn">{o.lateDays}d late</div>}
                  </td>
                  <td>
                    {o.status === 'paid' && <Pill tone="good">Paid</Pill>}
                    {o.status === 'delivered' && (
                      <span className="small">
                        <Pill tone="info">Awaiting payment</Pill>
                        {o.paymentDueAt !== null && (
                          <div className="muted num">due in {formatDuration(Math.max(0, o.paymentDueAt - state.time))}</div>
                        )}
                      </span>
                    )}
                    {o.status === 'cancelled' && <Pill tone="bad">Cancelled</Pill>}
                    {o.status === 'expired' && <Pill tone="muted">Expired</Pill>}
                    {o.status === 'declined' && <Pill tone="muted">Declined</Pill>}
                    {o.status === 'lost' && (
                      <span title="A rival won this offer while it waited">
                        <Pill tone="warn">Lost to {o.lostTo ? rivalName(o.lostTo) : 'a rival'}</Pill>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
