/**
 * MotorWorx Tycoon — all tunable game data lives here.
 * Times are in game minutes. Money is in whole dollars.
 * Edit values freely; the simulation reads everything from this object.
 */

export const STATION_IDS = ['stamping', 'body', 'paint', 'final', 'inspection'] as const;
export type StationId = (typeof STATION_IDS)[number];

export const COMPONENT_IDS = ['steel', 'powertrain', 'interior', 'wheels', 'paint'] as const;
export type ComponentId = (typeof COMPONENT_IDS)[number];

export const TRIM_IDS = ['economy', 'premium'] as const;
export type TrimId = (typeof TRIM_IDS)[number];

export const MODEL_IDS = ['sedan', 'suv', 'pickup'] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export const FINISH_IDS = ['solid', 'metallic'] as const;
export type FinishId = (typeof FINISH_IDS)[number];

export type StaffRole = 'operator' | 'inspector' | 'technician';

export type Recipe = Partial<Record<StationId, Partial<Record<ComponentId, number>>>>;

/** Values for one model × trim combination. */
export interface TrimSpec {
  /** Reference market value; dealer order prices and market demand are measured against it. */
  baseValue: number;
  /** Customer appeal score (market demand scales with appeal / market.appealReference). */
  appeal: number;
  /** Open-market buyers per day at the reference price, reputation 50. */
  baseDemandPerDay: number;
  /** Components consumed at each station. */
  recipe: Recipe;
}

export interface ModelSpec {
  /** Vehicle class shown in the UI ("SUV"). */
  className: string;
  /** Default model name; the player can rename it. */
  defaultName: string;
  defaultColorId: string;
  blurb: string;
  /** One-off tooling investment to start building this model (0 = available from the start). */
  unlockCost: number;
  /** Reputation needed before the tooling can be bought. */
  minReputation: number;
  /** Multiplies every station's cycle time (on top of the trim multiplier). */
  timeMult: number;
  /** Relative chance that a dealer offer asks for this model (among unlocked models). */
  orderWeight: number;
  trims: Record<TrimId, TrimSpec>;
}

export const BALANCE = {
  time: {
    /** Game minutes simulated per tick (fixed timestep). */
    minutesPerTick: 1,
    /** Ticks per real second at 1× speed. 6 → one game day ≈ 4 real minutes. */
    ticksPerSecondAt1x: 6,
    speeds: [1, 2, 4] as const,
    /** Game starts on day 1 at 06:00. */
    startMinute: 6 * 60,
    minutesPerDay: 1440,
    /** Safety cap so a long frame (tab switch) cannot freeze the page. */
    maxTicksPerFrame: 240,
  },

  start: {
    seed: 20261020,
    cash: 120_000,
    reputation: 50,
    /** Models the player can build from day 1. */
    unlockedModels: ['sedan'] as ModelId[],
    /** Starting raw materials (bought earlier at Corvan prices/quality). */
    inventory: {
      steel: { qty: 6, unitCost: 1800, quality: 0.92 },
      powertrain: { qty: 0, unitCost: 6500, quality: 0.92 },
      interior: { qty: 0, unitCost: 2200, quality: 0.92 },
      wheels: { qty: 0, unitCost: 1200, quality: 0.92 },
      paint: { qty: 3, unitCost: 400, quality: 0.92 },
    } as Record<ComponentId, { qty: number; unitCost: number; quality: number }>,
    staff: { operator: 4, inspector: 1, technician: 1 } as Record<StaffRole, number>,
    /** Operators assigned per station at start (inspection is staffed by inspectors). */
    assignments: { stamping: 2, body: 2, paint: 0, final: 0, inspection: 0 } as Record<StationId, number>,
    stationCondition: { stamping: 86, body: 90, paint: 52, final: 82, inspection: 95 } as Record<StationId, number>,
    warehouseCapacity: 120,
    yardCapacity: 10,
    /** A guaranteed easy first order so the tutorial has something to accept. */
    firstOrder: {
      dealer: 'Northgate Motors',
      model: 'sedan' as ModelId,
      trim: 'economy' as TrimId,
      quantity: 3,
      unitPrice: 21_800,
      deadlineInMinutes: 48 * 60,
      offerLifetimeMinutes: 24 * 60,
      paymentTermIndex: 1,
    },
    defaultFinish: { economy: 'solid', premium: 'metallic' } as Record<TrimId, FinishId>,
  },

  components: {
    steel: { name: 'Steel coil', short: 'Steel', basePrice: 1800 },
    powertrain: { name: 'Powertrain kit', short: 'Powertrain', basePrice: 6500 },
    interior: { name: 'Interior kit', short: 'Interior', basePrice: 2200 },
    wheels: { name: 'Wheel set', short: 'Wheels', basePrice: 1200 },
    paint: { name: 'Paint drum', short: 'Paint', basePrice: 400 },
  } as Record<ComponentId, { name: string; short: string; basePrice: number }>,

  suppliers: [
    {
      id: 'brightline',
      name: 'Brightline Supply Co.',
      blurb: 'Budget bulk supplier. Cheap, slow and inconsistent.',
      priceMult: 0.85,
      leadMinutes: 10 * 60,
      quality: 0.8,
    },
    {
      id: 'corvan',
      name: 'Corvan Industrial',
      blurb: 'Dependable mid-market parts at list price.',
      priceMult: 1.0,
      leadMinutes: 5 * 60,
      quality: 0.92,
    },
    {
      id: 'apex',
      name: 'Apex Precision Parts',
      blurb: 'Premium tolerances and express freight.',
      priceMult: 1.25,
      leadMinutes: 2 * 60,
      quality: 0.985,
    },
  ],

  /** Trim levels shared by every model. Per-model values (recipe, value, demand) live in `models`. */
  trims: {
    economy: { name: 'Economy', timeMult: 1.0 },
    premium: { name: 'Premium', timeMult: 1.35 },
  } as Record<TrimId, { name: string; timeMult: number }>,

  models: {
    sedan: {
      className: 'Sedan',
      defaultName: 'Meridian',
      defaultColorId: 'ember',
      blurb: 'Compact four-door. Quick to build, steady demand.',
      unlockCost: 0,
      minReputation: 0,
      timeMult: 1.0,
      orderWeight: 1.0,
      trims: {
        economy: {
          baseValue: 21_500,
          appeal: 62,
          baseDemandPerDay: 2.6,
          recipe: { stamping: { steel: 2 }, paint: { paint: 1 }, final: { powertrain: 1, interior: 1, wheels: 1 } },
        },
        premium: {
          baseValue: 33_500,
          appeal: 84,
          baseDemandPerDay: 1.3,
          recipe: { stamping: { steel: 3 }, paint: { paint: 2 }, final: { powertrain: 1, interior: 2, wheels: 1 } },
        },
      },
    },
    suv: {
      className: 'SUV',
      defaultName: 'Kestrel',
      defaultColorId: 'cobalt',
      blurb: 'Family crossover. Bigger margins, slower to build, needs a strong reputation.',
      unlockCost: 90_000,
      minReputation: 55,
      timeMult: 1.25,
      orderWeight: 0.8,
      trims: {
        economy: {
          baseValue: 30_000,
          appeal: 68,
          baseDemandPerDay: 1.8,
          recipe: { stamping: { steel: 3 }, paint: { paint: 2 }, final: { powertrain: 1, interior: 2, wheels: 1 } },
        },
        premium: {
          baseValue: 43_000,
          appeal: 88,
          baseDemandPerDay: 1.0,
          recipe: { stamping: { steel: 4 }, paint: { paint: 3 }, final: { powertrain: 1, interior: 3, wheels: 1 } },
        },
      },
    },
    pickup: {
      className: 'Pickup',
      defaultName: 'Trailhand',
      defaultColorId: 'graphite',
      blurb: 'Work truck with a cargo bed. Heavy on steel, popular with fleet dealers.',
      unlockCost: 110_000,
      minReputation: 60,
      timeMult: 1.15,
      orderWeight: 0.9,
      trims: {
        economy: {
          baseValue: 28_000,
          appeal: 64,
          baseDemandPerDay: 2.0,
          recipe: { stamping: { steel: 4 }, paint: { paint: 2 }, final: { powertrain: 1, interior: 1, wheels: 1 } },
        },
        premium: {
          baseValue: 39_500,
          appeal: 80,
          baseDemandPerDay: 1.0,
          recipe: { stamping: { steel: 5 }, paint: { paint: 3 }, final: { powertrain: 1, interior: 2, wheels: 1 } },
        },
      },
    },
  } as Record<ModelId, ModelSpec>,

  /**
   * Retooling time added to a job when a station switches to a different model than its previous job.
   * Batching the same model back to back avoids it.
   */
  changeover: {
    minutes: { stamping: 45, body: 30, paint: 15, final: 20, inspection: 0 } as Record<StationId, number>,
  },

  finishes: {
    solid: { name: 'Solid', paintMult: 1, paintMinutesAdd: 0, appealAdd: 0, valueAdd: 0 },
    metallic: { name: 'Metallic', paintMult: 2, paintMinutesAdd: 20, appealAdd: 6, valueAdd: 900 },
  } as Record<FinishId, { name: string; paintMult: number; paintMinutesAdd: number; appealAdd: number; valueAdd: number }>,

  colors: [
    { id: 'ember', name: 'Ember Orange', hex: '#e8742a' },
    { id: 'graphite', name: 'Graphite', hex: '#4a4f57' },
    { id: 'glacier', name: 'Glacier White', hex: '#e8ecef' },
    { id: 'cobalt', name: 'Cobalt Blue', hex: '#2f5fb3' },
    { id: 'racing', name: 'Signal Red', hex: '#c8323a' },
    { id: 'moss', name: 'Moss Green', hex: '#4f7a4a' },
    { id: 'sand', name: 'Desert Sand', hex: '#c9b07a' },
    { id: 'onyx', name: 'Onyx Black', hex: '#1d1f22' },
  ],

  stations: {
    stamping: {
      name: 'Stamping',
      verb: 'Pressing body panels',
      baseMinutes: 60,
      staffRole: 'operator' as StaffRole,
      staffPerSlot: 2,
      energyPerActiveHour: 60,
      wearPerActiveMinute: 0.035,
    },
    body: {
      name: 'Body Assembly',
      verb: 'Welding body shell',
      baseMinutes: 90,
      staffRole: 'operator' as StaffRole,
      staffPerSlot: 2,
      energyPerActiveHour: 45,
      wearPerActiveMinute: 0.03,
    },
    paint: {
      name: 'Paint',
      verb: 'Painting body',
      baseMinutes: 75,
      staffRole: 'operator' as StaffRole,
      staffPerSlot: 1,
      energyPerActiveHour: 70,
      wearPerActiveMinute: 0.04,
    },
    final: {
      name: 'Final Assembly',
      verb: 'Installing powertrain, interior & wheels',
      baseMinutes: 120,
      staffRole: 'operator' as StaffRole,
      staffPerSlot: 2,
      energyPerActiveHour: 35,
      wearPerActiveMinute: 0.025,
    },
    inspection: {
      name: 'Quality Inspection',
      verb: 'Inspecting vehicle',
      baseMinutes: 45,
      staffRole: 'inspector' as StaffRole,
      staffPerSlot: 1,
      energyPerActiveHour: 15,
      wearPerActiveMinute: 0.015,
    },
  } as Record<
    StationId,
    {
      name: string;
      verb: string;
      baseMinutes: number;
      staffRole: StaffRole;
      staffPerSlot: number;
      energyPerActiveHour: number;
      wearPerActiveMinute: number;
    }
  >,

  /** Input buffer (queue) in front of each station except stamping. */
  queue: { baseCapacity: 2, perCapacityLevel: 1 },

  equipment: {
    /** Below this condition the UI shows a wear warning. */
    warnCondition: 60,
    /** Below this condition the UI shows "breakdown risk high". */
    dangerCondition: 35,
    /** Breakdown hazard only exists below this condition. */
    hazardThreshold: 60,
    /** Per active minute: hazardScale × ((threshold − condition)/threshold)². */
    hazardScale: 0.0025,
    maintenance: { cost: 1200, minutes: 60 },
    repair: { cost: 4500, minutes: 180, restoreCondition: 65 },
    /** Each reliability level multiplies wear and hazard by these factors. */
    reliabilityWearMult: 0.75,
    reliabilityHazardMult: 0.6,
  },

  quality: {
    baseDefect: 0.01,
    /** Defect chance added per (1 − component quality). */
    componentWeight: 0.45,
    /** Defect chance added per (1 − condition/100). */
    conditionWeight: 0.08,
    detectionBase: 0.55,
    detectionPerInspector: 0.15,
    detectionMax: 0.97,
    reworkCost: 900,
    reworkMinutes: 60,
    reworkQueueCapacity: 3,
    /** Escaped (undetected) defect discovered by a customer after delivery/sale. */
    escapedDefectWarrantyCost: 1500,
    escapedDefectReputation: -2,
  },

  staff: {
    operator: { name: 'Operator', plural: 'Operators', dailyWage: 340, hireFee: 600 },
    inspector: { name: 'Inspector', plural: 'Inspectors', dailyWage: 420, hireFee: 800 },
    technician: { name: 'Maintenance Technician', plural: 'Technicians', dailyWage: 460, hireFee: 900 },
    /** Severance paid on dismissal, in days of wages. */
    severanceDays: 1,
  } as {
    operator: { name: string; plural: string; dailyWage: number; hireFee: number };
    inspector: { name: string; plural: string; dailyWage: number; hireFee: number };
    technician: { name: string; plural: string; dailyWage: number; hireFee: number };
    severanceDays: number;
  },

  overhead: {
    /** Fixed daily site costs (rent, utilities base, insurance). Billed at midnight with energy. */
    dailyBase: 3600,
  },

  orders: {
    checkEveryMinutes: 60,
    baseChance: 0.07,
    chancePerReputation: 0.0012,
    maxOpenOffers: 4,
    offerLifetimeMinutes: 12 * 60,
    minQty: 2,
    maxQtyBase: 3,
    /** +1 max quantity per this many reputation points. */
    repPerExtraQty: 25,
    priceSpread: [0.93, 1.1] as [number, number],
    premiumShareBase: 0.25,
    premiumSharePerRep: 1 / 400,
    paymentTerms: [
      { label: 'Cash on delivery', minutes: 0, priceMult: 0.97 },
      { label: 'Net 12 hours', minutes: 12 * 60, priceMult: 1.0 },
      { label: 'Net 24 hours', minutes: 24 * 60, priceMult: 1.04 },
    ],
    /** Build-time estimate per vehicle used to set deadlines. */
    deadlineMinutesPerVehicle: 150,
    deadlineBaseMinutes: 8 * 60,
    deadlineSlackMinutes: [12 * 60, 30 * 60] as [number, number],
    /** Invoice reduced by this fraction per started day late (capped). */
    latePenaltyPerDay: 0.1,
    latePenaltyMax: 0.5,
    /** Order cancelled this long after the deadline. */
    cancelAfterLateMinutes: 48 * 60,
    /** Fraction of order value charged when a dealer cancels for lateness. */
    cancelFeePct: 0.1,
    repOnTime: 3,
    repLate: -4,
    repCancel: -10,
    dealers: [
      'Northgate Motors',
      'Harbor City Auto',
      'Redline Dealer Group',
      'Summit Autohaus',
      'Prairie Wheels',
      'Lakeside Car Center',
      'Ironbridge Fleet Sales',
      'Coastal Auto Mall',
    ],
  },

  market: {
    checkEveryMinutes: 10,
    /** Demand falls by e^(−elasticity × (price/reference − 1)). */
    elasticity: 4,
    /** Demand multiplier = repBase + reputation/100. */
    repBase: 0.5,
    /** Demand multiplier = appeal / appealReference. */
    appealReference: 70,
    maxPriceFactor: 2.5,
    repPerSale: 0.15,
  },

  /**
   * Rival manufacturers. Open-market buyers in each model × trim segment are shared between you and the
   * rivals active in it by "attractiveness" (appeal × reputation × price factor, same formula as yours).
   * Segment size = marketSizeCompanies × baseDemandPerDay, so at full parity you sell what you did without rivals.
   */
  competition: {
    marketSizeCompanies: 4,
    rivals: [
      {
        id: 'vantor',
        name: 'Vantor Automotive',
        color: '#3fa7d6',
        strategy: 'Budget',
        blurb: 'High-volume builder that undercuts on price and cuts deeper when it loses share.',
        /** Price as a multiple of the segment reference value. */
        priceIndex: 0.93,
        /** Added to the segment's appeal score. */
        appealAdj: -5,
        reputation: 48,
        /** Game day each model launches (0 = from the start, null = never). */
        launchDay: { sedan: 0, suv: 5, pickup: 3 } as Record<ModelId, number | null>,
      },
      {
        id: 'halberd',
        name: 'Halberd Motors',
        color: '#c94f6d',
        strategy: 'Premium',
        blurb: 'Established brand with polished cars and high prices. Rarely discounts.',
        priceIndex: 1.08,
        appealAdj: 6,
        reputation: 64,
        launchDay: { sedan: 0, suv: 0, pickup: null } as Record<ModelId, number | null>,
      },
      {
        id: 'sunline',
        name: 'Sunline Cars',
        color: '#d9a441',
        strategy: 'Balanced',
        blurb: 'Mid-market all-rounder with a strong pickup line and frequent promotions.',
        priceIndex: 1.0,
        appealAdj: 0,
        reputation: 52,
        launchDay: { sedan: 0, suv: 8, pickup: 0 } as Record<ModelId, number | null>,
      },
    ] as {
      id: string;
      name: string;
      color: string;
      strategy: string;
      blurb: string;
      priceIndex: number;
      appealAdj: number;
      reputation: number;
      launchDay: Record<ModelId, number | null>;
    }[],
    /** Each midnight a rival moves its price index by this step: down if its segment share is below fair, up if above. */
    priceStep: 0.02,
    /** Share band (as a multiple of the fair share 1/companies) inside which a rival drifts back toward its strategy price. */
    fairBand: [0.8, 1.25] as [number, number],
    minPriceIndex: 0.82,
    maxPriceIndex: 1.22,
    /** Chance per rival per day of starting a promotion in one random segment. */
    promoChancePerDay: 0.2,
    promoDiscount: 0.08,
    promoDays: 2,
    /** Rival reputation drifts toward this value by `repDrift` per day (the market's long-run average). */
    repTarget: 55,
    repDrift: 0.5,
    /** Open dealer offers can be won by a rival: chance per hour once the offer is this old. */
    offerSnipeAfterMinutes: 2 * 60,
    offerSnipeChancePerHour: 0.05,
    /** Dealer offer prices follow rival pricing: price × (1 + follow × (average rival index − 1)). */
    offerPriceFollow: 0.5,
    shareHistoryDays: 14,
  },

  reputation: { min: 0, max: 100 },

  finance: {
    /** Time allowed with negative cash before the company is declared insolvent. */
    insolvencyGraceMinutes: 24 * 60,
    /** Older ledger entries are folded into a carried-forward total. */
    ledgerMaxEntries: 1500,
    dailyHistoryDays: 14,
  },

  upgrades: {
    /** Station capacity: +1 work slot and +1 input queue space per level. */
    capacity: { costs: [45_000, 80_000] },
    /** Equipment reliability: less wear and fewer breakdowns per level. */
    reliability: { costs: [18_000, 32_000, 50_000] },
    /** Warehouse: more component storage and finished-vehicle yard spaces. */
    warehouse: { costs: [20_000, 35_000, 55_000], componentAdd: 80, yardAdd: 6 },
  },

  save: {
    autosaveKey: 'motorworx-tycoon-autosave-v1',
    manualKey: 'motorworx-tycoon-save-v1',
    autosaveRealSeconds: 30,
  },

  events: { maxLogEntries: 60 },
};

export type Balance = typeof BALANCE;
