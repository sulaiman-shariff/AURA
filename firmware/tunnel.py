"""
Expose the local Flask server through ngrok.

Uses the ngrok Python SDK rather than the ngrok.exe agent: Windows Smart App
Control is enforced on this machine and blocks the freshly-downloaded agent
binary on reputation grounds, while the SDK's embedded agent loads inside
python.exe and is current enough for the account's minimum-version rule.

Reads NGROK_AUTHTOKEN, NGROK_DOMAIN and SERVER_PORT from ../.env.

    python tunnel.py [--port 5000] [--domain foo.ngrok-free.app]
"""

import argparse
import sys
import threading
from pathlib import Path

import ngrok

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"


def read_env():
    values = {}

    if not ENV_PATH.exists():
        return values

    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        key, _, value = line.partition("=")
        values[key.strip()] = value.strip()

    return values


def main():
    env = read_env()

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=int(env.get("SERVER_PORT", "5000")))
    parser.add_argument("--domain", default=env.get("NGROK_DOMAIN", ""))
    parser.add_argument("--authtoken", default=env.get("NGROK_AUTHTOKEN", ""))
    args = parser.parse_args()

    if not args.authtoken:
        print("No NGROK_AUTHTOKEN in .env and none passed.", file=sys.stderr)
        return 1

    options = {
        "authtoken": args.authtoken,
        "addr": args.port,
    }

    # A reserved domain keeps the URL stable across restarts, which matters
    # because it is compiled into the firmware.
    if args.domain:
        options["domain"] = args.domain

    listener = ngrok.forward(**options)

    print(f"Public URL: {listener.url()}")
    print(f"Forwarding to: http://127.0.0.1:{args.port}")

    if not args.domain:
        print(
            "\nWARNING: no reserved domain, so this URL changes on every "
            "restart and the firmware would need re-flashing each time.\n"
            "Set NGROK_DOMAIN in .env to your static ngrok domain."
        )

    print("\nTunnel is up. Press Ctrl-C to stop.")

    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
