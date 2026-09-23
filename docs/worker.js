// Web Worker driving the WASM physics engine, so the 20000-step simulation
// (FFT-based split-operator propagation + energy-resolved flux analysis)
// never blocks the page's UI thread. Talks to the main thread with plain
// postMessage()s:
//   in:  { type: 'run', params: {usrxmjacreac: 87, ...} }
//   out: { type: 'progress', step, ntimes }
//        { type: 'done', runData }               // runData shape: see app.js
//        { type: 'error', message }

importScripts('param-spec.js');
importScripts('engine.js'); // Emscripten glue, built by engine/build.sh -> defines createEngineModule()

let modulePromise = createEngineModule({
  // Emscripten prints to console by default; keep worker console quiet for
  // normal runs but still surface real errors.
  printErr: (msg) => console.error('[engine]', msg),
});

// Copies out of the WASM heap into an owned Float64Array: compact to store
// in IndexedDB, transferable to the main thread without a copy, and accepted
// directly by Plotly.
function readF64(Module, ptr, length) {
  return new Float64Array(Module.HEAPF64.buffer, ptr, length).slice();
}

async function runSimulation(params) {
  const Module = await modulePromise;
  const n = BUILD_INFO;

  const paramsPtr = Module._malloc(WASM_PARAM_ORDER.length * 8);
  const view = new Float64Array(Module.HEAPF64.buffer, paramsPtr, WASM_PARAM_ORDER.length);
  WASM_PARAM_ORDER.forEach((key, i) => {
    const v = params[key];
    view[i] = (v === null || v === undefined || v === '') ? NaN : Number(v);
  });
  Module._wasm_init(paramsPtr);
  Module._free(paramsPtr);

  const CHUNK = 200;
  let step = 0;
  while (step < n.ntimes) {
    step = Module._wasm_run_steps(CHUNK);
    postMessage({ type: 'progress', step, ntimes: n.ntimes });
    // yield so the postMessage above actually flushes before the next
    // (synchronous, CPU-bound) chunk starts
    await new Promise((r) => setTimeout(r, 0));
  }

  const overview = {
    pot: { position: readF64(Module, Module._wasm_pot_position(), n.npun1), potential: readF64(Module, Module._wasm_pot_potential(), n.npun1) },
    paq0: { position: readF64(Module, Module._wasm_paq0_position(), n.npun1), prob: readF64(Module, Module._wasm_paq0_prob(), n.npun1) },
    gaussp: {
      k: readF64(Module, Module._wasm_gaussp_k(), n.npin),
      re: readF64(Module, Module._wasm_gaussp_re(), n.npin),
      im: readF64(Module, Module._wasm_gaussp_im(), n.npin),
      prob: readF64(Module, Module._wasm_gaussp_prob(), n.npin),
    },
    gausspanalytic: {
      k: readF64(Module, Module._wasm_gausspanalytic_k(), n.npin),
      re: readF64(Module, Module._wasm_gausspanalytic_re(), n.npin),
      im: readF64(Module, Module._wasm_gausspanalytic_im(), n.npin),
      prob: readF64(Module, Module._wasm_gausspanalytic_prob(), n.npin),
    },
    gaussE: {
      energy: readF64(Module, Module._wasm_gaussE_energy(), n.netot).slice(1),
      re: readF64(Module, Module._wasm_gaussE_re(), n.netot).slice(1),
      im: readF64(Module, Module._wasm_gaussE_im(), n.netot).slice(1),
      prob: readF64(Module, Module._wasm_gaussE_prob(), n.netot).slice(1),
    },
  };

  const snapCount = Module._wasm_snap_count();
  const paqSteps = [];
  const paqPosition = readF64(Module, Module._wasm_paq_position(), n.npun1);
  const momK = readF64(Module, Module._wasm_mom_k(), n.npun1);
  const paqFrames = new Map();
  const momFrames = new Map();
  for (let i = 0; i < snapCount; i++) {
    const s = Module._wasm_snap_step(i);
    paqSteps.push(s);
    paqFrames.set(s, {
      position: paqPosition,
      re: readF64(Module, Module._wasm_paq_re(i), n.npun1),
      im: readF64(Module, Module._wasm_paq_im(i), n.npun1),
      prob: readF64(Module, Module._wasm_paq_prob(i), n.npun1),
    });
    momFrames.set(s, {
      k: momK,
      prob: readF64(Module, Module._wasm_mom_prob(i), n.npun1),
      re: readF64(Module, Module._wasm_mom_re(i), n.npun1),
    });
  }

  // engine.c's wasm_trans_left/right are the fluxes through the left
  // (usrrfluxleft) and right (usrrflux) points, i.e. T(E) and R(E).
  const transmission = {
    numeric: {
      energy: readF64(Module, Module._wasm_trans_energy(), n.netot),
      transmission: readF64(Module, Module._wasm_trans_left(), n.netot),
      reflection: readF64(Module, Module._wasm_trans_right(), n.netot),
    },
    analytic: {
      energy: readF64(Module, Module._wasm_trans_energy(), n.netot),
      transmission: readF64(Module, Module._wasm_trans_analytic(), n.netot),
    },
    final_step: n.ntimes,
  };

  const initConditions = {
    xk0_actual: Module._wasm_init_cond_xk0(),
    alpha0_actual: Module._wasm_init_cond_alpha0(),
  };

  return {
    params,
    overview,
    steps: { paq: paqSteps, momentapaq: paqSteps.slice() }, // same 100-step cadence, see app.js's index-reuse note
    paqFrame: (step) => paqFrames.get(step) || null,
    momentapaqFrame: (step) => momFrames.get(step) || null,
    initConditions,
    transmission,
  };
}

// Every distinct ArrayBuffer under `value`, for postMessage's transfer list
// (moves the ~16 MB of frames instead of copying them). Deduplicated: the
// position/k grids are shared by all frames, and listing a buffer twice
// throws a DataCloneError.
function collectBuffers(value, seen = new Set()) {
  if (ArrayBuffer.isView(value)) {
    seen.add(value.buffer);
  } else if (value && typeof value === 'object') {
    for (const key in value) collectBuffers(value[key], seen);
  }
  return [...seen];
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type !== 'run') return;
  try {
    const runData = await runSimulation(msg.params);
    // runData carries closures (paqFrame/momentapaqFrame) that can't cross
    // postMessage's structured-clone boundary -- send the raw frame maps as
    // plain arrays instead and let the main thread rebuild the accessors.
    const paqFramesArr = runData.steps.paq.map((s) => runData.paqFrame(s));
    const momFramesArr = runData.steps.momentapaq.map((s) => runData.momentapaqFrame(s));
    const done = {
      type: 'done',
      params: runData.params,
      overview: runData.overview,
      steps: runData.steps,
      paqFramesArr,
      momFramesArr,
      initConditions: runData.initConditions,
      transmission: runData.transmission,
    };
    postMessage(done, collectBuffers(done));
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.stack || err) });
  }
};
