"""
Flicker frequency allocation.

Grounded in the SSVEP literature rather than derived from first principles --
an earlier version of this module got the core constraint wrong, and the
correction matters enough to record here.

WHAT WAS WRONG
--------------
The obvious assumption is that a flicker frequency must divide the refresh
rate evenly (f = R / 2k), because a square wave can only switch on frame
boundaries. That is true for on/off stimulation and it is very restrictive:
at 60 Hz it leaves five usable frequencies in the 5-20 Hz band.

It does not apply here. Manyakov et al. (2013) introduced the *sampled
sinusoidal* stimulation profile, in which the stimulus luminance on frame i is

    s(f, phi, i) = 0.5 * (1 + sin(2*pi*f*(i / refresh_rate) + phi))

Because the sinusoid is sampled rather than switched, any frequency below
Nyquist is renderable at any phase. Chen et al. (2015, PNAS) used exactly this
to place 40 targets at 0.2 Hz spacing on an ordinary 60 Hz monitor. So the
refresh rate does not quantise the frequency set; it only bounds it.

WHAT ACTUALLY CONSTRAINS US
---------------------------
1. Nyquist, and rendering quality. A sampled sinusoid needs enough frames per
   cycle to look like one. Chen et al. ran 15.8 Hz on a 60 Hz display -- about
   3.8 frames per cycle -- so refresh/4 is a defensible practical ceiling.

2. The decoder's frequency resolution. This is the real limit, and it is a
   property of our decoder, not of SSVEP. The firmware measures local SNR
   against neighbours at +/- 0.75, 1.00 and 1.25 Hz, so a second target inside
   that band corrupts the first target's noise estimate. Hence MIN_SEPARATION.
   Template-correlation decoders (CCA, FBCCA, TRCA) do not work this way and
   tolerate 0.2 Hz spacing -- which is why moving the decoder off the
   microcontroller is what unlocks a large target set, not a better display.

3. Harmonic collision. The decoder counts the second harmonic as evidence, so
   a target at 2f of another is confusable. There is a clean way to make this
   impossible rather than merely checked for: keep every target inside a
   single octave. If max(f) < 2 * min(f), no target's second harmonic can
   land on any other target. Chen et al.'s 8.0-15.8 Hz band satisfies this,
   and it is almost certainly why that band was chosen.

WHAT WE GIVE UP, AND WHY
------------------------
Low frequencies (around 10-15 Hz) have the best SSVEP SNR, because EEG power
follows a 1/f law and the response rides on top of it. They are also squarely
inside the 8-20 Hz photosensitive-seizure band. Frequencies above 20 Hz are
markedly safer and nearly imperceptible around 37-40 Hz, with comparable SNR
but much higher inter-subject variability. `band` below exposes that choice
rather than burying it.

References
----------
Manyakov, Chumerin, Robben, Combaz, van Vliet, Van Hulle (2013),
    J. Neural Eng. 10(3):036011 -- sampled sinusoidal stimulation.
Chen, Wang, Nakanishi, Gao, Jung, Gao (2015), PNAS 112(44):E6058 --
    joint frequency-phase modulation, 40 targets, ITR 5.32 bits/s.
Chen, Wang, Gao, Jung, Gao (2015), J. Neural Eng. 12:046008 -- FBCCA.
Nakanishi et al. (2018), IEEE TBME -- TRCA, 325 bits/min online.
"""

# Practical rendering ceiling as a fraction of the refresh rate. Below this,
# the sampled sinusoid has enough frames per cycle to be faithful.
MAX_REFRESH_FRACTION = 0.25

# Minimum spacing between targets for the CURRENT firmware decoder, whose
# noise estimate reaches +/- 1.25 Hz. Raise the target count by shrinking this
# only if the decoder changes.
MIN_SEPARATION_HZ = 1.5

# The decoder's low-pass (LOW_PASS_HZ in aura_ssvep.ino). A stimulus above
# this is removed by our own filter before analysis: a 41 Hz trial scored
# -16 dB not because the subject failed to respond but because the firmware
# never saw it. Any band above this is unusable until that filter moves.
DECODER_LOW_PASS_HZ = 35.0

# Alpha rhythm. The largest spontaneous EEG oscillation, peaking near 10 Hz
# and strongest over the occipital region -- precisely where the SSVEP
# electrode sits.
ALPHA_LOW_HZ = 8.0
ALPHA_HIGH_HZ = 13.0

BANDS = {
    # Best raw SNR, and what Chen et al. (2015) used -- but it sits on the
    # alpha peak. Measured on this rig, 10 Hz won 12 of 14 trials regardless
    # of what was displayed, including trials whose stimulus had been
    # filtered out entirely. A real 10 Hz SSVEP (5.5-7.1 dB when cued) rode
    # on an alpha pedestal (-0.9 to 3.1 dB when not), and that pedestal beat
    # 15 Hz every time. Prefer "clear" unless you have a reason not to.
    "standard": (8.0, 15.6),
    # Above the alpha band, below the decoder's low-pass. 2 x 14 = 28 < 35,
    # so second-harmonic evidence is still available for the lower targets,
    # and 20 < 2 x 14 keeps the whole set inside one octave.
    "clear": (14.0, 20.0),
    # Legacy name, overlapping alpha at its low end.
    "comfort": (11.0, 20.0),
    # Above the main photosensitivity range and nearly imperceptible -- but
    # ENTIRELY ABOVE THE DECODER'S LOW-PASS, so unusable until LOW_PASS_HZ
    # in the firmware is raised. describe() reports this rather than
    # silently returning frequencies that cannot work.
    "high": (30.0, 58.0),
}

DEFAULT_BAND = "clear"


def max_renderable_hz(refresh_hz):
    """Highest frequency this display can render as a sampled sinusoid."""
    return refresh_hz * MAX_REFRESH_FRACTION


def allocate(
    refresh_hz,
    count=None,
    band=DEFAULT_BAND,
    separation_hz=MIN_SEPARATION_HZ,
):
    """Evenly spaced flicker frequencies inside a one-octave band.

    Returns frequencies ascending. If `count` is given, returns exactly that
    many when they fit, spread across the band for maximum separation; if they
    do not fit, returns as many as do.
    """
    low, high = BANDS.get(band, BANDS[DEFAULT_BAND])

    # Two independent ceilings: what the display can render as a sampled
    # sinusoid, and what the decoder's low-pass lets through. Returning a
    # frequency above the latter produces a target the firmware filters out
    # before it ever reaches the Goertzel -- which reads as a total absence
    # of response and looks like a subject or electrode failure.
    ceiling = min(max_renderable_hz(refresh_hz), DECODER_LOW_PASS_HZ)
    high = min(high, ceiling)

    if high <= low:
        return []

    # Guarantee the one-octave property even after clamping to the ceiling.
    low = max(low, high / 2.0 + 0.01)

    capacity = int((high - low) // separation_hz) + 1

    if capacity < 1:
        return []

    n = capacity if count is None else min(count, capacity)

    if n == 1:
        return [round((low + high) / 2.0, 4)]

    # Spread the n targets across the whole band rather than packing them at
    # the bottom: wider spacing is more robust, and there is no reason to
    # leave the top of the band empty.
    step = (high - low) / (n - 1)

    return [round(low + i * step, 4) for i in range(n)]


def phases(count, interval=0.5):
    """Phase offsets in radians for joint frequency-phase modulation.

    Chen et al. (2015) distinguish targets sharing a frequency by phase,
    stepping 0.5*pi between adjacent targets. Our current Goertzel decoder
    discards phase, so this is unused today -- but Goertzel produces a complex
    result, so recovering phase is a small change and would double or
    quadruple the target count without needing any more frequencies.
    """
    import math

    return [round((i * interval * math.pi) % (2.0 * math.pi), 6) for i in range(count)]


def describe(refresh_hz, band=DEFAULT_BAND, separation_hz=MIN_SEPARATION_HZ):
    """Allocation report, served by /api/frequencies."""
    low, high = BANDS.get(band, BANDS[DEFAULT_BAND])
    allocated = allocate(refresh_hz, band=band, separation_hz=separation_hz)

    low, high_hz = BANDS.get(band, BANDS[DEFAULT_BAND])

    warnings = []
    if low >= DECODER_LOW_PASS_HZ:
        warnings.append(
            f"band is entirely above the decoder's {DECODER_LOW_PASS_HZ:g} Hz "
            "low-pass; the firmware cannot see these frequencies"
        )
    elif high_hz > DECODER_LOW_PASS_HZ:
        warnings.append(
            f"upper part of this band exceeds the decoder's "
            f"{DECODER_LOW_PASS_HZ:g} Hz low-pass"
        )
    if low < ALPHA_HIGH_HZ:
        warnings.append(
            "band overlaps the alpha rhythm (8-13 Hz), which can outscore a "
            "real SSVEP at other frequencies"
        )

    return {
        "refresh_hz": round(refresh_hz, 3),
        "band": band,
        "warnings": warnings,
        "usable": bool(allocated) and not any("cannot see" in w for w in warnings),
        "band_hz": [low, high],
        "max_renderable_hz": round(max_renderable_hz(refresh_hz), 3),
        "separation_hz": separation_hz,
        "allocated": allocated,
        "max_targets": len(allocated),
        "one_octave": (allocated[-1] < 2.0 * allocated[0]) if allocated else True,
        "method": "sampled_sinusoidal",
    }
