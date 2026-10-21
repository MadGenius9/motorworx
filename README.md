# MotorWorx Tycoon

A browser tycoon game: run a small car factory, take dealer orders, buy parts, staff the line, keep the machines running, and grow the business. Built with React 18, TypeScript, Vite, and a Canvas 2D factory view. No backend or accounts; saves go to the browser's localStorage.

## Launch

```bash
npm install
npm run dev          # open the printed URL (default http://localhost:5173)
```

To build and serve a production copy:

```bash
npm run build
npm run preview      # http://localhost:4173
```

## Checks

```bash
npm run typecheck    # TypeScript
npm test             # Vitest simulation and controller tests
npm run smoke        # builds, serves, and plays through the UI in headless Chromium
```

## How to play

The tutorial card (bottom left) walks through the first order:

1. **Orders**: accept the Northgate Motors offer.
2. **Suppliers**: buy steel, powertrain kits, interior kits, wheel sets and paint. The tutorial's button (or **Parts kit** in Suppliers) buys exactly what's missing in one click. Deliveries take a few game hours.
3. **Staff**: hire operators and assign them to Paint and Final Assembly.
4. **Orders**: press *Schedule build* on the order.
5. Watch the cars move through Stamping → Body Assembly → Paint → Final Assembly → Quality Inspection. Defects that inspection catches go to the rework bay.
6. Press *Deliver* when all the cars are in the yard. Payment arrives after the order's payment terms.

Once you have some reputation and spare cash, open **Vehicles** to buy tooling for the **SUV** or the **Pickup**. Each model has its own parts recipe, build time, price and demand, and dealers start ordering it. Stations lose time retooling whenever they switch models, so schedule the same model back to back.

You are not alone: three rival makers (Vantor, Halberd, Sunline) compete for open-market buyers and react to your prices, run promotions, and launch new models over time. Dealer offers you leave waiting can be won by a rival. The **Market** tab shows market share, rival prices per segment and rival news.

The **R&D** tab runs one research project at a time: faster stations, fewer defects, cheaper builds, more dealer orders and more appealing cars. Each project costs cash up front and finishes after some game hours.

Pick a **scenario** when you start a new game: the Standard start, Shoestring (little cash, worn machines) or a Crowded market (stronger rivals). Each has a goal (a net worth, plus market share in the crowded market) and a gold/silver/bronze rating by how many days you take. The **Goals** tab tracks the goal, twelve milestones and any active events. Reaching the goal doesn't end the game.

From day 6, random events shake things up: supplier strikes, parts price spikes, recessions and booms, and recalls if defective cars reach customers. **Finances** offers loans when you need cash fast (repaid daily with interest). In **Staff**, wages set morale: happy workers are faster and make fewer mistakes, unhappy ones may strike. Training courses make operators, inspectors and technicians better.

When reputation and cash allow, build a second (and third) plant from **Upgrades**. Each plant has its own line, staff and upgrades, and shares cash, parts, the yard and the production plan. Switch plants with the tabs above the factory, and dedicate a plant to one model (Stamping panel) to avoid retooling.

The factory is shown in **3D** (three.js/WebGL): drag to pan, right-drag (or Shift+drag) to rotate, mouse wheel to zoom toward the cursor, click a station for details and actions. The **2D** button switches to the flat plan view; browsers without WebGL get the 2D view automatically. On phones and tablets the panel sits under the factory view: one finger pans, pinch zooms, and two-finger twist rotates the 3D view. Sound effects (synthesized, no downloads) can be muted or turned down with the speaker button. Keys: **Space** pause, **1/2/3** for 1×/2×/4× speed, **Esc** closes the station panel.

## Code layout

| Path | Contents |
|---|---|
| `src/config/balance.ts` | All tunable values: prices, recipes, suppliers, stations, wages, probabilities, upgrades |
| `src/sim/` | Deterministic fixed-step simulation (1 tick = 1 game minute), commands, selectors, save/load. No DOM. |
| `src/game/GameController.ts` | Game loop, pause/speed, autosave, manual save/load |
| `src/render/` | Floor-plan layout, the 2D canvas renderer (fallback / plan view) and `FactoryCanvas`, which picks 3D or 2D |
| `src/render3d/` | three.js renderer: hall, stations and machines, extruded per-model cars, warehouse, dock, boards, labels |
| `src/ui/`, `src/App.tsx` | React panels: top bar, alerts, station drawer, tabs, tutorial |
| `tests/` | Validation tests (full order loop, materials, breakdowns, rework, payments, inventory, save/load, speed, ledger) |
| `docs/DESIGN.md` | Game rules and module contracts |

For debugging, the browser console has `window.motorworx` (the game controller).
