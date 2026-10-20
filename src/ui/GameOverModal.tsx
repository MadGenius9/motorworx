import { KV, Modal } from './common';
import { formatMoney, formatTime } from './format';
import { useUi } from './useGame';

export function GameOverModal() {
  const { state, controller } = useUi();
  const s = state.stats;
  return (
    <Modal
      title="Game over"
      footer={
        <button type="button" className="btn btn-primary" data-autofocus onClick={() => controller.newGame()}>
          Start new game
        </button>
      }
    >
      <p className="gameover-reason">{state.gameOverReason ?? 'The company has closed.'}</p>
      <div className="stats-grid">
        <KV k="Ended" v={formatTime(state.time)} />
        <KV k="Final cash" v={formatMoney(Math.round(state.cash))} tone={state.cash < 0 ? 'bad' : undefined} />
        <KV k="Reputation" v={Math.round(state.reputation)} />
        <KV k="Revenue" v={formatMoney(Math.round(state.finance.revenue))} />
        <KV k="Vehicles built" v={s.vehiclesBuilt} />
        <KV k="Orders delivered" v={s.ordersDelivered} />
        <KV k="Late / cancelled" v={`${s.ordersLate} / ${s.ordersCancelled}`} />
        <KV k="Sold on market" v={s.marketSold} />
        <KV k="Defects caught / escaped" v={`${s.defectsCaught} / ${s.defectsEscaped}`} />
        <KV k="Breakdowns" v={s.breakdowns} />
      </div>
      <p className="muted small">You can also load an earlier save from the top bar.</p>
    </Modal>
  );
}
