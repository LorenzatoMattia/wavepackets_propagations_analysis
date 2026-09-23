// Results-page logic: static overview charts, transmission comparison, and
// a scrubbable/playable animation over the paq###### wavepacket snapshots
// (reproducing paquete.gnu interactively).

function plotlyLayout(title, xaxis, yaxis) {
  return {
    title: { text: title, font: { size: 14 } },
    xaxis: { title: xaxis },
    yaxis: { title: yaxis },
    margin: { t: 36, r: 16, b: 40, l: 50 },
    autosize: true,
  };
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

function renderOverviewCharts(data) {
  if (!data) return;

  if (data.pot) {
    Plotly.newPlot('pot-plot', [{ x: data.pot.position, y: data.pot.potential, mode: 'lines' }],
      plotlyLayout('Potential (Eckart barrier)', 'x (a0)', 'V (cm-1)'));
  }
  if (data.paq0) {
    Plotly.newPlot('paq0-plot', [{ x: data.paq0.position, y: data.paq0.prob, mode: 'lines' }],
      plotlyLayout('Space representation (initial wavepacket)', 'x (a0)', '|ψ(x)|²'));
  }
  if (data.gaussp && data.gausspanalytic) {
    Plotly.newPlot('gaussp-plot', [
      { x: data.gausspanalytic.k, y: data.gausspanalytic.prob, mode: 'lines', name: 'analytic' },
      { x: data.gaussp.k, y: data.gaussp.prob, mode: 'lines', name: 'numeric' },
    ], plotlyLayout('Momentum representation (initial wavepacket)', 'k (1/a0)', '|a(k)|²'));
  }
  if (data.gaussE) {
    Plotly.newPlot('gaussE-plot', [{ x: data.gaussE.energy, y: data.gaussE.prob, mode: 'lines' }],
      plotlyLayout('Energy representation, (initial wavepacket)', 'E (cm-1)', '|a(E)|²'));
  }
}

const COMPUTED_LABELS = {
  xk0_actual: ['Mean momentum k (actual)', '1/a0'],
  alpha0_actual: ['Wavepacket width α (actual)', 'a0'],
};

async function loadInitConditions(runId) {
  const data = await fetchJSON(`/api/runs/${runId}/init_conditions`);
  const tbody = document.querySelector('#computed-table tbody');
  if (!tbody) return;
  if (!data || !Object.keys(data).length) {
    tbody.innerHTML = '<tr><td colspan="2" class="hint">not available yet</td></tr>';
    return;
  }
  // Flask's jsonify() sorts keys alphabetically, so display in the fixed
  // order defined by COMPUTED_LABELS rather than trusting the JSON's order.
  tbody.innerHTML = Object.keys(COMPUTED_LABELS).filter((key) => key in data).map((key) => {
    const [label, unit] = COMPUTED_LABELS[key];
    return `<tr><td>${label}</td><td>${data[key]} ${unit}</td></tr>`;
  }).join('');
}

// Relative |a(E)|² threshold below which the flux-method T(E) is not shown:
// there the initial wavepacket has ~no energy content, so the flux ratio is
// noise divided by noise (the Fortran source warns about "very high numbers
// due to numerical errors"). 1e-3 keeps every shown point within [0, 1.1]
// and within 3e-3 of the analytic curve on the reference runs.
const ENERGY_CONTENT_THRESHOLD = 1e-3;

// values[i] where the initial wavepacket's energy weight |a(E)|² (gaussE.prob,
// linearly interpolated onto the ascending `energy` grid) is at least
// relThreshold of its maximum, null elsewhere (Plotly draws a gap).
function maskByEnergyContent(energy, values, gaussE, relThreshold = ENERGY_CONTENT_THRESHOLD) {
  if (!gaussE || !gaussE.energy || gaussE.energy.length < 2) return Array.from(values);
  const ge = gaussE.energy;
  const gp = gaussE.prob;
  let wmax = 0;
  for (let i = 0; i < gp.length; i++) if (gp[i] > wmax) wmax = gp[i];
  const cut = relThreshold * wmax;
  const last = ge.length - 1;
  const out = new Array(values.length);
  let j = 0;
  for (let i = 0; i < energy.length; i++) {
    const e = energy[i];
    while (j < last - 1 && ge[j + 1] < e) j++;
    let w;
    if (e <= ge[0]) w = gp[0];
    else if (e >= ge[last]) w = gp[last];
    else w = gp[j] + (e - ge[j]) / (ge[j + 1] - ge[j]) * (gp[j + 1] - gp[j]);
    out[i] = w >= cut ? values[i] : null;
  }
  return out;
}

// Classical limit of T(E): 0 below the barrier top V_max, 1 above.
function classicalStep(vmax, xmax) {
  return {
    x: [0, vmax, vmax, Math.max(xmax, vmax)], y: [0, 0, 1, 1], mode: 'lines',
    name: `classical step (V<sub>max</sub> = ${Math.round(vmax)} cm⁻¹)`,
    line: { color: '#9ca3af', dash: 'dash', width: 1.5 },
  };
}

function potentialMax(overview) {
  const pot = overview && overview.pot && overview.pot.potential;
  if (!pot || !pot.length) return null;
  let vmax = -Infinity;
  for (let i = 0; i < pot.length; i++) if (pot[i] > vmax) vmax = pot[i];
  return vmax;
}

function renderTransmission(data, overview) {
  if (!data) return;
  const traces = [];
  let xmax = 0;
  if (data.analytic) {
    traces.push({ x: data.analytic.energy, y: data.analytic.transmission, mode: 'lines', name: 'analytic (Eckart)' });
  }
  if (data.numeric) {
    // Runs saved before the column rename carry trans_left (= T).
    const trans = data.numeric.transmission ?? data.numeric.trans_left;
    const shown = maskByEnergyContent(data.numeric.energy, trans, overview && overview.gaussE);
    shown.forEach((t, i) => { if (t !== null) xmax = Math.max(xmax, data.numeric.energy[i]); });
    traces.push({ x: data.numeric.energy, y: shown, mode: 'lines', name: `numeric (flux), step ${data.final_step}` });
  }
  const vmax = potentialMax(overview);
  if (vmax !== null) xmax = Math.max(xmax, 2 * vmax);
  if (vmax !== null && vmax > 0) traces.push(classicalStep(vmax, 1.05 * xmax));
  if (!traces.length) return;

  const layout = plotlyLayout('Transmission coefficient T(E)', 'E (cm⁻¹)', 'T(E)');
  layout.yaxis.range = [0, 1.1];
  if (xmax > 0) layout.xaxis.range = [0, 1.05 * xmax];
  Plotly.newPlot('transmission-plot', traces, layout);
}

async function loadTransmission(runId, overview) {
  renderTransmission(await fetchJSON(`/api/runs/${runId}/transmission`), overview);
}

// Vertical reference lines ("asymptotes") marking physically meaningful
// boundaries on the wavepacket plot: where the absorbing (non-physical)
// region starts, and where flux is evaluated for T(E)/R(E) -- same intent
// as the original physicalwavep.gnu, which excluded the absorption region.
function boundaryMarkers(params) {
  const marks = [
    { x: params.usrabsr1min, color: '#d97706', label: 'absorption start' },
    { x: params.usrabsr1max, color: '#d97706', label: 'absorption start' },
    { x: params.usrrfluxleft, color: '#059669', label: 'flux point' },
    { x: params.usrrflux, color: '#059669', label: 'flux point' },
  ].filter((m) => typeof m.x === 'number');

  return {
    shapes: marks.map((m) => ({
      type: 'line', x0: m.x, x1: m.x, y0: 0, y1: 1, yref: 'paper',
      line: { color: m.color, dash: 'dashdot', width: 1.5 },
    })),
    annotations: marks.map((m) => ({
      x: m.x, y: 1, yref: 'paper', yanchor: 'bottom', showarrow: false,
      text: m.label, font: { size: 9, color: m.color }, textangle: -90,
      xanchor: 'left',
    })),
  };
}

async function initResultsPage(runId, params) {
  const overview = await fetchJSON(`/api/runs/${runId}/overview`);
  renderOverviewCharts(overview);
  loadTransmission(runId, overview);
  loadInitConditions(runId);
  // loadAbsorption(runId);

  const slider = document.getElementById('step-slider');
  const label = document.getElementById('step-label');
  const playBtn = document.getElementById('play-btn');
  const toggleReIm = document.getElementById('toggle-reim');

  // Overlay the potential barrier (position vs. V(x)) behind the wavepacket
  // as a background reference, same intent as the original physicalwavep.gnu
  // script -- on its own y-axis since V (cm-1) and |ψ|² are wildly different
  // scales.
  const potTrace = overview && overview.pot
    ? {
      x: overview.pot.position, y: overview.pot.potential, mode: 'lines',
      name: 'potential', yaxis: 'y2',
      line: { color: '#9ca3af', dash: 'dot', width: 1.5 },
    }
    : null;

  const paqLayout = plotlyLayout('Wavepacket |ψ|² over time', 'position (a0)', 'amplitude');
  if (potTrace) {
    paqLayout.yaxis2 = { title: 'V (cm-1)', overlaying: 'y', side: 'right', showgrid: false };
    paqLayout.margin.r = 50;
  }
  const { shapes, annotations } = boundaryMarkers(params || {});
  paqLayout.shapes = shapes;
  paqLayout.annotations = annotations;
  const momentaLayout = plotlyLayout('Momentum-space |ψ(k)|² over time', 'k (1/a0)', '|ψ(k)|²');

  let paqSteps = [];
  let momentaSteps = [];
  let playing = false;
  let timer = null;

  function buildPaqTraces(frame) {
    const traces = [{ x: frame.position, y: frame.prob, mode: 'lines', name: '|ψ|²' }];
    if (toggleReIm.checked) {
      traces.push({ x: frame.position, y: frame.re, mode: 'lines', name: 'Re ψ', opacity: 0.6 });
      traces.push({ x: frame.position, y: frame.im, mode: 'lines', name: 'Im ψ', opacity: 0.6 });
    }
    if (potTrace) traces.push(potTrace);
    return traces;
  }

  async function showIndex(idx) {
    label.textContent = `step ${paqSteps[idx] ?? ''}`;

    const paqFrame = await fetchJSON(`/api/runs/${runId}/paq/${paqSteps[idx]}`);
    if (paqFrame) Plotly.react('paq-plot', buildPaqTraces(paqFrame), paqLayout);

    if (momentaSteps.length) {
      // momentapaq is written on the same 100-step cadence as paq, so reuse
      // the same index into whichever family actually has that many frames.
      const mIdx = Math.min(idx, momentaSteps.length - 1);
      const mFrame = await fetchJSON(`/api/runs/${runId}/momentapaq/${momentaSteps[mIdx]}`);
      if (mFrame) Plotly.react('momenta-plot', [{ x: mFrame.k, y: mFrame.prob, mode: 'lines' }], momentaLayout);
    }
  }

  slider.addEventListener('input', () => showIndex(Number(slider.value)));
  toggleReIm.addEventListener('change', () => showIndex(Number(slider.value)));

  playBtn.addEventListener('click', () => {
    if (playing) {
      playing = false;
      clearInterval(timer);
      playBtn.textContent = 'Play';
      return;
    }
    playing = true;
    playBtn.textContent = 'Pause';
    timer = setInterval(() => {
      let idx = Number(slider.value) + 1;
      if (idx >= paqSteps.length) idx = 0;
      slider.value = idx;
      showIndex(idx);
    }, 200);
  });

  fetchJSON(`/api/runs/${runId}/steps`).then(async (steps) => {
    if (!steps) return;
    paqSteps = steps.paq;
    momentaSteps = steps.momentapaq;
    if (!paqSteps.length) return;
    slider.min = 0;
    slider.max = paqSteps.length - 1;
    slider.value = 0;
    await showIndex(0);
  });
}
