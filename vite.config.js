import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Multi-page build. Thirteen entries: the main dashboard at `index.html`
// (served at `/`), the bookmark-only three-slot beta lab at
// `beta/index.html` (served at `/beta/`), the bookmark-only two-slot
// alpha lab at `alpha/index.html` (served at `/alpha/`), the
// bookmark-only two-slot dev lab at `dev/index.html` (served at
// `/dev/`), the bookmark-only GARCH family zoo at `garch/index.html`
// (served at `/garch/`), the bookmark-only three-slot regime-model
// lab at `regime/index.html` (served at `/regime/`), the
// bookmark-only three-slot rough-volatility lab at `rough/index.html`
// (served at `/rough/`), the bookmark-only four-slot stochastic-
// vol lab at `stochastic/index.html` (served at `/stochastic/`), the
// bookmark-only four-slot local-volatility lab at
// `local/index.html` (served at `/local/`), the bookmark-only
// four-slot risk lab at `risk/index.html` (served at `/risk/`), the
// bookmark-only four-slot jump-process lab at `jump/index.html`
// (served at `/jump/`), and the bookmark-only six-slot discrete and
// parametric lab at `discrete/index.html` (served at `/discrete/`),
// and the two-slot put-call-parity lab at `parity/index.html`
// (served at `/parity/`).
// The dev lab is a peer
// scratch pad to /alpha — same pre-β release stage, independent
// concept. The garch lab is a dedicated family-zoo surface for the
// full GARCH specification list (univariate + multivariate) with an
// equal-weight master ensemble. The regime lab is a dedicated three-
// method zoo (Mixture Lognormal, Markov Regime Switching, Wasserstein
// K-Means) for regime-identification models fit in-browser on daily
// SPX log returns. The rough-vol lab is a three-slot zoo for
// fractional-Brownian / Volterra-type volatility models: an RFSV
// Hurst-signature diagnostic, a Rough Bergomi Monte Carlo simulator,
// and a multi-estimator Hurst triangulation, all fit in-browser on
// the same daily SPX log-return series. The stochastic-vol lab is a
// four-slot lineage of the canonical options-market SV family —
// Heston (1993), SABR (2002), Local Stochastic Vol (Dupire + LSV
// leverage function), and Rough Bergomi (2016) — fit in-browser
// against the current SPX options chain and its SVI slice set. The
// local-vol lab is a dedicated four-slot study of Dupire local
// volatility end-to-end: surface extraction from the SVI slice set,
// Monte Carlo pricing as a self-check of the extraction, an
// interactive 3D viewer with K-slice / T-slice controls, and the
// forward-smile flattening diagnostic that motivates local-stochastic
// vol. The risk lab is a four-slot surface for risk-measurement and
// Greek-comparison models on the live chain: cross-model Greeks
// across Black-Scholes, Bachelier, and Heston; five competing delta
// definitions including Hull-White minimum-variance; a Vanna-Volga
// three-anchor smile reconstruction; and the second-order Greeks
// (vanna, volga, charm) across the smile. The jump lab is a four-slot
// lineage of the canonical jump-process options-pricing models —
// Merton (1976) finite-activity Gaussian jumps, Kou (2002)
// asymmetric double-exponential jumps, Bates (1996) SVJ that
// combines Heston with Merton jumps, and Variance Gamma
// (Madan-Carr-Chang 1998) as a pure-jump infinite-activity Levy
// process — all calibrated in-browser against the live SPX chain. The
// discrete lab is a six-slot zoo pairing two discrete pricing engines
// (Cox-Ross-Rubinstein binomial tree, Kamrad-Ritchken trinomial tree)
// against the four-parameterization SVI family (raw, natural, JW, SSVI)
// so the reader can compare what a state-space pricer and a parametric
// surface smoother each produce from the same live chain. The parity
// lab is the staging home for the put-call-parity study that
// originated in /alpha as a Discord-prompted prototype: a v4
// composite of box-spread r vs direct-PCP r at q = 0 stacked over the
// PCP-recovered SPX forward, paired with the v1 box-spread baseline.
// The parity entry is linked from QuantMenu as the tail item — it is
// a measurement surface (no-arbitrage diagnostic that reads r, q, and
// F off the chain with no pricer on top), not a trading strategy
// (box spreads are not the desk's focus), so it sits at the bottom
// of the sequence rather than the top. The page currently produces
// implausible live-chain readings (median r ≈ −222%, nearest ≈ −87%)
// and carries an in-page calibration warning while box construction,
// mark quality, sign / unit conventions, and dividend treatment are
// being audited; see parity/App.jsx for the five-candidate diagnostic
// checklist. Nothing in the built output
// links the thirteen together. See beta/App.jsx, alpha/App.jsx,
// dev/App.jsx, garch/App.jsx, regime/App.jsx, rough/App.jsx,
// stochastic/App.jsx, local/App.jsx, risk/App.jsx, jump/App.jsx,
// discrete/App.jsx, and parity/App.jsx for the rationale.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'https://aigamma.com',
        changeOrigin: true,
        secure: true,
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        beta: fileURLToPath(new URL('./beta/index.html', import.meta.url)),
        alpha: fileURLToPath(new URL('./alpha/index.html', import.meta.url)),
        dev: fileURLToPath(new URL('./dev/index.html', import.meta.url)),
        garch: fileURLToPath(new URL('./garch/index.html', import.meta.url)),
        regime: fileURLToPath(new URL('./regime/index.html', import.meta.url)),
        rough: fileURLToPath(new URL('./rough/index.html', import.meta.url)),
        stochastic: fileURLToPath(new URL('./stochastic/index.html', import.meta.url)),
        local: fileURLToPath(new URL('./local/index.html', import.meta.url)),
        risk: fileURLToPath(new URL('./risk/index.html', import.meta.url)),
        jump: fileURLToPath(new URL('./jump/index.html', import.meta.url)),
        discrete: fileURLToPath(new URL('./discrete/index.html', import.meta.url)),
        parity: fileURLToPath(new URL('./parity/index.html', import.meta.url)),
      },
    },
  },
})
