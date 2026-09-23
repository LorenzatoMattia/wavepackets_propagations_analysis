# CLAUDE.md

1D quantum wavepacket propagation (split-operator, FFT kinetic propagator) through an Eckart barrier. There are two front ends that share the same physics.

## Layout
- `fortran/` (git-ignored, never commit): `barreritafluxexpenmomchebcontabsmod.f`, the original Fortran program. It is the physics reference and is compiled to `mlara_win.exe` (linked against FFTW3, `libfftw3-3.dll` next to the exe). Course material, not distributed.
- `webui/`: a local Flask app. `runner.py` launches `mlara_win.exe` in an isolated run directory under `runs/`, `parsers.py` reads its output, and `nmlwriter.py` writes the input namelist.
- `docs/`: the browser-only build, published on GitHub Pages by `.github/workflows/pages.yml` (CI builds `engine.js`/`engine.wasm`; they are git-ignored). `engine/engine.c` is a C port of the physics compiled to WASM. `worker.js` runs the engine, `main.js`/`app.js` handle the UI, and `idb.js` saves runs to IndexedDB in the browser.

## Commands
- Web UI: `pip install -r requirements.txt`, then `cd webui && python app.py` (serves http://127.0.0.1:5000). Needs `libgfortran-5.dll` on the PATH.
- Static site: `cd docs && python -m http.server`. It has to be served over HTTP, not `file://`.
- WASM engine: with emsdk activated, run `docs/engine/build.sh`. It writes `docs/engine.js` and `docs/engine.wasm`.
- Fortran: `cd fortran && gfortran barreritafluxexpenmomchebcontabsmod.f -lfftw3 -o mlara_win.exe`
- Tests: `pip install -r requirements-dev.txt`, then `pytest` (webui modules are imported flat via `tests/conftest.py`).

## Invariants
- `docs/engine/engine.c` must stay numerically consistent with the Fortran output. Any change to the physics or numerics needs a comparison run against `mlara_win.exe`.
- The physics and the Fortran source are course material by M. Lara Garrido and O. Roncero Villa (EM-TCCM, 2021). Keep the credit, don't add an open-source license to it, and never push the Fortran files or binaries (the public branch is `main`; local `master` still has them in history and must not be pushed).
- Transmission files: column 2 = flux at the left point = T(E), column 3 = right point = R(E).

## ECC rules (`.claude/rules/ecc/`)
- `engine.c` is C, and no ECC rule is scoped to `*.c`. Apply `rules/ecc/cpp/*` where it makes sense for C (not C++).
- The "immutability" rule in `common/coding-style.md` doesn't apply to numerical hot loops in C or numpy. Updating arrays in place is intended there.
- `docs/*.js` is plain browser JavaScript with no bundler or npm. Don't bring in a build toolchain.
