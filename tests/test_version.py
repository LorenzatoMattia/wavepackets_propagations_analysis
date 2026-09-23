import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION = (ROOT / "VERSION").read_text().strip()
APP_NAME = f"Wavepacket Propagation Analysis - V{VERSION}"


def test_version_is_semver():
    assert re.fullmatch(r"\d+\.\d+\.\d+", VERSION)


def test_browser_build_shows_version_in_title_and_header():
    # docs/ is a static site with no build step for HTML, so the version is
    # written into index.html by hand -- this keeps it in sync with VERSION.
    html = (ROOT / "docs" / "index.html").read_text(encoding="utf-8")

    assert f"<title>{APP_NAME}</title>" in html
    assert f'id="nav-brand">{APP_NAME}</a>' in html


def test_webui_shows_version_in_title_and_header():
    from app import app

    html = app.test_client().get("/").get_data(as_text=True)

    assert f">{APP_NAME}" in html
    assert re.search(rf"<title>\s*Runs — {re.escape(APP_NAME)}\s*</title>", html)
