import parsers


def test_transmission_columns_map_to_transmission_and_reflection(tmp_path):
    # Column 2 is the flux through the left (transmission) point, column 3
    # through the right (reflection) point -- see engine.c's
    # engine_transmission() and the real Fortran output, where column 2
    # matches the analytic Eckart T(E) and column 3 is ~1 - T(E).
    (tmp_path / "transmission000100").write_text("1.0 0.9 0.9\n")
    (tmp_path / "transmission020000").write_text(
        "100.0 0.0 1.0\n"
        "500.0 0.5 0.5\n"
        "900.0 1.0 0.0\n"
    )
    (tmp_path / "analytic").write_text(
        "100.0 0.0\n"
        "500.0 0.5\n"
        "900.0 1.0\n"
    )

    out = parsers.load_transmission_comparison(tmp_path)

    assert out["final_step"] == 20000
    assert out["numeric"]["energy"] == [100.0, 500.0, 900.0]
    assert out["numeric"]["transmission"] == [0.0, 0.5, 1.0]
    assert out["numeric"]["reflection"] == [1.0, 0.5, 0.0]
    assert out["analytic"]["transmission"] == [0.0, 0.5, 1.0]


def test_transmission_missing_files_returns_empty(tmp_path):
    out = parsers.load_transmission_comparison(tmp_path)

    assert out == {"numeric": None, "analytic": None, "final_step": None}
