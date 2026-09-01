from flask import Flask, Response, jsonify, request, send_from_directory
from threading import Lock
import json
import os
import statistics
import time

import alerts
import frequencies as freq
import vision

# A 1280-wide JPEG is comfortably under this; the cap exists so a runaway
# client cannot post an arbitrarily large body.
MAX_IMAGE_BYTES = 6 * 1024 * 1024

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# The UI is a Vite + React app in web/. `npm run build` there writes the
# production bundle to web/dist, which Flask serves from the site root so the
# browser page and the ESP32 API share one origin (and one ngrok tunnel).
# For UI development run `npm run dev` in web/ instead; it proxies /api here.
WEB_DIST_DIR = os.path.join(BASE_DIR, "web", "dist")

# Widest stimulus range the system will accept. The upper bound allows the
# high-frequency band (30-58 Hz), which is far safer for photosensitive
# users than the 8-20 Hz range but evokes weaker responses.
MIN_STIMULUS_HZ = 5.0
MAX_STIMULUS_HZ = 60.0

# Firmware buffer limit (MAX_TARGETS in aura_ssvep.ino).
MAX_TARGETS = 8

app = Flask(__name__, static_folder=WEB_DIST_DIR, static_url_path="")

state_lock = Lock()

CALIBRATION_PROFILE_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "calibration_profile.json",
)

# ---------------------------------------------------------------------------
# Command frequencies
# ---------------------------------------------------------------------------
#
# The frequencies that carry meaning: every calibration trial, threshold and
# resting baseline is keyed on these. They were hardcoded as 10 and 15 Hz
# throughout this file and the frontend. 10 Hz sits on the alpha rhythm, the
# largest spontaneous EEG oscillation, which on this rig scored 3.5-7 dB with
# no stimulus present once the subject was tired -- so every other frequency
# was being judged against the subject's own resting rhythm and losing.
#
# Configurable via COMMAND_HZ in .env (comma-separated). The default is three
# alpha-free frequencies 2 Hz apart: 15 Hz is confirmed on this rig
# (+6.82 dB staring vs -6.11 dB with eyes covered), and three is the minimum
# for a live tile set (HELP, Cancel, one option). Second-harmonic evidence is
# available for 15 and 17 (30, 34 Hz) but not 19 (38 Hz is above the
# firmware's 35 Hz low-pass).

def _env_value(name, default=""):
    env_path = os.path.join(BASE_DIR, ".env")
    try:
        with open(env_path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                if key.strip() == name:
                    return value.strip()
    except OSError:
        pass
    return default


def _parse_command_frequencies():
    raw = _env_value("COMMAND_HZ", "")
    values = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            hz = float(part)
        except ValueError:
            continue
        if MIN_STIMULUS_HZ <= hz <= MAX_STIMULUS_HZ:
            values.append(hz)
    return values or [15.0, 17.0, 19.0]


COMMAND_FREQUENCIES = _parse_command_frequencies()


def command_key(hz):
    """Stable string key for a command frequency: 15.0 -> "15", 17.5 -> "17.5"."""
    return f"{hz:.2f}".rstrip("0").rstrip(".")


COMMAND_KEYS = [command_key(hz) for hz in COMMAND_FREQUENCIES]
COMMAND_BY_KEY = dict(zip(COMMAND_KEYS, COMMAND_FREQUENCIES))

DEFAULT_THRESHOLD = {"evidence_threshold": 1.5, "margin_threshold": 0.5}


def default_thresholds():
    return {key: dict(DEFAULT_THRESHOLD) for key in COMMAND_KEYS}


MIN_EVIDENCE_THRESHOLD = 0.5
MAX_EVIDENCE_THRESHOLD = 8.0

MIN_MARGIN_THRESHOLD = 0.25
MAX_MARGIN_THRESHOLD = 6.0

CAL_TRIALS_PER_FREQUENCY = 8
VALIDATION_TRIALS_PER_FREQUENCY = 3

# Resting windows (no flicker) used to measure each command frequency's
# baseline evidence. Three medians out a single blink or fidget.
BASELINE_WINDOWS = 3


def empty_profile():
    return {
        "frequencies": list(COMMAND_FREQUENCIES),
        "thresholds": default_thresholds(),
        "baseline_db": {key: 0.0 for key in COMMAND_KEYS},
        "calibrated_at": None,
    }


def load_profile():
    """Load the calibration profile, but only if it was made for THIS
    frequency set.

    A profile carries thresholds and baselines measured against a specific
    montage and set of frequencies. Reusing one across a change of either is
    exactly how a stale 10/15 Hz profile produced a 50% false-positive rate
    on a new montage: its thresholds sat below the new noise floor. So a
    profile whose frequencies do not match is ignored, not adapted.
    """
    if not os.path.exists(CALIBRATION_PROFILE_PATH):
        return empty_profile()

    try:
        with open(CALIBRATION_PROFILE_PATH) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return empty_profile()

    stored = data.get("frequencies") if isinstance(data, dict) else None

    if not isinstance(stored, list) or len(stored) != len(COMMAND_FREQUENCIES) or any(
        abs(float(a) - b) > 1e-6 for a, b in zip(stored, COMMAND_FREQUENCIES)
    ):
        print(
            "Calibration profile is for a different frequency set "
            f"({stored}); starting from defaults for {COMMAND_FREQUENCIES}."
        )
        return empty_profile()

    profile = empty_profile()

    for key in COMMAND_KEYS:
        stored_thresholds = (data.get("thresholds") or {}).get(key)
        if isinstance(stored_thresholds, dict):
            profile["thresholds"][key] = {
                "evidence_threshold": float(stored_thresholds.get("evidence_threshold", 1.5)),
                "margin_threshold": float(stored_thresholds.get("margin_threshold", 0.5)),
            }
        try:
            profile["baseline_db"][key] = float((data.get("baseline_db") or {}).get(key, 0.0))
        except (TypeError, ValueError):
            profile["baseline_db"][key] = 0.0

    profile["calibrated_at"] = data.get("calibrated_at")
    return profile


def save_profile(profile):
    try:
        with open(CALIBRATION_PROFILE_PATH, "w") as f:
            json.dump(profile, f, indent=2)
    except OSError as error:
        print(f"Could not save calibration profile: {error}")


def nearest_command_key(hz):
    return min(COMMAND_KEYS, key=lambda k: abs(COMMAND_BY_KEY[k] - hz))


def baseline_for(hz):
    """Resting baseline for a frequency, or 0 if it is not a command frequency."""
    key = nearest_command_key(hz)
    if abs(COMMAND_BY_KEY[key] - hz) > 0.05:
        return 0.0
    return float(baseline_db.get(key, 0.0))


def clamp(value, minimum, maximum):
    return max(minimum, min(maximum, value))


# Live target/session state, as before.
state = {
    "trial_id": 0,
    "active": False,
    "requested_hz": 0.0,
    "target_hz": 0.0,
    # Full active frequency set. Index 0 is the cued target and always
    # equals target_hz; a single-target trial is just the length-1 case.
    "frequencies": [],
    # Measured display refresh, reported by the browser. Only bounds the
    # renderable range -- the sampled sinusoidal profile means it does not
    # quantise the frequency set. See frequencies.py.
    "refresh_hz": 0.0,
    "started_at": None,
    "last_result": None,
}

history = []

# Persisted per-command thresholds, used by every live (non-calibration)
# trial as well as calibration validation trials.
profile = load_profile()
threshold_profile = profile["thresholds"]
baseline_db = profile["baseline_db"]

# Calibration workflow state, driven by the frontend and updated whenever
# a result belonging to a pending calibration trial arrives.
calibration = {
    "running": False,
    # idle | contact_check | calibrate | validation_ready | validation | done
    "phase": "idle",
    "current_key": None,
    "message": "",
    "contact_attempts": 0,
    "contact_ok": False,
    "baseline_windows": 0,
    "baseline_samples": {key: [] for key in COMMAND_KEYS},
    "baseline_db": {key: 0.0 for key in COMMAND_KEYS},
    "cal_data": {key: [] for key in COMMAND_KEYS},
    "validation_results": [],
    "thresholds": {key: None for key in COMMAND_KEYS},
    "summary": None,
}

# trial_id -> {"phase", "command_key", "is_validation"}
pending_calibration = {}


def _reset_calibration_state():
    calibration["running"] = True
    calibration["phase"] = "contact_check"
    calibration["current_key"] = None
    calibration["message"] = "Measuring resting baseline -- sit still, eyes open."
    calibration["contact_attempts"] = 0
    calibration["contact_ok"] = False
    calibration["baseline_windows"] = 0
    calibration["baseline_samples"] = {key: [] for key in COMMAND_KEYS}
    calibration["baseline_db"] = {key: 0.0 for key in COMMAND_KEYS}
    calibration["cal_data"] = {key: [] for key in COMMAND_KEYS}
    calibration["validation_results"] = []
    calibration["thresholds"] = {key: None for key in COMMAND_KEYS}
    calibration["summary"] = None
    pending_calibration.clear()

    # The contact check measures RAW resting evidence, so any previous
    # baseline must not be subtracted while it runs.
    for key in COMMAND_KEYS:
        baseline_db[key] = 0.0


def _evidence_by_key(record):
    """Map a trial's per-target evidence array back onto command keys."""
    evidence = record.get("evidence_db") or []
    frequencies = record.get("target_set_hz") or []
    out = {}
    for hz, value in zip(frequencies, evidence):
        if not isinstance(value, (int, float)):
            continue
        key = nearest_command_key(float(hz))
        if abs(COMMAND_BY_KEY[key] - float(hz)) <= 0.05:
            out[key] = float(value)
    return out


def _record_baseline(result):
    """One accepted resting window: log the evidence at every command frequency.

    With no stimulus on screen, whatever the decoder reports at each
    frequency is that frequency's resting pedestal -- alpha at 10 Hz, the
    1/f slope everywhere. Subtracting it in the firmware turns the decision
    into "how much MORE than resting" instead of "how much", which is the
    only fair comparison when one frequency sits on a rhythm the others do
    not.
    """
    by_key = _evidence_by_key(result)

    for key, value in by_key.items():
        calibration["baseline_samples"][key].append(value)

    calibration["baseline_windows"] += 1
    done = calibration["baseline_windows"]

    if done < BASELINE_WINDOWS:
        calibration["message"] = f"Resting baseline: {done}/{BASELINE_WINDOWS} windows."
        return

    for key in COMMAND_KEYS:
        samples = calibration["baseline_samples"][key]
        value = statistics.median(samples) if samples else 0.0
        calibration["baseline_db"][key] = round(value, 4)
        baseline_db[key] = round(value, 4)

    profile["baseline_db"] = dict(baseline_db)
    save_profile(profile)

    summary = ", ".join(f"{k} Hz {baseline_db[k]:+.1f} dB" for k in COMMAND_KEYS)
    calibration["message"] = f"Resting baseline measured: {summary}."


def _compute_all_thresholds():
    """Derive per-frequency thresholds once every frequency has its trials.

    Every trial cued at one frequency is simultaneously a negative example
    for each of the others, because the firmware reports evidence at every
    frequency in the set. So N x 8 trials yield both a positive and a
    negative distribution for each command, with no separate "look at
    nothing" condition. Thresholds sit midway between the medians.
    """
    if any(
        len(calibration["cal_data"][key]) < CAL_TRIALS_PER_FREQUENCY
        for key in COMMAND_KEYS
    ):
        return

    def med(values, fallback):
        return statistics.median(values) if values else fallback

    for key in COMMAND_KEYS:
        own = calibration["cal_data"][key]
        others = [
            r for other in COMMAND_KEYS if other != key
            for r in calibration["cal_data"][other]
        ]

        positive_evidence, positive_margin = [], []
        for r in own:
            ev = _evidence_by_key(r)
            if key not in ev:
                continue
            positive_evidence.append(ev[key])
            rest = [v for k, v in ev.items() if k != key]
            if rest:
                positive_margin.append(ev[key] - max(rest))

        negative_evidence, negative_margin = [], []
        for r in others:
            ev = _evidence_by_key(r)
            if key not in ev:
                continue
            negative_evidence.append(ev[key])
            rest = [v for k, v in ev.items() if k != key]
            if rest:
                negative_margin.append(ev[key] - max(rest))

        evidence_threshold = clamp(
            (med(positive_evidence, 1.5) + med(negative_evidence, 0.0)) / 2.0,
            MIN_EVIDENCE_THRESHOLD,
            MAX_EVIDENCE_THRESHOLD,
        )
        margin_threshold = clamp(
            (med(positive_margin, 0.5) + med(negative_margin, 0.0)) / 2.0,
            MIN_MARGIN_THRESHOLD,
            MAX_MARGIN_THRESHOLD,
        )

        threshold_profile[key] = {
            "evidence_threshold": round(evidence_threshold, 4),
            "margin_threshold": round(margin_threshold, 4),
        }
        calibration["thresholds"][key] = threshold_profile[key]

    profile["calibrated_at"] = time.time()
    save_profile(profile)

    calibration["phase"] = "validation_ready"
    calibration["current_key"] = None
    calibration["message"] = "Thresholds computed. Starting validation..."


def _finalise_validation():
    results = calibration["validation_results"]
    total = len(results)
    correct = sum(1 for r in results if r["correct"])

    per_frequency = {}

    for key in COMMAND_KEYS:
        subset = [r for r in results if r["command_key"] == key]
        subset_correct = sum(1 for r in subset if r["correct"])
        thresholds = threshold_profile.get(key) or dict(DEFAULT_THRESHOLD)

        # Where the trials cued at this frequency actually landed, so a
        # systematic bias (e.g. "the lowest frequency always wins") is
        # visible rather than hidden inside an accuracy percentage.
        confusion = {}
        for r in subset:
            winner = r.get("winner_key") or "none"
            confusion[winner] = confusion.get(winner, 0) + 1

        per_frequency[key] = {
            "evidence_threshold": thresholds["evidence_threshold"],
            "margin_threshold": thresholds["margin_threshold"],
            "baseline_db": baseline_db.get(key, 0.0),
            "validation_correct": subset_correct,
            "validation_total": len(subset),
            "confusion": confusion,
        }

    overall_pct = (correct / total * 100.0) if total else 0.0

    if overall_pct >= 75.0:
        quality = "GOOD"
    elif overall_pct >= 50.0:
        quality = "FAIR"
    else:
        quality = "POOR"

    calibration["summary"] = {
        "quality": quality,
        "overall_accuracy_pct": round(overall_pct, 2),
        "overall_correct": correct,
        "overall_total": total,
        "chance_pct": round(100.0 / max(1, len(COMMAND_KEYS)), 1),
        "per_frequency": per_frequency,
    }

    calibration["phase"] = "done"
    calibration["running"] = False
    calibration["current_key"] = None
    calibration["message"] = "Calibration complete."


def _process_calibration_result(pending, result, accepted):
    phase = pending["phase"]
    key = pending["command_key"]
    is_validation = pending["is_validation"]

    if phase == "contact_check":
        calibration["contact_attempts"] += 1
        calibration["contact_ok"] = accepted
        if accepted:
            _record_baseline(result)
        else:
            calibration["message"] = (
                f"Contact check failed ({result.get('reason', 'unknown')}) -- "
                "check electrode placement."
            )
        return

    if not accepted:
        calibration["message"] = (
            f"Trial rejected ({result.get('reason', 'unknown')}); repeating."
        )
        return

    record = {
        "trial_id": result["trial_id"],
        "target_hz": result["target_hz"],
        "evidence_db": result.get("evidence_db"),
        "target_set_hz": result.get("target_set_hz"),
        "best_hz": result.get("best_hz"),
        "main_fundamental_snr_db": result.get("main_fundamental_snr_db"),
        "main_harmonic_snr_db": result.get("main_harmonic_snr_db"),
        "artifact_fundamental_snr_db": result.get("artifact_fundamental_snr_db"),
        "artifact_harmonic_snr_db": result.get("artifact_harmonic_snr_db"),
        "target_evidence_db": result.get("score"),
        "competitor_hz": result.get("competitor_hz"),
        "competitor_evidence_db": result.get("competitor_evidence_db"),
        "margin_db": result.get("margin"),
        "main_p2p": result.get("main_p2p"),
        "artifact_p2p": result.get("artifact_p2p"),
        "main_rms": result.get("main_rms"),
        "artifact_rms": result.get("artifact_rms"),
        "reason": result.get("reason"),
    }

    if phase == "calibrate" and not is_validation:
        calibration["cal_data"][key].append(record)
        calibration["phase"] = "calibrate"
        calibration["current_key"] = key
        collected = len(calibration["cal_data"][key])
        calibration["message"] = (
            f"{key} Hz calibration: {collected}/{CAL_TRIALS_PER_FREQUENCY} "
            "trials collected."
        )
        _compute_all_thresholds()

    elif phase == "validation":
        thresholds = threshold_profile.get(key) or dict(DEFAULT_THRESHOLD)
        target_evidence = record["target_evidence_db"]
        margin = record["margin_db"]

        predicted_match = (
            target_evidence is not None
            and margin is not None
            and target_evidence >= thresholds["evidence_threshold"]
            and margin >= thresholds["margin_threshold"]
        )

        best_hz = record.get("best_hz")
        winner_key = (
            nearest_command_key(float(best_hz))
            if isinstance(best_hz, (int, float)) else None
        )

        calibration["validation_results"].append(
            {
                "command_key": key,
                "winner_key": winner_key,
                "correct": predicted_match,
                "record": record,
            }
        )

        calibration["phase"] = "validation"
        calibration["current_key"] = key
        completed = len(calibration["validation_results"])
        needed = VALIDATION_TRIALS_PER_FREQUENCY * len(COMMAND_KEYS)
        calibration["message"] = f"Validation: {completed}/{needed} trials complete."

        if completed >= needed:
            _finalise_validation()


@app.get("/")
def index():
    index_path = os.path.join(WEB_DIST_DIR, "index.html")

    if not os.path.exists(index_path):
        return Response(
            "The UI has not been built yet.\n\n"
            "    cd web\n"
            "    npm install\n"
            "    npm run build\n\n"
            "then reload this page.",
            status=503,
            mimetype="text/plain",
        )

    response = send_from_directory(WEB_DIST_DIR, "index.html")
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/state")
def get_state():
    with state_lock:
        response = dict(state)
        response["history"] = list(history[-30:])

    return jsonify(response)


@app.get("/api/target")
def get_target():
    """
    Lightweight endpoint for the ESP32.

    Format:
        trial_id,active,evidence_threshold,margin_threshold,n,f1..fn,b1..bn

    f1 is the cued target; the rest are its competitors. b1..bn are each
    frequency's resting baseline in dB (0 for anything that is not a
    calibrated command frequency); the firmware subtracts them before it
    compares targets. They are trailing and optional, so an older firmware
    that stops reading after the frequencies still works.

    Plain text rather than JSON because the firmware scans it field by
    field with no allocation and no JSON parser.
    """
    with state_lock:
        trial_id = state["trial_id"]
        active = 1 if state["active"] else 0
        target_hz = state["target_hz"]
        active_frequencies = list(state["frequencies"])

        key = nearest_command_key(target_hz) if target_hz else COMMAND_KEYS[0]
        thresholds = threshold_profile.get(key) or dict(DEFAULT_THRESHOLD)

        evidence_threshold = thresholds["evidence_threshold"]
        margin_threshold = thresholds["margin_threshold"]
        baselines = [baseline_for(hz) for hz in active_frequencies]

    fields = [
        str(trial_id),
        str(active),
        f"{evidence_threshold:.4f}",
        f"{margin_threshold:.4f}",
        str(len(active_frequencies)),
    ]

    fields.extend(f"{hz:.4f}" for hz in active_frequencies)
    fields.extend(f"{b:.4f}" for b in baselines)

    return Response(
        ",".join(fields),
        mimetype="text/plain",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/config")
def get_config():
    """Everything the frontend used to hardcode about the command set."""
    return jsonify({
        "frequencies": list(COMMAND_FREQUENCIES),
        "keys": list(COMMAND_KEYS),
        "calibration_trials_per_frequency": CAL_TRIALS_PER_FREQUENCY,
        "validation_trials_per_frequency": VALIDATION_TRIALS_PER_FREQUENCY,
        "baseline_windows": BASELINE_WINDOWS,
        "max_targets": MAX_TARGETS,
        "bands": {name: list(rng) for name, rng in freq.BANDS.items()},
        "default_band": freq.DEFAULT_BAND,
    })


@app.get("/api/frequencies")
def get_frequencies():
    """Allocation report for a given refresh rate and stimulus band.

    The browser calls this after measuring its own refresh rate, so the
    frequency set is decided in one place rather than duplicated in JS.
    """
    try:
        refresh_hz = float(request.args.get("refresh_hz", 60.0))
    except (TypeError, ValueError):
        return jsonify({"error": "refresh_hz must be a number"}), 400

    band = request.args.get("band", freq.DEFAULT_BAND)

    if band not in freq.BANDS:
        return jsonify({
            "error": "unknown band",
            "bands": sorted(freq.BANDS),
        }), 400

    report = freq.describe(refresh_hz, band=band)
    report["allocated"] = report["allocated"][:MAX_TARGETS]
    report["max_targets"] = len(report["allocated"])
    report["firmware_limit"] = MAX_TARGETS

    return jsonify(report)


@app.post("/api/start")
def start_trial():
    data = request.get_json(silent=True) or {}

    try:
        requested_hz = float(data["requested_hz"])
        actual_hz = float(data["actual_hz"])
    except (KeyError, TypeError, ValueError):
        return jsonify({
            "error": "requested_hz and actual_hz are required"
        }), 400

    for name, value in (("requested_hz", requested_hz), ("actual_hz", actual_hz)):
        if not MIN_STIMULUS_HZ <= value <= MAX_STIMULUS_HZ:
            return jsonify({
                "error": (
                    f"{name} must be between "
                    f"{MIN_STIMULUS_HZ:g} and {MAX_STIMULUS_HZ:g}"
                )
            }), 400

    """
    Optional competitor set. The cued frequency is always index 0; any
    frequencies given here are appended as competitors, so a plain
    single-target trial still works with no change to the caller.
    """
    competitors = data.get("competitors")

    if competitors is None:
        # Default to the full command set: every calibration trial then
        # reports evidence at every command frequency, which is what lets
        # one cued trial serve as a negative example for all the others.
        competitors = [hz for hz in COMMAND_FREQUENCIES if abs(hz - actual_hz) > 1e-6]

    try:
        competitors = [float(hz) for hz in competitors]
    except (TypeError, ValueError):
        return jsonify({"error": "competitors must be a list of numbers"}), 400

    for hz in competitors:
        if not MIN_STIMULUS_HZ <= hz <= MAX_STIMULUS_HZ:
            return jsonify({
                "error": (
                    f"competitor {hz:g} outside "
                    f"{MIN_STIMULUS_HZ:g}-{MAX_STIMULUS_HZ:g} Hz"
                )
            }), 400

    active_frequencies = [actual_hz] + [
        hz for hz in competitors if abs(hz - actual_hz) > 1e-6
    ]

    if len(active_frequencies) > MAX_TARGETS:
        return jsonify({
            "error": f"at most {MAX_TARGETS} frequencies (firmware limit)",
            "given": len(active_frequencies),
        }), 400

    try:
        refresh_hz = float(data.get("refresh_hz", 0.0))
    except (TypeError, ValueError):
        refresh_hz = 0.0

    # Optional calibration metadata. "manual" (the default) is a normal,
    # uncalibrated trial and is never added to pending_calibration.
    phase = str(data.get("phase", "manual"))

    # Legacy phase names from the two-frequency era.
    if phase.startswith("cal_"):
        phase = "calibrate"

    if phase not in ("manual", "contact_check", "calibrate", "validation"):
        return jsonify({"error": f"unknown phase {phase!r}"}), 400

    key_raw = data.get("command_key")
    logical_hz_raw = data.get("logical_hz")
    is_validation = bool(data.get("is_validation", False))

    with state_lock:
        state["trial_id"] += 1
        state["active"] = True
        state["requested_hz"] = requested_hz
        state["target_hz"] = actual_hz
        state["frequencies"] = active_frequencies

        if refresh_hz > 0:
            state["refresh_hz"] = refresh_hz

        state["started_at"] = time.time()
        state["last_result"] = None

        trial_id = state["trial_id"]

        if phase != "manual":
            if key_raw is not None and str(key_raw) in COMMAND_BY_KEY:
                key = str(key_raw)
            elif logical_hz_raw is not None:
                key = nearest_command_key(float(logical_hz_raw))
            else:
                key = nearest_command_key(actual_hz)

            pending_calibration[trial_id] = {
                "phase": phase,
                "command_key": key,
                "is_validation": is_validation,
            }

            calibration["running"] = True
            calibration["phase"] = phase
            if phase == "calibrate":
                calibration["current_key"] = key

        response = dict(state)

    return jsonify(response)


@app.post("/api/stop")
def stop_trial():
    with state_lock:
        state["active"] = False
        state["frequencies"] = []

    return jsonify({"ok": True})


@app.post("/api/alert")
def raise_alert():
    """Forward a HELP alert raised by the live session.

    The browser has already sounded the local alarm before calling this, so
    a failure here degrades the alert rather than losing it. The response
    reports exactly what happened -- whether it was written to disk, and
    whether anyone was actually notified -- so the UI can say so plainly
    instead of implying help is on the way.
    """
    data = request.get_json(silent=True) or {}

    message = str(data.get("message") or "Help requested.")[:400]
    trial_id = data.get("trial_id")
    detail = data.get("detail")

    try:
        trial_id = int(trial_id) if trial_id is not None else None
    except (TypeError, ValueError):
        trial_id = None

    outcome = alerts.raise_help(
        message=message,
        trial_id=trial_id,
        source=str(data.get("source") or "live_session")[:64],
        detail=str(detail)[:400] if detail is not None else None,
    )

    print(
        f"HELP raised | trial={trial_id} | logged={outcome['logged']} | "
        f"forwarded={outcome['forwarded']} | {outcome['detail']}"
    )

    return jsonify({"ok": True, **outcome})


@app.get("/api/alerts")
def list_alerts():
    return jsonify({"alerts": alerts.recent()})


def _image_from_request(data):
    """Pull a base64 image out of a JSON body, accepting a data: URL."""
    raw = data.get("image")

    if not isinstance(raw, str) or not raw:
        return None, None, "an 'image' field is required"

    mime_type = "image/jpeg"

    if raw.startswith("data:"):
        header, _, encoded = raw.partition(",")
        if not encoded:
            return None, None, "malformed data URL"
        if ";" in header and ":" in header:
            mime_type = header.split(":", 1)[1].split(";", 1)[0] or mime_type
        raw = encoded

    if len(raw) > MAX_IMAGE_BYTES:
        return None, None, "image too large"

    return raw, mime_type, None


@app.post("/api/scene")
def analyse_scene():
    """Call A: a camera frame in, taggable objects out.

    Boxes come back as fractional [x0, y0, x1, y1] so the browser can place
    tags without knowing anything about Gemini's coordinate convention.
    """
    data = request.get_json(silent=True) or {}

    image_b64, mime_type, error = _image_from_request(data)

    if error:
        return jsonify({"error": error}), 400

    result = vision.detect_objects(image_b64, mime_type)

    print(
        f"Scene: {len(result['objects'])} object(s) via {result['source']}"
        + (f" | {result['detail']}" if result["detail"] else "")
    )

    return jsonify(result)


@app.post("/api/intents")
def propose_intents():
    """Call B: a selected object in, candidate intents out.

    These become the next set of SSVEP tiles. Nothing here executes: the
    user's second gaze selection is what commits an action.
    """
    data = request.get_json(silent=True) or {}

    label = str(data.get("label") or "").strip()

    if not label:
        return jsonify({"error": "a 'label' field is required"}), 400

    image_b64 = None
    mime_type = "image/jpeg"

    if data.get("image"):
        image_b64, mime_type, error = _image_from_request(data)
        if error:
            return jsonify({"error": error}), 400

    result = vision.propose_intents(label[:60], image_b64, mime_type)

    print(f"Intents for {label!r}: {len(result['intents'])} via {result['source']}")

    return jsonify(result)


@app.get("/api/profile")
def get_profile():
    profile = vision.load_profile()
    profile["gemini_configured"] = vision.configured()
    profile["model"] = vision.model_name()
    return jsonify(profile)


@app.post("/api/profile")
def put_profile():
    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({"error": "a JSON object is required"}), 400

    saved = vision.save_profile(data)

    return jsonify({"ok": saved})


@app.post("/api/result")
def receive_result():
    data = request.get_json(silent=True) or {}

    required = [
        "trial_id",
        "target_hz",
        "detected_hz",
        "score",
        "margin",
        "p2p",
        "confident",
        "match",
    ]

    missing = [key for key in required if key not in data]

    if missing:
        return jsonify({
            "error": "Missing fields",
            "fields": missing
        }), 400

    try:
        result = {
            "trial_id": int(data["trial_id"]),
            "target_hz": float(data["target_hz"]),
            "detected_hz": float(data["detected_hz"]),
            "score": float(data["score"]),
            "margin": float(data["margin"]),
            "p2p": int(data["p2p"]),
            "confident": bool(data["confident"]),
            "match": bool(data["match"]),
            "received_at": time.time(),
        }

        for key, value in data.items():
            if key in result:
                continue

            if value is None or isinstance(value, (str, int, float, bool)):
                result[key] = value
                continue

            # Per-target arrays (evidence_db, target_set_hz). Kept only if
            # every element is a plain number, so nothing structured can be
            # smuggled into the history.
            if isinstance(value, list) and all(
                isinstance(item, (int, float)) and not isinstance(item, bool)
                for item in value
            ):
                result[key] = list(value)
    except (TypeError, ValueError):
        return jsonify({
            "error": "Invalid result values"
        }), 400

    accepted = (
        bool(data.get("main_contact_good", False))
        and bool(data.get("artifact_contact_good", False))
        and int(data.get("main_clipped", 0) or 0) == 0
        and int(data.get("artifact_clipped", 0) or 0) == 0
        and not bool(data.get("artifact_rejected", False))
    )
    result["accepted"] = accepted

    trial_id = result["trial_id"]

    with state_lock:
        history.append(result)

        if len(history) > 100:
            del history[:-100]

        state["last_result"] = result

        pending = pending_calibration.pop(trial_id, None)

        if pending is not None:
            _process_calibration_result(pending, result, accepted)

    print(
        f"Trial {result['trial_id']} | "
        f"target={result['target_hz']:.2f} Hz | "
        f"detected={result['detected_hz']:.2f} Hz | "
        f"score={result['score']:.2f} | "
        f"margin={result['margin']:.2f} | "
        f"match={result['match']} | "
        f"accepted={accepted}"
    )

    return jsonify({"ok": True, "accepted": accepted})


@app.post("/api/calibration/begin")
def begin_calibration():
    with state_lock:
        _reset_calibration_state()
        snapshot = dict(calibration)

    return jsonify(snapshot)


@app.get("/api/calibration/status")
def calibration_status():
    with state_lock:
        snapshot = dict(calibration)

    return jsonify(snapshot)


@app.post("/api/calibration/cancel")
def cancel_calibration():
    with state_lock:
        calibration["running"] = False
        calibration["phase"] = "idle"
        calibration["message"] = "Calibration cancelled."
        pending_calibration.clear()
        state["active"] = False

        snapshot = dict(calibration)

    return jsonify(snapshot)


@app.get("/api/calibration/profile")
def get_calibration_profile():
    with state_lock:
        snapshot = {
            "frequencies": list(COMMAND_FREQUENCIES),
            "keys": list(COMMAND_KEYS),
            "thresholds": {k: dict(v) for k, v in threshold_profile.items()},
            "baseline_db": dict(baseline_db),
            "calibrated_at": profile.get("calibrated_at"),
        }

    return jsonify(snapshot)


if __name__ == "__main__":
    print()
    print("SSVEP server running.")
    print("Open this page on the computer:")
    print("http://127.0.0.1:5000")
    print()
    print("Use the computer's LAN IPv4 address in the ESP32 code.")
    print("Example: http://192.168.1.25:5000")
    print()

    app.run(
        host="0.0.0.0",
        port=5000,
        debug=False,
        threaded=True
    )