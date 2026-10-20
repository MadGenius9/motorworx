/** Every player action is a Command applied by sim/commands.ts `applyCommand(state, cmd)`. */
import type { ComponentId, FinishId, ModelId, StaffRole, StationId, TrimId } from './types';

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
  | { type: 'scheduleBuild'; model: ModelId; trim: TrimId; quantity: number }
  | { type: 'moveJob'; jobId: number; dir: -1 | 1 }
  /** Removes the unstarted remainder of a job. Started vehicles keep flowing. */
  | { type: 'cancelJob'; jobId: number }
  // Suppliers
  | { type: 'purchase'; supplierId: string; component: ComponentId; quantity: number }
  /** Buys from one supplier every component still missing to build `cars` vehicles (net of stock and deliveries). */
  | { type: 'purchaseKit'; supplierId: string; model: ModelId; trim: TrimId; cars: number }
  // Staff
  | { type: 'hire'; role: StaffRole; count: number }
  | { type: 'fire'; role: StaffRole }
  /**
   * Moves one free worker onto (+1) or off (−1) a station. Operators staff the production stations;
   * Quality Inspection takes inspectors. `plant` defaults to 0.
   */
  | { type: 'assignOperator'; station: StationId; delta: 1 | -1; plant?: number }
  // Equipment
  | { type: 'scheduleMaintenance'; station: StationId; plant?: number }
  | { type: 'repair'; station: StationId; plant?: number }
  // Upgrades
  | { type: 'upgradeCapacity'; station: StationId; plant?: number }
  | { type: 'upgradeReliability'; station: StationId; plant?: number }
  | { type: 'upgradeWarehouse' }
  // Plants
  /** Buys and starts building the next plant site. */
  | { type: 'buildPlant' }
  /** Allows or forbids a plant to start a model. At least one model must stay allowed. */
  | { type: 'setPlantModel'; plant: number; model: ModelId; allowed: boolean }
  // Product (per model)
  /** Buys the model's tooling (BALANCE.models[model].unlockCost) so it can be built and ordered. */
  | { type: 'unlockModel'; model: ModelId }
  | { type: 'setProductName'; model: ModelId; name: string }
  | { type: 'setColor'; model: ModelId; colorId: string }
  | { type: 'setFinish'; model: ModelId; trim: TrimId; finish: FinishId }
  | { type: 'setPrice'; model: ModelId; trim: TrimId; price: number }
  | { type: 'setMarketListed'; model: ModelId; trim: TrimId; listed: boolean }
  // Research
  /** Pays the project's cost and starts it in the R&D lab (one at a time). */
  | { type: 'startResearch'; project: string }
  /** Stops the active project. Progress and money are lost. */
  | { type: 'cancelResearch' }
  // Tutorial
  | { type: 'dismissTutorial' }
  | { type: 'showTutorial' };

export interface CommandResult {
  ok: boolean;
  /** Player-facing explanation when ok=false (or confirmation when ok=true). */
  message?: string;
}
