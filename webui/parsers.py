"""Parsing of mlara_win.exe's whitespace-delimited ASCII output files into
JSON-friendly column dicts, for the results view.
"""
import io
import re
from pathlib import Path

import numpy as np

PAQ_STEP_RE = re.compile(r"^paq(\d{6})$")
MOMENTAPAQ_STEP_RE = re.compile(r"^momentapaq(\d{6})$")
TRANSMISSION_STEP_RE = re.compile(r"^transmission(\d{6})$")

# gfortran's list-directed `write(unit,*)` drops the 'E' on 3-digit exponents
# to keep the field width fixed (e.g. "0.1512555-100" instead of
# "0.1512555E-100"), which numpy.loadtxt can't parse. Only matches a sign
# glued directly to the preceding digit (no separating whitespace), so it
# never touches an ordinary whitespace-separated negative number.
_MISSING_EXPONENT_RE = re.compile(r"(?<=[0-9])([+-]\d{3})(?=\s|$)", re.MULTILINE)


def _load_columns(path: Path, col_names: list[str]) -> dict:
    text = Path(path).read_text()
    text = _MISSING_EXPONENT_RE.sub(r"E\1", text)
    data = np.loadtxt(io.StringIO(text))
    if data.ndim == 1:
        data = data.reshape(1, -1)
    return {name: data[:, i].tolist() for i, name in enumerate(col_names)}


def load_overview(run_dir: Path) -> dict:
    """Small, fixed-name files describing the static setup of a run."""
    out = {}
    specs = {
        "pot": ["position", "potential"],
        "paq0": ["position", "prob"],
        "gaussp": ["k", "re", "im", "prob"],
        "gausspanalytic": ["k", "re", "im", "prob"],
        "gaussE": ["energy", "re", "im", "prob"],
    }
    for filename, cols in specs.items():
        path = run_dir / filename
        if path.exists():
            out[filename] = _load_columns(path, cols)
    return out


def _available_steps(run_dir: Path, pattern: re.Pattern) -> list[int]:
    steps = []
    for entry in run_dir.iterdir():
        m = pattern.match(entry.name)
        if m:
            steps.append(int(m.group(1)))
    return sorted(steps)


def available_paq_steps(run_dir: Path) -> list[int]:
    return _available_steps(run_dir, PAQ_STEP_RE)


def available_momentapaq_steps(run_dir: Path) -> list[int]:
    return _available_steps(run_dir, MOMENTAPAQ_STEP_RE)


def load_paq_frame(run_dir: Path, step: int) -> dict | None:
    path = run_dir / f"paq{step:06d}"
    if not path.exists():
        return None
    return _load_columns(path, ["position", "re", "im", "prob"])


def load_momentapaq_frame(run_dir: Path, step: int) -> dict | None:
    path = run_dir / f"momentapaq{step:06d}"
    if not path.exists():
        return None
    return _load_columns(path, ["k", "prob", "re"])


_INIT_COND_FIELDS = {
    "collision_energy_cm1": r"colision energy\(1/cm\)=\s*(\S+)",
    "energy_width_cm1": r"energy width\(1/cm\)=\s*(\S+)",
    "r10_a0": r"r10\s*=\s*(\S+)",
    "xk0_actual": r"\bk=\s*(\S+)",
    "alpha0_actual": r"alpha=\s*(\S+)",
}


def parse_init_conditions(run_dir: Path) -> dict:
    """Actually-used derived quantities (xk0, alpha0, ...) echoed by the
    program to stdout at startup -- the source of truth for what a run used,
    whether auto-computed from ecol/deltae or explicitly overridden.
    """
    stdout_path = run_dir / "stdout.log"
    if not stdout_path.exists():
        return {}
    text = stdout_path.read_text(errors="ignore")
    text = _MISSING_EXPONENT_RE.sub(r"E\1", text)
    out = {}
    for key, pattern in _INIT_COND_FIELDS.items():
        m = re.search(pattern, text)
        if m:
            try:
                out[key] = float(m.group(1))
            except ValueError:
                pass
    return out


_TIMESTEP_LINE_RE = re.compile(r"^[+-]?\d+\.\d+E[+-]?\d+$", re.IGNORECASE)


def parse_absorption_timeseries(run_dir: Path) -> dict:
    """Cumulative absorbed probability over time, from the per-timestep
    `write(6,1111)time,xnormtot,abstot` line the program prints every step
    (barreritafluxexpenmomchebcontabsmod.f:1523-1536) -- this is the actual
    absorption *happening* during propagation, not the static f(x) profile.
    Isolated by keeping only stdout lines made of exactly 3 float tokens,
    since the setup/summary lines mix text labels with numbers and never
    match that shape.
    """
    stdout_path = run_dir / "stdout.log"
    if not stdout_path.exists():
        return {"time": [], "norm_total": [], "absorbed": []}
    text = stdout_path.read_text(errors="ignore")
    text = _MISSING_EXPONENT_RE.sub(r"E\1", text)

    time, norm_total, absorbed = [], [], []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 3 and all(_TIMESTEP_LINE_RE.match(p) for p in parts):
            time.append(float(parts[0]))
            norm_total.append(float(parts[1]))
            absorbed.append(float(parts[2]))
    return {"time": time, "norm_total": norm_total, "absorbed": absorbed}


def load_transmission_comparison(run_dir: Path) -> dict:
    """Final transmission######## (numeric) overlaid against analytic.

    Column 2 is the flux through the left point (usrrfluxleft), i.e. T(E);
    column 3 the flux through the right point (usrrflux), i.e. R(E).
    """
    steps = _available_steps(run_dir, TRANSMISSION_STEP_RE)
    out = {"numeric": None, "analytic": None, "final_step": None}
    if steps:
        final_step = steps[-1]
        out["final_step"] = final_step
        out["numeric"] = _load_columns(
            run_dir / f"transmission{final_step:06d}",
            ["energy", "transmission", "reflection"],
        )
    analytic_path = run_dir / "analytic"
    if analytic_path.exists():
        out["analytic"] = _load_columns(analytic_path, ["energy", "transmission"])
    return out
