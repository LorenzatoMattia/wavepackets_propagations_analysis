# Wavepacket Propagation Analysis

A 1D quantum wavepacket propagation simulator (split-operator method, FFT-based
kinetic propagator) for scattering off an Eckart potential barrier, with two
front ends:

- **`docs/`** — a browser-only build: the physics reimplemented from scratch
  in C and compiled to WebAssembly (`docs/engine/engine.c`), so a simulation
  can be configured and run entirely client-side, with no server at all.
  **Live at <https://lorenzatomattia.github.io/wavepackets_propagations_analysis/>.**
  Saved runs live in the visitor's own browser (IndexedDB), nothing is
  uploaded anywhere.
- **`webui/`** — a local Flask app that drives the original compiled Fortran
  simulation (`mlara_win.exe`) and displays results with Plotly. Requires
  the Fortran program, which is **not** distributed with this repository
  (see below).

## Credits

The physics (the Fortran program, the split-operator/Eckart-barrier/absorbing-boundary model it implements) 
is by **Manuel Lara Garrido and Octavio Roncero Villa**, course material for
the EM-TCCM Master (Madrid, 2021). The Fortran source and its compiled
binary are not included in this repository; no open-source license is
granted for them.

The C reimplementation in `docs/engine/engine.c` is a from-scratch port of
the same documented algorithm (needed since WebAssembly can't run the
Fortran binary or link FFTW3 the way the original does), written for this
project and validated numerically against the original Fortran's output.

## Browser build (GitHub Pages)

Every push to `main` runs `.github/workflows/pages.yml`, which runs the
tests, compiles `docs/engine/engine.c` to `docs/engine.js` +
`docs/engine.wasm` with Emscripten, and deploys `docs/` to GitHub Pages.

To run it locally you need the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)
to build the engine, then any static file server (it must be served over
HTTP, not `file://`, for the WebAssembly module and Web Worker to load):

```
cd emsdk && ./emsdk install latest && ./emsdk activate latest && source ./emsdk_env.sh
cd ../wavepackets_propagations_analysis/docs/engine
./build.sh
cd .. && python -m http.server
```

## Running the local (Flask) app

The `webui/` directory contains a local Flask interface for the original Fortran simulation.

**This component cannot be run from this repository alone.** The original Fortran source code, 
compiled binary, and associated FFTW3/runtime files are not distributed with this repository. 
They must be obtained separately by users who are authorized to use the original Fortran program.

If you have the required files, place them in the `fortran/` directory (git-ignored):

```text
fortran/
  barreritafluxexpenmomchebcontabsmod.f
  locales.common.h
  locales.parameter.h
  fftw3.f
  mlara_win.exe
  libfftw3-3.dll
  libfftw3.a
```

Then install the Python dependencies and start the Flask application:

```bash
pip install -r requirements.txt
cd webui
python app.py
```

The application will be available at:

```text
http://127.0.0.1:5000/
```

`mlara_win.exe` is a Windows binary dynamically linked against `libfftw3-3.dll`, 
which must be located next to the executable. It also requires the `libgfortran-5.dll` runtime; 
a MinGW-w64 gfortran runtime may be required if it is not already installed.

### Rebuilding the Fortran executable

If you have the original Fortran source and a Windows/MinGW build of FFTW3, the executable can be rebuilt with:

```bash
cd fortran
gfortran barreritafluxexpenmomchebcontabsmod.f -lfftw3 -o mlara_win.exe
```

The `webui/` application is provided as a local interface for the original Fortran implementation; 
the browser-based `docs/` application is the self-contained, publicly runnable version of the project.

## Tests

```
pip install -r requirements.txt -r requirements-dev.txt
pytest
```
