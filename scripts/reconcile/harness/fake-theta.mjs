// In-memory fake for createThetaClient. Configurable per-test via the setters.

export function createFakeTheta() {
  let terminalUp = true;
  const eodByDate = new Map();
  let fetchError = null;

  return {
    probe: async () => terminalUp,
    fetchEodGreeks: async ({ date }) => {
      if (fetchError) throw fetchError;
      return eodByDate.get(date) ?? { response: [] };
    },
    _setTerminalUp: (v) => { terminalUp = v; },
    _setEodResponse: (date, response) => { eodByDate.set(date, response); },
    _setFetchError: (err) => { fetchError = err; },
  };
}

// Shape a ThetaData EOD response for the fake. state-machine.deriveFromEod
// unwraps `response.derived` directly when present, so tests can express the
// expected per-day outcome without touching wire format.
export function derivedEod({ levels = {}, termStructure = [] }) {
  return { derived: { levels, termStructure }, response: [{}] };
}
