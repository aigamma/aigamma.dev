// netlify/functions/data.mjs
// Reads options chain data and computed levels from Supabase.
// n8n is the sole Massive API consumer; this function never calls Massive.
// CDN cache headers ensure edge caching absorbs read traffic.

export default async function handler(request) {
  const url = new URL(request.url);
  const underlying = url.searchParams.get('underlying') || 'SPY';
  const date = url.searchParams.get('date') || null; // optional: YYYY-MM-DD for historical

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return new Response(JSON.stringify({ error: 'Supabase not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // Determine which snapshot to fetch
    const snapshotType = date ? 'daily' : 'intraday';
    const capturedAt = date || new Date().toISOString().split('T')[0];

    // Fetch snapshots
    const snapshotParams = new URLSearchParams({
      underlying: `eq.${underlying}`,
      snapshot_type: `eq.${snapshotType}`,
      captured_at: `eq.${capturedAt}`,
      order: 'strike.asc',
    });

    const snapshotRes = await fetch(
      `${supabaseUrl}/rest/v1/snapshots?${snapshotParams}`,
      { headers }
    );

    if (!snapshotRes.ok) {
      throw new Error(`Supabase snapshots returned ${snapshotRes.status}`);
    }

    const contracts = await snapshotRes.json();

    // Fetch computed levels
    const levelsParams = new URLSearchParams({
      underlying: `eq.${underlying}`,
      computed_at: `eq.${capturedAt}`,
    });

    const levelsRes = await fetch(
      `${supabaseUrl}/rest/v1/computed_levels?${levelsParams}`,
      { headers }
    );

    const levels = await levelsRes.json();

    // Extract spot price from computed levels or first contract
    let spotPrice = null;
    if (levels.length > 0 && levels[0].spot_price) {
      spotPrice = parseFloat(levels[0].spot_price);
    } else if (contracts.length > 0 && contracts[0].spot_price) {
      spotPrice = parseFloat(contracts[0].spot_price);
    }

    // Get unique expirations
    const expirations = [...new Set(contracts.map((c) => c.expiration_date).filter(Boolean))];

    // Normalize contract fields to match frontend expectations
    const normalizedContracts = contracts.map((c) => ({
      strike_price: parseFloat(c.strike),
      contract_type: c.contract_type,
      expiration_date: c.expiration_date,
      implied_volatility: parseFloat(c.implied_volatility),
      delta: parseFloat(c.delta),
      gamma: parseFloat(c.gamma),
      theta: parseFloat(c.theta),
      vega: parseFloat(c.vega),
      open_interest: c.open_interest,
      volume: c.volume,
      close_price: c.close_price ? parseFloat(c.close_price) : null,
    }));

    const payload = {
      underlying,
      spotPrice,
      expiration: expirations.length === 1 ? expirations[0] : expirations.join(', '),
      contractCount: normalizedContracts.length,
      contracts: normalizedContracts,
      levels: levels.length > 0 ? {
        call_wall: parseFloat(levels[0].call_wall_strike),
        put_wall: parseFloat(levels[0].put_wall_strike),
        abs_gamma_strike: parseFloat(levels[0].abs_gamma_strike),
        zero_gamma_level: levels[0].zero_gamma_level ? parseFloat(levels[0].zero_gamma_level) : null,
        net_gamma_notional: parseFloat(levels[0].net_gamma_notional),
        gamma_tilt: levels[0].gamma_tilt ? parseFloat(levels[0].gamma_tilt) : null,
        atm_iv: levels[0].atm_iv ? parseFloat(levels[0].atm_iv) : null,
        skew_25d_rr: levels[0].skew_25d_rr ? parseFloat(levels[0].skew_25d_rr) : null,
      } : null,
      capturedAt,
      snapshotType,
    };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
