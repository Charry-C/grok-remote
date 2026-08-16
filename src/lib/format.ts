// Tiny formatting helpers shared across views.

/** Grok reports spend as integer ticks. 1 USD = 10^10 ticks. */
export const USD_TICKS_PER_DOLLAR = 10_000_000_000;

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

export function fmtUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return '';
  if (usd === 0) return '$0';
  if (usd < 1) {
    return `$${usd.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
  }
  return `$${usd.toFixed(2)}`;
}

export function fmtUsdFromTicks(ticks: number): string {
  if (!Number.isFinite(ticks) || ticks < 0) return '';
  return fmtUsd(ticks / USD_TICKS_PER_DOLLAR);
}
