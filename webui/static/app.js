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

async function loadTransmission(runId) {
  const data = await fetchJSON(`/api/runs/${runId}/transmission`);
  if (!data) return;
  const traces = [];
  if (data.analytic) {
    traces.push({ x: data.analytic.energy, y: data.analytic.transmission, mode: 'lines', name: 'analytic (Eckart)' });
  }
  if (data.numeric) {
    traces.push({ x: data.numeric.energy, y: data.numeric.transmission, mode: 'lines', name: `numeric T, step ${data.final_step}` });
    traces.push({ x: data.numeric.energy, y: data.numeric.reflection, mode: 'lines', name: 'numeric R', visible: 'legendonly' });
  }
  if (traces.length) {
    // Far from the sampled collision-energy region the wavepacket has
    // ~zero amplitude, so the flux-ratio estimate is dividing noise by
    // noise and can blow up to huge spurious values; T is physically in
    // [0,1], so clamp the axis (paquete.gnu did the same: "set yrange [0:1.1]").
    const layout = plotlyLayout('Transmission coefficient T(E)', 'E (cm-1)', 'T');
    layout.yaxis.range = [0, 1.1];
    Plotly.newPlot('transmission-plot', traces, layout);
  }
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
  loadTransmission(runId);
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
