// Results-rendering logic for the browser (WASM) build. This is an adapted
// copy of webui/static/app.js: the Plotly-facing rendering code is kept
// essentially verbatim, but every `fetchJSON(url)` HTTP call is replaced by
// a synchronous lookup into an in-memory `runData` object -- there is no
// server here, the WASM engine (run in a Web Worker, see worker.js) already
// produced all of this data before initResultsPage() is called.
//
// `runData` shape (mirrors what webui/parsers.py produces): {
//   params,                              // input config, same keys as PARAM_SPEC
//   overview: { pot, paq0, gaussp, gausspanalytic, gaussE },
//   steps: { paq: number[], momentapaq: number[] },
//   paqFrame(step) -> {position,re,im,prob} | null,
//   momentapaqFrame(step) -> {k,prob,re} | null,
//   initConditions: { xk0_actual, alpha0_actual, ... },
//   transmission: { numeric, analytic, final_step },
// }

function plotlyLayout(title, xaxis, yaxis) {
  return {
    title: { text: title, font: { size: 14 } },
    xaxis: { title: xaxis },
    yaxis: { title: yaxis },
    margin: { t: 36, r: 16, b: 40, l: 50 },
    autosize: true,
  };
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

function loadInitConditions(data) {
  const tbody = document.querySelector('#computed-table tbody');
  if (!tbody) return;
  if (!data || !Object.keys(data).length) {
    tbody.innerHTML = '<tr><td colspan="2" class="hint">not available yet</td></tr>';
    return;
  }
  tbody.innerHTML = Object.keys(COMPUTED_LABELS).filter((key) => key in data).map((key) => {
    const [label, unit] = COMPUTED_LABELS[key];
    return `<tr><td>${label}</td><td>${data[key]} ${unit}</td></tr>`;
  }).join('');
}

function loadTransmission(data) {
  if (!data) return;
  const traces = [];
  if (data.analytic) {
    traces.push({ x: data.analytic.energy, y: data.analytic.transmission, mode: 'lines', name: 'analytic (Eckart)' });
  }
  if (data.numeric) {
    // Runs saved before the column rename carry trans_left (= T) /
    // trans_right (= R) instead of transmission / reflection.
    const trans = data.numeric.transmission ?? data.numeric.trans_left;
    const reflec = data.numeric.reflection ?? data.numeric.trans_right;
    traces.push({ x: data.numeric.energy, y: trans, mode: 'lines', name: `numeric T, step ${data.final_step}` });
    traces.push({ x: data.numeric.energy, y: reflec, mode: 'lines', name: 'numeric R', visible: 'legendonly' });
  }
  if (traces.length) {
    // Far from the sampled collision-energy region the wavepacket has
    // ~zero amplitude, so the flux-ratio estimate is dividing noise by
    // noise and can blow up to huge spurious values; T is physically in
    // [0,1], so clamp the axis.
    const layout = plotlyLayout('Transmission coefficient T(E)', 'E (cm-1)', 'T');
    layout.yaxis.range = [0, 1.1];
    Plotly.newPlot('transmission-plot', traces, layout);
  }
}

// Vertical reference lines marking physically meaningful boundaries on the
// wavepacket plot: where the absorbing (non-physical) region starts, and
// where flux is evaluated for T(E)/R(E).
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

// Same grouped-block layout as webui/templates/results.html, built from
// the JS mirror of nmlwriter.grouped_fields() (docs/param-spec.js).
function renderParamGroups(params) {
  const container = document.getElementById('results-param-groups');
  if (!container) return;
  container.innerHTML = groupedFields().map((group) => {
    const rows = group.fields.map((f) => {
      const value = params ? params[f.key] : null;
      const shown = (value === null || value === undefined) ? 'auto' : value;
      return `<tr><td>${f.label}</td><td>${shown} ${f.unit}</td></tr>`;
    }).join('');
    return `<fieldset><legend>${group.name}</legend><table class="params-table"><tbody>${rows}</tbody></table></fieldset>`;
  }).join('');
}

// This is a single-page app: the results view's DOM (slider, Play button,
// Re/Im toggle) persists across runs, so each initResultsPage() call must
// tear down the previous run's listeners and playback timer first --
// otherwise they stack up and Play/Pause toggles once per opened run.
let resultsTeardown = null;

function stopResultsPlayback() {
  if (resultsTeardown) resultsTeardown();
  resultsTeardown = null;
}

function initResultsPage(runData) {
  stopResultsPlayback();
  renderParamGroups(runData.params);
  renderOverviewCharts(runData.overview);
  loadTransmission(runData.transmission);
  loadInitConditions(runData.initConditions);

  const slider = document.getElementById('step-slider');
  const label = document.getElementById('step-label');
  const playBtn = document.getElementById('play-btn');
  const toggleReIm = document.getElementById('toggle-reim');

  const overview = runData.overview;
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
  const { shapes, annotations } = boundaryMarkers(runData.params || {});
  paqLayout.shapes = shapes;
  paqLayout.annotations = annotations;
  const momentaLayout = plotlyLayout('Momentum-space |ψ(k)|² over time', 'k (1/a0)', '|ψ(k)|²');

  const paqSteps = runData.steps.paq;
  const momentaSteps = runData.steps.momentapaq;
  let playing = false;
  let timer = null;
  const controller = new AbortController();
  const { signal } = controller;
  playBtn.textContent = 'Play';
  resultsTeardown = () => {
    controller.abort();
    clearInterval(timer);
    playBtn.textContent = 'Play';
  };

  function buildPaqTraces(frame) {
    const traces = [{ x: frame.position, y: frame.prob, mode: 'lines', name: '|ψ|²' }];
    if (toggleReIm.checked) {
      traces.push({ x: frame.position, y: frame.re, mode: 'lines', name: 'Re ψ', opacity: 0.6 });
      traces.push({ x: frame.position, y: frame.im, mode: 'lines', name: 'Im ψ', opacity: 0.6 });
    }
    if (potTrace) traces.push(potTrace);
    return traces;
  }

  function showIndex(idx) {
    label.textContent = `step ${paqSteps[idx] ?? ''}`;

    const paqFrame = runData.paqFrame(paqSteps[idx]);
    if (paqFrame) Plotly.react('paq-plot', buildPaqTraces(paqFrame), paqLayout);

    if (momentaSteps.length) {
      const mIdx = Math.min(idx, momentaSteps.length - 1);
      const mFrame = runData.momentapaqFrame(momentaSteps[mIdx]);
      if (mFrame) Plotly.react('momenta-plot', [{ x: mFrame.k, y: mFrame.prob, mode: 'lines' }], momentaLayout);
    }
  }

  slider.addEventListener('input', () => showIndex(Number(slider.value)), { signal });
  toggleReIm.addEventListener('change', () => showIndex(Number(slider.value)), { signal });

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
  }, { signal });

  if (paqSteps.length) {
    slider.min = 0;
    slider.max = paqSteps.length - 1;
    slider.value = 0;
    showIndex(0);
  }
}
