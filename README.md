# Wavepacket Propagation Analysis

A 1D quantum wavepacket propagation simulator based on the split-operator method with an FFT-based kinetic propagator, for scattering from an Eckart potential barrier.

The project provides two front ends:

* **`docs/`** — a browser-based version in which the physics engine has been reimplemented from scratch in C and compiled to WebAssembly (`docs/engine/engine.c`). Simulations run entirely client-side, with no application server or backend required.
  **Live at https://lorenzatomattia.github.io/wavepackets_propagations_analysis/.**
  Saved runs are stored locally in the visitor's browser using IndexedDB; no data is uploaded.

* **`webui/`** — a local Flask interface for the original compiled Fortran simulation (`mlara_win.exe`), with results displayed using Plotly. This interface requires the original Fortran program and associated runtime files, which are **not distributed with this repository** (see below).

## Credits

The original physics implementation and Fortran program, including the split-operator, Eckart-barrier, and absorbing-boundary model, are based on course material by **Manuel Lara Garrido and Octavio Roncero Villa** for the EM-TCCM Master (Madrid, 2021). The original Fortran source code and compiled binary are not included in this repository, and no open-source license is granted for them.

The C implementation in `docs/engine/engine.c` is a from-scratch reimplementation of the same documented algorithm. It was developed for this project and numerically validated against the output of the original Fortran implementation. A separate C implementation was necessary because the original Fortran executable and its FFTW3 dependency cannot be used directly in the browser.

## Browser build (GitHub Pages)

The `docs/` directory contains a self-contained browser version of the simulator. The physics engine in `docs/engine/engine.c` is compiled with Emscripten into WebAssembly (`.wasm`) together with the corresponding JavaScript glue code (`.js`).

Every push to `main` runs `.github/workflows/pages.yml`, which:

1. runs the tests;
2. compiles `docs/engine/engine.c` with Emscripten;
3. generates `docs/engine.js` and `docs/engine.wasm`;
4. deploys the `docs/` directory to GitHub Pages.

The application is publicly available at:

https://lorenzatomattia.github.io/wavepackets_propagations_analysis/

### Running the browser version locally

The browser version does not require the original Fortran program.

To rebuild the WebAssembly engine locally, you need the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html). After installing and activating Emscripten, build the engine with:

```bash
cd emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh

cd ../wavepackets_propagations_analysis/docs/engine
./build.sh
```

The `docs/` directory must then be served through a local HTTP server. Opening the HTML files directly with `file://` is not supported, because the WebAssembly module and Web Worker require an HTTP(S) context.

For example:

```bash
cd ..
python -m http.server
```

The application can then be opened at the local address shown by the server, typically:

```text
http://127.0.0.1:8000/
```

## Running the local Flask app

The `webui/` directory contains a local Flask interface for the original Fortran simulation.

**This component cannot be run from this repository alone.** The original Fortran source code, compiled binary, and associated FFTW3/runtime files are not distributed with this repository. They must be obtained separately by users who are authorized to use the original Fortran program.

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

`mlara_win.exe` is a Windows binary dynamically linked against `libfftw3-3.dll`, which must be located next to the executable. It also requires the GNU Fortran runtime (`libgfortran-5.dll`); a compatible MinGW-w64/gfortran runtime may be required if it is not already installed.

### Rebuilding the Fortran executable

If you have the original Fortran source and a Windows/MinGW build of FFTW3, the executable can be rebuilt with:

```bash
cd fortran
gfortran barreritafluxexpenmomchebcontabsmod.f -lfftw3 -o mlara_win.exe
```

The `webui/` application is provided as a local interface to the original Fortran implementation. The browser-based `docs/` application is the self-contained, publicly runnable version of the project.

## Tests

Install the test dependencies and run:

```bash
pip install -r requirements.txt -r requirements-dev.txt
pytest
```
