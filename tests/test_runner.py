import pytest

import runner


def test_exe_lives_in_fortran_folder():
    assert runner.EXE_PATH == runner.BASE_DIR / "fortran" / "mlara_win.exe"


def test_launch_without_exe_explains_where_to_put_it(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "EXE_PATH", tmp_path / "fortran" / "mlara_win.exe")
    monkeypatch.setattr(runner, "RUNS_DIR", tmp_path / "runs")

    with pytest.raises(RuntimeError, match="fortran/"):
        runner.launch({})

    assert not (tmp_path / "runs").exists()
