// Token Radar — scoring model "radar-2".
//
// The input is one sealed snapshot of DefiLlama's protocol index, taken
// once on 2026-11-14: 758 protocols at or above $5,000,000 of TVL, 40 of
// them on the house watchlist. The output is a ranked board of protocols
// that record no token, each with an implied launch value and a seven-step
// farm plan. Nothing here names a protocol by hand: every decision reads
// the snapshot's own fields, so the same program scores any snapshot the
// same way.
//
// The value model, in one breath: a protocol's TVL is worth a quarter of
// itself at launch, lifted when its TVL is compounding and trimmed when it
// is shrinking, lifted again the longer it has run without a token (up to
// three years), and lifted a little more for every extra chain it runs on
// (up to four). The farm plan is a rule table over the protocol's category,
// chains, TVL and age — never a list of names.

export type SnapshotProtocol = {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
};

export type Snapshot = {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
};

export type ModelConstants = {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  breadth_per_chain: number;
  breadth_max_chains: number;
};

// The tuning of model radar-2. base_multiple prices TVL at a quarter of
// itself; growth_weight takes seven-day growth at full strength; maturity
// runs from 0.65 for a brand-new listing to 1.00 after three years with no
// token; breadth adds 5% per extra chain, at most four.
export const MODEL: ModelConstants = {
  base_multiple: 0.25,
  growth_weight: 1.0,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.65,
  maturity_range: 0.35,
  maturity_days: 1095,
  unknown_age_days: 365,
  breadth_per_chain: 0.05,
  breadth_max_chains: 4,
};

export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the dashboard keeps in its Live view. */
export const LIVE_ROWS = 24;

export type FarmStep = {
  text: string;
  cost: string;
  time: string;
};

export type BoardRow = {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
};

export type RadarRow = {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
};

export type LiveRow = {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
};

export type RadarData = {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
  watchlist: string[];
};

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const MS_PER_DAY = 86_400_000;

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days between the snapshot date and the day listing began. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const snapshotDay = Date.parse(`${asOf}T00:00:00Z`);
  const listedDay = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(snapshotDay) || !Number.isFinite(listedDay)) return null;
  return Math.max(0, Math.floor((snapshotDay - listedDay) / MS_PER_DAY));
}

export type Score = {
  implied: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  breadthMult: number;
  age: number | null;
};

function clampGrowth(raw: number | null, t: ModelConstants): number {
  const g = asNumber(raw, 0);
  return Math.min(t.growth_cap, Math.max(t.growth_floor, g));
}

function maturityFactor(age: number | null, t: ModelConstants): number {
  const known = age ?? t.unknown_age_days;
  const capped = Math.min(Math.max(known, 0), t.maturity_days);
  return t.maturity_floor + (capped / t.maturity_days) * t.maturity_range;
}

function breadthFactor(chainCount: number, t: ModelConstants): number {
  const extra = Math.max(0, Math.min(chainCount - 1, t.breadth_max_chains));
  return 1 + extra * t.breadth_per_chain;
}

/**
 * Score one protocol. The arithmetic runs in a fixed order — base, then
 * growth, then maturity, then breadth — so the same snapshot always gives
 * the same implied value, down to the dollar.
 */
export function impliedValue(p: SnapshotProtocol, asOf: string, t: ModelConstants): Score {
  const age = ageDays(asOf, p.listed_at);
  const growthPct = clampGrowth(p.change_7d, t);
  const growthMult = 1 + (growthPct / 100) * t.growth_weight;
  const maturityMult = maturityFactor(age, t);
  const breadthMult = breadthFactor(p.chains.length, t);
  const base = p.tvl_usd * t.base_multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult * breadthMult));
  return { implied, growthPct, growthMult, maturityMult, breadthMult, age };
}

// A name ending in a version marker ("V2", "v2", "2.0") is a new edition of
// something, not a protocol of its own.
const VERSION_TAIL = /\s(?:[Vv]\d+(?:\.\d+)?|\d+\.\d+)$/;
// A whole word wrapped, staked or staking marks a product of a token that
// already trades.
const WRAPPED_WORD = /\b(?:wrapped|staked|staking)\b/i;
// Categories that are a wrapped, staked, bridged or exchange product by
// definition, so their token — if one ever comes — is not a fresh launch.
const BLOCKED_CATEGORIES = new Set([
  'CEX',
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
]);
// Names that start with an exchange are the exchange's own product.
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** No token on record: no market cap, no CoinGecko id, no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * A launch candidate: it records no token, and it is not a wrapped, staked,
 * bridged or exchange product of one that trades. The rule reads only the
 * snapshot's fields, so it can never be tuned to favour a name.
 */
export function isLaunchable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && BLOCKED_CATEGORIES.has(p.category)) return false;
  if (VERSION_TAIL.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  return !EXCHANGE_NAMES.some((prefix) => p.name.startsWith(prefix));
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

function mainChain(p: SnapshotProtocol): string {
  return p.chains[0] ?? 'its main chain';
}

/** How much capital the plan puts to work, from the protocol's own TVL. */
function stakeFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long the position must be held, from the protocol's age. */
function holdFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

type ActionRule = {
  words: string[];
  line: (name: string, capital: number, chain: string) => string;
};

// The first action, picked by the protocol's category. The rules run in
// order and the first one whose words appear in the category wins; a
// category that matches none of them falls through to the plain deposit.
const FIRST_ACTIONS: ActionRule[] = [
  {
    words: ['lend', 'cdp', 'collateral'],
    line: (name, capital, chain) => `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`,
  },
  {
    words: ['dex', 'yield', 'leveraged farm'],
    line: (name, capital, chain) => `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`,
  },
  {
    words: ['bridge'],
    line: (name, capital, chain) => `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`,
  },
  {
    words: ['staking', 'restak'],
    line: (name, capital, chain) => `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`,
  },
  {
    words: ['perpetual', 'derivative'],
    line: (name, capital, chain) => `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`,
  },
  {
    words: ['prediction'],
    line: (name, capital) => `Fund $${capital} and place one market position on ${name}.`,
  },
  {
    words: ['curator', 'allocator'],
    line: (name, capital, chain) => `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`,
  },
  {
    words: ['stable'],
    line: (name, capital, chain) => `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`,
  },
  {
    words: ['rwa'],
    line: (name, capital, chain) => `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`,
  },
  {
    words: ['insurance'],
    line: (name, capital, chain) => `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`,
  },
];

// The second action, a different move on the same protocol, so the farm
// reads as a pattern of use rather than a single deposit. Its order is its
// own: trading first, then borrowing, then the rest.
const SECOND_ACTIONS: ActionRule[] = [
  {
    words: ['dex', 'yield'],
    line: (name, capital, chain) =>
      `Swap $${Math.max(10, Math.round(capital / 5))} between two assets in ${name}'s pool on ${chain} so the wallet shows trading as well as liquidity.`,
  },
  {
    words: ['lend', 'cdp'],
    line: (name, capital) =>
      `Borrow $${Math.max(10, Math.round(capital / 5))} against the deposit on ${name} and repay it the same week, so the wallet shows borrowing as well as supplying.`,
  },
  {
    words: ['perpetual', 'derivative'],
    line: (name) => `Close the hedge on ${name} and open a fresh one the next week, so the wallet shows repeated use.`,
  },
  {
    words: ['prediction'],
    line: (name) => `Settle the first position on ${name} and place a second one on a different market.`,
  },
  {
    words: ['bridge'],
    line: (name) => `Bridge a smaller amount back through ${name} so the wallet shows both directions.`,
  },
];

function pickAction(rules: ActionRule[], category: string, name: string, capital: number, chain: string): string | null {
  const c = category.toLowerCase();
  for (const rule of rules) {
    if (rule.words.some((w) => c.includes(w))) return rule.line(name, capital, chain);
  }
  return null;
}

function firstAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const found = pickAction(FIRST_ACTIONS, p.category ?? '', p.name, capital, chain);
  return found ?? `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`;
}

function secondAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const found = pickAction(SECOND_ACTIONS, p.category ?? '', p.name, capital, chain);
  if (found !== null) return found;
  if (p.chains.length > 1) {
    return `Repeat the same position on ${p.name} on ${p.chains[1] ?? ''} so the wallet shows more than one chain.`;
  }
  return `Use a second feature of ${p.name} on ${chain}, such as its rewards page or a vote, so the wallet shows more than one action.`;
}

/**
 * One protocol's farm plan: seven steps, each an action with a cost and a
 * time. Every word of it is derived from the protocol's own record —
 * category, chains, TVL and age — so two protocols in the same shape get
 * the same shape of plan, and no name is ever special-cased.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = mainChain(p);
  const capital = stakeFor(p);
  const hold = holdFor(age);
  const small = Math.max(10, Math.round(capital / 5));
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: firstAction(p, capital, chain),
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: secondAction(p, capital, chain),
      cost: `about $${small} of capital and $2 of gas`,
      time: '10 minutes',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/**
 * Build the board. The watchlist comes first, every slug on it whatever its
 * TVL; then the early radar adds every launchable protocol below the
 * watchlist floor — the whole set, never a top-N cut. The board is sorted
 * by implied value, ties broken by slug so the order is fixed.
 */
export function buildBoard(snapshot: Snapshot, t: ModelConstants = MODEL): BoardRow[] {
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = bySlug.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  for (const p of snapshot.protocols) {
    if (chosen.has(p.slug)) continue;
    if (!isLaunchable(p)) continue;
    if (p.tvl_usd >= snapshot.floor_usd) continue;
    chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => ({ p, score: impliedValue(p, snapshot.as_of, t) }));
  scored.sort((a, b) => b.score.implied - a.score.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.score.age,
    implied_value_usd: s.score.implied,
    model: {
      base_multiple: t.base_multiple,
      growth_pct: s.score.growthPct,
      growth_multiplier: round4(s.score.growthMult),
      maturity_multiplier: round4(s.score.maturityMult),
      breadth_multiplier: round4(s.score.breadthMult),
      age_days: s.score.age,
    },
    farm_steps: farmSteps(s.p, s.score.age).map(stepText),
  }));
}

/** The live-token protocols, biggest market cap first, kept off the board. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
  };
}

export function buildRadar(snapshot: Snapshot, t: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, t);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: t,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
    watchlist: [...snapshot.watchlist],
  };
  return { board, radar };
}

function needText(o: Record<string, unknown>, key: string, what: string): string {
  if (typeof o[key] !== 'string') throw new SnapshotError(`snapshot.json: ${what} is missing or not text`);
  return o[key];
}

function needInt(o: Record<string, unknown>, key: string, what: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new SnapshotError(`snapshot.json: ${what} is missing or not a positive whole number`);
  return v;
}

/**
 * Read and check a snapshot. The shape is strict on purpose: a snapshot
 * that is missing a field, or carries one of the wrong kind, is refused
 * here rather than scored wrong further down the line.
 */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o: Record<string, unknown> = raw;
  const asOf = needText(o, 'as_of', 'as_of');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new SnapshotError('snapshot.json: as_of is not a YYYY-MM-DD date');
  const source = needText(o, 'source', 'source');
  const floor = needInt(o, 'floor_usd', 'floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json: protocols is not an array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json: watchlist is not an array of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json: protocol ${i} is not an object`);
    const p: Record<string, unknown> = v;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json: protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: asOf, source, floor_usd: floor, protocols, watchlist: o.watchlist as string[] };
}

/**
 * The board's own checks, run before anything is written: the watchlist
 * must be covered in full, ranks must run 1..N, implied value must not rise
 * as rank ascends, and every farm plan must hold 3–12 steps of 20–600
 * characters. The first problem found is the one reported.
 */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const onBoard = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !onBoard.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i].implied_value_usd > board[i - 1].implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0].implied_value_usd === board[board.length - 1].implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0].implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** The dashboard's data, as one script the page reads with no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
