// lib/cost/plan-guard.mjs — opt-in stop of Claude subscription requests at 100% of a plan window.
// Reads only THIS process's own plan gauge (handed in as getPlan); it never calls out itself, and it fails
// OPEN in every case where the gauge cannot be trusted. Stored as stopAtPlanLimit in the plugin's caps.json.
import { loadCaps } from './caps.mjs';
import { formatReset } from '../plan-usage.mjs';

export const PLAN_LIMIT_CODE = 'PLAN_LIMIT';
export const PLAN_MAX_AGE_MS = 10 * 60 * 1000; // a gauge older than this is not trusted
export const PLAN_READ_BUDGET_MS = 2000; // a request never waits longer than this for the gauge
const family = (model) => (/opus/i.test(model) ? 'opus' : /sonnet/i.test(model) ? 'sonnet' : null);

/** Windows that apply to this request: 5-hour, weekly, and the weekly for the requested model's family
 *  (sevenDayOpus / sevenDaySonnet, or the labelled scopedWeekly when its label names the same family). */
export function windowsFor(plan, model) {
  const out = [];
  const fam = family(String(model || ''));
  const add = (label, win) => { if (win && typeof win.percent === 'number' && Number.isFinite(win.percent)) out.push({ label, percent: win.percent, resetsAt: win.resetsAt || null }); };
  add('5-hour window', plan.fiveHour);
  add('weekly window', plan.sevenDay);
  if (fam === 'opus') add('weekly Opus window', plan.sevenDayOpus);
  if (fam === 'sonnet') add('weekly Sonnet window', plan.sevenDaySonnet);
  const label = plan.scopedWeekly && typeof plan.scopedWeekly.label === 'string' ? plan.scopedWeekly.label : '';
  if (fam && label && label.toLowerCase().includes(fam)) add(`weekly ${label} window`, plan.scopedWeekly);
  return out;
}

/** Pure decision. plan = the /status plan object; fails OPEN on everything but a fresh, exhausted, still-current window. */
export function evaluatePlanLimit({ plan, model, now }) {
  if (!plan || plan.mode !== 'plan') return { action: 'ok', why: 'gauge-unavailable' }; // unavailable | expired | api | signed-out
  const age = now - (typeof plan.fetchedAt === 'number' ? plan.fetchedAt : NaN);
  if (!Number.isFinite(age) || age < 0 || age > PLAN_MAX_AGE_MS) return { action: 'ok', why: 'gauge-stale' };
  for (const win of windowsFor(plan, model)) {
    if (win.percent < 100) continue;
    const resets = win.resetsAt ? Date.parse(win.resetsAt) : NaN;
    if (Number.isFinite(resets) && resets <= now) continue; // it has reset since the fetch
    const when = win.resetsAt ? ` (resets ${formatReset(win.resetsAt, undefined, now)})` : '';
    return {
      action: 'block', which: 'plan-limit', code: PLAN_LIMIT_CODE, pct: 100, window: win.label, resetsAt: win.resetsAt,
      reason: `your Claude ${win.label} is at ${win.percent}% of the plan${when}`,
    };
  }
  return { action: 'ok', why: 'under-limit' };
}

/** createPlanGuard({ dataDir, getPlan, now, budgetMs }) -> { check({provider, model, billing}) -> Promise<verdict> }; never throws. */
export function createPlanGuard({ dataDir, getPlan, now = Date.now, budgetMs = PLAN_READ_BUDGET_MS } = {}) {
  return {
    async check({ provider, model, billing } = {}) {
      try {
        // other providers and billing kinds are never touched: getPlan is not even called
        if (provider !== 'anthropic' || billing !== 'subscription') return { action: 'ok', why: 'not-claude-subscription' };
        // read per call, so a toggle applies at once
        if (loadCaps(dataDir).stopAtPlanLimit !== true) return { action: 'ok', why: 'off' };
        let timer;
        const gate = new Promise((resolve) => { timer = setTimeout(() => resolve(null), budgetMs); timer.unref?.(); });
        let plan = null;
        try { plan = await Promise.race([Promise.resolve().then(getPlan), gate]); } catch { plan = null; } finally { clearTimeout(timer); }
        return evaluatePlanLimit({ plan, model, now: now() });
      } catch { return { action: 'ok', why: 'error' }; }
    },
  };
}

/** Terminal error stream, delivered like the SPEND_CAP block (a `finish` chunk with an error reason).
 *  The message avoids the words credit/quota so the credit-failure detector never matches it. */
export function planBlockedStream(reason) {
  const failure = Object.freeze({
    message: `Request blocked by model-hub plan guard: ${reason}. Turn it off in Settings -> Models -> Model hub (Claude plan usage) or run \`dsh-hub caps set stopAtPlanLimit=off\`.`,
    code: PLAN_LIMIT_CODE,
  });
  return { async *[Symbol.asyncIterator]() { yield { type: 'finish', reason: { kind: 'error', failure } }; } };
}
