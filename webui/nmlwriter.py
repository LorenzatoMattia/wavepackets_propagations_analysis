"""Defaults for the 14 runtime-configurable simulation parameters, and a
writer for the Fortran NAMELIST file (run_config.nml) the compiled
mlara_win.exe reads at startup.

These defaults must mirror the literal values hardcoded in
barreritafluxexpenmomchebcontabsmod.f before the run_config.nml patch, so
that a run launched with the exact defaults reproduces the original
behavior of the program.
"""

# Each entry: fortran namelist key -> (label, unit, default, group)
PARAM_SPEC = {
    "usrxmjacreac": ("Particle mass", "u (amu)", 87.0, "Mass, timestep & grid"),
    "usrtstep":     ("Time step", "zots", 0.1, "Mass, timestep & grid"),
    "usrrfin1":     ("Grid length (right edge)", "a0", 55.0, "Mass, timestep & grid"),
    "usrrflux":     ("Flux point (right, reflection)", "a0", 43.0, "Flux evaluation points"),
    "usrrfluxleft": ("Flux point (left, transmission)", "a0", 12.0, "Flux evaluation points"),
    "usrabsr1min":  ("Absorption region start", "a0", 11.0, "Absorbing boundary"),
    "usrabsr1max":  ("Absorption region end", "a0", 44.0, "Absorbing boundary"),
    "usrabsalp":    ("Absorption strength", "1/a0", 0.0007, "Absorbing boundary"),
    "usrAparam":    ("Barrier asymmetry (A)", "hartree", 0.0, "Eckart barrier shape"),
    "usrBparam":    ("Barrier height factor (B, x4)", "cm-1", 500.0, "Eckart barrier shape"),
    "usrylength":   ("Barrier width", "a0", 10.0, "Eckart barrier shape"),
    "usrecol":      ("Collision energy", "cm-1", 500.0, "Initial wavepacket"),
    "usrr1col":     ("Wavepacket start position", "a0", 40.0, "Initial wavepacket"),
    "usrdeltae":    ("Energy width", "cm-1", 500.0 / 3.2, "Initial wavepacket"),
    # Normally derived from ecol/deltae/mass (see parse_init_conditions for
    # the actual value used in a given run); default None = "auto", leave
    # blank to keep that. Only set these to bypass the derivation directly.
    "usralpha0":    ("Wavepacket width α (override)", "a0", None, "Override auto-computed k/α"),
    "usrxk0":       ("Mean momentum k (override)", "1/a0", None, "Override auto-computed k/α"),
}

# Read-only compile-time constants (require editing locales.parameter.h + rebuild)
BUILD_INFO = {
    "ntimes": 20000,
    "npun1": 2048,
    "netot": 2000,
    "npunt": 12000,
    "npun": 12000,
}

GROUP_ORDER = [
    "Mass, timestep & grid",
    "Flux evaluation points",
    "Absorbing boundary",
    "Eckart barrier shape",
    "Initial wavepacket",
    "Override auto-computed k/α",
]

PARAM_LABELS = {key: (label, unit) for key, (label, unit, default, group) in PARAM_SPEC.items()}


def default_params():
    """Dict of namelist-key -> default float value."""
    return {key: spec[2] for key, spec in PARAM_SPEC.items()}


def grouped_fields():
    """PARAM_SPEC entries grouped and ordered for form rendering."""
    groups = {g: [] for g in GROUP_ORDER}
    for key, (label, unit, default, group) in PARAM_SPEC.items():
        groups[group].append(
            {"key": key, "label": label, "unit": unit, "default": default}
        )
    return [{"name": g, "fields": groups[g]} for g in GROUP_ORDER]


def render_namelist(params: dict) -> str:
    """Render a &runcfg NAMELIST block. `params` may be a partial dict;
    only keys present are written, so gfortran's NAMELIST read leaves any
    omitted key at its in-program default (see nml_smoketest verification).
    """
    lines = ["&runcfg"]
    for key in PARAM_SPEC:
        if key in params and params[key] is not None:
            value = float(params[key])
            lines.append(f"{key} = {value!r}")
    lines.append("/")
    return "\n".join(lines) + "\n"


def write_namelist(path, params: dict) -> None:
    with open(path, "w") as f:
        f.write(render_namelist(params))
