/**
 * Simulation state. Everything here is plain JSON so it can be saved/loaded directly.
 * The simulation (src/sim) owns and mutates this; rendering and UI only read it.
 */
import type { ComponentId, FinishId, StaffRole, StationId, TrimId } from '../config/balance';

export type { ComponentId, FinishId, StaffRole, StationId, TrimId };

export const SAVE_VERSION = 1;

/** Where a vehicle physically is. Station ids mean "in that station's queue or a work slot". */
export type VehicleStage = StationId | 'rework' | 'finished' | 'delivered' | 'sold';

export interface Vehicle {
  id: number;
  /** Human-readable serial e.g. "MX-0007". */
  serial: string;
  trim: TrimId;
  finish: FinishId;
  /** Hex colour fixed when the vehicle is started. */
  color: string;
  stage: VehicleStage;
  /** Accumulated material cost (inventory cost basis). Labour is a period expense, not capitalised. */
  cost: number;
  /** True if the vehicle currently carries a defect (hidden until inspection catches it). */
  defect: boolean;
  /** Station names where defects were introduced (for UI after detection). */
  defectNotes: string[];
  /** True once inspection has caught the current defect (until rework fixes it). */
  defectDetected: boolean;
  reworkCount: number;
  /** Accepted sales order this finished vehicle is reserved to, or null. */
  orderId: number | null;
  /** Order the production job was scheduled for (display only; reservation happens at completion). */
  plannedForOrderId: number | null;
  startedAt: number;
  finishedAt: number | null;
  /** Time delivered or sold. */
  closedAt: number | null;
  /** Revenue recognised for this vehicle (per-unit invoice share or market price). */
  salePrice: number | null;
}

/** A unit of work in a station or the rework bay. */
export interface WorkSlot {
  vehicleId: number;
  /** Effective minutes of work completed. */
  progress: number;
  /** Minutes of work needed. */
  required: number;
  /** Work finished; waiting to move downstream (blocked if destination is full). */
  done: boolean;
  /** Average quality (0..1) of components consumed for this job; 1 if none. */
  componentQuality: number;
  /** Inspection only: result decided when inspection completes. */
  outcome: 'pass' | 'rework' | null;
}

export interface ServiceJob {
  kind: 'maintenance' | 'repair';
  remaining: number;
  total: number;
  cost: number;
}

export type IssueKind = 'broken' | 'service' | 'downstream' | 'materials' | 'staff' | 'idle' | 'cash';

/** Why a station (or the rework bay) is not doing full work this tick. Rebuilt every tick. */
export interface StationIssue {
  kind: IssueKind;
  /** Player-facing explanation, e.g. "Missing Powertrain kit (need 1, have 0)". */
  text: string;
  /** For 'materials': the components that are short. */
  components?: ComponentId[];
}

export interface StationState {
  id: StationId;
  /** Length = number of work slots (1 + capacityLevel). null = empty slot. */
  slots: (WorkSlot | null)[];
  /** Vehicle ids waiting in the input buffer, front first. Always empty for stamping. */
  queue: number[];
  capacityLevel: number;
  reliabilityLevel: number;
  /** 0..100 */
  condition: number;
  broken: boolean;
  service: ServiceJob | null;
  /** Operators assigned (unused for inspection, which uses all inspectors). */
  assigned: number;
  issues: StationIssue[];
  /** Energy cost accrued since the last midnight bill. */
  energyAccrued: number;
  /** Lifetime counters. */
  completedTotal: number;
  activeMinutesTotal: number;
}

export interface ReworkBayState {
  queue: number[];
  slot: WorkSlot | null;
  issues: StationIssue[];
}

export interface ComponentStock {
  qty: number;
  /** Total cost basis of units on hand. Average cost = value / qty. */
  value: number;
  /** Sum of quality over units on hand. Average quality = qualitySum / qty. */
  qualitySum: number;
}

export interface Shipment {
  id: number;
  supplierId: string;
  component: ComponentId;
  qty: number;
  unitCost: number;
  quality: number;
  orderedAt: number;
  arrivesAt: number;
}

export type OrderStatus = 'offered' | 'accepted' | 'delivered' | 'paid' | 'declined' | 'expired' | 'cancelled';

export interface SalesOrder {
  id: number;
  dealer: string;
  trim: TrimId;
  quantity: number;
  unitPrice: number;
  createdAt: number;
  offerExpiresAt: number;
  deadline: number;
  paymentTermsLabel: string;
  paymentTermsMinutes: number;
  latePenaltyPerDay: number;
  latePenaltyMax: number;
  cancelAfterLateMinutes: number;
  cancelFee: number;
  status: OrderStatus;
  /** Lower number = higher priority among accepted orders. */
  priority: number;
  /** Finished vehicle ids reserved to this order. */
  reserved: number[];
  acceptedAt: number | null;
  deliveredAt: number | null;
  paymentDueAt: number | null;
  invoiceAmount: number | null;
  paidAt: number | null;
  lateDays: number;
  /** Set once when the deadline passes while undelivered (to log one warning). */
  lateWarned: boolean;
}

export interface ProductionJob {
  id: number;
  trim: TrimId;
  quantity: number;
  /** Vehicles already started at stamping from this job. */
  started: number;
  orderId: number | null;
}

export type LedgerCategory =
  | 'sales' // cash received from orders and market sales
  | 'purchase' // component purchases (cash → inventory asset)
  | 'payroll'
  | 'utilities'
  | 'maintenance'
  | 'repair'
  | 'rework'
  | 'warranty'
  | 'hiring'
  | 'severance'
  | 'penalty'
  | 'upgrade';

export interface LedgerEntry {
  id: number;
  time: number;
  category: LedgerCategory;
  description: string;
  /** Signed cash movement: + inflow, − outflow. */
  amount: number;
  /** Cash balance after this entry. */
  balance: number;
}

export type ExpenseCategory =
  | 'payroll'
  | 'utilities'
  | 'maintenance'
  | 'repair'
  | 'rework'
  | 'warranty'
  | 'hiring'
  | 'severance'
  | 'penalty';

export interface DailySummary {
  day: number;
  revenue: number;
  cogs: number;
  expenses: number;
  cashEnd: number;
  built: number;
}

export interface FinanceState {
  startingCash: number;
  /** Revenue recognised (orders at delivery, market sales at sale). */
  revenue: number;
  /** Material cost of vehicles delivered/sold. */
  cogs: number;
  opex: Record<ExpenseCategory, number>;
  /** Upgrade spending (capital investment, not part of operating profit). */
  capex: number;
  /** Cash spent on components (moves cash into inventory, not an expense). */
  materialsPurchased: number;
  ledger: LedgerEntry[];
  /** Sum of ledger amounts that were trimmed from the front of the ledger. */
  ledgerCarriedForward: number;
  /** Running figures for the current day; pushed to history at midnight. */
  today: DailySummary;
  history: DailySummary[];
}

export interface EventLogEntry {
  id: number;
  time: number;
  kind: 'info' | 'good' | 'warn' | 'bad';
  text: string;
}

export interface ProductConfig {
  name: string;
  colorId: string;
  finish: Record<TrimId, FinishId>;
  price: Record<TrimId, number>;
  /** Whether unreserved finished vehicles of this trim are offered on the open market. */
  marketListed: Record<TrimId, boolean>;
}

export interface GameStats {
  vehiclesStarted: number;
  vehiclesBuilt: number;
  ordersAccepted: number;
  ordersDelivered: number;
  ordersPaid: number;
  ordersLate: number;
  ordersCancelled: number;
  marketSold: number;
  purchases: number;
  defectsCaught: number;
  defectsEscaped: number;
  reworksDone: number;
  breakdowns: number;
  builtToday: number;
}

export interface GameState {
  version: number;
  /** Game minutes since day 0 00:00. Day = floor(time/1440)+1 is NOT used; see selectors.formatTime. */
  time: number;
  /** Seeded RNG state (uint32). All randomness goes through it so runs are reproducible. */
  rng: number;
  nextId: number;
  cash: number;
  reputation: number;
  product: ProductConfig;
  inventory: Record<ComponentId, ComponentStock>;
  shipments: Shipment[];
  warehouseLevel: number;
  stations: Record<StationId, StationState>;
  rework: ReworkBayState;
  /** All vehicles, keyed by id. Delivered/sold vehicles are pruned beyond a history limit. */
  vehicles: Record<string, Vehicle>;
  /** Finished vehicle ids in the yard, oldest first. */
  yard: number[];
  orders: SalesOrder[];
  plan: ProductionJob[];
  staff: Record<StaffRole, number>;
  finance: FinanceState;
  stats: GameStats;
  events: EventLogEntry[];
  tutorial: { dismissed: boolean };
  /** Time cash first went negative, or null. */
  insolventSince: number | null;
  gameOver: boolean;
  gameOverReason: string | null;
}
