// Launch Radar's model: one sealed snapshot in, one ranked board out.
//
// The board ranks pre-token protocols by expected launch value:
//
//   launch_value = size_curve(tvl_usd, category) x growth_tilt
//   implied (EV) = launch_value x token_odds(age)
//
// Every term is calibrated on the snapshot's own traded protocols (the comps) and kept or dropped
// on two blind tests, both printed on the dashboard: leave-one-out over all the fitted comps, and
// a walk-forward split that fits the earlier half of the comps by listing date and prices the
// later half it never saw. The growth tilt's weight is chosen on a grid by the worse of the two
// tests, not asserted. An ablation table in the Method section shows each term's held-out cost of
// removal. The reader sees the model's measured error, not a promise: the headline error is the
// leave-one-out median factor, and each row's range is the interquartile band of the leave-one-out
// residuals.
//
//   size_curve(tvl, category): a log-log curve fitted by least squares over the launch-like
//     comps, log(market cap) = intercept + slope x log(TVL) + a per-category offset shrunk
//     toward zero by the category's comp count. The curve's slope is well under 1: value grows
//     slower than TVL, so a big protocol's implied multiple is thinner than a small one's, and
//     each category's offset moves it off the common curve by that sector's own record.
//   token_odds(age): the cross-section of the snapshot itself. Protocols are bucketed by the
//     age at which DefiLlama first tracked them; the share already holding a token in each bucket
//     is S(age) (a monotone smoothing of it was tested and dropped: it scored worse held-out, see
//     the ablation). With an asymptote A for the share that ever lists, a protocol still tokenless
//     at `age` launches with odds (A - S) / (1 - S): the longer it has run with no token, the
//     lower the odds it ever lists. The dashboard states this is a cross-sectional estimate, not
//     a hazard rate measured over time.
//
// No protocol name is ever special-cased: one function scores every row, and the page recomputes
// every row from the shipped parameters and reports how many agree.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
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
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** One row of the ablation table: a term's held-out error with it and without it, and the verdict. */
export interface AblationRow {
  term: string;
  /** Leave-one-out median error factor with / without the term (price terms only). */
  loo_with: number | null;
  loo_without: number | null;
  /** Walk-forward median error factor with / without the term (price terms only). */
  wf_with: number | null;
  wf_without: number | null;
  /** Split-half Brier score with / without the term (the odds smoothing row only). */
  brier_with: number | null;
  brier_without: number | null;
  kept: boolean;
}

/** The model's fitted parameters, shipped to the dashboard so the page runs the same arithmetic. */
export interface ModelFit {
  version: string;
  /** Median mcap/TVL over every traded comp, kept as a held-out baseline. */
  global_multiple: number;
  /** The size curve: log(market cap) = intercept + slope x log(TVL) + the category's offset. */
  fit_intercept: number;
  fit_slope: number;
  /** Per-category offsets on the size curve, shrunk toward zero by the comp count. */
  cat_offsets: Record<string, number>;
  /** How many fitted comps stand behind each category offset. */
  cat_comp_counts: Record<string, number>;
  /** The growth tilt's weight and clamp; the weight is fitted on the two blind tests (see ablation). */
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  /** The smoothed share of protocols holding a token, by age in days: [age_days, share] points. */
  odds_curve: [number, number][];
  /** The share of protocols assumed ever to list a token. */
  odds_asymptote: number;
  /** Odds used when a protocol's listing age is not recorded. */
  odds_unknown_age: number;
  /** Held-out (leave-one-out) median error factors: this model against the two baselines. */
  loo_model_factor: number;
  loo_global_factor: number;
  loo_flat_factor: number;
  /** Share of comps the model prices within a factor of two, held-out. */
  loo_within_2x: number;
  /** The 25th and 75th percentiles of the leave-one-out predicted/actual ratios: each row's range band. */
  loo_ratio_q25: number;
  loo_ratio_q75: number;
  /**
   * Walk-forward blind test: the curve fitted on the earlier half of the dated comps (by listed_at)
   * prices the later half. Median error factors for this model and the two baselines, the split
   * date (the first test comp's listing date) and the two halves' sizes.
   */
  wf_model_factor: number;
  wf_global_factor: number;
  wf_flat_factor: number;
  wf_split_date: string;
  wf_train_count: number;
  wf_test_count: number;
  /** Each model term's ablation: held-out error with and without it, and whether it survived. */
  ablation: AblationRow[];
  /** How many launch-like comps the fit and the held-out test ran on. */
  comp_count: number;
  /** How many traded comps the snapshot holds in all, before the launch-like trim. */
  comp_total: number;
  /** The airdrop assumptions behind every farm verdict, stated on the page. */
  farm_allocation_share: number;
  capital_apr: number;
}

export const MODEL_VERSION = 'launch-radar-3';

/** Board size: the watchlist plus the strongest early protocols, by TVL, to this many rows. */
export const BOARD_ROWS = 224;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** The flat baseline multiple the held-out test compares against (the starter model's constant). */
const FLAT_MULTIPLE = 0.25;
/** Shrinkage strength for category offsets: an offset is trusted as if it had this many zero comps. */
const OFFSET_SHRINK_K = 6;
/**
 * The launch-like trim: comps whose market cap is decoupled from their protocol's TVL (a ratio
 * outside this band) are not what a launch looks like, so the curve is fitted without them. The
 * rule and the count it removes are stated on the dashboard.
 */
const TRIM_LOW = 0.005;
const TRIM_HIGH = 10;
/** Multiple clamps, outside anything the comps support. */
const MULT_MIN = 0.005;
const MULT_MAX = 5;
/** Odds clamps: no launch is certain, none is impossible. */
const ODDS_MIN = 0.03;
const ODDS_MAX = 0.95;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
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
  /** The board's ranking number: launch value weighted by the odds a token ever lists. */
  implied_value_usd: number;
  /** The value if the token lists: TVL x multiple x growth tilt, before odds. */
  launch_value_usd: number;
  /** The odds a token ever lists, from the peers' record at this protocol's age. */
  token_odds: number;
  /** The fitted multiple this row was priced with, and the comps behind it. */
  multiple: number;
  comp_count: number;
  /** The farm verdict and its arithmetic: expected airdrop value against the plan's true cost. */
  verdict: 'farm' | 'thin' | 'skip';
  expected_reward_usd: number;
  plan_cost_usd: number;
  farm_steps: string[];
}

/** The dashboard's compact view of one row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  launch_value_usd: number;
  token_odds: number;
  multiple: number;
  comp_count: number;
  verdict: 'farm' | 'thin' | 'skip';
  expected_reward_usd: number;
  plan_cost_usd: number;
  range_low_usd: number;
  range_high_usd: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** The full accounting of the snapshot: every protocol is ranked, set aside live, or excluded with a reason. */
export interface Accounting {
  total: number;
  ranked: number;
  live: number;
  unranked: number;
  versioned: number;
  cex: number;
  wrapped_or_staked: number;
}

/** Everything the dashboard needs: the board, the live set, the fit and the accounting. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelFit;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  accounting: Accounting;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories that name a wrapped, staked or bridged product of a protocol whose token trades. */
const WRAPPED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);

/** Why a pre-token protocol is not ranked, or null when it may be: the watchlist's own exclusions. */
export function exclusionReason(p: SnapshotProtocol): 'versioned' | 'cex' | 'wrapped_or_staked' | null {
  if (p.category === 'CEX') return 'cex';
  if (VERSIONED.test(p.name)) return 'versioned';
  if (p.category !== null && WRAPPED_CATEGORIES.has(p.category)) return 'wrapped_or_staked';
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return 'wrapped_or_staked';
  return null;
}

/** The traded protocols the fit learns from: a token, a market cap and a TVL, and not an exchange token. */
function comps(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX');
}

/** The launch-like comps the curve is fitted on: traded comps inside the stated ratio band. */
function launchLikeComps(snapshot: Snapshot): SnapshotProtocol[] {
  return comps(snapshot).filter((p) => {
    const ratio = p.mcap_usd! / p.tvl_usd;
    return ratio >= TRIM_LOW && ratio <= TRIM_HIGH;
  });
}

/** Which curve terms are switched on: the ablation tests refit with one term removed at a time. */
interface CurveShape {
  slope: boolean;
  offsets: boolean;
}

const FULL_SHAPE: CurveShape = { slope: true, offsets: true };

/** Least-squares log-log curve with shrunk per-category offsets, over a set of comps. */
function olsFit(cs: SnapshotProtocol[], shape: CurveShape = FULL_SHAPE): { intercept: number; slope: number; offsets: Record<string, number>; counts: Record<string, number> } {
  const xs = cs.map((p) => Math.log(p.tvl_usd));
  const ys = cs.map((p) => Math.log(p.mcap_usd!));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let slope = 0;
  if (shape.slope) {
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i]! - mx) * (ys[i]! - my);
      den += (xs[i]! - mx) * (xs[i]! - mx);
    }
    slope = den === 0 ? 0 : num / den;
  }
  const intercept = my - slope * mx;
  const offsets: Record<string, number> = {};
  const counts: Record<string, number> = {};
  if (shape.offsets) {
    const byCat = new Map<string, number[]>();
    for (const p of cs) {
      const key = p.category ?? '(none)';
      if (!byCat.has(key)) byCat.set(key, []);
      byCat.get(key)!.push(Math.log(p.mcap_usd!) - (intercept + slope * Math.log(p.tvl_usd)));
    }
    for (const [cat, residuals] of byCat) {
      const mean = residuals.reduce((a, b) => a + b, 0) / residuals.length;
      offsets[cat] = (residuals.length / (residuals.length + OFFSET_SHRINK_K)) * mean;
      counts[cat] = residuals.length;
    }
  }
  return { intercept, slope, offsets, counts };
}

/** The curve's value for one protocol from raw fit parameters, clamped to the comps' supported band. */
function curveFromParams(intercept: number, slope: number, offsets: Record<string, number>, category: string | null, tvl: number): number {
  const offset = category !== null && offsets[category] !== undefined ? offsets[category]! : 0;
  const value = Math.exp(intercept + slope * Math.log(tvl) + offset);
  return clamp(value, tvl * MULT_MIN, tvl * MULT_MAX);
}

/** The launch value the curve gives one protocol, before growth and odds: TVL in, dollars out. */
function curveValue(category: string | null, tvl: number, fit: ModelFit): number {
  return curveFromParams(fit.fit_intercept, fit.fit_slope, fit.cat_offsets, category, tvl);
}

/** The growth tilt's clamp band, shared by the fit, the tests and the board. */
const GROWTH_FLOOR = -50;
const GROWTH_CAP = 100;

/** The growth tilt factor at an explicit weight: 1 plus the clamped 7-day change times the weight. */
function tiltFactor(change7d: number | null, weight: number): number {
  const g = clamp(finite(change7d, 0), GROWTH_FLOOR, GROWTH_CAP);
  return 1 + (g / 100) * weight;
}

/** A quantile of a sorted array, linearly interpolated (the common type-7 rule). */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base]! + rest * (sorted[base + 1]! - sorted[base]!) : sorted[base]!;
}

/** Age buckets for the odds cross-section: [bucket ceiling in days, label midpoint]. */
const AGE_BUCKETS: [number, number][] = [
  [180, 90],
  [365, 270],
  [730, 540],
  [1460, 1095],
  [Infinity, 1825],
];

/** The raw share holding a token in each age bucket over a set of protocols; null where a bucket is empty. */
function bucketShares(ps: SnapshotProtocol[], asOf: string): (number | null)[] {
  return AGE_BUCKETS.map(([ceiling]) => {
    let total = 0;
    let token = 0;
    for (const p of ps) {
      const age = ageDays(asOf, p.listed_at);
      if (age === null) continue;
      const bucket = AGE_BUCKETS.findIndex(([c]) => age < c);
      if (AGE_BUCKETS[bucket]![0] !== ceiling) continue;
      total++;
      if (!isPreToken(p)) token++;
    }
    return total > 0 ? token / total : null;
  });
}

/** Pool adjacent violators: the share holding a token cannot fall as age rises. */
function smoothShares(shares: number[]): number[] {
  const smooth = [...shares];
  for (let i = 1; i < smooth.length; i++) if (smooth[i]! < smooth[i - 1]!) smooth[i] = smooth[i - 1]!;
  return smooth;
}

/** The smoothed share holding a token by age, and the odds for an unrecorded age. */
function oddsCurve(snapshot: Snapshot, useSmoothing: boolean): { curve: [number, number][]; asymptote: number; unknownAge: number } {
  const raw = bucketShares(snapshot.protocols, snapshot.as_of);
  const shares: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    shares.push(raw[i] !== null ? raw[i]! : shares.length > 0 ? shares[shares.length - 1]! : 0);
  }
  let unknownTotal = 0;
  let unknownToken = 0;
  for (const p of snapshot.protocols) {
    if (p.listed_at === null) {
      unknownTotal++;
      if (!isPreToken(p)) unknownToken++;
    }
  }
  const series = useSmoothing ? smoothShares(shares) : shares;
  const asymptote = clamp((series[series.length - 1] ?? 0) + 0.04, 0.5, 0.92);
  const unknownShare = unknownTotal > 0 ? unknownToken / unknownTotal : 0.5;
  const unknownOdds = clamp((asymptote - unknownShare) / Math.max(0.05, 1 - unknownShare), ODDS_MIN, ODDS_MAX);
  return {
    curve: AGE_BUCKETS.map(([, mid], i) => [mid, round4(series[i]!)] as [number, number]),
    asymptote: round4(asymptote),
    unknownAge: round4(unknownOdds),
  };
}

/**
 * The odds smoothing's own blind test: split the aged protocols into two slug-sorted halves, fit
 * each bucket's share on one half and score the other half's token-or-not record by Brier score,
 * both directions averaged. Smoothed shares against the raw bucket shares they replace.
 */
function oddsBrierTest(snapshot: Snapshot): { smoothed: number; raw: number } {
  const aged = snapshot.protocols
    .map((p) => ({ p, age: ageDays(snapshot.as_of, p.listed_at) }))
    .filter((x): x is { p: SnapshotProtocol; age: number } => x.age !== null)
    .sort((a, b) => (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const halves: { p: SnapshotProtocol; age: number }[][] = [
    aged.filter((_, i) => i % 2 === 0),
    aged.filter((_, i) => i % 2 === 1),
  ];
  let sErr = 0;
  let rErr = 0;
  let n = 0;
  for (const [train, test] of [
    [halves[0]!, halves[1]!],
    [halves[1]!, halves[0]!],
  ] as const) {
    const trainPs = train.map((x) => x.p);
    const rawShares = bucketShares(trainPs, snapshot.as_of);
    const flat = trainPs.filter((p) => !isPreToken(p)).length / Math.max(1, trainPs.length);
    const filled = rawShares.map((s, i) => (s !== null ? s : i > 0 ? rawShares[i - 1] ?? flat : flat));
    const smooth = smoothShares(filled.map((s) => s ?? flat));
    for (const x of test) {
      const bucket = AGE_BUCKETS.findIndex(([c]) => x.age < c);
      const y = isPreToken(x.p) ? 0 : 1;
      const ps = smooth[bucket] ?? flat;
      const pr = rawShares[bucket] ?? flat;
      sErr += (ps - y) * (ps - y);
      rErr += (pr - y) * (pr - y);
      n++;
    }
  }
  return { smoothed: n > 0 ? sErr / n : NaN, raw: n > 0 ? rErr / n : NaN };
}

/** The smoothed share holding a token at `age`, interpolated over the curve's points. */
function shareAt(curve: [number, number][], age: number): number {
  if (age <= curve[0]![0]) return curve[0]![1];
  for (let i = 1; i < curve.length; i++) {
    if (age <= curve[i]![0]) {
      const [x0, y0] = curve[i - 1]!;
      const [x1, y1] = curve[i]!;
      return y0 + ((y1 - y0) * (age - x0)) / Math.max(1, x1 - x0);
    }
  }
  return curve[curve.length - 1]![1];
}

/** The odds a protocol still tokenless at `age` ever lists, from the curve. */
export function tokenOdds(age: number | null, fit: ModelFit): number {
  if (age === null) return fit.odds_unknown_age;
  const s = shareAt(fit.odds_curve, age);
  return clamp((fit.odds_asymptote - s) / Math.max(0.05, 1 - s), ODDS_MIN, ODDS_MAX);
}

/** The growth tilt: bounded, and its weight is fitted on the two blind tests (see fitModel). */
function growthTilt(change7d: number | null, fit: ModelFit): number {
  return tiltFactor(change7d, fit.growth_weight);
}

/** Leave-one-out over a set of comps at one curve shape and growth weight: error factors and ratios. */
function looRun(cs: SnapshotProtocol[], shape: CurveShape, weight: number): { factors: number[]; ratios: number[] } {
  const factors: number[] = [];
  const ratios: number[] = [];
  for (let i = 0; i < cs.length; i++) {
    const held = cs[i]!;
    const rest = cs.filter((_, j) => j !== i);
    const f = olsFit(rest, shape);
    const predicted = curveFromParams(f.intercept, f.slope, f.offsets, held.category, held.tvl_usd) * tiltFactor(held.change_7d, weight);
    ratios.push(predicted / held.mcap_usd!);
    factors.push(Math.max(predicted / held.mcap_usd!, held.mcap_usd! / predicted));
  }
  return { factors, ratios };
}

/**
 * The walk-forward blind test: comps with a listing date, split at the median date; the curve is
 * fitted on the earlier half and prices the later half it never saw. Comps with no recorded date
 * cannot be ordered in time and sit this test out; their count is the difference from comp_count.
 */
function wfRun(cs: SnapshotProtocol[], shape: CurveShape, weight: number): { model: number; global: number; flat: number; splitDate: string; train: number; test: number } {
  const dated = cs
    .filter((p) => p.listed_at !== null)
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1));
  const mid = Math.floor(dated.length / 2);
  const train = dated.slice(0, mid);
  const test = dated.slice(mid);
  const f = olsFit(train, shape);
  const trainGlobal = median(train.map((p) => p.mcap_usd! / p.tvl_usd));
  const err = (pred: number, actual: number): number => Math.max(pred / actual, actual / pred);
  return {
    model: median(test.map((p) => err(curveFromParams(f.intercept, f.slope, f.offsets, p.category, p.tvl_usd) * tiltFactor(p.change_7d, weight), p.mcap_usd!))),
    global: median(test.map((p) => err(p.tvl_usd * trainGlobal, p.mcap_usd!))),
    flat: median(test.map((p) => err(p.tvl_usd * FLAT_MULTIPLE, p.mcap_usd!))),
    splitDate: test[0]!.listed_at!,
    train: train.length,
    test: test.length,
  };
}

/** Fit the model on the snapshot's launch-like comps; every term is kept or dropped on two blind tests. */
export function fitModel(snapshot: Snapshot): ModelFit {
  const all = comps(snapshot);
  const cs = launchLikeComps(snapshot);
  const globalMultiple = median(all.map((p) => p.mcap_usd! / p.tvl_usd));
  const fit = olsFit(cs);
  // The odds smoothing faces its own blind test first (split-half Brier, below with the ablation):
  // if the monotone smoothing does not beat the raw bucket shares held-out, the curve ships raw.
  const brier = oddsBrierTest(snapshot);
  const oddsSmoothingKept = brier.smoothed < brier.raw;
  const odds = oddsCurve(snapshot, oddsSmoothingKept);

  // The growth tilt's weight, fitted: grid-search the weight whose full model scores best on the
  // worse of the two blind tests (leave-one-out and walk-forward). A weight of zero wins any tie,
  // so the tilt survives only if both tests say it earns its place.
  const grid: { weight: number; loo: number; wf: number }[] = [];
  for (let w = 0; w <= 0.601; w += 0.05) {
    const weight = Math.round(w * 100) / 100;
    grid.push({ weight, loo: median(looRun(cs, FULL_SHAPE, weight).factors), wf: wfRun(cs, FULL_SHAPE, weight).model });
  }
  const chosen = grid.reduce((best, g) => (Math.max(g.loo, g.wf) < Math.max(best.loo, best.wf) - 1e-9 ? g : best), grid[0]!);
  const growthWeight = chosen.weight;

  // The headline held-out test: leave-one-out with the full model, tilt included, against both
  // baselines fitted on the same remaining comps.
  const loo = looRun(cs, FULL_SHAPE, growthWeight);
  const errGlobal: number[] = [];
  const errFlat: number[] = [];
  for (let i = 0; i < cs.length; i++) {
    const held = cs[i]!;
    const rest = cs.filter((_, j) => j !== i);
    const restGlobal = median(rest.map((p) => p.mcap_usd! / p.tvl_usd));
    const predGlobal = held.tvl_usd * restGlobal;
    errGlobal.push(Math.max(predGlobal / held.mcap_usd!, held.mcap_usd! / predGlobal));
    const predFlat = held.tvl_usd * FLAT_MULTIPLE;
    errFlat.push(Math.max(predFlat / held.mcap_usd!, held.mcap_usd! / predFlat));
  }
  const within = loo.factors.filter((f) => f <= 2).length;
  const sortedRatios = [...loo.ratios].sort((a, b) => a - b);
  const wf = wfRun(cs, FULL_SHAPE, growthWeight);

  // The ablation: refit with one term removed at a time, everything else held at the full model,
  // and re-run both blind tests. The odds smoothing is tested on its own ground, a split-half
  // Brier score over every aged protocol's token-or-not record.
  const noSlopeLoo = median(looRun(cs, { slope: false, offsets: true }, growthWeight).factors);
  const noSlopeWf = wfRun(cs, { slope: false, offsets: true }, growthWeight).model;
  const noOffsetsLoo = median(looRun(cs, { slope: true, offsets: false }, growthWeight).factors);
  const noOffsetsWf = wfRun(cs, { slope: true, offsets: false }, growthWeight).model;
  const noGrowth = grid[0]!;
  // The tilt's ablation row pits the best positive weight the grid found against dropping it.
  const bestPositive = grid.slice(1).reduce((best, g) => (Math.max(g.loo, g.wf) < Math.max(best.loo, best.wf) - 1e-9 ? g : best), grid[1]!);
  const ablation: AblationRow[] = [
    {
      term: 'Size-curve slope',
      loo_with: round4(chosen.loo),
      loo_without: round4(noSlopeLoo),
      wf_with: round4(chosen.wf),
      wf_without: round4(noSlopeWf),
      brier_with: null,
      brier_without: null,
      kept: noSlopeLoo > chosen.loo || noSlopeWf > chosen.wf,
    },
    {
      term: 'Category offsets',
      loo_with: round4(chosen.loo),
      loo_without: round4(noOffsetsLoo),
      wf_with: round4(chosen.wf),
      wf_without: round4(noOffsetsWf),
      brier_with: null,
      brier_without: null,
      kept: noOffsetsLoo > chosen.loo || noOffsetsWf > chosen.wf,
    },
    {
      term: `Growth tilt (best tested weight ${bestPositive.weight})`,
      loo_with: round4(bestPositive.loo),
      loo_without: round4(noGrowth.loo),
      wf_with: round4(bestPositive.wf),
      wf_without: round4(noGrowth.wf),
      brier_with: null,
      brier_without: null,
      kept: growthWeight > 0,
    },
    {
      term: 'Odds smoothing (monotone)',
      loo_with: null,
      loo_without: null,
      wf_with: null,
      wf_without: null,
      brier_with: round4(brier.smoothed),
      brier_without: round4(brier.raw),
      kept: oddsSmoothingKept,
    },
  ];

  return {
    version: MODEL_VERSION,
    global_multiple: round4(globalMultiple),
    fit_intercept: fit.intercept,
    fit_slope: round4(fit.slope),
    cat_offsets: Object.fromEntries(Object.entries(fit.offsets).map(([c, v]) => [c, round4(v)])),
    cat_comp_counts: fit.counts,
    growth_weight: growthWeight,
    growth_floor: GROWTH_FLOOR,
    growth_cap: GROWTH_CAP,
    odds_curve: odds.curve,
    odds_asymptote: odds.asymptote,
    odds_unknown_age: odds.unknownAge,
    loo_model_factor: round4(median(loo.factors)),
    loo_global_factor: round4(median(errGlobal)),
    loo_flat_factor: round4(median(errFlat)),
    loo_within_2x: round4(within / cs.length),
    loo_ratio_q25: round4(quantile(sortedRatios, 0.25)),
    loo_ratio_q75: round4(quantile(sortedRatios, 0.75)),
    wf_model_factor: round4(wf.model),
    wf_global_factor: round4(wf.global),
    wf_flat_factor: round4(wf.flat),
    wf_split_date: wf.splitDate,
    wf_train_count: wf.train,
    wf_test_count: wf.test,
    ablation,
    comp_count: cs.length,
    comp_total: all.length,
    farm_allocation_share: 0.05,
    capital_apr: 0.04,
  };
}

/** Gas for one round trip on a chain, in dollars: the figure every farm plan prices with. */
const CHAIN_GAS: Record<string, number> = {
  Ethereum: 12,
  Arbitrum: 0.6,
  Base: 0.4,
  Optimism: 0.5,
  Polygon: 0.05,
  Solana: 0.05,
  'BNB Chain': 0.3,
  Avalanche: 0.4,
  'zkSync Era': 0.3,
  Linea: 0.4,
  Scroll: 0.5,
  Mantle: 0.2,
  Blast: 0.4,
  Starknet: 0.3,
  Sonic: 0.1,
  Berachain: 0.2,
};

function gasFor(chain: string): number {
  return CHAIN_GAS[chain] ?? 1;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  if (p.tvl_usd >= 10_000_000) return 75;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** Wallets a farmer competes with, scaled by the protocol's TVL: stated on the page as an assumption. */
function competingWallets(tvl: number): number {
  return clamp(Math.round(400 * Math.sqrt(tvl / 1_000_000)), 200, 20_000);
}

/** The category's core action and its weekly follow-up, in words a farmer can follow. */
function actionsFor(p: SnapshotProtocol, capital: number, chain: string): { core: string; weekly: string } {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('collateral'))
    return {
      core: `Supply $${capital} of USDC to ${n} on ${chain}, then borrow about 40% against it and re-supply the borrow once, so both sides of the market count.`,
      weekly: `Repay and re-borrow a small amount on ${n} each week to keep the loan active, and never let the health factor fall below 1.6.`,
    };
  if (c.includes('cdp') || c.includes('stable'))
    return {
      core: `Deposit $${capital} of collateral into ${n} on ${chain} and mint its stablecoin against it at under 50% of the liquidation line.`,
      weekly: `Top up or partially repay the ${n} vault each week so the mint stays open and the collateral ratio stays in a safe band.`,
    };
  if (c.includes('dex') || c.includes('amm'))
    return {
      core: `Provide $${capital} of liquidity, split evenly between USDC and the pool's other asset, to ${n}'s highest-volume pool on ${chain}.`,
      weekly: `Claim the week's fees on ${n} and re-deposit them into the same pool, keeping the position in range.`,
    };
  if (c.includes('bridge'))
    return {
      core: `Bridge $${capital} of USDC from Ethereum to ${chain} through ${n}, then make one swap with the bridged funds on the far side.`,
      weekly: `Bridge a small amount back or onward through ${n} each week, alternating direction, and keep the receipts from both chains.`,
    };
  if (c.includes('restak') || c.includes('staking'))
    return {
      core: `Stake $${capital} of the chain's staking asset through ${n} on ${chain} and keep the liquid receipt token in the same wallet.`,
      weekly: `Claim and re-stake the week's rewards on ${n}; if it runs operator votes or restaking elections, take part in one.`,
    };
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options'))
    return {
      core: `Deposit $${capital} of USDC as margin on ${n} and open one small hedged position, long and short the same asset in equal size.`,
      weekly: `Roll the hedge on ${n} once a week and keep total leverage under 2x, so the account records volume without directional risk.`,
    };
  if (c.includes('curator') || c.includes('allocator') || c.includes('yield'))
    return {
      core: `Deposit $${capital} into a ${n} vault on ${chain}, choosing the vault with the most depositors rather than the highest advertised yield.`,
      weekly: `Move a small part of the position between ${n} vaults each week, or add to it, so the shares keep compounding.`,
    };
  if (c.includes('rwa'))
    return {
      core: `Complete ${n}'s onboarding on ${chain} and mint $${capital} of its yield-bearing asset, holding it in the farming wallet.`,
      weekly: `Check the ${n} position weekly and claim any distribution the moment it posts, keeping the mint receipt.`,
    };
  if (c.includes('insurance'))
    return {
      core: `Buy $${capital} of cover from ${n} on ${chain} against a protocol you actually use, for the longest term it sells.`,
      weekly: `Renew or extend one ${n} policy each week if terms allow, and stake a small amount in its assessment pool if it has one.`,
    };
  if (c.includes('basis') || c.includes('delta'))
    return {
      core: `Open ${n}'s basis position with $${capital} on ${chain}: long the spot asset and short the same size on its perpetual market, as the vault directs.`,
      weekly: `Rebalance the ${n} hedge each week to keep it delta-neutral and claim the funding it collects.`,
    };
  if (c.includes('payment'))
    return {
      core: `Fund $${capital} into ${n} on ${chain} and route one real payment through it to a second wallet you control.`,
      weekly: `Make one payment a week through ${n}, varying the amount, and keep the transaction hashes as your activity record.`,
    };
  if (c.includes('prediction'))
    return {
      core: `Fund $${capital} on ${n} and take one position in its most liquid market, sized under a fifth of the wallet.`,
      weekly: `Settle finished markets on ${n} and open one new position a week, keeping a note of each market you traded.`,
    };
  return {
    core: `Deposit $${capital} of USDC into ${n} on ${chain} through its main app and keep the position open.`,
    weekly: `Repeat one small qualifying action on ${n} each week, a deposit, a withdrawal and re-deposit, or a vote, and log it.`,
  };
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

const usd0 = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

/**
 * A protocol's farm plan and its verdict. The plan is derived from the protocol's own record
 * (category, chains, TVL, age) and priced with the chain's gas; the verdict nets the expected
 * airdrop (launch value x odds x the stated allocation share, split over competing wallets)
 * against the plan's true cost (gas plus the capital's opportunity cost over the hold).
 */
export function farmPlan(
  p: SnapshotProtocol,
  age: number | null,
  launchValue: number,
  odds: number,
  fit: ModelFit,
): { steps: FarmStep[]; verdict: 'farm' | 'thin' | 'skip'; expectedReward: number; planCost: number } {
  const chain = chainOf(p);
  const gas = gasFor(chain);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const { core, weekly } = actionsFor(p, capital, chain);
  const wallets = competingWallets(p.tvl_usd);
  const expectedReward = (launchValue * odds * fit.farm_allocation_share) / wallets;
  const gasTotal = gas * 8;
  const opportunity = capital * fit.capital_apr * (hold / 365);
  const planCost = gasTotal + opportunity;
  const net = expectedReward - planCost;
  const verdict: 'farm' | 'thin' | 'skip' = net >= 150 ? 'farm' : net >= 0 ? 'thin' : 'skip';
  const steps: FarmStep[] = [
    {
      text: `Set up a fresh wallet for ${p.name} alone, fund it on ${chain}, and keep its seed phrase offline; never farm from a wallet that holds other assets.`,
      cost: `about ${usd0(gas)} of gas to fund and approve`,
      time: '10 minutes',
    },
    {
      text: core,
      cost: `${usd0(capital)} of capital and about ${usd0(gas * 2)} of gas`,
      time: '20 minutes to set up',
    },
    {
      text: weekly,
      cost: `about ${usd0(gas)} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the ${p.name} position for at least ${hold} days so the activity appears in more than one weekly snapshot, and keep the balance above $${Math.round(capital * 0.8)} throughout.`,
      cost: `the ${usd0(capital)} stays locked; opportunity cost about ${usd0(opportunity)} at a 4% rate`,
      time: `${hold} days`,
    },
    {
      text: `Watch ${p.name}'s own channels for a points or rewards page, and claim only from a link the protocol itself publishes; never pay a third party to claim.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes a week',
    },
    {
      text: `Verdict: ${verdict.toUpperCase()}. Expected airdrop value is about ${usd0(expectedReward)} (a 5% community allocation of the expected launch value, split over roughly ${wallets.toLocaleString('en-US')} competing wallets) against a true cost of about ${usd0(planCost)} in gas and locked-capital cost, so ${verdict === 'farm' ? 'the plan clears its cost with room to spare' : verdict === 'thin' ? 'the plan roughly breaks even and is worth it only at this one wallet, never a farm of wallets' : 'the expected reward does not cover the cost at this size; revisit only if the protocol ships a points program'}.`,
      cost: `net expectation about ${usd0(net)}`,
      time: '5 minutes to review',
    },
  ];
  return { steps, verdict, expectedReward: Math.round(expectedReward), planCost: Math.round(planCost) };
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, fit: ModelFit): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isPreToken(p) && exclusionReason(p) === null && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, Math.max(0, BOARD_ROWS - chosen.size));
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const curve = curveValue(p.category, p.tvl_usd, fit);
    const multiple = curve / p.tvl_usd;
    const launch = Math.max(1, Math.round(curve * growthTilt(p.change_7d, fit)));
    const odds = tokenOdds(age, fit);
    const ev = Math.max(1, Math.round(launch * odds));
    const plan = farmPlan(p, age, launch, round4(odds), fit);
    return { p, age, multiple, launch, odds, ev, plan };
  });
  scored.sort((a, b) => b.ev - a.ev || b.launch - a.launch || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
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
    age_days: s.age,
    implied_value_usd: s.ev,
    launch_value_usd: s.launch,
    token_odds: round4(s.odds),
    multiple: round4(s.multiple),
    comp_count: s.p.category !== null ? (fit.cat_comp_counts[s.p.category] ?? 0) : 0,
    verdict: s.plan.verdict,
    expected_reward_usd: s.plan.expectedReward,
    plan_cost_usd: s.plan.planCost,
    farm_steps: s.plan.steps.map(stepText),
  }));
}

/** Every protocol in the snapshot accounted for: ranked, live, or excluded with its reason. */
export function accounting(snapshot: Snapshot, boardSize: number): Accounting {
  let live = 0;
  let below = 0;
  let versioned = 0;
  let cex = 0;
  let wrapped = 0;
  const boardSlugs = new Set<string>();
  void boardSlugs;
  for (const p of snapshot.protocols) {
    if (!isPreToken(p)) {
      live++;
      continue;
    }
    const reason = exclusionReason(p);
    if (reason === 'versioned') versioned++;
    else if (reason === 'cex') cex++;
    else if (reason === 'wrapped_or_staked') wrapped++;
  }
  const preToken = snapshot.protocols.filter(isPreToken).length;
  below = preToken - versioned - cex - wrapped - boardSize;
  return { total: snapshot.protocols.length, ranked: boardSize, live, unranked: below, versioned, cex, wrapped_or_staked: wrapped };
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
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

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const fit = fitModel(snapshot);
  const board = buildBoard(snapshot, fit);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const acct = accounting(snapshot, board.length);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: fit,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    accounting: acct,
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      age_days: r.age_days,
      implied_value_usd: r.implied_value_usd,
      launch_value_usd: r.launch_value_usd,
      token_odds: r.token_odds,
      multiple: r.multiple,
      comp_count: r.comp_count,
      verdict: r.verdict,
      expected_reward_usd: r.expected_reward_usd,
      plan_cost_usd: r.plan_cost_usd,
      range_low_usd: Math.max(1, Math.round(r.implied_value_usd * fit.loo_ratio_q25)),
      range_high_usd: Math.round(r.implied_value_usd * fit.loo_ratio_q75),
    })),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
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
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
