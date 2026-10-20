import { BALANCE, COMPONENT_IDS, MODEL_IDS, STATION_IDS, TRIM_IDS } from '../config/balance';
import { normaliseSeed } from './rng';
import type {
  ComponentId,
  ComponentStock,
  ExpenseCategory,
  GameState,
  MarketState,
  ModelConfig,
  ModelId,
  RivalSegment,
  RivalState,
  SalesOrder,
  StationId,
  StationState,
} from './types';
import { SAVE_VERSION } from './types';

const EXPENSES: ExpenseCategory[] = [
  'payroll',
  'utilities',
  'maintenance',
  'repair',
  'rework',
  'warranty',
  'hiring',
  'severance',
  'penalty',
  'research',
];

function makeStation(id: StationId): StationState {
  return {
    id,
    slots: [null],
    queue: [],
    capacityLevel: 0,
    reliabilityLevel: 0,
    condition: BALANCE.start.stationCondition[id],
    broken: false,
    service: null,
    assigned: id === 'inspection' ? 0 : BALANCE.start.assignments[id],
    issues: [],
    lastModel: null,
    energyAccrued: 0,
    completedTotal: 0,
    activeMinutesTotal: 0,
  };
}

/** Default player settings for a model: default name/colour, base-value prices, every trim listed. */
export function defaultModelConfig(m: ModelId, unlocked: boolean): ModelConfig {
  const spec = BALANCE.models[m];
  const price = {} as ModelConfig['price'];
  const listed = {} as ModelConfig['marketListed'];
  for (const t of TRIM_IDS) {
    price[t] = spec.trims[t].baseValue;
    listed[t] = true;
  }
  return {
    unlocked,
    name: spec.defaultName,
    colorId: spec.defaultColorId,
    finish: { ...BALANCE.start.defaultFinish },
    price,
    marketListed: listed,
  };
}

/** Rivals at their starting positions; segments whose launch day has arrived by `time` are active. */
export function createMarket(time: number): MarketState {
  const day = Math.floor(time / BALANCE.time.minutesPerDay) + 1;
  const rivals: RivalState[] = BALANCE.competition.rivals.map((spec) => {
    const segments = {} as RivalState['segments'];
    for (const m of MODEL_IDS) {
      const launch = spec.launchDay[m];
      const bySeg = {} as Record<(typeof TRIM_IDS)[number], RivalSegment>;
      for (const t of TRIM_IDS) {
        bySeg[t] = { active: launch !== null && launch <= day, priceIndex: spec.priceIndex, promoUntil: null };
      }
      segments[m] = bySeg;
    }
    return { id: spec.id, reputation: spec.reputation, segments };
  });
  const empty = () => Object.fromEntries(BALANCE.competition.rivals.map((r) => [r.id, 0]));
  return { rivals, today: { day, player: 0, rivals: empty() }, history: [] };
}

/** Fresh game state built entirely from BALANCE.start. */
export function createInitialState(seed: number = BALANCE.start.seed): GameState {
  const S = BALANCE.start;
  const time = BALANCE.time.startMinute;
  let nextId = 1;

  const inventory = {} as Record<ComponentId, ComponentStock>;
  for (const c of COMPONENT_IDS) {
    const s = S.inventory[c];
    inventory[c] = { qty: s.qty, value: s.qty * s.unitCost, qualitySum: s.qty * s.quality };
  }

  const stations = {} as Record<StationId, StationState>;
  for (const id of STATION_IDS) stations[id] = makeStation(id);

  const fo = S.firstOrder;
  const terms = BALANCE.orders.paymentTerms[fo.paymentTermIndex] ?? BALANCE.orders.paymentTerms[0];
  const firstOrder: SalesOrder = {
    id: nextId++,
    dealer: fo.dealer,
    model: fo.model,
    trim: fo.trim,
    quantity: fo.quantity,
    unitPrice: fo.unitPrice,
    createdAt: time,
    offerExpiresAt: time + fo.offerLifetimeMinutes,
    deadline: time + fo.deadlineInMinutes,
    paymentTermsLabel: terms.label,
    paymentTermsMinutes: terms.minutes,
    latePenaltyPerDay: BALANCE.orders.latePenaltyPerDay,
    latePenaltyMax: BALANCE.orders.latePenaltyMax,
    cancelAfterLateMinutes: BALANCE.orders.cancelAfterLateMinutes,
    cancelFee: Math.round(fo.quantity * fo.unitPrice * BALANCE.orders.cancelFeePct),
    status: 'offered',
    priority: 0,
    reserved: [],
    acceptedAt: null,
    deliveredAt: null,
    paymentDueAt: null,
    invoiceAmount: null,
    paidAt: null,
    lateDays: 0,
    lateWarned: false,
    contested: false,
    lostTo: null,
  };

  const models = {} as Record<ModelId, ModelConfig>;
  for (const m of MODEL_IDS) models[m] = defaultModelConfig(m, BALANCE.models[m].unlockCost <= 0 || S.unlockedModels.includes(m));

  const opex = {} as Record<ExpenseCategory, number>;
  for (const e of EXPENSES) opex[e] = 0;

  const day = Math.floor(time / BALANCE.time.minutesPerDay) + 1;

  const state: GameState = {
    version: SAVE_VERSION,
    time,
    rng: normaliseSeed(seed),
    nextId,
    cash: S.cash,
    reputation: S.reputation,
    product: { models },
    inventory,
    shipments: [],
    warehouseLevel: 0,
    stations,
    rework: { queue: [], slot: null, issues: [] },
    vehicles: {},
    yard: [],
    orders: [firstOrder],
    market: createMarket(time),
    research: { completed: [], active: null },
    plan: [],
    staff: { ...S.staff },
    finance: {
      startingCash: S.cash,
      revenue: 0,
      cogs: 0,
      opex,
      capex: 0,
      materialsPurchased: 0,
      ledger: [],
      ledgerCarriedForward: 0,
      today: { day, revenue: 0, cogs: 0, expenses: 0, cashEnd: S.cash, built: 0 },
      history: [],
    },
    stats: {
      vehiclesStarted: 0,
      vehiclesBuilt: 0,
      ordersAccepted: 0,
      ordersDelivered: 0,
      ordersPaid: 0,
      ordersLate: 0,
      ordersCancelled: 0,
      marketSold: 0,
      purchases: 0,
      defectsCaught: 0,
      defectsEscaped: 0,
      reworksDone: 0,
      breakdowns: 0,
      builtToday: 0,
    },
    events: [],
    tutorial: { dismissed: false },
    insolventSince: null,
    gameOver: false,
    gameOverReason: null,
  };

  state.events.push({
    id: state.nextId++,
    time,
    kind: 'info',
    text: `Welcome to MotorWorx! You've taken over a small ${BALANCE.models[fo.model].defaultName} plant with $${S.cash.toLocaleString(
      'en-US',
    )} in the bank. ${fo.dealer} wants ${fo.quantity} ${BALANCE.trims[fo.trim].name} ${BALANCE.models[fo.model].defaultName}s — check the Orders tab.`,
  });

  return state;
}
