"""
The scene-understanding layer: Gemini turns a camera frame into taggable
objects, and a selected object into candidate intents.

TWO CALLS, DELIBERATELY SEPARATE
--------------------------------
Call A (`detect_objects`) runs on the whole frame and returns labelled boxes.
Those become the SSVEP tags.

Call B (`propose_intents`) runs only after the user has selected an object,
and returns two to four things they might want done with it. Those become the
next set of SSVEP tiles.

The split is the safety property, not an implementation detail. The model
never decides an action: it proposes a menu, and the user's second gaze
selection is what commits. See README section 4.3 on the Midas-touch problem.

WHY THE KEY LIVES HERE AND NOT IN THE BROWSER
---------------------------------------------
The page could call Gemini directly, but then the API key ships to every
client. It stays server-side in .env, and the browser only ever posts frames
to this server.

RUNNING WITHOUT A KEY
---------------------
With no GEMINI_API_KEY the module returns clearly-marked stub data instead of
failing. That keeps the whole pipeline -- camera, tags, selection, intent
menu, decode -- demonstrable and testable, and makes the real thing a matter
of dropping a key into .env. Every response carries `source`, so the UI can
say plainly whether it is showing real detections or placeholders.
"""

import json
import os
import urllib.error
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(BASE_DIR, ".env")
PROFILE_PATH = os.path.join(BASE_DIR, "profile.json")

# gemini-2.5-flash-lite is scheduled for shutdown in October 2026; 3.1 is the
# current lightweight model for the Developer API.
DEFAULT_MODEL = "gemini-3.1-flash-lite"

API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models"

# A frame is worth little if it arrives after the user has moved on. The
# guardrail in README section 8.3 calls for a fallback rather than a hang.
DETECT_TIMEOUT_SECONDS = 6
INTENT_TIMEOUT_SECONDS = 6

# Detect generously. The frequency budget (frequencies.py) limits how many
# objects can carry a *flickering* tag, but the rest are still worth showing
# as labelled boxes -- the scene reads as "it sees the room" rather than "it
# found three things", and paging a selectable tag onto them is then just a
# UI question rather than another Gemini call.
MAX_OBJECTS = 14
MAX_INTENTS = 4


def _read_env():
    values = {}

    if not os.path.exists(ENV_PATH):
        return values

    try:
        with open(ENV_PATH, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip()
    except OSError:
        pass

    return values


def api_key():
    return _read_env().get("GEMINI_API_KEY", "").strip()


def model_name():
    return _read_env().get("GEMINI_MODEL", "").strip() or DEFAULT_MODEL


def configured():
    return bool(api_key())


# ---------------------------------------------------------------------------
# Caregiver profile
# ---------------------------------------------------------------------------

DEFAULT_PROFILE = {
    "user": {"name": "", "notes": ""},
    "contacts": [],
    "devices": [],
    "needs": ["water", "toilet", "pain", "reposition", "too hot", "too cold"],
    "language": "en-IN",
}


def load_profile():
    if os.path.exists(PROFILE_PATH):
        try:
            with open(PROFILE_PATH, encoding="utf-8") as handle:
                data = json.load(handle)
                if isinstance(data, dict):
                    merged = dict(DEFAULT_PROFILE)
                    merged.update(data)
                    return merged
        except (OSError, ValueError):
            pass

    return dict(DEFAULT_PROFILE)


def save_profile(profile):
    try:
        with open(PROFILE_PATH, "w", encoding="utf-8") as handle:
            json.dump(profile, handle, indent=2)
        return True
    except OSError as error:
        print(f"Could not save the profile: {error}")
        return False


# ---------------------------------------------------------------------------
# Gemini transport
# ---------------------------------------------------------------------------


def _call_gemini(parts, schema, timeout):
    """POST one generateContent request. Returns (parsed, error)."""
    key = api_key()

    if not key:
        return None, "no API key"

    url = f"{API_ROOT}/{model_name()}:generateContent"

    payload = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            # Structured output: the response is parsed, not scraped, so a
            # chatty model cannot break the pipeline.
            "responseMimeType": "application/json",
            "responseSchema": schema,
            # Near-deterministic. This is a labelling task, not a creative
            # one, and a device someone relies on should behave the same way
            # twice.
            "temperature": 0.1,
        },
    }

    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": key,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:200]
        return None, f"HTTP {error.code}: {detail}"
    except (urllib.error.URLError, OSError, ValueError) as error:
        return None, f"request failed: {error}"

    try:
        text = body["candidates"][0]["content"]["parts"][0]["text"]
        return json.loads(text), None
    except (KeyError, IndexError, ValueError) as error:
        return None, f"unexpected response shape: {error}"


def _image_part(image_b64, mime_type="image/jpeg"):
    return {"inline_data": {"mime_type": mime_type, "data": image_b64}}


# ---------------------------------------------------------------------------
# Call A -- scene detection
# ---------------------------------------------------------------------------

DETECT_SCHEMA = {
    "type": "object",
    "properties": {
        "objects": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "box_2d": {
                        "type": "array",
                        "items": {"type": "integer"},
                    },
                    "actionable": {"type": "boolean"},
                },
                "required": ["label", "box_2d", "actionable"],
            },
        }
    },
    "required": ["objects"],
}

DETECT_PROMPT = (
    "You are the vision stage of an assistive device for a person who cannot "
    "move and communicates only by looking at things.\n\n"
    "List every distinct physical object you can see in this photograph. "
    "Include anything a person might conceivably refer to, ask about, or want "
    "handled: cups, bottles, phones, remotes, books, food, plates, cutlery, "
    "lamps, switches, fans, laptops, keyboards, bags, clothing, pillows, "
    "plants, clocks, doors, windows, chairs, tables.\n\n"
    "Skip only large flat structure that nobody would act on -- bare wall, "
    "floor, ceiling.\n\n"
    f"Return up to {MAX_OBJECTS} objects, ordered by how likely the person is "
    "to want something done with each. Set \"actionable\" true where a "
    "caregiver could actually do something with the object, false for things "
    "that are merely present. Use a short, concrete, everyday label of one or "
    "two words -- \"water glass\", not \"transparent drinking vessel\"."
)


def _normalise_box(box_2d):
    """Convert Gemini's box to fractional [x0, y0, x1, y1].

    Gemini returns [ymin, xmin, ymax, xmax] scaled 0-1000 -- y FIRST, which is
    the reverse of the usual computer-vision convention and the easiest thing
    in this file to get silently wrong. The frontend wants x-first fractions
    it can drop straight into CSS percentages.
    """
    if not isinstance(box_2d, (list, tuple)) or len(box_2d) != 4:
        return None

    try:
        ymin, xmin, ymax, xmax = (float(v) / 1000.0 for v in box_2d)
    except (TypeError, ValueError):
        return None

    x0, x1 = sorted((xmin, xmax))
    y0, y1 = sorted((ymin, ymax))

    # Clamp: the model occasionally runs a box slightly past the edge.
    x0, y0 = max(0.0, x0), max(0.0, y0)
    x1, y1 = min(1.0, x1), min(1.0, y1)

    if x1 - x0 < 0.01 or y1 - y0 < 0.01:
        return None

    return [round(x0, 4), round(y0, 4), round(x1, 4), round(y1, 4)]


STUB_OBJECTS = [
    {"label": "water glass", "box": [0.10, 0.34, 0.26, 0.72], "actionable": True},
    {"label": "phone", "box": [0.46, 0.55, 0.66, 0.76], "actionable": True},
    {"label": "lamp", "box": [0.72, 0.14, 0.93, 0.52], "actionable": True},
    {"label": "book", "box": [0.30, 0.62, 0.44, 0.80], "actionable": True},
    {"label": "mug", "box": [0.58, 0.30, 0.70, 0.48], "actionable": True},
    {"label": "remote", "box": [0.20, 0.12, 0.34, 0.26], "actionable": True},
    {"label": "plant", "box": [0.02, 0.05, 0.16, 0.30], "actionable": False},
]


def detect_objects(image_b64, mime_type="image/jpeg"):
    """Call A. Returns {objects, source, detail}."""
    if not configured():
        return {
            "objects": STUB_OBJECTS,
            "source": "stub",
            "detail": (
                "No GEMINI_API_KEY in .env, so these are placeholder objects "
                "at fixed positions, not real detections."
            ),
        }

    parsed, error = _call_gemini(
        [{"text": DETECT_PROMPT}, _image_part(image_b64, mime_type)],
        DETECT_SCHEMA,
        DETECT_TIMEOUT_SECONDS,
    )

    if error:
        return {
            "objects": STUB_OBJECTS,
            "source": "stub",
            "detail": f"Gemini call failed ({error}); showing placeholders.",
        }

    objects = []

    for item in (parsed or {}).get("objects", [])[:MAX_OBJECTS]:
        box = _normalise_box(item.get("box_2d"))
        label = str(item.get("label") or "").strip()

        if not box or not label:
            continue

        objects.append({
            "label": label[:40],
            "box": box,
            "actionable": bool(item.get("actionable", True)),
        })

    if not objects:
        return {
            "objects": [],
            "source": "gemini",
            "detail": "Gemini found nothing actionable in this frame.",
        }

    return {"objects": objects, "source": "gemini", "detail": ""}


# ---------------------------------------------------------------------------
# Call B -- intent proposal
# ---------------------------------------------------------------------------

INTENT_SCHEMA = {
    "type": "object",
    "properties": {
        "intents": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "action": {
                        "type": "string",
                        "enum": ["speak", "call", "device", "note"],
                    },
                    "params": {"type": "string"},
                },
                "required": ["label", "action", "params"],
            },
        }
    },
    "required": ["intents"],
}

# The allow-list from README section 8.3. An action outside it is dropped
# rather than executed, so the model cannot invent a capability.
ALLOWED_ACTIONS = {"speak", "call", "device", "note"}


def _intent_prompt(label, profile):
    contacts = ", ".join(
        f"{c.get('name', '')} ({c.get('relation', '')})"
        for c in profile.get("contacts", [])
        if c.get("name")
    ) or "none on file"

    devices = ", ".join(
        str(d.get("name", "")) for d in profile.get("devices", []) if d.get("name")
    ) or "none on file"

    needs = ", ".join(profile.get("needs", [])) or "none on file"

    return (
        "You are the intent stage of an assistive device. The user cannot "
        "move or speak and has just selected an object by looking at it. "
        "Your job is to propose what they might want done with it. You do not "
        "act; a second gaze selection chooses one of your proposals.\n\n"
        f"Selected object: {label}\n"
        f"Known contacts: {contacts}\n"
        f"Devices in the room: {devices}\n"
        f"Common needs for this user: {needs}\n\n"
        f"Propose 2 to {MAX_INTENTS} intents, most likely first. Rules:\n"
        "- Each label is at most 3 words. It is read beside a flickering "
        "target, so it must be graspable at a glance.\n"
        "- Phrase it as the user's own request: \"Pass me the glass\", not "
        "\"Give user water\".\n"
        "- action \"speak\" reads a sentence aloud to the carer; params is "
        "that sentence.\n"
        "- action \"call\" contacts someone; params is the contact name and "
        "must be one of the known contacts.\n"
        "- action \"device\" operates something in the room; params names the "
        "device and what to do.\n"
        "- action \"note\" records something; params is the note.\n"
        "- Do not propose anything requiring the user to move.\n"
        "- Do not propose emergency or medical help: a dedicated HELP control "
        "exists and never routes through you."
    )


STUB_INTENTS = {
    "default": [
        {"label": "Pass me that", "action": "speak", "params": "Please pass me that."},
        {"label": "Move it closer", "action": "speak", "params": "Please move it closer."},
        {"label": "Not now", "action": "note", "params": "Dismissed."},
    ],
}


def propose_intents(label, image_b64=None, mime_type="image/jpeg"):
    """Call B. Returns {intents, source, detail}."""
    profile = load_profile()

    if not configured():
        return {
            "intents": STUB_INTENTS["default"],
            "source": "stub",
            "detail": (
                "No GEMINI_API_KEY in .env, so these are placeholder intents, "
                "not generated for this object."
            ),
        }

    parts = [{"text": _intent_prompt(label, profile)}]

    # The crop is optional: the label alone is usually enough, and skipping
    # the image halves the latency of the second call.
    if image_b64:
        parts.append(_image_part(image_b64, mime_type))

    parsed, error = _call_gemini(parts, INTENT_SCHEMA, INTENT_TIMEOUT_SECONDS)

    if error:
        return {
            "intents": STUB_INTENTS["default"],
            "source": "stub",
            "detail": f"Gemini call failed ({error}); showing a fallback menu.",
        }

    intents = []

    for item in (parsed or {}).get("intents", [])[:MAX_INTENTS]:
        action = str(item.get("action") or "").strip()
        text = str(item.get("label") or "").strip()

        if not text or action not in ALLOWED_ACTIONS:
            continue

        intents.append({
            "label": text[:32],
            "action": action,
            "params": str(item.get("params") or "")[:300],
        })

    if not intents:
        return {
            "intents": STUB_INTENTS["default"],
            "source": "stub",
            "detail": "Gemini returned no usable intents; showing a fallback menu.",
        }

    return {"intents": intents, "source": "gemini", "detail": ""}
