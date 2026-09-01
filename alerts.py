"""
Onward alerting for the HELP path.

Design constraint: an assistive device that cries wolf gets switched off, and
one that stays silent when it matters is worse than useless. So this module
does the two things that can be relied on, and is explicit about what it does
not do.

WHAT IT DOES
------------
1. Always appends to alerts.log on local disk. This never fails for a reason
   outside the machine, and it is the audit trail -- if a HELP was raised and
   nobody came, the record of it exists.
2. Optionally POSTs to a webhook read from .env. No credentials are baked in
   and nothing is signed up for on the user's behalf.

WHY A WEBHOOK RATHER THAN AN SMS/CALL API
-----------------------------------------
Twilio and the WhatsApp Business API both need an account, a paid number and
a verified sender before a single message is delivered -- none of which can be
arranged from inside this codebase. A webhook works immediately with services
that need no credentials at all. https://ntfy.sh is the obvious one: choose an
unguessable topic, install the app, and

    ALERT_WEBHOOK_URL=https://ntfy.sh/aura-<something-unguessable>

delivers a push to a phone with no signup. A Discord or Slack incoming webhook
works the same way.

WHAT IT DOES NOT DO
-------------------
This runs on the compute unit, so it needs the network to reach anyone. The
local half of the HELP path -- the audible alarm and the on-screen alert --
happens in the browser and does not depend on this module or on connectivity.
A genuinely offline onward alert needs hardware: a buzzer or a relay wired to
a nurse-call line. That remains unbuilt, and README section 8.4 says so.
"""

import json
import os
import time
import urllib.error
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

ALERT_LOG_PATH = os.path.join(BASE_DIR, "alerts.log")
ENV_PATH = os.path.join(BASE_DIR, ".env")

# Deliberately short. A caregiver alert that hangs for 30 seconds is a
# caregiver alert that has already failed.
WEBHOOK_TIMEOUT_SECONDS = 5


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


def _append_log(entry):
    """Write one alert to disk. Returns True if it landed."""
    try:
        with open(ALERT_LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")
        return True
    except OSError as error:
        print(f"Could not write the alert log: {error}")
        return False


def _post_webhook(url, entry):
    """POST the alert. Returns (delivered, detail)."""
    title = "AURA: help requested"

    body = (
        f"{entry['message']}\n"
        f"trial {entry.get('trial_id', '-')} | "
        f"{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(entry['at']))}"
    )

    request = urllib.request.Request(
        url,
        data=body.encode("utf-8"),
        headers={
            "Content-Type": "text/plain; charset=utf-8",
            # ntfy reads these; other services ignore them harmlessly.
            "Title": title,
            "Priority": "urgent",
            "Tags": "rotating_light",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(
            request, timeout=WEBHOOK_TIMEOUT_SECONDS
        ) as response:
            return True, f"webhook returned {response.status}"
    except urllib.error.HTTPError as error:
        return False, f"webhook HTTP {error.code}"
    except (urllib.error.URLError, OSError, ValueError) as error:
        return False, f"webhook failed: {error}"


def raise_help(message, trial_id=None, source="live_session", detail=None):
    """Record and forward a HELP alert.

    Always returns a dict describing what actually happened, so the caller can
    tell the user whether anyone was really notified rather than implying it.
    """
    entry = {
        "at": time.time(),
        "kind": "help",
        "message": message,
        "trial_id": trial_id,
        "source": source,
        "detail": detail,
    }

    logged = _append_log(entry)

    env = _read_env()
    url = env.get("ALERT_WEBHOOK_URL", "").strip()

    if not url:
        return {
            "logged": logged,
            "forwarded": False,
            "detail": (
                "No ALERT_WEBHOOK_URL in .env, so the alert was recorded "
                "locally but not sent to anyone."
            ),
        }

    delivered, webhook_detail = _post_webhook(url, entry)

    return {
        "logged": logged,
        "forwarded": delivered,
        "detail": webhook_detail,
    }


def recent(limit=20):
    """Most recent alerts, newest last. Used by /api/alerts."""
    if not os.path.exists(ALERT_LOG_PATH):
        return []

    try:
        with open(ALERT_LOG_PATH, encoding="utf-8") as handle:
            lines = handle.readlines()[-limit:]
    except OSError:
        return []

    entries = []

    for line in lines:
        try:
            entries.append(json.loads(line))
        except ValueError:
            continue

    return entries
