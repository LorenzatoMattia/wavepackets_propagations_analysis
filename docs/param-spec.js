// JS mirror of webui/nmlwriter.py's PARAM_SPEC / GROUP_ORDER / grouped_fields().
// Keep in sync by hand if the Python source changes -- there is no server
// here to render this from a single source of truth.

const PARAM_SPEC = {
  usrxmjacreac: { label: 'Particle mass', unit: 'u (amu)', default: 87.0, group: 'Mass, timestep & grid' },
  usrtstep:     { label: 'Time step', unit: 'zots', default: 0.1, group: 'Mass, timestep & grid' },
  usrrfin1:     { label: 'Grid length (right edge)', unit: 'a0', default: 55.0, group: 'Mass, timestep & grid' },
  usrrflux:     { label: 'Flux point (right, reflection)', unit: 'a0', default: 43.0, group: 'Flux evaluation points' },
  usrrfluxleft: { label: 'Flux point (left, transmission)', unit: 'a0', default: 12.0, group: 'Flux evaluation points' },
  usrabsr1min:  { label: 'Absorption region start', unit: 'a0', default: 11.0, group: 'Absorbing boundary' },
  usrabsr1max:  { label: 'Absorption region end', unit: 'a0', default: 44.0, group: 'Absorbing boundary' },
  usrabsalp:    { label: 'Absorption strength', unit: '1/a0', default: 0.0007, group: 'Absorbing boundary' },
  usrAparam:    { label: 'Barrier asymmetry (A)', unit: 'hartree', default: 0.0, group: 'Eckart barrier shape' },
  usrBparam:    { label: 'Barrier height factor (B, x4)', unit: 'cm-1', default: 500.0, group: 'Eckart barrier shape' },
  usrylength:   { label: 'Barrier width', unit: 'a0', default: 10.0, group: 'Eckart barrier shape' },
  usrecol:      { label: 'Collision energy', unit: 'cm-1', default: 500.0, group: 'Initial wavepacket' },
  usrr1col:     { label: 'Wavepacket start position', unit: 'a0', default: 40.0, group: 'Initial wavepacket' },
  usrdeltae:    { label: 'Energy width', unit: 'cm-1', default: 500.0 / 3.2, group: 'Initial wavepacket' },
  usralpha0:    { label: 'Wavepacket width α (override)', unit: 'a0', default: null, group: 'Override auto-computed k/α' },
  usrxk0:       { label: 'Mean momentum k (override)', unit: '1/a0', default: null, group: 'Override auto-computed k/α' },
};

const GROUP_ORDER = [
  'Mass, timestep & grid',
  'Flux evaluation points',
  'Absorbing boundary',
  'Eckart barrier shape',
  'Initial wavepacket',
  'Override auto-computed k/α',
];

const BUILD_INFO = {
  ntimes: 20000,
  npun1: 2048,
  netot: 2000,
  npunt: 12000,
  npun: 12000,
  npin: 2 * 2000 + 1,   // momentum grid for energy diagnostics (gaussp/gausspanalytic)
  outEvery: 100,
  nsnap: 20000 / 100,    // number of paq/momentapaq snapshots buffered by the WASM engine
};

// Order the 16 doubles wasm_init() expects, matching engine.c's Params
// struct field order exactly. alpha0/xk0 use NaN for "auto".
const WASM_PARAM_ORDER = [
  'usrxmjacreac', 'usrtstep', 'usrrfin1', 'usrrflux', 'usrrfluxleft',
  'usrabsr1min', 'usrabsr1max', 'usrabsalp', 'usrAparam', 'usrBparam',
  'usrylength', 'usrecol', 'usrr1col', 'usrdeltae', 'usralpha0', 'usrxk0',
];

function defaultParams() {
  const out = {};
  for (const key in PARAM_SPEC) out[key] = PARAM_SPEC[key].default;
  return out;
}

function groupedFields() {
  const groups = {};
  for (const g of GROUP_ORDER) groups[g] = [];
  for (const key in PARAM_SPEC) {
    const f = PARAM_SPEC[key];
    groups[f.group].push({ key, label: f.label, unit: f.unit, default: f.default });
  }
  return GROUP_ORDER.map((g) => ({ name: g, fields: groups[g] }));
}
