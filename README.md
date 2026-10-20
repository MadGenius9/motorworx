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
2. **Suppliers**: buy steel, powertrain kits, interior kits, wheel sets and paint. Deliveries take a few game hours.
3. **Staff**: hire operators and assign them to Paint and Final Assembly.
4. **Orders**: press *Schedule build* on the order.
5. Watch the cars move through Stamping → Body Assembly → Paint → Final Assembly → Quality Inspection. Defects that inspection catches go to the rework bay.
6. Press *Deliver* when all the cars are in the yard. Payment arrives after the order's payment terms.

Once you have some reputation and spare cash, open **Vehicles** to buy tooling for the **SUV** or the **Pickup**. Each model has its own parts recipe, build time, price and demand, and dealers start ordering it. Stations lose time retooling whenever they switch models, so schedule the same model back to back.

You are not alone: three rival makers (Vantor, Halberd, Sunline) compete for open-market buyers and react to your prices, run promotions, and launch new models over time. Dealer offers you leave waiting can be won by a rival. The **Market** tab shows market share, rival prices per segment and rival news.

Controls: drag to pan, mouse wheel to zoom, click a station for details and actions. Keys: **Space** pause, **1/2/3** for 1×/2×/4× speed, **Esc** closes the station panel.

## Code layout

| Path | Contents |
|---|---|
| `src/config/balance.ts` | All tunable values: prices, recipes, suppliers, stations, wages, probabilities, upgrades |
| `src/sim/` | Deterministic fixed-step simulation (1 tick = 1 game minute), commands, selectors, save/load. No DOM. |
| `src/game/GameController.ts` | Game loop, pause/speed, autosave, manual save/load |
| `src/render/` | Canvas factory renderer (camera, layout, vehicle drawing) |
| `src/ui/`, `src/App.tsx` | React panels: top bar, alerts, station drawer, tabs, tutorial |
| `tests/` | Validation tests (full order loop, materials, breakdowns, rework, payments, inventory, save/load, speed, ledger) |
| `docs/DESIGN.md` | Game rules and module contracts |

For debugging, the browser console has `window.motorworx` (the game controller).
