import { useState, useEffect } from 'react';

// Wire schema the server sets `contractsV` to. Bump both sides together when
// the columnar shape changes in a way that isn't a superset of the prior
// version. This constant is also sent as a query-string cache-buster so the
// Netlify edge treats a new wire version as a separate cache key rather than
// serving a stale previous-schema response from the 60 s max-age / 300 s SWR
// window.
const WIRE_VERSION = 2;

// Rehydrate the server's columnar contractCols payload back into the
// row-of-objects shape every downstream consumer (LevelsPanel,
// FixedStrikeIvMatrix, VolatilitySmile, GexProfile, useSviFits, gammaProfile,
// gex, svi, Chat) already reads. Saves ~515 KB gzipped on the wire versus the
// prior row-of-objects encoding on a live 18,878-contract SPX snapshot, with
// zero component-code churn because the rehydrated rows carry the same key
// names (expiration_date / strike_price / contract_type / implied_volatility /
// delta / gamma / open_interest / volume / close_price) the old wire used.
// Takes ~30 ms on a modern laptop for a full SPX chain — dwarfed by the
// bandwidth saving it unlocks, especially on mobile connections where the
// ~3 s 4G transit win is the whole point.
function rehydrateContracts(payload) {
  const cols = payload.contractCols;
  if (!cols || !Array.isArray(cols.strike)) return;
  const expirations = Array.isArray(payload.expirations) ? payload.expirations : [];
  const n = cols.strike.length;
  const contracts = new Array(n);
  // `vol` may be absent from the server payload — grep across src/ confirmed
  // no downstream consumer reads per-contract volume (LevelsPanel reads the
  // pre-aggregated put_call_ratio_volume scalar, not this column), so data.mjs
  // omits the column from both the Supabase SELECT and the columnar wire
  // shape. Keep the rehydrator tolerant of the missing array so a hypothetical
  // future re-introduction of the column (defensive decoders are cheap) can
  // land without another wire-version bump.
  const volCol = Array.isArray(cols.vol) ? cols.vol : null;
  for (let i = 0; i < n; i++) {
    const expIdx = cols.exp[i];
    contracts[i] = {
      expiration_date: expIdx >= 0 && expIdx < expirations.length ? expirations[expIdx] : null,
      strike_price: cols.strike[i],
      contract_type: cols.type[i] === 0 ? 'call' : 'put',
      implied_volatility: cols.iv[i],
      delta: cols.delta[i],
      gamma: cols.gamma[i],
      open_interest: cols.oi[i],
      volume: volCol ? volCol[i] : null,
      close_price: cols.px[i],
    };
  }
  payload.contracts = contracts;
  // Drop the columnar blob so downstream memoization keyed on `data` doesn't
  // also hold the untransformed arrays alive for the lifetime of the mount.
  delete payload.contractCols;
}

// Pull (and consume) the early-boot promise if this mount matches the shape
// the inline boot script in index.html pre-fetched: cold retry, default SPX
// / intraday params, no expiration or trading-date override, WIRE_VERSION
// matches. Any mismatch (historical date, manual retry after a failure, a
// future underlying) falls through to a regular fetch. The promise is
// consumed on the first read so a later refetch() or a remount issues fresh
// bytes.
function consumeBootPromise({ underlying, snapshotType, expiration, tradingDate, prevDay, retryCount }) {
  if (typeof window === 'undefined') return null;
  if (retryCount !== 0) return null;
  if (expiration || tradingDate) return null;
  if (underlying !== 'SPX' || snapshotType !== 'intraday') return null;
  const boot = window.__apiBoot;
  if (!boot) return null;
  const key = prevDay ? 'prevDay' : 'today';
  const promise = boot[key];
  if (!promise) return null;
  boot[key] = null;
  return promise;
}

export default function useOptionsData({ underlying = 'SPX', snapshotType = 'intraday', expiration = null, tradingDate = null, prevDay = false, enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    async function fetchData() {
      setLoading(true);
      setError(null);

      try {
        const booted = consumeBootPromise({ underlying, snapshotType, expiration, tradingDate, prevDay, retryCount });
        let json;
        if (booted) {
          try {
            json = await booted;
          } catch (bootErr) {
            // Boot fetch failed (network glitch, 5xx from the edge during a
            // deploy). Fall through to a fresh fetch — the booted promise is
            // already drained, so this is the hook's only remaining path.
            booted.finalBootError = bootErr;
            json = null;
          }
        }
        if (!json) {
          const params = new URLSearchParams({ underlying, snapshot_type: snapshotType });
          if (expiration) params.set('expiration', expiration);
          if (tradingDate) params.set('date', tradingDate);
          if (prevDay && !tradingDate) {
            params.set('prev_day', '1');
            // prev-day goes through the lite (skip_contracts) variant by
            // default — above-fold only needs levels + expirationMetrics
            // for overnight alignment, not the ~19k-contract chain. Below-
            // fold diff charts that want prev-day contracts get them from
            // a separate post-first-paint idle fetch in App.jsx that omits
            // this flag. The boot script's __apiBoot.prevDay URL also
            // includes skip_contracts=1 so the match-and-consume path
            // resolves to this same response without triggering a second
            // network call.
            params.set('skip_contracts', '1');
          }
          params.set('v', String(WIRE_VERSION));

          const response = await fetch(`/api/data?${params}`);
          if (!response.ok) {
            const text = await response.text();
            throw new Error(`API ${response.status}: ${text}`);
          }
          json = await response.json();
        }
        rehydrateContracts(json);
        if (!cancelled) {
          setData(json);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchData();
    return () => {
      cancelled = true;
    };
  }, [underlying, snapshotType, expiration, tradingDate, prevDay, retryCount, enabled]);

  return { data, loading: enabled && loading, error, refetch: () => setRetryCount((c) => c + 1) };
}
