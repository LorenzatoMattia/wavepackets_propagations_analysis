import sys
from pathlib import Path

# webui/ modules import each other flat (`import parsers`), as when run via
# `cd webui && python app.py` -- mirror that for the tests.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "webui"))
