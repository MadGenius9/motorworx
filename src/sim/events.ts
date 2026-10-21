/**
 * Goals, random events, loans and the workforce: the parts of the daily simulation that sit around
 * production. Called from engine.step; every cash change goes through postCash.
 */
import { BALANCE, COMPONENT_IDS } from '../config/balance';
import type { IncidentKind, StaffRole } from '../config/balance';
import { addReputation, logEvent, postCash } from './ledger';
import { chance, pick, randRange } from './rng';
import {
  activeIncidents,
  componentName,
  dayOf,
  formatMoney,
  goalProgress,
  incidentDetail,
  incidentTitle,
  medalFor,
  milestoneMet,
  modelName,
  operatingPlants,
  scenarioSpec,
} from './selectors';
import type { GameState, Incident } from './types';

const MPD = BALANCE.time.minutesPerDay;

// ───────────────────────────── goals ─────────────────────────────

/**
 * Awards newly reached milestones and checks the scenario goal. With `silent`, milestones already met
 * are recorded without events or rewards (used when an old save is loaded).
 */
export function checkGoals(state: GameState, silent = false): void {
  const g = state.goals;
  for (const [id, spec] of Object.entries(BALANCE.milestones)) {
    if (g.completed[id] !== undefined || !milestoneMet(state, id)) continue;
    g.completed[id] = state.time;
    if (silent) continue;
    if (spec.reputation) addReputation(state, spec.reputation);
    logEvent(
      state,
      'good',
      `Milestone reached: ${spec.name} (${spec.description.replace(/\.$/, '')})${spec.reputation ? `. Reputation +${spec.reputation}` : ''}.`,
      'milestone',
    );
  }
  if (g.wonAt === null && goalProgress(state).met) {
    g.wonAt = state.time;
    if (silent) return;
    const days = dayOf(state.time);
    const medal = medalFor(state, days);
    logEvent(
      state,
      'good',
      `Goal reached on day ${days}: ${scenarioSpec(state).name} won with a ${medal} rating! Keep playing as long as you like.`,
      'victory',
    );
  }
}

// ───────────────────────────── incidents ─────────────────────────────

function startIncident(state: GameState, inc: Omit<Incident, 'id' | 'startedAt'>): void {
  const full: Incident = { id: state.nextId++, startedAt: state.time, ...inc };
  state.incidents.push(full);
  const days = Math.round((full.until - state.time) / 60 / 24);
  const hours = Math.round((full.until - state.time) / 60);
  const span = full.until - state.time >= MPD ? `${days} day${days === 1 ? '' : 's'}` : `${hours}h`;
  const good = full.kind === 'boom';
  logEvent(state, good ? 'good' : 'bad', `${incidentTitle(state, full)} for ${span}. ${incidentDetail(full)}`, full.kind === 'laborStrike' ? 'strike' : 'incident');
}

/** Removes expired incidents and logs their end. */
export function expireIncidents(state: GameState): void {
  if (state.incidents.length === 0) return;
  const keep: Incident[] = [];
  for (const i of state.incidents) {
    if (i.until > state.time) {
      keep.push(i);
      continue;
    }
    const ended: Record<Incident['kind'], string> = {
      supplierStrike: `${incidentTitle(state, i).replace(' on strike', '')} is back to work. Held deliveries are on their way.`,
      priceSpike: `${i.component ? componentName(i.component) : 'Parts'} prices are back to normal.`,
      recession: 'The recession is over: buyers are returning.',
      boom: 'The buying boom has cooled off.',
      laborStrike: `Workers at ${state.plants[i.plant ?? 0]?.name ?? 'the plant'} are back on the line.`,
    };
    logEvent(state, 'info', ended[i.kind]);
  }
  state.incidents = keep;
}

function recallChance(state: GameState): { chance: number; cars: number; model: string } {
  const R = BALANCE.incidents.recall;
  const since = state.time - R.windowDays * MPD;
  const closed = Object.values(state.vehicles).filter(
    (v) => (v.stage === 'delivered' || v.stage === 'sold') && (v.closedAt ?? 0) >= since,
  );
  const escaped = closed.filter((v) => v.defect);
  if (escaped.length === 0) return { chance: 0, cars: 0, model: '' };
  const model = escaped[escaped.length - 1].model;
  const cars = closed.filter((v) => v.model === model).length;
  return { chance: Math.min(0.9, escaped.length * R.chancePerEscape), cars, model };
}

function doRecall(state: GameState, cars: number, model: Parameters<typeof modelName>[1]): void {
  const R = BALANCE.incidents.recall;
  const cost = cars * R.costPerCar;
  postCash(state, 'warranty', `Recall: ${cars} ${modelName(state, model)} cars inspected`, -cost);
  addReputation(state, R.reputation);
  logEvent(
    state,
    'bad',
    `Recall! Defects that reached customers forced a check of ${cars} recent ${modelName(state, model)} cars: ${formatMoney(cost)}, reputation ${R.reputation}. Better inspection prevents this.`,
    'incident',
  );
}

/** Midnight roll for a new random event. */
function rollIncident(state: GameState): void {
  const I = BALANCE.incidents;
  if (dayOf(state.time) <= I.graceDays) return;
  if (!chance(state, I.chancePerDay * scenarioSpec(state).incidentChanceMult)) return;
  const active = new Set(activeIncidents(state).map((i) => i.kind as IncidentKind));
  const recall = recallChance(state);
  const options = (Object.entries(I.weights) as [IncidentKind, number][]).filter(([k]) => {
    if (active.has(k)) return false;
    if (k === 'recession' && active.has('boom')) return false;
    if (k === 'boom' && active.has('recession')) return false;
    if (k === 'recall') return recall.cars > 0;
    return true;
  });
  if (options.length === 0) return;
  const total = options.reduce((n, [, w]) => n + w, 0);
  let r = randRange(state, 0, total);
  let kind = options[options.length - 1][0];
  for (const [k, w] of options) {
    r -= w;
    if (r < 0) {
      kind = k;
      break;
    }
  }
  switch (kind) {
    case 'supplierStrike':
      startIncident(state, { kind, until: state.time + I.supplierStrikeDays * MPD, supplierId: pick(state, BALANCE.suppliers).id });
      break;
    case 'priceSpike':
      startIncident(state, { kind, until: state.time + I.priceSpike.days * MPD, component: pick(state, [...COMPONENT_IDS]) });
      break;
    case 'recession':
      startIncident(state, { kind, until: state.time + I.recession.days * MPD });
      break;
    case 'boom':
      startIncident(state, { kind, until: state.time + I.boom.days * MPD });
      break;
    case 'recall':
      if (chance(state, recall.chance)) doRecall(state, recall.cars, recall.model as Parameters<typeof modelName>[1]);
      break;
    case 'laborStrike':
      break;
  }
}

// ───────────────────────────── loans ─────────────────────────────

function loansMidnight(state: GameState): void {
  if (state.loans.length === 0) return;
  const keep = [];
  for (const l of state.loans) {
    const interest = Math.round(l.balance * l.dailyRate);
    const principal = Math.min(l.balance, Math.max(0, l.dailyPayment - interest));
    postCash(state, 'interest', `Interest: ${l.name}`, -interest);
    postCash(state, 'loan', `Repayment: ${l.name}`, -principal);
    l.balance -= principal;
    if (l.balance <= 0) {
      logEvent(state, 'good', `${l.name} is paid off.`, 'loan');
    } else {
      keep.push(l);
    }
  }
  state.loans = keep;
}

// ───────────────────────────── workforce ─────────────────────────────

function workforceMidnight(state: GameState): void {
  const W = BALANCE.workforce;
  const wf = state.workforce;
  const target = W.wages[wf.wage].moraleTarget;
  wf.morale = Math.max(0, Math.min(100, Math.round((wf.morale + (target - wf.morale) * W.moraleDailyPull) * 10) / 10));
  const plants = operatingPlants(state);
  if (wf.morale < W.strike.belowMorale && plants.length && !activeIncidents(state).some((i) => i.kind === 'laborStrike')) {
    if (chance(state, W.strike.chancePerDay)) {
      startIncident(state, { kind: 'laborStrike', until: state.time + W.strike.minutes, plant: pick(state, plants) });
      wf.morale = Math.min(100, wf.morale + W.strike.moraleAfter);
    }
  }
}

/** Advances a running training course by one minute. */
export function trainingTick(state: GameState): void {
  const c = state.workforce.course;
  if (!c) return;
  c.remaining -= 1;
  if (c.remaining > 0) return;
  const wf = state.workforce;
  wf.training[c.role] = Math.min(BALANCE.workforce.training.maxLevel, wf.training[c.role] + 1);
  wf.course = null;
  wf.morale = Math.min(100, wf.morale + BALANCE.workforce.trainingMoraleBoost);
  logEvent(
    state,
    'good',
    `Training finished: ${BALANCE.staff[c.role as StaffRole].plural} are now level ${wf.training[c.role]}. Morale +${BALANCE.workforce.trainingMoraleBoost}.`,
    'research',
  );
}

/** Daily work around production: loans first (cash), then morale, then a possible random event. */
export function eventsMidnight(state: GameState): void {
  loansMidnight(state);
  workforceMidnight(state);
  rollIncident(state);
}
