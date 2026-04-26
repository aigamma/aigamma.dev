import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import Chat from '../src/components/Chat';
import SlotA from './slots/SlotA';
import SlotB from './slots/SlotB';
import SlotC from './slots/SlotC';
import SlotD from './slots/SlotD';
import SlotE from './slots/SlotE';
import SlotF from './slots/SlotF';

// Discrete & Parametric Vol Lab. Every implied-vol number on the main
// dashboard is produced by a model fit. This lab opens the model layer
// and shows two complementary fitting families side by side: discrete
// pricing engines (binomial and trinomial trees) that reconstruct an
// option's price on a finite state space, and parametric surface
// families (SVI raw / natural / JW / SSVI) that fit a smooth functional
// form to the observed smile.
//
// The six slots in order:
//
//   SLOT A. Binomial Tree (Cox, Ross, Rubinstein 1979). Two-branch
//           recombining lattice with multiplicative up/down moves u, d
//           calibrated to match a log-normal diffusion in the limit
//           N -> infinity. Prices an ATM SPX option as a function of
//           tree depth; overlays the BSM reference so the reader sees
//           the odd/even oscillation and the convergence rate. A second
//           trace prices the same option under American exercise so the
//           early-exercise premium is visible at a glance.
//
//   SLOT B. Trinomial Tree (Boyle 1986). Three-branch recombining
//           lattice with an explicit "stay put" branch. Converges with
//           a smaller N than binomial because the extra branch absorbs
//           drift cleanly. Shown on the same axes as Slot A so the two
//           discrete methods can be compared step for step.
//
//   SLOT C. SVI Raw (Gatheral 2004). Five-parameter slice fit on total
//           variance w(k) = a + b(rho*(k-m) + sqrt((k-m)^2 + sigma^2)).
//           This is what powers the dashboard's SVI IV numbers. Shown
//           with Durrleman's g(k) butterfly diagnostic on a subplot so
//           the no-arbitrage region is explicit.
//
//   SLOT D. SVI Natural (Gatheral and Jacquier 2014). Same functional
//           form, reparameterized as (Delta, mu, rho, omega, zeta). The
//           five natural parameters map directly onto economically
//           meaningful quantities (ATM total variance, vol-of-vol-like
//           scale, skewness) so the fit is easier to reason about but
//           identical in shape to Slot C.
//
//   SLOT E. SVI-JW (Jump-Wing, Gatheral 2004). Trader-readable
//           reparameterization: ATM variance v_t, ATM skew psi_t, put
//           wing slope p_t, call wing slope c_t, minimum variance
//           v-tilde. A desk quoting "p_t = 0.6" or "psi_t = -0.8" can
//           eyeball the smile from the number, which is why JW is the
//           standard quoting convention among equity-index vol desks.
//
//   SLOT F. SSVI (Gatheral and Jacquier 2014). Surface SVI: one rho,
//           one function phi, and the ATM total variance theta_t as
//           the only per-tenor degree of freedom. Every slice on the
//           fitted surface is calendar-arbitrage-free by construction,
//           and butterfly arbitrage reduces to two scalar conditions
//           on phi. Tradeoff: per-slice fit quality is worse than
//           slice-by-slice SVI, but the surface is globally consistent
//           in a way that slice-fitting cannot guarantee.
//
// All six slots consume the same live /api/data snapshot. Nothing on
// the main site links here; the lab is bookmark-only and will only be
// reachable by typing /discrete directly.
export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <a href="/" className="lab-logo-link" aria-label="Return to aigamma.com homepage">
            <img src="/logo.webp" alt="aigamma.com" className="lab-logo" />
          </a>
          <span
            className="lab-badge"
            title="Discrete &amp; Parametric Vol Lab · binomial · trinomial · SVI raw · SVI natural · SVI-JW · SSVI"
          >
            <span className="lab-badge__desktop-text">Discrete &amp; Parametric Vol Lab</span>
            <span className="lab-badge__mobile-text">Discrete</span>
          </span>
        </div>
        <TopNav />
        <a
          href="/"
          className="lab-home-button lab-home-button--inline lab-home-button--split"
          aria-label="Return Home"
        >
          <span className="lab-home-button__desktop-text">Return Home</span>
          <span className="lab-home-button__mobile-text">Home</span>
        </a>
        <Menu />
      </header>

      <section className="lab-slot">
        <ErrorBoundary><SlotA /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary><SlotB /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary><SlotC /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary><SlotD /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary><SlotE /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary><SlotF /></ErrorBoundary>
      </section>

      <div className="card" style={{ padding: '1.1rem 1.25rem', margin: '1.25rem 0' }}>
        <div
          style={{
            fontFamily: 'Courier New, monospace',
            fontSize: '0.7rem',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--text-secondary)',
            marginBottom: '0.45rem',
          }}
        >
          why this page exists
        </div>
        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.65, fontSize: '0.95rem' }}>
          <p style={{ margin: '0 0 0.7rem' }}>
            Every implied-vol number on the dashboard is the output of a{' '}
            <strong style={{ color: 'var(--text-primary)' }}>model fit</strong>.
            The site does not display raw bid / ask quotes. It displays IVs
            that have already been through a pricing engine or a surface
            smoother. The choice of engine and smoother is part of the
            number.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            Two schools dominate production use. Discrete pricing engines
            rebuild the option price on a finite state space (a lattice or
            a PDE grid) and read the IV back by Black-Scholes inversion.
            Parametric surfaces pick a smooth functional form, fit it to
            observed IVs, and evaluate the form everywhere else. The first
            is what brokers run to price American-style and exotic
            structures. The second is what risk desks run to report a
            consistent IV surface to the rest of the firm.
          </p>
          <p style={{ margin: 0 }}>
            This lab runs both schools against the same live SPX chain so
            the outputs are directly comparable. For cash-settled European
            SPX, the tree engines collapse onto Black-Scholes by
            construction, which makes them a clean reference against which
            the parametric surface fits can be stress-tested. The six
            slots are not competing for the same answer. They are each
            showing a different piece of the fitting stack.
          </p>
        </div>
      </div>

      <ErrorBoundary>
        <Chat
          context="discrete"
          welcome={{
            quick:
              'Ask about the six slots above, how discrete pricing engines (binomial, trinomial) relate to parametric surfaces (SVI raw, natural, JW, SSVI), or how the two schools work together on a production vol surface. Chat stays on volatility, options, and quantitative finance.',
            deep:
              'Deep Analysis mode — longer and more structurally detailed responses on tree convergence, SVI reparameterizations, SSVI arbitrage-freedom conditions, and the philosophy of treating every implied-vol number as the output of a model fit.',
          }}
        />
      </ErrorBoundary>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · discrete &amp; parametric vol lab · six-slot fitting zoo · v0.1.0
        </span>
      </footer>
    </div>
  );
}
