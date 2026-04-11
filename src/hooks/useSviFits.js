import { useMemo } from 'react';
import { fitSviSlice, breedenLitzenberger } from '../lib/svi';

// Normalizes whatever shape the /api/data payload gives us and falls back to
// an on-the-fly fit if the backend has no stored fit for an expiration yet.
// This lets the dashboard keep working between backfill moments — for
// example, right after n8n ingests a new run but before the scheduled fit
// persistence lands.
export default function useSviFits({ contracts, spotPrice, capturedAt, backendFits }) {
  return useMemo(() => {
    if (!contracts || contracts.length === 0 || !spotPrice) {
      return { byExpiration: {}, source: 'none' };
    }

    const backendByExp = {};
    if (Array.isArray(backendFits)) {
      for (const fit of backendFits) {
        if (!fit?.expiration_date || !fit.params) continue;
        const { density_strikes, density_values } = fit;
        const hasDensity = Array.isArray(density_strikes) && Array.isArray(density_values) &&
          density_strikes.length === density_values.length && density_strikes.length > 0;
        backendByExp[fit.expiration_date] = {
          source: 'backend',
          expirationDate: fit.expiration_date,
          T: fit.t_years,
          forward: fit.forward_price ?? spotPrice,
          params: fit.params,
          rmseIv: fit.rmse_iv,
          converged: fit.converged,
          tenorWindow: fit.tenor_window,
          sampleCount: fit.sample_count,
          diagnostics: {
            nonNegativeVariance: fit.non_negative_variance,
            butterflyArbFree: fit.butterfly_arb_free,
            minDurrlemanG: fit.min_durrleman_g,
          },
          density: hasDensity
            ? { strikes: density_strikes, values: density_values, integral: fit.density_integral ?? 1 }
            : null,
        };
      }
    }

    const byExp = new Map();
    for (const c of contracts) {
      if (!c.expiration_date) continue;
      if (!byExp.has(c.expiration_date)) byExp.set(c.expiration_date, []);
      byExp.get(c.expiration_date).push(c);
    }

    const result = {};
    for (const [exp, slice] of byExp.entries()) {
      if (backendByExp[exp]) {
        result[exp] = backendByExp[exp];
        continue;
      }
      const fit = fitSviSlice({
        contracts: slice,
        spotPrice,
        expirationDate: exp,
        capturedAt,
      });
      if (!fit.ok) continue;
      const bl = breedenLitzenberger({ params: fit.params, spotPrice, T: fit.T });
      result[exp] = {
        source: 'client',
        expirationDate: exp,
        T: fit.T,
        forward: spotPrice,
        params: fit.params,
        rmseIv: fit.rmseIv,
        converged: fit.converged,
        tenorWindow: fit.tenorWindow,
        sampleCount: fit.sampleCount,
        diagnostics: fit.diagnostics,
        density: { strikes: bl.strikes, values: bl.density, integral: bl.integral },
      };
    }

    const sources = new Set(Object.values(result).map((r) => r.source));
    const source = sources.size === 0 ? 'none' : sources.size === 1 ? [...sources][0] : 'mixed';
    return { byExpiration: result, source };
  }, [contracts, spotPrice, capturedAt, backendFits]);
}
