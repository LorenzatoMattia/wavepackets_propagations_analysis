"""Run lifecycle: create an isolated run directory, launch mlara_win.exe in
it with a generated run_config.nml + fresh-start cont.data, and track its
progress/completion. Single run at a time (no queue) -- this is a
single-user local tool.
"""
import json
import subprocess
from datetime import datetime
from pathlib import Path

from nmlwriter import BUILD_INFO, default_params, write_namelist

BASE_DIR = Path(__file__).resolve().parent.parent  # repo root
# The Fortran source and its compiled binary are course material and are not
# distributed with this repo -- see README. libfftw3-3.dll must sit next to
# the exe (Windows resolves DLLs from the executable's own directory).
FORTRAN_DIR = BASE_DIR / "fortran"
EXE_PATH = FORTRAN_DIR / "mlara_win.exe"
RUNS_DIR = BASE_DIR / "runs"
RUNS_DIR.mkdir(exist_ok=True)

NTIMES = BUILD_INFO["ntimes"]
# Lines written to stdout before the first per-timestep line (banner +
# initial-conditions diagnostics) -- subtracted so the progress bar tracks
# actual timesteps rather than overshooting during startup.
HEADER_LINES = 19

_active: dict[str, subprocess.Popen] = {}


def _slug(params: dict) -> str:
    ecol = params.get("usrecol", default_params()["usrecol"])
    return f"ecol{ecol:g}"


def _write_meta(run_dir: Path, meta: dict) -> None:
    (run_dir / "meta.json").write_text(json.dumps(meta, indent=2))


def get_meta(run_id: str) -> dict | None:
    meta_path = RUNS_DIR / run_id / "meta.json"
    if meta_path.exists():
        return json.loads(meta_path.read_text())
    return None


def _finalize(run_id: str, proc: subprocess.Popen) -> None:
    run_dir = RUNS_DIR / run_id
    meta = get_meta(run_id) or {"run_id": run_id, "params": {}}
    meta["ended_at"] = datetime.now().isoformat(timespec="seconds")
    meta["status"] = "completed" if proc.returncode == 0 else "failed"
    meta["returncode"] = proc.returncode
    _write_meta(run_dir, meta)


def active_run_id() -> str | None:
    """Reap any finished process and return the id of the still-running one, if any."""
    for run_id, proc in list(_active.items()):
        if proc.poll() is None:
            return run_id
        _finalize(run_id, proc)
        del _active[run_id]
    return None


def list_runs() -> list[dict]:
    active_run_id()  # reap finished processes so status is current
    runs = []
    for d in sorted(RUNS_DIR.iterdir(), reverse=True):
        meta = get_meta(d.name)
        if meta:
            runs.append(meta)
    return runs


def launch(params: dict) -> str:
    if not EXE_PATH.exists():
        raise RuntimeError(
            f"mlara_win.exe not found at {EXE_PATH}: place the compiled Fortran "
            "binary (and libfftw3-3.dll) in fortran/ -- see README"
        )
    if active_run_id() is not None:
        raise RuntimeError("A run is already in progress")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    run_id = f"{timestamp}_{_slug(params)}"
    run_dir = RUNS_DIR / run_id
    run_dir.mkdir(parents=True)

    full_params = default_params()
    full_params.update(params)
    write_namelist(run_dir / "run_config.nml", full_params)
    (run_dir / "cont.data").write_text(" 0 0\n")

    stdout_file = open(run_dir / "stdout.log", "w")
    proc = subprocess.Popen(
        [str(EXE_PATH)],
        cwd=str(run_dir),
        stdout=stdout_file,
        stderr=subprocess.STDOUT,
    )
    _active[run_id] = proc

    _write_meta(run_dir, {
        "run_id": run_id,
        "params": full_params,
        "started_at": datetime.now().isoformat(timespec="seconds"),
        "ended_at": None,
        "status": "running",
    })
    return run_id


def status(run_id: str) -> dict:
    run_dir = RUNS_DIR / run_id
    active_run_id()  # reap the process if it just finished

    meta = get_meta(run_id) or {}
    stdout_path = run_dir / "stdout.log"
    lines_done = 0
    if stdout_path.exists():
        with open(stdout_path, "r", errors="ignore") as f:
            lines_done = sum(1 for _ in f)
    steps_done = max(0, lines_done - HEADER_LINES)

    return {
        "run_id": run_id,
        "status": meta.get("status", "unknown"),
        "steps_done": steps_done,
        "ntimes": NTIMES,
        "progress": min(1.0, steps_done / NTIMES) if NTIMES else 0.0,
        "started_at": meta.get("started_at"),
        "ended_at": meta.get("ended_at"),
        "params": meta.get("params", {}),
    }


def tail_stdout(run_id: str, n: int = 200) -> str:
    stdout_path = RUNS_DIR / run_id / "stdout.log"
    if not stdout_path.exists():
        return ""
    with open(stdout_path, "r", errors="ignore") as f:
        lines = f.readlines()
    return "".join(lines[-n:])


def run_dir_path(run_id: str) -> Path:
    return RUNS_DIR / run_id


def rename_run(run_id: str, display_name: str) -> None:
    run_dir = RUNS_DIR / run_id
    meta = get_meta(run_id)
    if meta is None:
        raise RuntimeError(f"Unknown run {run_id}")
    meta["display_name"] = display_name.strip() or None
    _write_meta(run_dir, meta)


def delete_run(run_id: str) -> None:
    import shutil
    run_dir = RUNS_DIR / run_id
    if run_dir.exists() and run_dir.parent == RUNS_DIR:
        shutil.rmtree(run_dir)
