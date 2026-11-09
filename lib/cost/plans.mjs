// lib/cost/plans.mjs — prepaid plan credits (config.json `plans`): billing cycle dates and the credits/overage split.
// Pure except planStatus, which reads the ledger. Cycle boundaries are UTC midnight.
import { providerSpend } from './ledger.mjs';

const r6 = (x) => Number(x.toFixed(6));
const dim = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate(); // days in month (m0 = 0-based month)
const at = (y, m0, day) => Date.UTC(y, m0, Math.min(day, dim(y, m0)));  // resetsOnDay clamped to the month's last day

/** The most recent reset (resetsOnDay, 00:00 UTC) at or before `now`. */
export function cycleStart(resetsOnDay, now = Date.now()) {
  const d = new Date(now);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const here = at(y, m, resetsOnDay);
  if (here <= now) return here;
  return m === 0 ? at(y - 1, 11, resetsOnDay) : at(y, m - 1, resetsOnDay);
}

/** The next reset strictly after `now`. */
export function nextReset(resetsOnDay, now = Date.now()) {
  const d = new Date(now);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const here = at(y, m, resetsOnDay);
  if (here > now) return here;
  return m === 11 ? at(y + 1, 0, resetsOnDay) : at(y, m + 1, resetsOnDay);
}

/**
 * applyCredits(plan, usedUsd, costUsd) -> { billing, usd, apiEquivUsd }
 * usedUsd = API value already consumed this cycle, costUsd = this call's API value. Within the included amount the
 * call is "credits" and charged $0. A call that crosses the line, or comes after it, is "metered" and charged only
 * the part beyond the included amount; apiEquivUsd is always the full value.
 */
export function applyCredits(plan, usedUsd, costUsd) {
  const included = Number.isFinite(plan?.includedUsd) ? plan.includedUsd : 0;
  const used = Number.isFinite(usedUsd) && usedUsd > 0 ? usedUsd : 0;
  const cost = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
  const total = used + cost;
  if (total <= included + 1e-12) return { billing: 'credits', usd: 0, apiEquivUsd: cost };
  const over = used >= included ? cost : total - included;
  return { billing: 'metered', usd: r6(Math.min(cost, over)), apiEquivUsd: cost };
}

/** One entry per configured plan: { provider, name, includedUsd, usedUsd, remainingUsd, overageUsd, cycleStart, resetsAt, resetsOnDay, complete }. */
export function planStatus(dataDir, plans, now = Date.now()) {
  const out = [];
  for (const [provider, p] of Object.entries(plans || {})) {
    const start = cycleStart(p.resetsOnDay, now);
    const s = providerSpend(dataDir, provider, start);
    const used = Math.min(p.includedUsd, s.apiEquivUsd);
    out.push({
      provider, name: p.name, includedUsd: p.includedUsd, resetsOnDay: p.resetsOnDay,
      usedUsd: r6(used), remainingUsd: r6(Math.max(0, p.includedUsd - s.apiEquivUsd)), overageUsd: r6(Math.max(0, s.apiEquivUsd - p.includedUsd)),
      calls: s.calls, cycleStart: new Date(start).toISOString(), resetsAt: new Date(nextReset(p.resetsOnDay, now)).toISOString(),
      complete: s.complete && !s.unreadable,
    });
  }
  return out;
}
