import { BALANCE, COMPONENT_IDS, MODEL_IDS, STATION_IDS, TRIM_IDS } from '../config/balance';
import type { ScenarioId } from '../config/balance';
import { normaliseSeed } from './rng';
import type {
  ComponentId,
  ComponentStock,
  ExpenseCategory,
  GameState,
  MarketState,
  ModelConfig,
  ModelId,
  PlantState,
  RivalSegment,
  RivalState,
  SalesOrder,
  StationId,
  StationState,
  WorkforceState,
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
  'interest',
];

function makeStation(id: StationId, condition: number, assigned: number): StationState {
  return {
    id,
    slots: [null],
    queue: [],
    capacityLevel: 0,
    reliabilityLevel: 0,
    condition,
    broken: false,
    service: null,
    assigned,
    issues: [],
    lastModel: null,
    energyAccrued: 0,
    completedTotal: 0,
    activeMinutesTotal: 0,
  };
}

/**
 * A plant with one slot per station. The starting plant uses BALANCE.start conditions and staffing;
 * new plants get fresh equipment, no staff, and a construction countdown.
 */
export function newPlant(id: number, name: string, constructionMinutes: number, conditionAdd = 0): PlantState {
  const first = id === 0;
  const stations = {} as Record<StationId, StationState>;
  for (const st of STATION_IDS) {
    const assigned = first ? (st === 'inspection' ? BALANCE.start.staff.inspector : BALANCE.start.assignments[st]) : 0;
    const condition = first ? Math.max(20, Math.min(100, BALANCE.start.stationCondition[st] + conditionAdd)) : BALANCE.plants.newCondition;
    stations[st] = makeStation(st, condition, assigned);
  }
  return {
    id,
    name,
    stations,
    rework: { queue: [], slot: null, issues: [] },
    allowedModels: [...MODEL_IDS],
    constructionRemaining: constructionMinutes,
  };
}

export function newWorkforce(): WorkforceState {
  return {
    wage: 'standard',
    morale: BALANCE.workforce.moraleStart,
    training: { operator: 0, inspector: 0, technician: 0 },
    course: null,
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

/** Game day a rival launches a model in a scenario (null = never). */
export function rivalLaunchDay(scenario: ScenarioId, rivalId: string, m: ModelId): number | null {
  const spec = BALANCE.competition.rivals.find((r) => r.id === rivalId);
  const d = spec?.launchDay[m] ?? null;
  return d === null ? null : Math.round(d * BALANCE.scenarios[scenario].rivalLaunchMult);
}

/** Rivals at their starting positions; segments whose launch day has arrived by `time` are active. */
export function createMarket(time: number, scenario: ScenarioId = 'standard'): MarketState {
  const day = Math.floor(time / BALANCE.time.minutesPerDay) + 1;
  const rivals: RivalState[] = BALANCE.competition.rivals.map((spec) => {
    const segments = {} as RivalState['segments'];
    for (const m of MODEL_IDS) {
      const launch = rivalLaunchDay(scenario, spec.id, m);
      const bySeg = {} as Record<(typeof TRIM_IDS)[number], RivalSegment>;
      for (const t of TRIM_IDS) {
        bySeg[t] = { active: launch !== null && launch <= day, priceIndex: spec.priceIndex, promoUntil: null };
      }
      segments[m] = bySeg;
    }
    return { id: spec.id, reputation: spec.reputation + BALANCE.scenarios[scenario].rivalReputationAdd, segments };
  });
  const empty = () => Object.fromEntries(BALANCE.competition.rivals.map((r) => [r.id, 0]));
  return { rivals, today: { day, player: 0, rivals: empty() }, history: [] };
}

/** Fresh game state built from BALANCE.start and the scenario's adjustments. */
export function createInitialState(seed: number = BALANCE.start.seed, scenario: ScenarioId = 'standard'): GameState {
  const S = BALANCE.start;
  const SC = BALANCE.scenarios[scenario] ?? BALANCE.scenarios.standard;
  const time = BALANCE.time.startMinute;
  let nextId = 1;

  const inventory = {} as Record<ComponentId, ComponentStock>;
  for (const c of COMPONENT_IDS) {
    const s = S.inventory[c];
    inventory[c] = { qty: s.qty, value: s.qty * s.unitCost, qualitySum: s.qty * s.quality };
  }


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
    cash: SC.cash,
    reputation: SC.reputation,
    product: { models },
    inventory,
    shipments: [],
    warehouseLevel: 0,
    plants: [newPlant(0, BALANCE.plants.sites[0].name, 0, SC.conditionAdd)],
    vehicles: {},
    yard: [],
    orders: [firstOrder],
    market: createMarket(time, scenario),
    research: { completed: [], active: null },
    goals: { scenario, completed: {}, wonAt: null },
    incidents: [],
    loans: [],
    workforce: newWorkforce(),
    plan: [],
    staff: { ...S.staff },
    finance: {
      startingCash: SC.cash,
      revenue: 0,
      cogs: 0,
      opex,
      capex: 0,
      materialsPurchased: 0,
      ledger: [],
      ledgerCarriedForward: 0,
      today: { day, revenue: 0, cogs: 0, expenses: 0, cashEnd: SC.cash, built: 0 },
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
    text: `Welcome to MotorWorx (${SC.name})! You've taken over a small ${BALANCE.models[fo.model].defaultName} plant with $${SC.cash.toLocaleString(
      'en-US',
    )} in the bank. ${fo.dealer} wants ${fo.quantity} ${BALANCE.trims[fo.trim].name} ${BALANCE.models[fo.model].defaultName}s — check the Orders tab.`,
  });

  return state;
}
