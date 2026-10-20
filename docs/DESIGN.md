# MotorWorx Tycoon — Design & Module Contracts

Desktop-first browser game. React 18 + TypeScript + Vite, Canvas 2D factory, localStorage saves, no backend.

## Module layout (ownership)

| Path | Owner | Notes |
|---|---|---|
| `src/config/balance.ts` | shared (lead) | All tunable numbers. Never hard-code balance values elsewhere. |
| `src/sim/types.ts`, `src/sim/commandTypes.ts`, `src/game/types.ts` | shared (lead) | Contracts. Do not change without telling the lead. |
| `src/sim/*.ts` (rng, initialState, engine, commands, selectors, save) | Sim agent | Pure TS. No DOM, no React. |
| `src/render/*` | Renderer agent | Canvas factory view + `FactoryCanvas.tsx` React wrapper. |
| `src/ui/*`, `src/App.tsx`, `src/main.tsx`, `src/styles.css` | UI agent | React panels and layout. |
| `src/game/GameController.ts`, `tests/*`, `scripts/*` | Controller/QA agent | Loop, saves, validation tests. |

Rule: **simulation never imports render/UI; render/UI never mutate state except through `controller.dispatch(command)`.**

## Time

* 1 tick = 1 game minute (`BALANCE.time.minutesPerTick`). Fixed timestep.
* At 1× speed, 6 ticks per real second (one game day ≈ 4 real minutes). 2× and 4× multiply ticks. Pause = zero ticks.
* `state.time` = minutes since day 0 00:00; game starts at `BALANCE.time.startMinute` (day 1 06:00 means time = 360; day number = floor(time/1440)+1).
* Midnight (time % 1440 === 0 after the tick) = daily billing.

## Simulation step (`engine.ts` → `export function step(state: GameState): void`)

Order within one tick (deterministic; all randomness via `state.rng`):
1. If `state.gameOver` → return without changing anything.
2. `state.time += 1`.
3. Shipments whose `arrivesAt <= time` move into inventory (qty, value = qty×unitCost, qualitySum = qty×quality). Event log entry.
4. Stations processed downstream-first: inspection, rework bay, final, paint, body, stamping. Each station's `issues` array is rebuilt every tick.
5. Market sales (every `market.checkEveryMinutes`).
6. Order generation (every `orders.checkEveryMinutes`), offer expiry, late warnings, auto-cancellation, payment collection.
7. Midnight billing (payroll + utilities = overhead.dailyBase + Σ station.energyAccrued), daily summary push, `builtToday` reset.
8. Insolvency: cash < 0 → set `insolventSince` (if null); cash ≥ 0 → clear. If `time − insolventSince ≥ finance.insolvencyGraceMinutes` → `gameOver = true`, reason text.

### Station tick
```
if service: remaining -= 1; issue 'service'; when remaining<=0: maintenance → condition=100; repair → broken=false, condition=max(condition, repair.restoreCondition); service=null. return.
if broken: issue 'broken' ("Breakdown — production stopped. Repair needed."); return.
1. Route done slots: stamping→body.queue, body→paint.queue, paint→final.queue, final→inspection.queue,
   inspection: outcome 'rework' → rework.queue (cap quality.reworkQueueCapacity), 'pass' → yard (cap yardCapacity).
   Destination full → slot stays (done=true), issue 'downstream' ("Output blocked: <Next> queue full").
   On entering the yard: stage='finished', finishedAt, stats.vehiclesBuilt++, builtToday++, then allocateReservations().
2. Fill empty slots (only if staffFactor > 0, else issue 'staff' "No operators assigned"/"No inspectors on staff"):
   stamping: first plan job with started < quantity (none → issue 'idle' "No production scheduled").
             Needs recipe[trim].stamping components. Creates the Vehicle (serial MX-0001…, color from product, finish from product.finish[trim], plannedForOrderId=job.orderId), job.started++, remove job when started==quantity. stats.vehiclesStarted++.
   others:   head of queue (empty → issue 'idle' "Waiting for vehicles"). Needs recipe[trim][station] (paint qty × finish.paintMult).
   Missing components → issue 'materials' "Missing Powertrain kit (need 1, have 0)" with components list; do NOT start, do not consume anything. FIFO (head-of-line blocks).
   Consumption: deduct qty, value (at average cost), qualitySum (at average quality); vehicle.cost += value consumed; slot.componentQuality = consumed avg quality (1 if none).
   required = round(baseMinutes × trim.timeMult) (+ finish.paintMinutesAdd at paint).
3. Work: each active, not-done slot: progress += staffFactor; condition -= wearPerActiveMinute × reliabilityWearMult^level × staffFactor (floor 0); energyAccrued += energyPerActiveHour/60; activeMinutesTotal++.
   staffFactor = min(1, staff / (staffPerSlot × slots.length)), staff = assigned operators (inspection: staff.inspector).
   If 0 < staffFactor < 1 add issue 'staff' "Understaffed: 1/2 operators (50% speed)".
   On completion (progress ≥ required): done=true, completedTotal++.
     Production stations: defect roll p = baseDefect + (1−componentQuality)×componentWeight + (1−condition/100)×conditionWeight → vehicle.defect=true, push station name to defectNotes.
     Inspection: if vehicle.defect: detected with probability detectionRate → outcome 'rework', defectDetected=true, stats.defectsCaught++; else 'pass'. Clean vehicle → 'pass'.
4. Breakdown (only if any slot worked this tick): if condition ≤ 0 → break; else if condition < hazardThreshold: p = hazardScale × ((threshold−condition)/threshold)² × reliabilityHazardMult^level. Break → broken=true, stats.breakdowns++, event 'bad'. Work in slots is frozen (kept) until repaired.
```
Rework bay (no staff, no breakdowns): done slot → inspection.queue if space (stage='inspection'), else issue 'downstream'. Empty slot + queue non-empty: needs cash ≥ reworkCost (else issue 'cash'); charge ledger 'rework' (opex), start slot (required = reworkMinutes). Completion: defect=false, defectDetected=false, defectNotes=[], reworkCount++, stats.reworksDone++. **Rework never creates or removes vehicles.**

### Reservations
`allocateReservations(state)`: accepted orders sorted by priority; for each with reserved.length < quantity, take the oldest unreserved yard vehicles of the order's trim. Called when a vehicle enters the yard, an order is accepted, or priorities change. Existing reservations are never stolen.

### Orders
* Offer generation (hourly): if open offers < maxOpenOffers and rng < baseChance + reputation×chancePerReputation. Trim premium with prob premiumShareBase + rep×premiumSharePerRep. Qty uniform in [minQty, maxQtyBase + floor(rep/repPerExtraQty)]. Terms random from paymentTerms. unitPrice = round50(baseValue(trim) × uniform(priceSpread) × (0.92 + rep/600) × terms.priceMult). deadline = now + deadlineBaseMinutes + qty×deadlineMinutesPerVehicle + uniform(deadlineSlackMinutes). cancelFee = round(qty×unitPrice×cancelFeePct).
* The initial state contains one offer built from `BALANCE.start.firstOrder`.
* Offer expires at offerExpiresAt → 'expired'.
* Accepted order past deadline: one 'warn' event (lateWarned). Past deadline + cancelAfterLateMinutes: 'cancelled', reservations released (vehicles orderId=null → available to market/other orders, then allocateReservations), cancelFee charged (ledger 'penalty'), rep += repCancel, stats.ordersCancelled++; production jobs for it get orderId=null.
* `deliverOrder`: only status 'accepted' with reserved.length === quantity. lateDays = ceil(max(0, time−deadline)/1440); invoice = round(qty×unitPrice×(1−min(latePenaltyMax, lateDays×latePenaltyPerDay))). Revenue += invoice (recognised now), COGS += Σ vehicle.cost, vehicles → stage 'delivered', removed from yard, salePrice = invoice/qty. Escaped defects among them: each → warranty cost (ledger 'warranty') + rep escapedDefectReputation, stats.defectsEscaped++. Rep += repOnTime or repLate (and ordersLate++). status='delivered', paymentDueAt = time + paymentTermsMinutes; if terms are 0, collect immediately. A second deliver call fails ("already delivered").
* Payment collection: status 'delivered' and time ≥ paymentDueAt → cash += invoice, ledger 'sales', status 'paid', paidAt. Exactly once.

### Market
Every 10 min per trim, if product.marketListed[trim] and an unreserved yard vehicle of that trim exists: sell with probability ratePerDay × 10/1440, where
`ratePerDay = baseDemandPerDay × (appeal+finish.appealAdd)/appealReference × (repBase + rep/100) × min(maxPriceFactor, exp(−elasticity × (price/ref − 1)))`, `ref = baseValue + finish.valueAdd`.
Sale: cash += price (ledger 'sales'), revenue += price, cogs += vehicle.cost, stage 'sold', escaped defect handling as above, rep += repPerSale, stats.marketSold++.

### Money rules
* **Every** cash change goes through one helper `postCash(state, category, description, amount)` that updates cash, appends a ledger entry with balance, and updates finance totals (opex categories, capex for 'upgrade', materialsPurchased for 'purchase'). Ledger trimming keeps `startingCash + ledgerCarriedForward + Σ ledger.amount === cash`.
* Purchases: cash → inventory asset. Consumption moves value into vehicle.cost (WIP) — **no cash entry**. Delivery/sale moves vehicle.cost into COGS.
* Player commands that cost money fail with a message if cash is insufficient. Automatic costs (payroll, utilities, warranty, cancel fee) may push cash negative → insolvency timer.

### Staff & equipment commands
* hire: fee×count (ledger 'hiring'). fire: severance = dailyWage×severanceDays (ledger 'severance'); operator requires an unassigned operator; technician requires a free technician (not on a service job); cannot fire the last inspector? — allowed (inspection then stops; alerts explain).
* assignOperator: +1 needs an unassigned operator; −1 needs assigned > 0; not for inspection.
* scheduleMaintenance: station not broken, no service, a free technician, cash ≥ cost → ledger 'maintenance', service job. repair: station broken, no service, free technician, cash → ledger 'repair', service job.
* Upgrades: capacity (+1 slot, +1 queue space) costs[capacityLevel]; reliability costs[reliabilityLevel]; warehouse costs[warehouseLevel] adds componentAdd capacity and yardAdd yard spaces. Ledger 'upgrade' (capex).
* purchase: qty integer 1..999; cost = round(basePrice×priceMult)×qty; requires cash and warehouse space (on hand + incoming + qty ≤ capacity).

## Vehicle models (milestone 2)

* `BALANCE.models` defines the Sedan (unlocked at start), SUV and Pickup. Each has a class name, default name/colour, `unlockCost` (tooling, booked as capital spending via ledger category `upgrade`), `minReputation`, `timeMult` (applied on top of the trim's `timeMult`), `orderWeight`, and per-trim `baseValue`, `appeal`, `baseDemandPerDay` and `recipe`. `BALANCE.trims` now only holds the shared trim name and time multiplier.
* `state.product.models[model]` holds the player's settings per model: `unlocked`, name, colour, finish/price/market listing per trim. Vehicles, sales orders and production jobs all carry `model`.
* `unlockModel` fails until reputation ≥ `minReputation` and cash ≥ `unlockCost` (the starting reputation is below every requirement, so there is no day-1 trap). `scheduleBuild` rejects locked models.
* Dealer offers pick among unlocked models weighted by `orderWeight` (no RNG draw while only one model is unlocked). Reservations and market sales match model **and** trim.
* **Changeover:** each station remembers `lastModel`. Starting a vehicle of a different model adds `BALANCE.changeover.minutes[station]` to that slot (`slot.changeover`, included in `required`). The renderer shows `RETOOLING` and the plan flags model switches, so batching the same model pays off.
* Saves are version 2. `deserialize` migrates version 1 saves: everything becomes the sedan, the old product settings become the sedan's, other models start locked (`tests/fixtures/save-v1.json` covers this).

## Competition (milestone 3)

* `BALANCE.competition.rivals`: Vantor (budget), Halberd (premium), Sunline (balanced). Each has a strategy price index, an appeal adjustment, a starting reputation and a launch day per model.
* **Open market:** each model × trim segment has `marketSizeCompanies × baseDemandPerDay` buyers per day. They split between the player (only while the player has unreserved stock listed) and active rivals by attractiveness = appeal/70 × (0.5 + rep/100) × price factor. Missing rivals are stood in for by generic importers at parity, so at full parity the player sells what they did before rivals existed. Rival sales are tracked as expected values in `state.market.today/history`.
* **Rival moves at midnight:** launch models on schedule; cut the price index by `priceStep` when below 0.8× a fair share, raise it above 1.25×, otherwise drift back toward their strategy price (clamped to 0.82–1.22). Each rival may start a promotion (−8 %, 2 days) in one segment. Rival reputation drifts toward 55.
* **Dealer offers:** prices follow the average rival price index in the segment (half-weight). Offers the player leaves waiting for 2 h+ can be won by a rival (5 % per hour) → status `lost`, `lostTo`. The tutorial's first order is never contested; accepted orders can't be lost.
* **UI:** Market tab (overall share, per-segment share and rival prices, rival profiles, daily sales, rival news). Alert "X isn't selling" when unreserved stock would take more than 3 days to clear, with a one-click price match.
* Saves are version 3; v2 saves gain fresh rivals and uncontested existing offers.

## Research (milestone 4)

* `BALANCE.research.projects`: 12 projects in three branches (Process, Quality, Product), each with cost, game-minute duration, prerequisites and an effect. `state.research = { completed, active }`.
* `startResearch` pays the cost up front (ledger/expense category `research`, part of operating expenses) and needs the prerequisites, a free lab and cash. `cancelResearch` loses progress and refunds nothing. The lab ticks once per game minute alongside production.
* `researchEffects(state)` combines completed effects. They are applied where the numbers are computed: `cycleMinutes(…, state)`, `changeoverMinutes`, `recipeFor(…, state)` (steel saved, never below 1), equipment wear, defect chance, `detectionRate`, player appeal in `segmentShares`, and the dealer-offer chance.
* Balance check (automated player, 20 days, 6 seeds): product research pays clearly (+19 % net worth); quality and process research are near neutral for a demand-limited player and pay back within days once the line is the bottleneck.
* Saves are version 4; v3 saves start with nothing researched.

## Multiple plants (milestone 5)

* `state.plants[]` (index = plant id). Each `PlantState` has its own `stations`, `rework` bay, `allowedModels` and `constructionRemaining`. Shared company-wide: cash, the parts warehouse (`inventory`, shipments), the finished-vehicle `yard`, the production `plan`, technicians, research and the market. `Vehicle.plant` records where it is built.
* `BALANCE.plants.sites`: Riverside (start), Eastgate ($320k, reputation 60), Harborview ($480k, reputation 75). `buildPlant` pays the site (capital spending) and starts a 2-day construction; one at a time. A plant under construction does no work. Each operating plant adds `overhead.dailyBase` per day.
* Stamping in each plant takes the first plan job whose model is in that plant's `allowedModels` (`setPlantModel`, at least one model stays allowed). Dedicated plants avoid model changeovers.
* Staff: operators and inspectors are hired company-wide and assigned per plant station (`assignOperator` with `plant`; Quality Inspection takes inspectors). New inspectors auto-assign to the inspection line that needs them most. Detection rate is per plant.
* Station selectors take an optional `plant` (default 0): `stationStatus`, `staffFactor`, `queueCapacity`, `changeoverMinutes`, `breakdownRisk`, `detectionRate`, `nextUpgradeCost`… Per-station commands (`repair`, `scheduleMaintenance`, `upgradeCapacity`, `upgradeReliability`) take an optional `plant`. Alerts carry the plant in their `openStation` actions.
* UI: a plant switcher over the factory view (status dots, construction countdown); the station panel, Staff tab and Upgrades tab follow the selected plant; the Upgrades tab lists plants and builds the next site.
* Balance check (automated player, 25 days, 6 seeds): building the second plant around day 10 ends at +45 % net worth.
* Saves are version 5; v4 saves become a single Riverside plant with every inspector assigned to it.

## Selectors (`src/sim/selectors.ts`) — read-only helpers used by UI and renderer

```ts
export type PanelTab = 'orders' | 'vehicles' | 'market' | 'suppliers' | 'staff' | 'finances' | 'research' | 'upgrades';
export type StationStatus = 'running' | 'idle' | 'blocked' | 'understaffed' | 'broken' | 'repair' | 'maintenance';
export type AlertAction =
  | { kind: 'openTab'; tab: PanelTab }
  | { kind: 'openStation'; station: StationId }
  | { kind: 'command'; command: Command };
export interface Alert { id: string; severity: 'critical' | 'warning' | 'info'; title: string; cause: string; actions: { label: string; action: AlertAction }[] }
export interface TutorialStep { id: string; title: string; text: string; done: boolean; action?: { label: string; action: AlertAction } }

dayOf(time): number; clockOf(time): string /* "14:05" */; formatTime(time): string /* "Day 2 · 14:05" */
formatDuration(minutes): string /* "3h 20m", "45m", "1d 2h" */; formatMoney(n): string /* "$12,300", "−$1,200" */
stationName(id): string
stationStatus(state, id): StationStatus      // broken>repair>maintenance>blocked(downstream|materials|cash)>understaffed(no staff or partial)>running>idle
stationStaff(state, id): number; stationRequiredStaff(state, id): number; staffFactor(state, id): number
queueCapacity(state, id): number             // 0 for stamping
cycleMinutes(id, model, trim, finish): number; changeoverMinutes(state, id, model): number
breakdownHazardPerHour(state, id): number; breakdownRisk(state, id): 'low' | 'elevated' | 'high'
detectionRate(state): number
unassignedOperators(state): number; freeTechnicians(state): number
warehouseCapacity(state): number; yardCapacity(state): number
stockOnHand(state): number; incomingUnits(state): number
avgUnitCost(state, c): number; avgQuality(state, c): number   // fall back to Corvan list price / quality when empty
dailyPayroll(state): number
projectedDailyCosts(state): { payroll: number; overhead: number; energy: number; total: number }
marketDemandPerDay(state, model, trim, price?): number
estimateUnitCost(state, model, trim): { materials: number; byComponent: Partial<Record<ComponentId, number>>; laborOverhead: number; total: number }
  // laborOverhead = projectedDailyCosts.total / estimated daily throughput (bottleneck: 1440 / max over stations of cycle/slots), clearly an estimate
estimatedProfitPerVehicle(state, model, trim, price?): number
inventoryValue(state): { raw: number; incoming: number /* paid, in transit */; wip: number; finished: number; total: number }
receivables(state): number; outstandingOrderValue(state): number /* accepted not yet delivered + receivables */
financeSummary(state): { revenue; cogs; grossProfit; opexTotal; operatingProfit; capex; materialsPurchased }
actualTrimResults(state, model, trim): { unitsSold: number; avgPrice: number; avgCost: number; avgMargin: number }
orderProgress(state, order): { reserved: number; inProduction: number; scheduled: number; shortfall: number; ready: boolean; late: boolean; minutesLeft: number }
ledgerReconciliation(state): { expected: number; actual: number; ok: boolean }
nextUpgradeCost(state, kind: 'capacity' | 'reliability', station: StationId): number | null; nextWarehouseCost(state): number | null
getAlerts(state): Alert[]       // sorted critical first; each names its cause and offers ≥1 working action
tutorialSteps(state): TutorialStep[]
vehiclesInStage(state, stage): Vehicle[]
modelName(state, m); modelClassName(m); vehicleLabel(state, m, t) /* "Kestrel Premium" */; trimSpec(m, t); unlockedModels(state); unlockBlocker(state, m): string | null
```

Alerts to cover: broken station (Repair command), service in progress (info), high breakdown risk (Schedule maintenance), missing materials (open Suppliers), no/under staff (open Staff), downstream blocked (open station), rework waiting for cash, yard full (open Orders/Vehicles), order ready (Deliver command), order late / at risk with shortfall (Schedule build command), new offers (open Orders), nothing scheduled while idle (open Orders), payroll exceeds cash (open Finances), insolvency countdown (open Finances), warehouse nearly full (open Suppliers).

Tutorial steps: accept first order → buy components → staff Paint & Final Assembly → schedule production for the order → build & inspect cars → deliver the order → collect payment.

## Save (`src/sim/save.ts`)
`serialize(state): string`, `deserialize(json): GameState` (throws a readable Error on bad/incompatible data; checks `version === SAVE_VERSION`), `createInitialState(seed?)` lives in `initialState.ts`.

## Visual style
Industrial: charcoal `#1b1d20` / `#24272b`, steel gray `#3a3f45` / `#8a939c`, text `#e6e8ea`, orange accent `#f07c1e`. Status: running green `#3fb950`, idle gray `#8a939c`, blocked/understaffed amber `#e3a008`, broken red `#e5484d`, maintenance/repair blue `#3b82f6`. Readable system font stack, tabular numbers.
