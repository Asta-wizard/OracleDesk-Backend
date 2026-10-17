/**
 * reasoning-registry `publish_trace` action strings (#131). The single source
 * of truth for the backend's agents; docs/api.md shows the same values.
 *
 * Note: the contracts repo's TypeScript agents use `buy` for trades, while this
 * backend distinguishes `buy_yes` / `buy_no` (see docs/contract-requests.md).
 */
export const TRACE_ACTIONS = {
  createMarket: 'create_market',
  buyYes: 'buy_yes',
  buyNo: 'buy_no',
} as const;

export type TraceAction = (typeof TRACE_ACTIONS)[keyof typeof TRACE_ACTIONS];

export const tradeTraceAction = (direction: 'YES' | 'NO'): TraceAction =>
  direction === 'YES' ? TRACE_ACTIONS.buyYes : TRACE_ACTIONS.buyNo;
