"""
Serial monitor for the AURA SSVEP firmware.

Reads the ESP32's 115200-baud output, timestamps each line, prints it, and
appends it to serial.log. Unlike `arduino-cli monitor` this is non-interactive,
so it can be left running in the background while the log file is inspected.

    python monitor.py [--port COM4] [--baud 115200] [--log serial.log]
"""

import argparse
import sys
import time
from pathlib import Path

import serial


def reopen(port_name, baud, emit, attempts=60, delay=2.0):
    """Wait for the serial port to reappear and open it again.

    Returns the new port, or None if it never came back. Sixty attempts at
    two seconds is two minutes -- long enough to cover unplugging the board,
    walking away, and plugging it back in.
    """
    for attempt in range(attempts):
        time.sleep(delay)

        try:
            port = serial.Serial(port_name, baud, timeout=1)
        except (serial.SerialException, OSError):
            continue

        emit(f"--- reattached to {port_name} after {int((attempt + 1) * delay)} s ---")
        return port

    emit(f"--- {port_name} did not come back; giving up ---")
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default="COM4")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument(
        "--log",
        default=str(Path(__file__).with_name("serial.log")),
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="pulse DTR/RTS to reboot the board on connect",
    )
    args = parser.parse_args()

    # Boot-ROM output and line noise on reset are not always valid text, and
    # the Windows console defaults to cp1252, which raises on anything it
    # cannot map. Degrade to replacement characters instead of dying.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    try:
        port = serial.Serial(args.port, args.baud, timeout=1)
    except serial.SerialException as error:
        # The most common cause by far is arduino-cli holding the port
        # during an upload -- only one process may own it at a time.
        print(f"Could not open {args.port}: {error}", file=sys.stderr)
        return 1

    if args.reset:
        port.setDTR(False)
        port.setRTS(True)
        time.sleep(0.1)
        port.setRTS(False)

    log = open(args.log, "a", encoding="utf-8", buffering=1)

    def emit(text):
        print(text, flush=True)
        log.write(text + "\n")

    emit(f"--- monitor attached to {args.port} @ {args.baud} ---")

    try:
        while True:
            try:
                raw = port.readline()
            except (serial.SerialException, OSError) as error:
                # Unplugging the board, or the CP2102 re-enumerating after a
                # reset, kills the handle mid-read. Reconnect instead of
                # dying: the whole point of this script is to be left running.
                emit(f"--- lost {args.port} ({error}); waiting for it to come back ---")
                port = reopen(args.port, args.baud, emit)
                if port is None:
                    return 1
                continue

            if not raw:
                continue

            text = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            emit(f"[{time.strftime('%H:%M:%S')}] {text}")
    except KeyboardInterrupt:
        pass
    finally:
        log.close()
        try:
            port.close()
        except Exception:
            pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
