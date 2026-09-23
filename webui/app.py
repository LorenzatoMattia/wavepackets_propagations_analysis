"""Local web UI for the M_LARA wavepacket simulation.

Run with: python app.py   (from inside the webui/ folder)
Opens http://127.0.0.1:5000/ automatically.
"""
import threading
import webbrowser
from pathlib import Path

from flask import Flask, abort, jsonify, redirect, render_template, request, url_for

import parsers
import runner
from nmlwriter import BUILD_INFO, grouped_fields

# Single source of the release version (repo-root VERSION, tagged vX.Y.Z on
# GitHub); docs/index.html carries the same string, kept in sync by
# tests/test_version.py.
VERSION = (Path(__file__).resolve().parent.parent / "VERSION").read_text().strip()
APP_NAME = f"Wavepacket Propagation Analysis - V{VERSION}"

app = Flask(__name__)
app.config["TEMPLATES_AUTO_RELOAD"] = True


@app.context_processor
def inject_app_name():
    return {"app_name": APP_NAME}


@app.route("/")
def index():
    return render_template("runs_list.html", runs=runner.list_runs())


@app.route("/configure")
def configure():
    return render_template(
        "configure.html", groups=grouped_fields(), build_info=BUILD_INFO, error=None
    )


@app.route("/launch", methods=["POST"])
def launch():
    params = {}
    for key in request.form:
        if key.startswith("usr"):
            try:
                params[key] = float(request.form[key])
            except ValueError:
                pass
    try:
        run_id = runner.launch(params)
    except RuntimeError as exc:
        return render_template(
            "configure.html",
            groups=grouped_fields(),
            build_info=BUILD_INFO,
            error=str(exc),
        ), 409
    return redirect(url_for("progress", run_id=run_id))


@app.route("/runs/<run_id>/progress")
def progress(run_id):
    if runner.get_meta(run_id) is None:
        abort(404)
    return render_template("progress.html", run_id=run_id)


@app.route("/runs/<run_id>/results")
def results(run_id):
    meta = runner.get_meta(run_id)
    if meta is None:
        abort(404)
    return render_template(
        "results.html", run_id=run_id, meta=meta, groups=grouped_fields()
    )


@app.route("/runs/<run_id>/delete", methods=["POST"])
def delete_run(run_id):
    runner.delete_run(run_id)
    return redirect(url_for("index"))


@app.route("/runs/<run_id>/rename", methods=["POST"])
def rename_run(run_id):
    runner.rename_run(run_id, request.form.get("display_name", ""))
    return redirect(url_for("index"))


@app.route("/api/runs/<run_id>/status")
def api_status(run_id):
    return jsonify(runner.status(run_id))


@app.route("/api/runs/<run_id>/stdout")
def api_stdout(run_id):
    return runner.tail_stdout(run_id), 200, {"Content-Type": "text/plain"}


@app.route("/api/runs/<run_id>/overview")
def api_overview(run_id):
    return jsonify(parsers.load_overview(runner.run_dir_path(run_id)))


@app.route("/api/runs/<run_id>/steps")
def api_steps(run_id):
    run_dir = runner.run_dir_path(run_id)
    return jsonify(
        {
            "paq": parsers.available_paq_steps(run_dir),
            "momentapaq": parsers.available_momentapaq_steps(run_dir),
        }
    )


@app.route("/api/runs/<run_id>/paq/<int:step>")
def api_paq_frame(run_id, step):
    frame = parsers.load_paq_frame(runner.run_dir_path(run_id), step)
    if frame is None:
        abort(404)
    return jsonify(frame)


@app.route("/api/runs/<run_id>/momentapaq/<int:step>")
def api_momentapaq_frame(run_id, step):
    frame = parsers.load_momentapaq_frame(runner.run_dir_path(run_id), step)
    if frame is None:
        abort(404)
    return jsonify(frame)


@app.route("/api/runs/<run_id>/init_conditions")
def api_init_conditions(run_id):
    return jsonify(parsers.parse_init_conditions(runner.run_dir_path(run_id)))


@app.route("/api/runs/<run_id>/absorption")
def api_absorption(run_id):
    return jsonify(parsers.parse_absorption_timeseries(runner.run_dir_path(run_id)))


@app.route("/api/runs/<run_id>/transmission")
def api_transmission(run_id):
    return jsonify(parsers.load_transmission_comparison(runner.run_dir_path(run_id)))


def _open_browser():
    webbrowser.open("http://127.0.0.1:5000/")


if __name__ == "__main__":
    threading.Timer(1.0, _open_browser).start()
    app.run(host="127.0.0.1", port=5000, debug=False)
