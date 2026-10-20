/** Every player action is a Command applied by sim/commands.ts `applyCommand(state, cmd)`. */
import type { ComponentId, FinishId, StaffRole, StationId, TrimId } from './types';

export type Command =
  // Orders
  | { type: 'acceptOrder'; orderId: number }
  | { type: 'declineOrder'; orderId: number }
  /** dir −1 = raise priority (earlier), +1 = lower. */
  | { type: 'moveOrderPriority'; orderId: number; dir: -1 | 1 }
  | { type: 'deliverOrder'; orderId: number }
  /** Adds a production job for the order's shortfall (qty − reserved − in production − already scheduled). */
  | { type: 'scheduleForOrder'; orderId: number }
  // Production plan
  | { type: 'scheduleBuild'; trim: TrimId; quantity: number }
  | { type: 'moveJob'; jobId: number; dir: -1 | 1 }
  /** Removes the unstarted remainder of a job. Started vehicles keep flowing. */
  | { type: 'cancelJob'; jobId: number }
  // Suppliers
  | { type: 'purchase'; supplierId: string; component: ComponentId; quantity: number }
  // Staff
  | { type: 'hire'; role: StaffRole; count: number }
  | { type: 'fire'; role: StaffRole }
  /** Operators only; inspection cannot be assigned (it uses all inspectors). */
  | { type: 'assignOperator'; station: StationId; delta: 1 | -1 }
  // Equipment
  | { type: 'scheduleMaintenance'; station: StationId }
  | { type: 'repair'; station: StationId }
  // Upgrades
  | { type: 'upgradeCapacity'; station: StationId }
  | { type: 'upgradeReliability'; station: StationId }
  | { type: 'upgradeWarehouse' }
  // Product
  | { type: 'setProductName'; name: string }
  | { type: 'setColor'; colorId: string }
  | { type: 'setFinish'; trim: TrimId; finish: FinishId }
  | { type: 'setPrice'; trim: TrimId; price: number }
  | { type: 'setMarketListed'; trim: TrimId; listed: boolean }
  // Tutorial
  | { type: 'dismissTutorial' }
  | { type: 'showTutorial' };

export interface CommandResult {
  ok: boolean;
  /** Player-facing explanation when ok=false (or confirmation when ok=true). */
  message?: string;
}
