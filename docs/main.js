// Page orchestration: view switching, configure-form building (from
// param-spec.js), Worker lifecycle, IndexedDB-backed saved-runs list.
// Results rendering itself is app.js's initResultsPage(), reused as-is
// from the local Flask build.

const PENCIL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>';
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
const TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>';

const views = {
  runs: document.getElementById('view-runs'),
  configure: document.getElementById('view-configure'),
  progress: document.getElementById('view-progress'),
  results: document.getElementById('view-results'),
};

function showView(name) {
  if (name !== 'results') stopResultsPlayback();
  for (const k in views) views[k].style.display = (k === name) ? '' : 'none';
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s == null ? '' : String(s);
  return div.innerHTML;
}

function makeRunId(params) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const ecol = params.usrecol;
  return `${ts}_ecol${typeof ecol === 'number' ? ecol : 'na'}`;
}

function buildRunData(record) {
  const paqMap = new Map(record.steps.paq.map((s, i) => [s, record.paqFramesArr[i]]));
  const momMap = new Map(record.steps.momentapaq.map((s, i) => [s, record.momFramesArr[i]]));
  return {
    params: record.params,
    overview: record.overview,
    steps: record.steps,
    paqFrame: (step) => paqMap.get(step) || null,
    momentapaqFrame: (step) => momMap.get(step) || null,
    initConditions: record.initConditions,
    transmission: record.transmission,
  };
}

// ---------- Runs list ----------

async function renderRunsList() {
  const runs = await listRuns();
  const table = document.getElementById('runs-table');
  const tbody = document.getElementById('runs-tbody');
  const emptyHint = document.getElementById('runs-empty-hint');
  table.style.display = runs.length ? '' : 'none';
  emptyHint.style.display = runs.length ? 'none' : '';
  tbody.innerHTML = '';

  for (const run of runs) {
    const tr = document.createElement('tr');
    const ecol = run.params ? run.params.usrecol : '';
    tr.innerHTML = `
      <td>
        <div class="run-name-row">
          <span class="run-name">${escapeHtml(run.display_name || run.id)}</span>
          <details class="rename-details">
            <summary class="icon-btn" title="Rename" aria-label="Rename run">${PENCIL_SVG}</summary>
            <form class="rename-form" data-id="${run.id}">
              <input type="text" name="display_name" value="${escapeHtml(run.display_name || '')}" placeholder="${escapeHtml(run.id)}">
              <button type="submit" class="icon-btn" title="Save name" aria-label="Save name">${CHECK_SVG}</button>
            </form>
          </details>
        </div>
        <code class="run-id-hint">${run.id}</code>
      </td>
      <td>${ecol}</td>
      <td>${new Date(run.created_at).toLocaleString()}</td>
      <td>
        <a href="#" class="open-run" data-id="${run.id}">results</a>
        <button type="button" class="icon-btn icon-danger delete-run" data-id="${run.id}" title="Delete run" aria-label="Delete run">${TRASH_SVG}</button>
      </td>`;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('.rename-form').forEach((form) => {
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const id = form.dataset.id;
      const name = form.elements.display_name.value;
      await renameRun(id, name);
      renderRunsList();
    });
  });
  tbody.querySelectorAll('.delete-run').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this saved run?')) return;
      await deleteRun(btn.dataset.id);
      renderRunsList();
    });
  });
  tbody.querySelectorAll('.open-run').forEach((a) => {
    a.addEventListener('click', async (ev) => {
      ev.preventDefault();
      const record = await getRun(a.dataset.id);
      if (!record) return;
      openResults(record);
    });
  });
}

// ---------- Configure form ----------

function buildConfigureForm() {
  const form = document.getElementById('configure-form');
  form.innerHTML = '';
  for (const group of groupedFields()) {
    const fieldset = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = group.name;
    fieldset.appendChild(legend);
    if (group.name === 'Override auto-computed k/α') {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = "Leave blank to auto-compute. Only fill in to bypass that and set the wavepacket's momentum/width directly.";
      fieldset.appendChild(hint);
    }
    for (const f of group.fields) {
      const label = document.createElement('label');
      label.className = 'field';
      label.innerHTML = `<span>${escapeHtml(f.label)} <small>(${escapeHtml(f.unit)})</small></span>`;
      const input = document.createElement('input');
      input.type = 'number';
      input.step = 'any';
      input.name = f.key;
      if (f.default === null) {
        input.placeholder = 'auto';
      } else {
        input.value = f.default;
        input.required = true;
      }
      label.appendChild(input);
      fieldset.appendChild(label);
    }
    form.appendChild(fieldset);
  }

  const buildFieldset = document.createElement('fieldset');
  buildFieldset.innerHTML = `
    <legend>Current build (compile-time, read-only)</legend>
    <p class="hint">
      Time steps: <b>${BUILD_INFO.ntimes}</b> &middot;
      Position grid points: <b>${BUILD_INFO.npun1}</b> &middot;
      Energy grid points: <b>${BUILD_INFO.netot}</b> &middot;
      Auxiliary grid points: <b>${BUILD_INFO.npunt}</b>
    </p>`;
  form.appendChild(buildFieldset);
}

document.getElementById('configure-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const params = {};
  for (const el of form.elements) {
    if (!el.name || !el.name.startsWith('usr')) continue;
    params[el.name] = el.value === '' ? null : Number(el.value);
  }
  await launchSimulation(params);
});

// ---------- Progress + worker ----------

let activeWorker = null;

async function launchSimulation(params) {
  showView('progress');
  document.getElementById('progress-bar').style.width = '0%';
  document.getElementById('progress-text').textContent = 'starting…';
  document.getElementById('progress-error').textContent = '';

  if (activeWorker) activeWorker.terminate();
  const worker = new Worker('worker.js');
  activeWorker = worker;

  worker.onmessage = async (ev) => {
    const msg = ev.data;
    if (msg.type === 'progress') {
      const pct = Math.round((msg.step / msg.ntimes) * 100);
      document.getElementById('progress-bar').style.width = pct + '%';
      document.getElementById('progress-text').textContent = `running — step ${msg.step} / ${msg.ntimes} (${pct}%)`;
    } else if (msg.type === 'done') {
      const id = makeRunId(params);
      const record = {
        id,
        display_name: null,
        created_at: new Date().toISOString(),
        params: msg.params,
        overview: msg.overview,
        steps: msg.steps,
        paqFramesArr: msg.paqFramesArr,
        momFramesArr: msg.momFramesArr,
        initConditions: msg.initConditions,
        transmission: msg.transmission,
      };
      // Each run is ~16 MB of frames; if browser storage is full the run is
      // still shown, just not persisted.
      try {
        await saveRun(record);
      } catch (err) {
        console.error('saveRun failed', err);
        alertNotSaved(err);
      }
      openResults(record);
    } else if (msg.type === 'error') {
      document.getElementById('progress-error').textContent = 'Error: ' + msg.message;
    }
  };
  worker.onerror = (ev) => {
    document.getElementById('progress-error').textContent = 'Worker error: ' + ev.message;
  };
  worker.postMessage({ type: 'run', params });
}

function alertNotSaved(err) {
  const reason = err && err.name === 'QuotaExceededError'
    ? 'browser storage is full — delete some saved runs'
    : String((err && err.message) || err);
  document.getElementById('results-save-warning').textContent =
    `This run was not saved (${reason}). It will be lost when you leave this page.`;
}

function openResults(record) {
  document.getElementById('results-save-warning').textContent = '';
  showView('results');
  document.getElementById('results-run-id').textContent = record.display_name || record.id;
  initResultsPage(buildRunData(record));
}

// ---------- Nav ----------

document.getElementById('nav-runs').addEventListener('click', (ev) => {
  ev.preventDefault();
  renderRunsList();
  showView('runs');
});
document.getElementById('nav-new').addEventListener('click', (ev) => {
  ev.preventDefault();
  buildConfigureForm();
  showView('configure');
});
document.getElementById('runs-empty-new').addEventListener('click', (ev) => {
  ev.preventDefault();
  buildConfigureForm();
  showView('configure');
});

renderRunsList();
showView('runs');
