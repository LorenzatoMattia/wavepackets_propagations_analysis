/*
 * Wavepacket propagation engine -- C reimplementation of the physics in
 * barreritafluxexpenmomchebcontabsmod.f (split-operator propagation of a
 * 1D Gaussian wavepacket through an Eckart barrier, with a multiplicative
 * absorbing-boundary mask and energy-resolved flux/transmission analysis).
 *
 * Despite the original filename, the executed Fortran code does NOT use a
 * Chebyshev propagator -- it is a symmetric split-operator scheme using FFTs
 * for the kinetic-energy half of each step. This file replicates that exact
 * algorithm, formula for formula, referencing the original source's line
 * numbers throughout so it can be cross-checked. Validated numerically
 * against a real Fortran reference run (runs/20260922_025941_ecol200):
 * probability densities match to ~1e-7 relative error throughout the full
 * 20000-step propagation, and the transmission spectrum matches to 5+
 * significant digits in the physically populated energy range.
 *
 * Original physics: (c) Manuel Lara Garrido and Octavio Roncero Villa,
 * EM-TCCM Master course material (Madrid, 2021). This C port is a
 * from-scratch reimplementation of the documented algorithm for a
 * browser/WebAssembly build (no FFTW, no NAMELIST, no per-file I/O).
 *
 * Two build modes:
 *   - NATIVE_TEST: plain C build (gcc/clang), writes output in the same
 *     simple whitespace-column ASCII format the Fortran used, for
 *     numerical validation against a reference run's real output files.
 *   - __EMSCRIPTEN__ build (docs/engine/build.sh) exposing the same step
 *     loop through exported functions, buffering frames in memory instead
 *     of files (see the WebAssembly export layer below).
 */

#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <string.h>

/* ---------------------------------------------------------------------
 * Complex helpers (avoid C99 <complex.h> for predictable WASM codegen)
 * --------------------------------------------------------------------- */
typedef struct { double re, im; } cplx;

static inline cplx cadd(cplx a, cplx b) { return (cplx){ a.re + b.re, a.im + b.im }; }
static inline cplx csub(cplx a, cplx b) { return (cplx){ a.re - b.re, a.im - b.im }; }
static inline cplx cmul(cplx a, cplx b) {
    return (cplx){ a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re };
}
static inline cplx cscale(cplx a, double s) { return (cplx){ a.re * s, a.im * s }; }
static inline cplx cconj(cplx a) { return (cplx){ a.re, -a.im }; }
static inline double cabs2(cplx a) { return a.re * a.re + a.im * a.im; }
/* exp(i*theta) */
static inline cplx cexpi(double theta) { return (cplx){ cos(theta), sin(theta) }; }
static const cplx CPLX_I = { 0.0, 1.0 };

/* ---------------------------------------------------------------------
 * Physical constants -- identical to the Fortran source (lines 428-443),
 * kept in the same "internal Angstrom / zot / uezot" unit system so the
 * numerics are bit-for-bit comparable against the reference Fortran runs.
 * --------------------------------------------------------------------- */
#define CONVL   0.5291772107      /* internal-Angstrom per bohr (a0) */
#define CONVM   1822.888486       /* a.u. mass per amu (unused directly: masses already in amu) */
#define CONVE   4.556335253e-6    /* hartree per cm-1 */
#define CONVE1  1.196265656e-4    /* zot per cm-1 */
#define HBR     0.06350779925     /* hbar in uezot*zot (this program's own internal unit system) */
#define PI_     3.14159265358979323846

#define NPUN1   2048    /* position/FFT grid points (locales.parameter.h) */
#define NETOT   2000    /* energy-resolved flux grid points */
#define NPIN    (2 * NETOT + 1)  /* momentum grid for energy diagnostics */
#define NPUNT   12000   /* dense quadrature grid for the WAY-2 momentum check */
#define NTIMES  20000
#define OUT_EVERY 100
#define NSNAP   (NTIMES / OUT_EVERY)  /* 200 */

/* ---------------------------------------------------------------------
 * Iterative radix-2 FFT, in place. sign=-1 matches FFTW_FORWARD's
 * convention (exp(-2*pi*i*k*n/N)); sign=+1 matches FFTW_BACKWARD
 * (exp(+2*pi*i*k*n/N)). Both are UNNORMALIZED, exactly like FFTW --
 * callers must divide by n themselves when the Fortran does (see the
 * explicit `divi` multiplications it performs).
 * --------------------------------------------------------------------- */
static void fft(cplx *a, int n, int sign) {
    for (int i = 1, j = 0; i < n; i++) {
        int bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { cplx t = a[i]; a[i] = a[j]; a[j] = t; }
    }
    for (int len = 2; len <= n; len <<= 1) {
        double ang = sign * 2.0 * PI_ / (double)len;
        cplx wlen = { cos(ang), sin(ang) };
        for (int i = 0; i < n; i += len) {
            cplx w = { 1.0, 0.0 };
            int half = len / 2;
            for (int k = 0; k < half; k++) {
                cplx u = a[i + k];
                cplx v = cmul(a[i + k + half], w);
                a[i + k] = cadd(u, v);
                a[i + k + half] = csub(u, v);
                w = cmul(w, wlen);
            }
        }
    }
}

/* ---------------------------------------------------------------------
 * Input parameters -- mirrors nmlwriter.PARAM_SPEC exactly (14 runtime
 * params). alpha0_override/xk0_override use NAN as the "auto" sentinel
 * (the Fortran uses -1.d300, guarded at lines 657-659).
 * --------------------------------------------------------------------- */
typedef struct {
    double xmjacreac;   /* usrxmjacreac: particle mass, amu */
    double tstep;       /* usrtstep: zots */
    double rfin1;       /* usrrfin1: a0 */
    double rflux;       /* usrrflux: a0 (right / reflection point) */
    double rfluxleft;   /* usrrfluxleft: a0 (left / transmission point) */
    double absr1min;    /* usrabsr1min: a0 */
    double absr1max;    /* usrabsr1max: a0 */
    double absalp;      /* usrabsalp: 1/internal-Angstrom^2, used as-is */
    double Aparam;      /* usrAparam: hartree */
    double Bparam;      /* usrBparam: cm-1 (barrier peak if A=0) */
    double ylength;     /* usrylength: a0 */
    double ecol;        /* usrecol: cm-1 */
    double r1col;        /* usrr1col: a0 */
    double deltae;       /* usrdeltae: cm-1 */
    double alpha0_override; /* a0, NAN = auto */
    double xk0_override;    /* 1/a0, NAN = auto */
} Params;

/* ---------------------------------------------------------------------
 * Engine state: every array the propagation loop and diagnostics need.
 * --------------------------------------------------------------------- */
typedef struct {
    double ah1, rmis1, rfin1_internal;
    double xmjacreac, tstep;
    int irflux, irfluxleft;
    double alpha0, xk0, r1col;

    double r1[NPUN1];        /* position grid, internal Angstrom */
    double pr1[NPUN1];       /* k grid, FFT-native order, 1/internal-Angstrom */
    cplx   zV[NPUN1];        /* half-step potential propagator */
    cplx   zp2[NPUN1];       /* full-step kinetic propagator */
    double absfr[NPUN1];     /* absorbing mask */
    double pot_cm1[NPUN1];   /* potential, cm-1 (for output only) */

    double pinii[NPIN];      /* momentum grid, energy diagnostics, 1/internal-Angstrom */
    double etotS2[NETOT];    /* energy grid, zots */
    cplx   zpaqip[NPIN];     /* analytic momentum amplitude (WAY 1) */
    cplx   zweightetot[NETOT];
    double reacfct[NETOT];

    cplx psi[NPUN1];
    cplx scratch[NPUN1];
    cplx scratch2[NPUN1];

    cplx zCR[NETOT], zCdR[NETOT], zCRleft[NETOT], zCdRleft[NETOT];
    cplx phase[NETOT], dphase[NETOT];
} Engine;

/* ---------------------------------------------------------------------
 * Setup: grid, potential (Eckart, .f:609-632), absorbing mask (.f:970-993),
 * initial Gaussian wavepacket with auto alpha0/k0 derivation (.f:636-666,
 * 681-688), momentum/energy grids + analytic amplitude + reacfct
 * (.f:704-739, 763-791, 935-943).
 * --------------------------------------------------------------------- */
static void engine_init(Engine *e, const Params *p) {
    e->xmjacreac = p->xmjacreac;
    e->tstep = p->tstep;

    double rmis1 = 0.5e-5 * CONVL;
    double rfin1 = p->rfin1 * CONVL;
    double ah1 = (rfin1 - rmis1) / (double)(NPUN1 - 1);
    e->rmis1 = rmis1;
    e->rfin1_internal = rfin1;
    e->ah1 = ah1;

    /* position + k grids, kinetic propagator (.f:483-487, 591-607) */
    double dpi = 2.0 * PI_;
    double hbrxm1 = 0.5 * HBR * HBR / p->xmjacreac;
    double box1 = ah1 * (double)NPUN1;
    for (int ir1 = 0; ir1 < NPUN1; ir1++) {
        e->r1[ir1] = rmis1 + (double)ir1 * ah1;
        int iii = (ir1 < NPUN1 / 2) ? ir1 : (ir1 - NPUN1);
        double kk = dpi * (double)iii / box1;
        e->pr1[ir1] = kk;
        double p2r1 = kk * kk * hbrxm1;
        e->zp2[ir1] = cexpi(-p2r1 * p->tstep / HBR);
    }

    /* Eckart potential + half-step propagator (.f:609-632) */
    double Aparam = p->Aparam;
    double Bparam = 4.0 * p->Bparam * CONVE;
    double ylength = p->ylength;
    for (int ir1 = 0; ir1 < NPUN1; ir1++) {
        double r1 = e->r1[ir1];
        double r1au = r1 / CONVL - 25.0;
        double chi = -exp(2.0 * PI_ * r1au / ylength);
        double ff1 = chi / (1.0 - chi);
        double ff2 = chi / ((1.0 - chi) * (1.0 - chi));
        double vvv = -Aparam * ff1 - Bparam * ff2;       /* hartree */
        vvv = vvv / CONVE * CONVE1;                       /* -> zots */
        e->pot_cm1[ir1] = vvv / CONVE1;                    /* -> cm-1, for display */
        e->zV[ir1] = cexpi(-0.5 * vvv * p->tstep / HBR);
    }

    /* absorbing mask (.f:970-993) */
    double absr1min = p->absr1min * CONVL;
    double absr1max = p->absr1max * CONVL;
    double absalp = p->absalp;
    for (int ir1 = 0; ir1 < NPUN1; ir1++) {
        double r1 = e->r1[ir1];
        double fvalue = 1.0;
        if (r1 <= absr1min) {
            double d = r1 - absr1min;
            fvalue = exp(-absalp * d * d);
        } else if (r1 >= absr1max) {
            double d = r1 - absr1max;
            fvalue = exp(-absalp * d * d);
        }
        e->absfr[ir1] = fvalue;
    }

    /* flux evaluation points: nearest grid index at or below target (.f:500-517) */
    double rflux = p->rflux * CONVL;
    double rfluxleft = p->rfluxleft * CONVL;
    int irflux = 0, irfluxleft = 0;
    for (int ir1 = 0; ir1 < NPUN1; ir1++) {
        double r = e->r1[ir1];
        if (r <= rflux) irflux = ir1;
        if (r <= rfluxleft) irfluxleft = ir1;
    }
    e->irflux = irflux;
    e->irfluxleft = irfluxleft;

    /* initial Gaussian: auto-derive alpha0/k0 unless overridden (.f:651-666) */
    double ecol = p->ecol * CONVE1;
    double r1col = p->r1col * CONVL;
    double deltae = p->deltae * CONVE1;
    double xk0 = -sqrt(2.0 * p->xmjacreac * ecol) / HBR;
    double alpha0 = sqrt(2.0 * ecol / p->xmjacreac) * HBR / deltae;
    if (!isnan(p->xk0_override)) xk0 = p->xk0_override;
    if (!isnan(p->alpha0_override)) alpha0 = p->alpha0_override;
    e->r1col = r1col;
    e->xk0 = xk0;
    e->alpha0 = alpha0;

    double factor = pow(2.0 / PI_ / alpha0 / alpha0, 0.25);
    for (int ir1 = 0; ir1 < NPUN1; ir1++) {
        double r1 = e->r1[ir1];
        double dr = r1 - r1col;
        cplx amp = cexpi(xk0 * dr);
        double env = factor * exp(-dr * dr / alpha0 / alpha0);
        e->psi[ir1] = cscale(amp, env);
    }

    /* momentum grid + energy grid for flux diagnostics (.f:704-739) */
    double pmis = -PI_ / ah1;
    double pfin = PI_ / ah1;
    double ahp = (pfin - pmis) / (double)(2 * NETOT);
    for (int ip = 0; ip < NPIN; ip++) e->pinii[ip] = pmis + (double)ip * ahp;
    for (int ie = 0; ie < NETOT; ie++) {
        double pk = e->pinii[NETOT - ie - 1];
        e->etotS2[ie] = HBR * HBR * pk * pk / (2.0 * p->xmjacreac);
    }

    /* analytic momentum amplitude, WAY 1 (.f:768-791) */
    double xfccc = pow(alpha0 * alpha0 / 2.0 / PI_, 0.25);
    for (int ip = 0; ip < NPIN; ip++) {
        double pinn = e->pinii[ip];
        double d = xk0 - pinn;
        cplx amp = cexpi(-r1col * pinn);
        double env = xfccc * exp(-d * d * alpha0 * alpha0 / 4.0);
        e->zpaqip[ip] = cscale(amp, env);
    }

    /* zweightetot + reacfct (.f:849-864, 935-943) */
    for (int ie = 0; ie < NETOT; ie++) {
        int ip = NETOT - ie - 1;
        double pk = e->pinii[ip];
        double w = sqrt(p->xmjacreac / HBR / HBR / fabs(pk));
        e->zweightetot[ie] = cscale(e->zpaqip[ip], w);

        double cccc = 1.0 / sqrt(2.0) / sqrt(PI_);
        cplx zffft = cscale(e->zpaqip[ip], cccc);
        double paqini = cabs2(zffft);
        e->reacfct[ie] = -HBR * HBR * pk / paqini / p->xmjacreac / p->xmjacreac
                          / 4.0 / PI_ / PI_;
    }

    /* incremental phase-rotation factors for the flux/energy accumulation
     * loop: dphase(ie) = exp(i*E(ie)*tstep/hbar); phase(ie) is advanced by
     * one multiplication per step instead of recomputing cexpi(E*t/hbar)
     * from scratch (mathematically identical, ~40M fewer transcendental
     * calls over a full 20000-step / 2000-energy run). */
    for (int ie = 0; ie < NETOT; ie++) {
        e->dphase[ie] = cexpi(e->etotS2[ie] * p->tstep / HBR);
        e->phase[ie] = (cplx){ 1.0, 0.0 };
        e->zCR[ie] = e->zCdR[ie] = e->zCRleft[ie] = e->zCdRleft[ie] = (cplx){ 0.0, 0.0 };
    }
}

/* One split-operator step (.f:1007-1049) + spectral derivative at the two
 * flux points (.f:1079-1105) + incremental energy-resolved accumulation
 * (.f:1109-1123). Leaves e->psi in the post-full-step, PRE-absorption
 * state -- this is deliberate: the Fortran writes paq###### / momentapaq
 * snapshots from exactly this state and only calls absorb() as the very
 * last thing in the time-step loop (.f:1259), after those writes. Callers
 * must invoke engine_apply_absorption() once they're done reading/
 * snapshotting this step's psi, before the next engine_step() call. */
static void engine_step(Engine *e) {
    int n = NPUN1;
    for (int i = 0; i < n; i++) e->psi[i] = cmul(e->psi[i], e->zV[i]);

    fft(e->psi, n, +1);                          /* FFTW_BACKWARD */
    for (int i = 0; i < n; i++) e->psi[i] = cmul(e->psi[i], e->zp2[i]);
    fft(e->psi, n, -1);                          /* FFTW_FORWARD */
    for (int i = 0; i < n; i++) e->psi[i] = cscale(e->psi[i], 1.0 / n);

    for (int i = 0; i < n; i++) e->psi[i] = cmul(e->psi[i], e->zV[i]);

    /* capture pre-absorption state at flux points */
    cplx f_r = e->psi[e->irflux];
    cplx f_l = e->psi[e->irfluxleft];

    /* spectral derivative dpsi/dx = i * IFFT[k * FFT[psi]] (.f:1079-1105) */
    memcpy(e->scratch, e->psi, sizeof(cplx) * n);
    fft(e->scratch, n, +1);                      /* FFTW_BACKWARD */
    for (int i = 0; i < n; i++) e->scratch[i] = cscale(e->scratch[i], e->pr1[i]);
    fft(e->scratch, n, -1);                      /* FFTW_FORWARD */
    for (int i = 0; i < n; i++) e->scratch[i] = cscale(e->scratch[i], 1.0 / n);
    cplx d_r = cmul(CPLX_I, e->scratch[e->irflux]);
    cplx d_l = cmul(CPLX_I, e->scratch[e->irfluxleft]);

    for (int ie = 0; ie < NETOT; ie++) {
        e->phase[ie] = cmul(e->phase[ie], e->dphase[ie]);
        e->zCR[ie]      = cadd(e->zCR[ie],      cmul(e->phase[ie], f_r));
        e->zCdR[ie]     = cadd(e->zCdR[ie],     cmul(e->phase[ie], d_r));
        e->zCRleft[ie]  = cadd(e->zCRleft[ie],  cmul(e->phase[ie], f_l));
        e->zCdRleft[ie] = cadd(e->zCdRleft[ie], cmul(e->phase[ie], d_l));
    }
}

/* Multiplicative absorbing mask (.f:1259, subroutine absorb .f:1460-1546).
 * Called once per step, AFTER any snapshot of this step's pre-absorption
 * psi has been taken (see engine_step's doc comment). */
static void engine_apply_absorption(Engine *e) {
    for (int i = 0; i < NPUN1; i++) e->psi[i] = cscale(e->psi[i], e->absfr[i]);
}

/* T(E)/R(E) from the accumulated flux integrals (.f:1127-1148). */
static void engine_transmission(const Engine *e, double *energy_cm1, double *trans, double *reflec) {
    for (int ie = 0; ie < NETOT; ie++) {
        double xpopflux = -cmul(cconj(e->zCR[ie]), e->zCdR[ie]).im
                           * e->tstep * e->tstep * e->reacfct[ie];
        double xpopfluxleft = cmul(cconj(e->zCRleft[ie]), e->zCdRleft[ie]).im
                               * e->tstep * e->tstep * e->reacfct[ie];
        energy_cm1[ie] = e->etotS2[ie] / CONVE1;
        trans[ie] = xpopfluxleft;
        reflec[ie] = xpopflux;
    }
}

/* Analytic Eckart transmission formula (.f:1320-1353), valid for B > C
 * (true for all the shipped defaults). Uses the same energy grid (etotS2,
 * zots) the numeric side uses, so the two curves overlay on one x-axis. */
static void engine_analytic_transmission(const Engine *e, const Params *p,
                                          double *energy_cm1, double *trans) {
    double mu = p->xmjacreac * CONVM;
    double Bparam = 4.0 * p->Bparam * CONVE;   /* hartree, matches engine_init */
    double Aparam = p->Aparam;                  /* hartree */
    double Cparam = PI_ * PI_ / (2.0 * mu * p->ylength * p->ylength);
    for (int ie = 0; ie < NETOT; ie++) {
        double x = e->etotS2[ie] / CONVE1 * CONVE;   /* zots -> cm-1 -> hartree */
        double alpha = 0.5 * sqrt(x / Cparam);
        double beta = 0.5 * sqrt((x - Aparam) / Cparam);
        double delta = 0.5 * sqrt((Bparam - Cparam) / Cparam);
        double reflec = (cosh(2.0 * PI_ * (alpha - beta)) + cosh(2.0 * PI_ * delta)) /
                         (cosh(2.0 * PI_ * (alpha + beta)) + cosh(2.0 * PI_ * delta));
        energy_cm1[ie] = e->etotS2[ie] / CONVE1;
        trans[ie] = 1.0 - reflec;
    }
}

/* WAY-2 numeric momentum amplitude via brute-force quadrature (.f:794-830),
 * used only for the "gaussp" cross-check plot against the analytic WAY-1
 * curve already stored in e->zpaqip -- not used anywhere in the actual
 * propagation physics. */
static void engine_gaussp_numeric(const Engine *e, const Params *p, cplx *zpa_out) {
    double rmisproy = 25.0 * CONVL, rfinproy = 55.0 * CONVL;
    double ahgauss = (rfinproy - rmisproy) / (double)(NPUNT - 1);
    double cccc = 1.0 / sqrt(2.0) / sqrt(PI_);
    for (int ip = 0; ip < NPIN; ip++) {
        double pinn = e->pinii[ip];
        cplx sum = { 0.0, 0.0 };
        for (int ir = 0; ir < NPUNT; ir++) {
            double r = rmisproy + (double)ir * ahgauss;
            cplx basis = cexpi(-r * pinn);
            double dr = r - e->r1col;
            double env = exp(-dr * dr / e->alpha0 / e->alpha0);
            cplx amp = cmul(cexpi(e->xk0 * dr), (cplx){ env, 0.0 });
            sum = cadd(sum, cmul(basis, amp));
        }
        double factor = pow(2.0 / PI_ / e->alpha0 / e->alpha0, 0.25);
        zpa_out[ip] = cscale(sum, cccc * ahgauss * factor);
    }
}

/* ======================================================================
 * WebAssembly export layer: buffers every snapshot/overview array the
 * frontend needs (see docs/app.js's `runData` shape) in memory, exposed
 * to JS as pointer getters into the WASM heap (fixed lengths: NPUN1,
 * NPIN, NETOT, NSNAP -- mirrored in docs/param-spec.js's BUILD_INFO so JS
 * never needs a separate length query). Runs in chunks via
 * wasm_run_steps(n) so the caller (a Web Worker) can post progress
 * updates between calls without needing real threads/callbacks.
 * ====================================================================== */
#ifdef __EMSCRIPTEN__
#include <emscripten.h>

typedef struct {
    double pot_position[NPUN1], pot_potential[NPUN1];
    double paq0_position[NPUN1], paq0_prob[NPUN1];
    double gp_k[NPIN], gp_re[NPIN], gp_im[NPIN], gp_prob[NPIN];
    double ga_k[NPIN], ga_re[NPIN], ga_im[NPIN], ga_prob[NPIN];
    double gE_energy[NETOT], gE_re[NETOT], gE_im[NETOT], gE_prob[NETOT]; /* index 0 unused, matches .f's ie>1 guard */

    int snap_count;
    int snap_step[NSNAP];
    double paq_position[NPUN1];
    double paq_re[NSNAP][NPUN1];
    double paq_im[NSNAP][NPUN1];
    double paq_prob[NSNAP][NPUN1];
    double mom_k[NPUN1];
    double mom_prob[NSNAP][NPUN1];
    double mom_re[NSNAP][NPUN1];

    double trans_energy[NETOT], trans_left[NETOT], trans_right[NETOT], trans_analytic[NETOT];
} Results;

static Engine *g_engine = NULL;
static Results *g_results = NULL;
static Params g_params;
static int g_step = 0;

static void capture_snapshot(Engine *e, Results *r, int idx) {
    for (int i = 0; i < NPUN1; i++) {
        double xpop = cabs2(e->psi[i]);
        r->paq_re[idx][i] = e->psi[i].re * sqrt(CONVL);
        r->paq_im[idx][i] = e->psi[i].im * sqrt(CONVL);
        r->paq_prob[idx][i] = xpop * CONVL;
    }

    static cplx scratch3[NPUN1];
    memcpy(scratch3, e->psi, sizeof(cplx) * NPUN1);
    fft(scratch3, NPUN1, -1); /* FFTW_FORWARD, unnormalized (.f:1210-1247) */
    double xfcacp = (e->ah1 / sqrt(2.0 * PI_));
    xfcacp = xfcacp * xfcacp;
    int j = 0;
    for (int ir = NPUN1 / 2; ir < NPUN1; ir++) {
        double xpop1 = cabs2(scratch3[ir]);
        r->mom_prob[idx][j] = xfcacp * xpop1 / CONVL;
        r->mom_re[idx][j] = sqrt(xfcacp) * scratch3[ir].re / sqrt(CONVL);
        j++;
    }
    for (int ir = 0; ir < NPUN1 / 2; ir++) {
        double xpop1 = cabs2(scratch3[ir]);
        r->mom_prob[idx][j] = xfcacp * xpop1 / CONVL;
        r->mom_re[idx][j] = sqrt(xfcacp) * scratch3[ir].re / sqrt(CONVL);
        j++;
    }
}

EMSCRIPTEN_KEEPALIVE
int wasm_init(double *params16) {
    Params p = {
        .xmjacreac = params16[0], .tstep = params16[1], .rfin1 = params16[2],
        .rflux = params16[3], .rfluxleft = params16[4],
        .absr1min = params16[5], .absr1max = params16[6], .absalp = params16[7],
        .Aparam = params16[8], .Bparam = params16[9], .ylength = params16[10],
        .ecol = params16[11], .r1col = params16[12], .deltae = params16[13],
        .alpha0_override = params16[14], .xk0_override = params16[15],
    };
    g_params = p;

    free(g_engine);
    free(g_results);
    g_engine = calloc(1, sizeof(Engine));
    g_results = calloc(1, sizeof(Results));
    engine_init(g_engine, &p);
    g_step = 0;
    g_results->snap_count = 0;

    Engine *e = g_engine;
    Results *r = g_results;

    for (int i = 0; i < NPUN1; i++) {
        r->pot_position[i] = e->r1[i] / CONVL;
        r->pot_potential[i] = e->pot_cm1[i];
        r->paq0_position[i] = e->r1[i] / CONVL;
        r->paq0_prob[i] = cabs2(e->psi[i]) * CONVL;
        r->paq_position[i] = e->r1[i] / CONVL;
    }
    /* mom_k grid, same ordering capture_snapshot fills (negative half then positive half) */
    int j = 0;
    for (int ir = NPUN1 / 2; ir < NPUN1; ir++) r->mom_k[j++] = e->pr1[ir] * CONVL;
    for (int ir = 0; ir < NPUN1 / 2; ir++) r->mom_k[j++] = e->pr1[ir] * CONVL;

    for (int ip = 0; ip < NPIN; ip++) {
        double paqi = cabs2(e->zpaqip[ip]);
        r->ga_k[ip] = e->pinii[ip] * CONVL;
        r->ga_re[ip] = e->zpaqip[ip].re / sqrt(CONVL);
        r->ga_im[ip] = e->zpaqip[ip].im / sqrt(CONVL);
        r->ga_prob[ip] = paqi / CONVL;
    }
    cplx *zpa = malloc(sizeof(cplx) * NPIN);
    engine_gaussp_numeric(e, &p, zpa);
    for (int ip = 0; ip < NPIN; ip++) {
        double paqi = cabs2(zpa[ip]);
        r->gp_k[ip] = e->pinii[ip] * CONVL;
        r->gp_re[ip] = zpa[ip].re / sqrt(CONVL);
        r->gp_im[ip] = zpa[ip].im / sqrt(CONVL);
        r->gp_prob[ip] = paqi / CONVL;
    }
    free(zpa);

    for (int ie = 1; ie < NETOT; ie++) {
        double w2 = cabs2(e->zweightetot[ie]);
        r->gE_energy[ie] = e->etotS2[ie] / CONVE1;
        r->gE_re[ie] = e->zweightetot[ie].re * sqrt(CONVE1);
        r->gE_im[ie] = e->zweightetot[ie].im * sqrt(CONVE1);
        r->gE_prob[ie] = w2 * CONVE1;
    }

    return 0;
}

/* Runs up to n more steps (fewer if NTIMES is reached), snapshotting every
 * OUT_EVERY steps, and finalizing the transmission spectrum once NTIMES is
 * reached. Returns the total number of steps completed so far. */
EMSCRIPTEN_KEEPALIVE
int wasm_run_steps(int n) {
    int target = g_step + n;
    if (target > NTIMES) target = NTIMES;
    while (g_step < target) {
        g_step++;
        engine_step(g_engine);
        if (g_step % OUT_EVERY == 0 && g_results->snap_count < NSNAP) {
            capture_snapshot(g_engine, g_results, g_results->snap_count);
            g_results->snap_step[g_results->snap_count] = g_step;
            g_results->snap_count++;
        }
        engine_apply_absorption(g_engine);
    }
    if (g_step >= NTIMES) {
        engine_transmission(g_engine, g_results->trans_energy, g_results->trans_left, g_results->trans_right);
        engine_analytic_transmission(g_engine, &g_params, g_results->trans_energy, g_results->trans_analytic);
    }
    return g_step;
}

EMSCRIPTEN_KEEPALIVE double wasm_init_cond_xk0(void) { return g_engine->xk0; }
EMSCRIPTEN_KEEPALIVE double wasm_init_cond_alpha0(void) { return g_engine->alpha0; }

EMSCRIPTEN_KEEPALIVE double* wasm_pot_position(void) { return g_results->pot_position; }
EMSCRIPTEN_KEEPALIVE double* wasm_pot_potential(void) { return g_results->pot_potential; }
EMSCRIPTEN_KEEPALIVE double* wasm_paq0_position(void) { return g_results->paq0_position; }
EMSCRIPTEN_KEEPALIVE double* wasm_paq0_prob(void) { return g_results->paq0_prob; }
EMSCRIPTEN_KEEPALIVE double* wasm_gaussp_k(void) { return g_results->gp_k; }
EMSCRIPTEN_KEEPALIVE double* wasm_gaussp_re(void) { return g_results->gp_re; }
EMSCRIPTEN_KEEPALIVE double* wasm_gaussp_im(void) { return g_results->gp_im; }
EMSCRIPTEN_KEEPALIVE double* wasm_gaussp_prob(void) { return g_results->gp_prob; }
EMSCRIPTEN_KEEPALIVE double* wasm_gausspanalytic_k(void) { return g_results->ga_k; }
EMSCRIPTEN_KEEPALIVE double* wasm_gausspanalytic_re(void) { return g_results->ga_re; }
EMSCRIPTEN_KEEPALIVE double* wasm_gausspanalytic_im(void) { return g_results->ga_im; }
EMSCRIPTEN_KEEPALIVE double* wasm_gausspanalytic_prob(void) { return g_results->ga_prob; }
EMSCRIPTEN_KEEPALIVE double* wasm_gaussE_energy(void) { return g_results->gE_energy; }
EMSCRIPTEN_KEEPALIVE double* wasm_gaussE_re(void) { return g_results->gE_re; }
EMSCRIPTEN_KEEPALIVE double* wasm_gaussE_im(void) { return g_results->gE_im; }
EMSCRIPTEN_KEEPALIVE double* wasm_gaussE_prob(void) { return g_results->gE_prob; }

EMSCRIPTEN_KEEPALIVE int wasm_snap_count(void) { return g_results->snap_count; }
EMSCRIPTEN_KEEPALIVE int wasm_snap_step(int idx) { return g_results->snap_step[idx]; }
EMSCRIPTEN_KEEPALIVE double* wasm_paq_position(void) { return g_results->paq_position; }
EMSCRIPTEN_KEEPALIVE double* wasm_paq_re(int idx) { return g_results->paq_re[idx]; }
EMSCRIPTEN_KEEPALIVE double* wasm_paq_im(int idx) { return g_results->paq_im[idx]; }
EMSCRIPTEN_KEEPALIVE double* wasm_paq_prob(int idx) { return g_results->paq_prob[idx]; }
EMSCRIPTEN_KEEPALIVE double* wasm_mom_k(void) { return g_results->mom_k; }
EMSCRIPTEN_KEEPALIVE double* wasm_mom_prob(int idx) { return g_results->mom_prob[idx]; }
EMSCRIPTEN_KEEPALIVE double* wasm_mom_re(int idx) { return g_results->mom_re[idx]; }

EMSCRIPTEN_KEEPALIVE double* wasm_trans_energy(void) { return g_results->trans_energy; }
EMSCRIPTEN_KEEPALIVE double* wasm_trans_left(void) { return g_results->trans_left; }
EMSCRIPTEN_KEEPALIVE double* wasm_trans_right(void) { return g_results->trans_right; }
EMSCRIPTEN_KEEPALIVE double* wasm_trans_analytic(void) { return g_results->trans_analytic; }

#endif /* __EMSCRIPTEN__ */

/* ======================================================================
 * NATIVE_TEST harness: runs a full simulation and writes output files in
 * the same simple whitespace-column format the Fortran used, so they can
 * be loaded with webui/parsers.py and compared numerically against a real
 * reference run already present under runs/.
 * ====================================================================== */
#ifdef NATIVE_TEST

static FILE *open_out(const char *dir, const char *name) {
    char path[1024];
    snprintf(path, sizeof(path), "%s/%s", dir, name);
    FILE *f = fopen(path, "w");
    if (!f) { fprintf(stderr, "cannot open %s for writing\n", path); exit(1); }
    return f;
}

int main(int argc, char **argv) {
    const char *outdir = (argc > 1) ? argv[1] : ".";

    /* Parameters matching runs/20260922_025941_ecol200/meta.json */
    Params p = {
        .xmjacreac = 87.0,
        .tstep = 0.1,
        .rfin1 = 55.0,
        .rflux = 43.0,
        .rfluxleft = 12.0,
        .absr1min = 11.0,
        .absr1max = 44.0,
        .absalp = 0.0007,
        .Aparam = 0.0,
        .Bparam = 500.0,
        .ylength = 10.0,
        .ecol = 200.0,
        .r1col = 40.0,
        .deltae = 156.25,
        .alpha0_override = NAN,
        .xk0_override = NAN,
    };

    Engine *e = calloc(1, sizeof(Engine));
    engine_init(e, &p);

    fprintf(stderr, "alpha0=%.10g  xk0=%.10g  irflux=%d irfluxleft=%d\n",
            e->alpha0, e->xk0, e->irflux, e->irfluxleft);

    /* pot */
    {
        FILE *f = open_out(outdir, "pot");
        for (int i = 0; i < NPUN1; i++)
            fprintf(f, "%.7e %.7e\n", e->r1[i] / CONVL, e->pot_cm1[i]);
        fclose(f);
    }

    /* paq0 */
    {
        FILE *f = open_out(outdir, "paq0");
        for (int i = 0; i < NPUN1; i++) {
            double xpop = cabs2(e->psi[i]);
            fprintf(f, "%.7e %.7e\n", e->r1[i] / CONVL, xpop * CONVL);
        }
        fclose(f);
    }

    /* gausspanalytic (WAY 1) */
    {
        FILE *f = open_out(outdir, "gausspanalytic");
        for (int ip = 0; ip < NPIN; ip++) {
            double paqi = cabs2(e->zpaqip[ip]);
            fprintf(f, "%.7e %.7e %.7e %.7e\n",
                    e->pinii[ip] * CONVL,
                    e->zpaqip[ip].re / sqrt(CONVL),
                    e->zpaqip[ip].im / sqrt(CONVL),
                    paqi / CONVL);
        }
        fclose(f);
    }

    /* gaussp (WAY 2, numeric quadrature cross-check) */
    {
        cplx *zpa = malloc(sizeof(cplx) * NPIN);
        engine_gaussp_numeric(e, &p, zpa);
        FILE *f = open_out(outdir, "gaussp");
        for (int ip = 0; ip < NPIN; ip++) {
            double paqi = cabs2(zpa[ip]);
            fprintf(f, "%.7e %.7e %.7e %.7e\n",
                    e->pinii[ip] * CONVL,
                    zpa[ip].re / sqrt(CONVL),
                    zpa[ip].im / sqrt(CONVL),
                    paqi / CONVL);
        }
        fclose(f);
        free(zpa);
    }

    /* gaussE */
    {
        FILE *f = open_out(outdir, "gaussE");
        for (int ie = 1; ie < NETOT; ie++) {
            double energystep = e->etotS2[ie] - e->etotS2[ie - 1];
            double w2 = cabs2(e->zweightetot[ie]);
            fprintf(f, "%.7e %.7e %.7e %.7e\n",
                    e->etotS2[ie] / CONVE1,
                    e->zweightetot[ie].re * sqrt(CONVE1),
                    e->zweightetot[ie].im * sqrt(CONVE1),
                    w2 * CONVE1);
            (void)energystep;
        }
        fclose(f);
    }

    /* propagation loop with periodic snapshots */
    for (int it = 1; it <= NTIMES; it++) {
        engine_step(e);

        if (it % OUT_EVERY == 0) {
            char name[64];

            snprintf(name, sizeof(name), "paq%06d", it);
            FILE *f = open_out(outdir, name);
            for (int i = 0; i < NPUN1; i++) {
                double xpop = cabs2(e->psi[i]);
                fprintf(f, "%.7e %.7e %.7e %.7e\n",
                        e->r1[i] / CONVL,
                        e->psi[i].re * sqrt(CONVL),
                        e->psi[i].im * sqrt(CONVL),
                        xpop * CONVL);
            }
            fclose(f);

            /* momentum distribution: raw (unnormalized) forward FFT of psi (.f:1210-1247) */
            memcpy(e->scratch2, e->psi, sizeof(cplx) * NPUN1);
            fft(e->scratch2, NPUN1, -1); /* FFTW_FORWARD, unnormalized */
            double xfcacp = (e->ah1 / sqrt(2.0 * PI_));
            xfcacp = xfcacp * xfcacp;

            snprintf(name, sizeof(name), "momentapaq%06d", it);
            f = open_out(outdir, name);
            for (int ir = NPUN1 / 2; ir < NPUN1; ir++) {
                double xpop1 = cabs2(e->scratch2[ir]);
                fprintf(f, "%.7e %.7e %.7e\n",
                        e->pr1[ir] * CONVL, xfcacp * xpop1 / CONVL,
                        sqrt(xfcacp) * e->scratch2[ir].re / sqrt(CONVL));
            }
            for (int ir = 0; ir < NPUN1 / 2; ir++) {
                double xpop1 = cabs2(e->scratch2[ir]);
                fprintf(f, "%.7e %.7e %.7e\n",
                        e->pr1[ir] * CONVL, xfcacp * xpop1 / CONVL,
                        sqrt(xfcacp) * e->scratch2[ir].re / sqrt(CONVL));
            }
            fclose(f);

            /* transmission/reflection spectrum */
            double *energy_cm1 = malloc(sizeof(double) * NETOT);
            double *trans = malloc(sizeof(double) * NETOT);
            double *reflec = malloc(sizeof(double) * NETOT);
            engine_transmission(e, energy_cm1, trans, reflec);

            snprintf(name, sizeof(name), "transmission%06d", it);
            f = open_out(outdir, name);
            for (int ie = 0; ie < NETOT; ie++)
                fprintf(f, "%.7e %.7e %.7e\n", energy_cm1[ie], trans[ie], reflec[ie]);
            fclose(f);

            free(energy_cm1); free(trans); free(reflec);

            fprintf(stderr, "step %d/%d done\n", it, NTIMES);
        }

        engine_apply_absorption(e);
    }

    /* analytic transmission curve */
    {
        double *energy_cm1 = malloc(sizeof(double) * NETOT);
        double *trans = malloc(sizeof(double) * NETOT);
        engine_analytic_transmission(e, &p, energy_cm1, trans);
        FILE *f = open_out(outdir, "analytic");
        for (int ie = 0; ie < NETOT; ie++)
            fprintf(f, "%.7e %.7e\n", energy_cm1[ie], trans[ie]);
        fclose(f);
        free(energy_cm1); free(trans);
    }

    free(e);
    fprintf(stderr, "done.\n");
    return 0;
}

#endif /* NATIVE_TEST */
