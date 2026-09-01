# AURA — Master Design Document

**A**ssistive **U**ser **R**esponse **A**gent — an SSVEP brain–computer interface with a
scene-understanding AI layer, for people who cannot move but can still direct their gaze.

> **Status:** design master. This file is the single source of truth for the patent filing,
> the final-year project report, and the research paper. Where a design decision changed from
> the original concept, both the original and the reason for the change are recorded, because
> the reasoning is itself part of the contribution.
>
> **Revision:** 1.3 · 2026-08-28
> **Implemented:** §6.1–6.3 (signal chain), §6.5 (frequency allocation, 1-of-N selection up to
> 8 simultaneous targets), §4.4 (live session: continuous decode windows, permanent HELP and
> CANCEL tiles, abortable countdown, spoken feedback), §8 (camera + Gemini scene layer, intent
> menus), §9.1 (HELP alerting), §10 (calibration with resting baselines over a configurable
> command set), §11 (server, firmware, React/Vite frontend).
> Not yet built: onward alerting that survives losing the network; bed/wheelchair actuation.
>
> **Revision 1.3 records the first full bench session with electrodes on** (§18): a genuine
> SSVEP was confirmed, the alpha rhythm was found to dominate any 10 Hz target, and three
> firmware bugs were fixed. The calibration protocol (§10) was rebuilt around what was learned.
>
> **Revision 1.1 corrected five claims in revision 1.0** after a literature review — most
> importantly the frequency-quantisation analysis in §6.5 and the prior-art position in §14.
> Corrections are marked inline rather than silently edited, because the reasoning matters.

---

## Table of contents

1. [Summary](#1-summary)
2. [Problem and target users](#2-problem-and-target-users)
3. [System overview](#3-system-overview)
4. [User journey](#4-user-journey)
5. [Hardware](#5-hardware)
6. [Signal chain and decoding](#6-signal-chain-and-decoding)
7. [Stimulus and display](#7-stimulus-and-display)
8. [AI layer](#8-ai-layer)
9. [Actions and integrations](#9-actions-and-integrations)
10. [Calibration protocol](#10-calibration-protocol)
11. [Software architecture](#11-software-architecture)
12. [Evaluation protocol](#12-evaluation-protocol)
13. [Safety, privacy, regulatory](#13-safety-privacy-regulatory)
14. [Novelty and patent claims](#14-novelty-and-patent-claims)
15. [Roadmap](#15-roadmap)
16. [Open questions and risks](#16-open-questions-and-risks)
17. [Glossary](#17-glossary)
18. [Bench findings, 28 Aug 2026](#18-bench-findings-28-aug-2026)

---

## Running the bench

The operator UI is a Vite + React + TypeScript app in `web/`. Flask serves the
production build from `web/dist`, so the browser page and the ESP32 API share
one origin (and one ngrok tunnel).

```
cd web && npm install && npm run build   # once, and after any UI change
cd .. && python main.py                  # http://127.0.0.1:5000
```

For UI work, run `npm run dev` inside `web/` and open http://localhost:5173 --
Vite proxies `/api` to the Flask server on port 5000 and hot-reloads. The
stimulus timing lives in `web/src/engine/clock.ts` and the trial / selection /
calibration workflows in `web/src/engine/session.ts`; the React components
under `web/src/components/` only render state.

---

## 1. Summary

AURA lets a paralysed person act on the physical world using nothing but where they look.

A camera views the scene in front of the user. A vision-language model identifies the objects
in that scene. Each object is given a small flickering marker — a **tag** — rendered on a
screen at its own frequency. When the user looks at a tag, the flicker frequency appears in
their visual cortex as a steady-state visually evoked potential (SSVEP), which EEG electrodes
at the back of the head pick up. The system decodes which frequency dominates, and therefore
which object the user chose.

Selecting an object does **not** perform an action. Instead the AI proposes two to four things
the user might plausibly want to do with that object, and those proposals become the next set
of flickering tiles. A second selection commits. A permanent HELP tile and a permanent CANCEL
tile sit outside this flow at all times.

The result is a general-purpose intent channel — not a fixed menu of pre-programmed commands —
that adapts to whatever happens to be in the room.

---

## 2. Problem and target users

### 2.1 The problem

People with severe motor impairment retain intent and, usually, vision, but have no reliable
motor channel to express it. Existing options are narrow:

- **Eye trackers** need calibrated head position and fail with ptosis, nystagmus, involuntary
  eye movement, or glasses. They are also expensive.
- **Switch scanning** (single button, cycling highlight) is reliable but agonisingly slow —
  often 20–60 seconds per selection.
- **Existing SSVEP spellers** are fast but their vocabulary is fixed at build time. A speller
  can spell "water" but cannot know there is a glass on the table.

AURA's premise is that the **vocabulary should come from the room**, not from a config file.

### 2.2 Target population

The primary target is deliberately broad — "paralysed and disabled" — but the populations differ
in ways that materially change the design, and the document must not pretend otherwise.

| Population | Eye control | Implication for AURA |
|---|---|---|
| **Spinal cord injury / quadriplegia** | Full | Best case. Full gaze range, normal cognition, may retain head movement. Primary validation population. |
| **Locked-in syndrome** (brainstem stroke) | Often vertical only | Tag layout must not require horizontal saccades. Prefer a **vertical column** layout or ensure every tag is reachable within the residual range. |
| **ALS / motor neurone disease** | Degrades over time | Early stage behaves like SCI. Late stage loses eye movement entirely — SSVEP still works through **covert attention** (attending without foveating), but amplitude drops sharply and the window must lengthen. This is the strongest argument for SSVEP over eye tracking. |
| **Severe cerebral palsy** | Variable, often with involuntary movement | Motion artifact is the dominant problem. The artifact channel (§6.3) matters most here. |
| **Post-stroke hemiplegia** | Usually full | May have visual field neglect — tags must be placed in the intact field, which calibration should discover. |

**Design consequence:** the tag layout engine (§7.1) must accept a per-user *reachable gaze
region* set at calibration, and place tags only inside it.

### 2.3 Who operates it

A caregiver dons the headset, positions the screen, and runs first-time setup. The user
operates it unaided afterwards. Nothing in the interaction loop may require a second person.

---

## 3. System overview

```
                    ┌──────────────────────────────────────────┐
                    │            PHYSICAL SCENE                │
                    │      (bed, table, phone, glass, TV)      │
                    └────────────────────┬─────────────────────┘
                                         │  light
                    ┌────────────────────▼─────────────────────┐
                    │   CAMERA  (behind / above the screen)    │
                    └────────────────────┬─────────────────────┘
                                         │  frames
   ┌─────────────────────────────────────▼─────────────────────────────────┐
   │                       COMPUTE UNIT  (laptop, v1)                      │
   │                                                                       │
   │   ┌──────────────┐   ┌──────────────┐   ┌────────────────────────┐    │
   │   │ Scene service│──▶│ Tag allocator│──▶│  Renderer (browser)    │    │
   │   │ (Gemini)     │   │ freq + layout│   │  sinusoidal flicker    │    │
   │   └──────────────┘   └──────────────┘   └───────────┬────────────┘    │
   │          ▲                                          │                 │
   │          │ crop + profile                           │                 │
   │   ┌──────┴───────┐   ┌──────────────┐               │                 │
   │   │ Intent svc   │◀──│   Decoder    │◀──────────────┼── EEG verdict   │
   │   │ (Gemini)     │   │  (evidence,  │               │                 │
   │   └──────┬───────┘   │   margin)    │               │                 │
   │          │           └──────────────┘               │                 │
   │          ▼                                          │                 │
   │   ┌──────────────┐   ┌──────────────┐               │                 │
   │   │ Action svc   │   │   Logger     │               │                 │
   │   └──────────────┘   └──────────────┘               │                 │
   └───────────────────────────────────────┬─────────────┴─────────────────┘
                                           │  screen (flickering tags)
                    ┌──────────────────────▼───────────────────┐
                    │                  USER                    │
                    │           gaze selects a tag             │
                    └──────────────────────┬───────────────────┘
                                           │  occipital SSVEP
                    ┌──────────────────────▼───────────────────┐
                    │  ELECTRODES → BioAmp EXG → ESP32 ADC     │
                    │           250 Hz, 2 channels             │
                    └──────────────────────┬───────────────────┘
                                           │  HTTP (Wi-Fi / ngrok)
                                           └──▶ back to Decoder
```

### 3.1 v1 versus v2 at a glance

| | **v1 (now — demo, paper, patent)** | **v2 (product direction)** |
|---|---|---|
| Display | Tablet/monitor on articulated arm | AR/VR passthrough |
| Camera | Fixed, behind the screen | Head-mounted |
| Electrodes | 2 ch, dry spring-pin, BioAmp EXG Pill | 8 ch, active dry, ADS1299 |
| ADC | ESP32 internal, 12-bit | ADS1299, 24-bit |
| Where DSP runs | **On the ESP32** (verdict posted) | On compute unit (**raw streamed**) |
| Decoder | Goertzel, evidence + margin | CCA / TRCA |
| Targets | 2 (10, 15 Hz) → up to ~5 | 20–40 via frequency-phase coding |
| Window | 4 s + 1 s warm-up | 1–2 s |
| Per-step latency | ≤10 s | ≤3 s |
| AI | Gemini Flash Lite (cloud) | On-device VLM (Jetson Orin Nano / phone) |
| HELP path | Cloud-dependent ⚠ | Fully local |

---

## 4. User journey

### 4.1 First-time setup (caregiver, once per person, ~20 min)

1. **Profile.** Caregiver fills in contacts (names, relationships, numbers), devices in the
   room, known needs and phrases, medical notes. Stored locally; sent to Gemini as context
   (§8.2).
2. **Electrode placement.** Occipital montage (§5.3). Impedance check per electrode.
3. **Reachable gaze region.** A dot moves to the screen edges; caregiver marks where the user
   can still follow it. Defines the tag placement envelope (§2.2).
4. **Refresh-rate measurement.** The renderer measures true display refresh over 120 frames
   and takes the median, then computes which flicker frequencies are exactly representable
   (§7.2).
5. **Threshold calibration.** The guided routine in §10 — 8 trials at 10 Hz, 8 at 15 Hz, then
   8 shuffled validation trials. Produces `calibration_profile.json`.

### 4.2 Every session (~60 s, unattended)

1. **Resting baseline.** Three accepted 4 s windows with the disc static. The firmware reports
   evidence at every command frequency with nothing flickering; the server medians them and
   the firmware subtracts the result from every later window (§6.2). This doubles as the
   contact check — a window only counts if both channels clear the gates in §6.3.
2. Threshold re-check: one confirmation trial per frequency. If evidence has drifted more than
   a set tolerance from the stored profile, nudge thresholds and log it. *(Not yet built.)*
3. If no clean window arrives, speak and display *"Please check the electrodes"* and alert the
   caregiver.

> **Why this exists.** The user asked for "one-time configuration." A genuinely one-time
> calibration is not achievable with dry electrodes, because contact impedance changes with
> hair, sweat, skin hydration and headset seating — thresholds calibrated on Monday will not
> be right on Friday. This 60-second automatic re-check preserves the *feel* of one-time setup
> while remaining honest about the physics. The user never answers a question during it.

### 4.3 Normal interaction

```
 SCENE VIEW
   Camera frame is displayed. Gemini has labelled the objects.
   Each object carries a small flickering tag at its own frequency.
   HELP and CANCEL tiles are always present at fixed frequencies.
        │
        │  user gazes at the tag on the phone for one 4 s window
        ▼
 OBJECT SELECTED
   Audio: "Phone."   Visual: the phone's tag highlights, others stop flickering.
        │
        │  Gemini receives the phone crop + caregiver profile
        ▼
 INTENT MENU
   2–4 tiles appear, each flickering:
        [ Call Priya ]  [ Read messages ]  [ Hand me the phone ]  [ Cancel ]
        │
        │  user gazes at "Call Priya"
        ▼
 CONFIRMED
   Audio: "Calling Priya."   Action dispatched.   Return to SCENE VIEW.
```

**Why two steps and not one.** The original concept fired an action directly from gaze —
look at the phone, the AI infers "call someone." This is the classic **Midas touch problem**:
people look at objects constantly without intending anything by it. A one-step system would
fire on every idle glance, and its false-positive rate would make it unusable and, where the
action is "call for help," genuinely unsafe. Splitting the interaction moves the AI from
*deciding* to *proposing*: the model's judgment is bounded to "what is plausible here", and
every action still requires a deliberate second act of attention from the user.

### 4.4 HELP, CANCEL, and escape

> **Implemented** in `web/src/engine/live.ts` and `components/LivePanel.tsx`, with one
> deviation from the spec below, recorded rather than hidden.
>
> **HELP takes two consecutive decode windows, not a ~6 s dwell.** A countdown is only
> meaningful if something can observe the user looking away, and the only observation available
> is the next decode window. So the first HELP window speaks a warning and starts the countdown,
> and the second either confirms or aborts it. With the current 1 s warm-up plus 4 s analysis
> that is roughly 10 s, not 6 — slower than specified. The honest fix is a shorter analysis
> window, which needs the multi-channel decoder (§6.4); shortening the number here would only
> make the countdown a lie. HELP is also given the **lowest allocated frequency**, since the
> 8–15 Hz band has the best SSVEP SNR and this is the one tile that must work.
>
> Windows that fail the §6.3 quality gates neither advance nor abort the countdown: a rejected
> window says nothing about where the user was looking.

| Control | Behaviour |
|---|---|
| **HELP** | Permanent tile, fixed frequency, always on screen in every state. Fires in **one step** after a ~6 s dwell (longer than a normal selection). An audible **3-2-1 countdown** runs during the final seconds — looking away aborts. |
| **CANCEL** | Permanent tile. Returns to SCENE VIEW from any menu without acting. |
| **Timeout** | 10 s with no confident selection in a menu returns to SCENE VIEW automatically. |
| **Pause** | Caregiver-accessible; stops all flicker (blank screen) for rest breaks. |

The countdown is the important detail: it makes HELP both fast *and* recoverable, which a
plain dwell trigger is not. HELP is never routed through the LLM (§8.3).

---

## 5. Hardware

### 5.1 v1 bill of materials (built / buildable now)

| Item | Part | Notes | Approx ₹ |
|---|---|---|---|
| Bio-amplifier ×2 | Upside Down Labs **BioAmp EXG Pill** | One per channel. Single-ended output into ESP32 ADC. | 2,500 |
| MCU | **ESP32-WROOM-32** DevKit V1 | Confirmed: ESP32-D0WD-V3, CP2102 USB, MAC `cc:7b:5c:1e:d9:48`. | 500 |
| Electrodes | Dry spring-pin / comb, occipital | Plus reference and ground. | 1,500 |
| Headband | Adjustable, holds electrodes at Oz/O1/O2 | 3D-printable. | 500 |
| Display | Tablet or monitor | **Refresh rate is a design input, not a detail** — see §7.2. | — |
| Mount | Articulated / bedside arm | Positions screen at ~50–70 cm. | 2,000 |
| Camera | USB webcam behind the screen | 1080p sufficient. | 1,500 |
| Compute | Laptop / PC | Runs Flask, decoder, renderer, Gemini calls. | — |

### 5.2 v2 bill of materials (product direction)

| Item | Part | Why |
|---|---|---|
| AFE | **ADS1299** (8-ch, 24-bit) | The industry-standard EEG front end. Enables CCA/TRCA, 8 channels, and a 1–2 s window. |
| Compute | **Jetson Orin Nano 8 GB** or a phone | On-device VLM. *Note: the original Jetson Nano named in the concept is discontinued and cannot run a useful VLM — Orin Nano is the correct part.* |
| Electrodes | Active dry electrodes | Buffer at the electrode; tolerates high contact impedance. |
| Display | AR/VR passthrough | The originally envisioned form factor. |

### 5.3 Electrode montage

- **v1 (2 channels) — as built and measured on the Brain BioAmp Band, 28 Aug 2026.**
  Two BioAmp EXG Pills, three snap electrodes each. The band has two snaps at the occiput, two
  at the temples and two free.

  | Pill | Wire | Electrode | Site |
  |---|---|---|---|
  | 1 (main, GPIO 35) | red IN+ | back-right snap | **O2** |
  | 1 | black IN− | free snap, gel | **right mastoid** |
  | 1 | yellow REF | free snap, gel | **left mastoid** |
  | 2 (artifact, GPIO 34) | red IN+ | temple-right snap | right temple |
  | 2 | black IN− | temple-left snap | left temple |
  | 2 | yellow REF | back-left snap | O1 position, bias only |

  **Gel on every snap.** Dry, the occipital channel railed 0↔4095 with hundreds of clipped
  samples per window; gelled, it settled to P2P 37–95 with zero clipping. Nothing else about
  the wiring changed. The band ships expecting gel.

  The two Pills' REF wires do **not** need to share one electrode: the firmware never combines
  the channels arithmetically (each has its own mean removal, stats and SNR), so separate
  references a couple of centimetres apart are fine. An earlier draft of this document said
  otherwise and was wrong.

  **Temple-to-temple is a horizontal EOG derivation**, ~19× more active at rest than the
  occipital channel (RMS 20–100 vs 1–7). That is what makes it a good artifact channel and
  what drove the RMS-based burst rule in §6.3.

  **O2-to-ear versus O1–O2 bipolar** (the manufacturer's default) was not settled empirically;
  the literature is split (§18). O2-to-ear is what the measurements below were taken with.

- **v2 (8 channels).** O1, O2, Oz, PO3, PO4, PO7, PO8, POz — the standard SSVEP montage that
  spatial filters (CCA, TRCA) are designed around.

**Note on the artifact channel.** Its job is not to be clean; its job is to be *dirty in the
same way* whenever something non-neural happens. A blink or a cable tug appears on both
channels, but only the occipital channel should carry the flicker frequency — so a large swing
on the artifact channel is grounds to discard the block regardless of what the main channel
appears to show. This is why the design keeps it even though it costs a channel.

> **Measured.** On this montage a single blink shows as artifact P2P 1300–1600 with RMS at the
> resting 25–30; sustained blinking pushes RMS to 64–146. Resting is P2P 545–882, RMS 27–44.
> Those three distributions are why the burst rule tests RMS, not P2P (§6.3).

### 5.4 Electrical safety

- The user is electrically connected to the system, so **the compute unit must never be
  mains-connected while the electrodes are on** without medical-grade isolation. For v1: run
  the ESP32 from a battery or an isolated USB supply, and keep the laptop on battery during
  recording.
- Target standard for any clinical work: **IEC 60601-1** with type BF applied parts.
- Documented as a limitation of v1, and a hard gate before any patient contact beyond
  self-experimentation.

---

## 6. Signal chain and decoding

Everything in §6.1–6.3 is implemented and running in
`firmware/aura_ssvep/aura_ssvep.ino`.

### 6.1 Acquisition and filtering

| Parameter | Value | Constant |
|---|---|---|
| Sample rate | 250 Hz | `SAMPLE_RATE` |
| Analysis window | 4 s (1000 samples) | `RECORD_SECONDS` |
| Filter warm-up (discarded) | 1 s (250 samples) | `WARMUP_SECONDS` |
| ADC | 12-bit, 11 dB attenuation | `analogReadResolution(12)` |
| Pins | GPIO 35 (main), GPIO 34 (artifact) | ADC1, input-only |
| High-pass | 3 Hz, one-pole RC | `HIGH_PASS_HZ` |
| Notch | 50 Hz biquad, Q = 20 | `NOTCH_FREQUENCY_HZ`, `NOTCH_Q` |
| Low-pass | 35 Hz, one-pole RC | `LOW_PASS_HZ` |

Two deliberate choices worth defending in the paper:

- **35 Hz low-pass, not 30.** It preserves the 30 Hz second harmonic of the 15 Hz target. The
  decoder treats 2f as legitimate evidence (§6.2), and for many people the harmonic is stronger
  than the fundamental — the very first live trial on this hardware selected `second_harmonic`
  as its evidence source.
- **50 Hz notch, Q = 20.** Indian mains. A high Q keeps the notch narrow enough not to eat the
  nearby 45–55 Hz band, which matters if the frequency set is ever extended upward.

The 1 s warm-up exists because the IIR filters have not settled at t=0; including those samples
injects a transient that the Goertzel reads as broadband power.

### 6.2 Frequency analysis and the decision rule

For each candidate frequency, a **Goertzel** filter over the Hamming-windowed 1000-sample
buffer gives the power at that frequency. Local SNR is then

```
SNR_dB(f) = 10 · log10( (P(f) + 1) / (mean P(f ± {0.75, 1.00, 1.25} Hz) + 1) )
```

clamped to ±30 dB. Measuring against immediate neighbours rather than the whole spectrum makes
the metric robust to the 1/f slope of EEG — a broadband amplitude change moves signal and noise
together and cancels out.

**Evidence** for a target is the better of its fundamental and its penalised second harmonic:

```
evidence(f) = max( SNR(f),  SNR(2f) − 0.5 dB )
```

The 0.5 dB penalty (`HARMONIC_PENALTY_DB`) breaks ties in favour of the fundamental without
discarding the harmonic, which is often the stronger response.

**Margin** is the discriminative quantity — the whole decision rests on it:

```
margin = evidence(target) − evidence(competitor)
```

A selection is committed only when **both** hold:

```
evidence ≥ evidence_threshold   AND   margin ≥ margin_threshold
```

with both thresholds supplied per-frequency by the server from the calibration profile.

**Resting baseline subtraction.** Before the comparison, each frequency's evidence has its
*resting* evidence subtracted:

```
evidence(f) = raw_evidence(f) − baseline(f)
```

where `baseline(f)` is the median evidence at `f` over three accepted windows with nothing
flickering, measured at the start of calibration and sent to the firmware with every target
(§11.1). This exists because of a measured failure: the 10 Hz target sat on the subject's alpha
rhythm and scored 3.5–7 dB with no stimulus present, so every other frequency was judged against
the subject's own resting rhythm and lost. Subtracting the pedestal turns the question from
"how much" into "how much *more than resting*", which is the only fair contest when one
frequency sits on a rhythm the others do not. The command set was also moved off alpha
entirely (15 / 17 / 19 Hz); the baseline is belt-and-braces for whatever residual slope remains.

**Why two conditions.** Evidence alone answers "is there a response?" but not "to which
target?" — a drowsy alpha burst at 10 Hz produces strong evidence at 10 Hz with no intent
behind it. Margin alone answers "which is bigger?" but fires on noise when both are weak.
Requiring both is what makes an SSVEP decision safe enough to attach an action to. The
firmware also reports the competitor's evidence explicitly, so the server can build separate
positive and negative distributions per command (§10).

### 6.3 Contact and artifact gating

No detection is trusted unless the signal itself is plausible. Measured on raw ADC counts over
the analysis window:

| Gate | Main | Artifact |
|---|---|---|
| Clipped samples (≤20 or ≥4075) | 0 allowed | 0 allowed |
| Peak-to-peak | 25 – 2200 | 40 – 3000 |
| Filtered RMS | 1.0 – 800 | 1.0 – 600 |
| Artifact burst | — | **RMS > 55** ⇒ discard block (P2P > 2800 as a backstop) |

Failure produces `CHECK_MAIN_ELECTRODES`, `CHECK_ARTIFACT_ELECTRODES`, or
`ARTIFACT_REJECTED`, and the server refuses to accept the result:

```python
accepted = (main_contact_good and artifact_contact_good
            and main_clipped == 0 and artifact_clipped == 0
            and not artifact_rejected)
```

Both bounds matter. Too *little* variation means a floating or disconnected electrode; too
*much* means saturation, a lead coming loose, or gross movement.

**These values were retuned on 28 Aug 2026 from measured distributions**, and two of the
earlier ones were wrong in instructive ways:

- The main-channel P2P floor was 100, calibrated against a *badly contacted* montage whose rest
  sat at 490–985 — mostly drift. With gel the clean baseline is 37–95, so the old floor rejected
  good data as bad contact. A disconnected input on this hardware rails (P2P 4095) or sits dead
  flat; 25 separates those from a clean recording.
- The burst rule was **P2P > 900**, then **P2P > 1300**. Both rejected every calibration trial,
  because P2P cannot tell one blink (P2P 1300–1600, RMS 25–27) from continuous blinking
  (P2P 982–2529, RMS 64–146). RMS can. A single blink barely perturbs a Goertzel averaged over
  1000 samples; sustained blinking genuinely corrupts it. The statistic was the bug, not the
  value.
- The artifact ceiling was 1500, below what a hard blink produces (2529), so blinks were reported
  as `CHECK_ARTIFACT_ELECTRODES` — blaming the electrodes for an eye movement.

### 6.4 v2: move the DSP off the microcontroller

Today the ESP32 computes a verdict and posts it; the raw samples are discarded on the device.
**This should change.** The ESP32 should stream raw 250 Hz frames and nothing else, because:

- **CCA and TRCA need all channels simultaneously.** They are spatial filters — they find the
  channel combination that best matches a reference — and cannot be computed per-channel on a
  microcontroller.
- **The raw data is the research asset.** Every discarded block is a training example that no
  longer exists. For the paper, offline re-analysis with different decoders on the same
  recordings is worth more than any single online result.
- **Decoder iteration stops requiring a re-flash.** Currently every threshold or algorithm
  change means recompiling and reflashing.

Target: ADS1299 over SPI → ESP32 → BLE or USB → compute unit, with **CCA** as the baseline
decoder and **TRCA** (which learns per-user spatial filters from calibration data) as the
higher-accuracy option.

### 6.5 Frequency plan

> **Correction.** An earlier revision of this document asserted that flicker frequencies must
> divide the refresh rate evenly (`f = R/2k`), and concluded that a 60 Hz display permits only
> three targets while 120 Hz permits five. **That is wrong**, and the error is worth recording
> because it would have driven a pointless hardware purchase.

**Frequencies are not quantised by the refresh rate.** The `f = R/2k` constraint applies only
to **on/off square-wave** stimulation, which can switch only on frame boundaries. Manyakov et
al. (2013) introduced the **sampled sinusoidal** profile, where the luminance on frame `i` is

```
s(f, φ, i) = ½ · ( 1 + sin( 2π f (i / R) + φ ) )
```

Because the sinusoid is *sampled* rather than switched, any frequency below Nyquist is
renderable at any phase. Chen et al. (2015, PNAS) used precisely this to place **40 targets at
0.2 Hz spacing on an ordinary 60 Hz monitor**. The refresh rate does not quantise the frequency
set; it only bounds it.

`web/src/engine/clock.ts` already renders a sinusoid — but `calculateActualFrequency()` then quantises to
whole frames anyway, which is the square-wave constraint applied to a stimulus that does not
need it. **This is a live bug, not just a documentation error.**

#### What actually constrains the target count

1. **Rendering ceiling.** A sampled sinusoid needs enough frames per cycle. Chen et al. ran
   15.8 Hz on 60 Hz — about 3.8 frames/cycle — so `R/4` is a defensible practical ceiling.
2. **Decoder resolution — the binding constraint.** The firmware measures local SNR against
   neighbours at ±0.75, ±1.00 and ±1.25 Hz (§6.2), so a second target inside that band corrupts
   the first's noise estimate. That forces ≥1.5 Hz spacing. **This is a property of our
   decoder, not of SSVEP** — CCA/FBCCA/TRCA correlate against templates and tolerate 0.2 Hz.
3. **Harmonic collision, solved structurally.** Rather than testing pairs, keep every target
   inside **one octave**: if `max(f) < 2·min(f)`, no second harmonic can land on any target.
   Chen et al.'s 8.0–15.8 Hz band satisfies this, which is almost certainly why it was chosen.

#### The resulting budget

Implemented in `frequencies.py`. Bands are one-octave by construction:

| Band | Range | Rationale |
|---|---|---|
| `standard` | 8.0 – 15.6 Hz | Best SNR; matches Chen et al. Inside the photosensitive band. |
| `comfort` | 11.0 – 20.0 Hz | Slightly gentler, still good SNR. |
| `high` | 30.0 – 58.0 Hz | Above the main photosensitivity range, nearly imperceptible; weaker response and high inter-subject variability. |

Measured output at 1.5 Hz separation:

```
 60 Hz →  5 targets   [8.0, 9.75, 11.5, 13.25, 15.0]
120 Hz →  6 targets   [8.0, 9.52, 11.04, 12.56, 14.08, 15.6]
165 Hz →  6 targets   [8.0, 9.52, 11.04, 12.56, 14.08, 15.6]
```

**The refresh rate is nearly irrelevant.** 60 Hz gives 5 targets and 165 Hz gives 6; the band
runs out before the display does. Six targets is HELP + CANCEL + **4 scene tags**.

#### How to get more, in order of leverage

1. **Move the decoder off the microcontroller** (§6.4) and adopt FBCCA/TRCA. Spacing drops from
   1.5 Hz to ~0.2 Hz and the same 8–15.6 Hz band holds **~38 targets**. This — not the display —
   is what unlocks a large target set.
2. **Add phase coding (JFPM).** Chen et al. distinguish targets sharing a frequency by phase in
   0.5π steps. Our Goertzel already computes a **complex** result, so the phase is sitting there
   unused; recovering it would multiply the target count by 2–4 for a small code change. This is
   the cheapest available win and should come before the ADS1299.
3. More electrodes, which helps decoding generally but does not by itself change spacing.

The current firmware hard-codes `COMMAND_1_HZ = 10.0` and `COMMAND_2_HZ = 15.0`. Extending to a
frequency table is the first implementation step (§15).

---

## 7. Stimulus and display

### 7.1 Object-anchored tags

**The original concept divided the entire field of view into N flickering regions.** That is
replaced here by small tags attached to detected objects. The reasons are substantive:

| Problem with full-field regions | Effect |
|---|---|
| The user's whole visual world strobes at 5–20 Hz continuously | 15–20 Hz is the peak of photosensitive-seizure sensitivity. Unacceptable for a device worn for hours. |
| SSVEP fatigue | Large-field flicker becomes uncomfortable within minutes even for healthy subjects. |
| Loss of spatial selectivity | Parafoveal edges of *neighbouring* regions also drive the response, so bigger regions discriminate *worse*, not better. |
| Region ≠ object | "Quadrant 3" may contain a phone, a glass and a lamp. The AI must then guess which was meant. |
| Head or camera movement | Screen-fixed regions decouple from the scene mid-trial, silently invalidating the window. |

Object-anchored tags fix all five: the flickering area is small and foveated (which produces a
*cleaner* SSVEP), the rest of the scene stays static, a selection identifies exactly one
object, and tags track their objects if anything moves.

**Tag specification**

- Size: ~2–3° of visual angle (≈ 2 cm at 50 cm viewing distance).
- Placement: adjacent to the object's bounding box, biased toward the centre of the user's
  reachable gaze region (§2.2); never overlapping another tag by less than ~5°.
- Contains: the flickering patch plus a static text label (the object name). The label does not
  flicker — reading it must not require staring at a strobe.

**When there are more objects than frequencies.** With a 5-frequency budget and 2 permanent
tiles, only 3 scene tags can exist at once. The allocator therefore:

1. Ranks detected objects by *actionability* (from the caregiver profile — a phone or a glass
   outranks a curtain) and by proximity to the gaze centre.
2. Tags the top 3.
3. Provides a **MORE** tile that cycles to the next page of objects.

### 7.2 Refresh-rate quantisation

Implemented in `web/src/engine/clock.ts`:

- `measureRefreshRate()` samples 120 `requestAnimationFrame` intervals and takes the **median**
  — robust to the occasional dropped frame in a way a mean is not.
- `calculateActualFrequency()` then quantises:
  ```js
  framesPerHalfCycle = round(refreshHz / (2 × requestedHz))
  actualHz           = refreshHz / (2 × framesPerHalfCycle)
  ```
- **The actual frequency, not the requested one, is sent to the server and used as the decoding
  target.** This is why `/api/target` reports values like 10.0417 Hz rather than 10.0, and why
  the firmware tolerates ±1.5 Hz when matching a target to a command.

This closes a failure mode that silently destroys SSVEP systems: asking for 10 Hz on a 60 Hz
display and actually rendering 10.0 Hz is impossible, and decoding at 10.0 while displaying
10.0417 loses real SNR.

### 7.3 Luminance modulation

`web/src/engine/clock.ts` uses **sinusoidal** modulation, not a square wave:

```
LUMINANCE_MIDDLE = 138,  LUMINANCE_AMPLITUDE = 28   →  grey oscillates 110 … 166
```

A square wave contains all odd harmonics, which spreads energy across the spectrum and creates
exactly the cross-target confusion §6.5 is trying to avoid. A sinusoid puts nearly all its
energy at f. Sinusoidal rendering is also what makes arbitrary frequencies possible (§6.5).

> **Done.** Modulation depth was raised from ±28 about 138 (~22% of full scale, below the
> entire range the controlled study tested) to **±76 about 128 (~60%)**, the study's recommended
> optimum. Measured the same evening: 15 Hz evidence while staring went from a 0.1–6.8 dB spread
> to a **12.9 dB separation against an eyes-covered control** (+6.82 vs −6.11 dB). Other things
> changed in the same session, so this is not a clean ablation — but the first genuine SSVEP
> confirmation came after the change, not before.

### 7.4 Fatigue and photosensitivity mitigation

- Only tags flicker; the scene does not.
- Low modulation depth (§7.3).
- Flicker runs only during an active trial (`ACTIVE_SECONDS = 8`), with rest between
  (`REST_SECONDS = 10`).
- Frequencies below 15 Hz preferred where the frequency budget allows.
- Hard stop: Escape/Space and tab-hide both abort the flicker immediately; `beforeunload` sends
  a `sendBeacon("/api/stop")`.
- **Screening requirement:** anyone with a personal or family history of photosensitive epilepsy
  is excluded until a clinical assessment says otherwise. This must appear in the consent form.

---

## 8. AI layer

> **Implemented** in `vision.py` (server) and `web/src/engine/scene.ts` + `sceneApi.ts` +
> `camera.ts` (browser), with `components/ScenePanel.tsx` for the UI.
>
> **Model:** `gemini-3.1-flash-lite`. Note that `gemini-2.5-flash-lite` is scheduled for
> shutdown on 16 October 2026, so it is not a safe target.
>
> **Bounding boxes:** Gemini returns `box_2d` as `[ymin, xmin, ymax, xmax]` scaled 0–1000 —
> **y first**, the reverse of the usual computer-vision convention, and the easiest thing in
> this layer to get silently wrong. `vision.py::_normalise_box` converts to x-first fractions
> so the browser never sees the raw convention.
>
> **The key stays server-side.** The page could call Gemini directly, but then the key ships to
> every client. The browser only ever posts frames to Flask.
>
> **Frames are frozen during a selection.** Tags are anchored to boxes from one analysed frame;
> if live video kept playing underneath, tags would drift off their objects the moment anything
> moved — and a decode window lasts seconds, so "anything" includes someone walking past.
> Tracking across live video is a v2 problem.
>
> **Without a key** the layer returns clearly-marked placeholder objects and intents rather than
> failing, so the whole pipeline stays demonstrable. Every response carries `source`, and the UI
> shows a "Placeholder data" badge — it never passes stubs off as real detections.

### 8.1 Gemini Flash Lite — two calls

**Call A — scene detection** (on entering SCENE VIEW, and on significant scene change)

- *Input:* full camera frame.
- *Output:* list of `{label, bounding_box, actionable}`.
- These become the tags.

**Call B — intent generation** (on object selection)

- *Input:* cropped image of the selected object, its label, and the caregiver profile (§8.2).
- *Output:* 2–4 short intent phrases, each with an action type and parameters.

```jsonc
// Call B response schema
{
  "object": "phone",
  "intents": [
    { "label": "Call Priya",        "action": "call",  "params": {"contact": "Priya"} },
    { "label": "Read messages",     "action": "tts",   "params": {"text": "..."} },
    { "label": "Hand me the phone", "action": "speak", "params": {"text": "Please hand me the phone"} }
  ]
}
```

`label` must be ≤ 3 words — it has to be readable at a glance next to a flickering patch.

> **Considered and rejected:** having Gemini decide the action outright (frame in, action out).
> It is the simplest pipeline and it is what the original concept implied, but it collapses the
> two-step confirmation of §4.3 and puts an unbounded model output directly in control of a
> phone call. The model proposes; the user disposes.

> **Deferred, not rejected:** running a local detector (YOLO / MediaPipe) for Call A and
> reserving Gemini for Call B. This is almost certainly the right v1.1 move — a local detector
> runs at 30 fps so tags track objects smoothly instead of jumping each time a cloud round-trip
> returns, and it cuts both cost and latency. v1 uses Gemini for both only to keep the component
> count down for the first demo.

### 8.2 Caregiver profile schema

Filled once at setup. No learning in v1 — behaviour stays predictable, which matters for a
device that can place phone calls.

```jsonc
{
  "user":     { "name": "...", "notes": "vertical gaze only; wears glasses" },
  "contacts": [ { "name": "Priya", "relation": "daughter", "phone": "+91..." } ],
  "devices":  [ { "name": "bed",  "type": "adjustable_bed", "actions": ["raise_head", "lower_head"] },
                { "name": "TV",   "type": "television" } ],
  "needs":    [ "water", "toilet", "pain", "reposition", "too hot", "too cold" ],
  "language": "en-IN"
}
```

### 8.3 Guardrails

1. **HELP never touches the LLM.** It is decoded locally and dispatched locally. No model
   output sits between the user and an emergency.
2. **Bounded outputs.** Intents must conform to the schema and to an allow-list of action
   types. Anything else is dropped.
3. **Timeouts.** If Gemini does not answer within 3 s, fall back to a static menu
   (`Speak need` / `Call for help` / `Cancel`).
4. **No open-ended text to actions.** The model cannot compose an arbitrary command; it selects
   from known action types with parameters drawn from the profile.
5. **Cancel is always present** in every generated menu, injected by the system rather than by
   the model.

### 8.4 The offline contradiction — stated plainly

The original concept called for the system to be "completely offline," and also to use Gemini
Flash Lite. Those cannot both be true. **The decision for v1 is cloud**, which means:

> ⚠ **In v1, if the network is down, HELP does not work.**

This is the single most serious limitation in the current design, and it is a limitation of a
*prototype*, not a defensible property of a product. The mitigation is the first item on the
roadmap (§15): a **local HELP path** that decodes and dispatches without any network — the
decoder already runs locally, so this is a matter of a local alert channel (buzzer, GPIO
relay to a nurse call, or a Bluetooth-paired phone) rather than new science.

---

## 9. Actions and integrations

| Action | v1 status | Mechanism |
|---|---|---|
| **Call for help / alert caregiver** | **Implemented** | Two layers. **Local:** a WebAudio alarm tone and spoken announcement generated in the browser — no network, no assets, works offline. **Onward:** `POST /api/alert` → `alerts.py`, which always appends to `alerts.log` and, if `ALERT_WEBHOOK_URL` is set in `.env`, POSTs there. See §9.1. |
| **Speak a need (TTS)** | Real | "I'm thirsty", "I'm in pain", plus scene-derived phrases. |
| **Bed / wheelchair controls** | **Displayed only — does not actuate** | Tiles appear ("Raise head", "Lower head", "Sit up") and the selection is logged and spoken, but nothing is driven. Demonstrates the interaction without touching a medical device. |
| **Phone: call / message a contact** | Real, via the help/call channel | Contacts come from the profile. |
| **Smart home** | Not in v1 | — |

### 9.1 The HELP alert path

Ordered so the part that cannot fail happens first:

1. **Local alarm** — a two-tone WebAudio chime plus "Calling for help now", both synthesised in
   the page. No network, no audio files, no dependency on the server being reachable.
2. **Audit log** — `alerts.log`, one JSON line per alert. Written before any network attempt, so
   if a HELP was raised and nobody came, the record exists.
3. **Onward notification** — POST to `ALERT_WEBHOOK_URL` if configured, with a 5 s timeout.

**Why a webhook and not Twilio or WhatsApp.** Both need an account, a paid number and a verified
sender before one message is delivered — none arrangeable from inside the codebase. A webhook
works immediately with services needing no credentials at all: `https://ntfy.sh/<unguessable-topic>`
gives a phone push with no signup, and Discord or Slack incoming webhooks work identically.

**The UI never claims help is coming until the server says someone was told.** The banner reports
the local alarm and the forwarding result as two separate statements, and shows the failure
reason verbatim. An assistive device that overstates what it did is worse than one that does
less.

**Still missing:** this runs on the compute unit, so onward alerting needs the network, and the
EEG itself arrives via the server. A genuinely offline onward alert needs hardware — a buzzer or
a relay on a nurse-call line. §8.4 still stands.

**On actuating the bed and wheelchair later.** The realistic approach is a relay board wired in
parallel with the existing hand controller's button contacts — it works with any powered bed
and needs no protocol reverse-engineering, unlike CAN/R-Net which is usually locked and differs
per manufacturer. It also requires an electrical safety review, because it means an
AURA-controlled circuit can move a bed with a person in it. Keeping it display-only in v1 is
the right call: it proves the interaction is expressive enough without taking on that risk
before the false-positive rate has been measured (§12).

---

## 10. Calibration protocol

Implemented across `main.py` and `web/src/engine/session.ts`.

### 10.1 Sequence

Runs over the **command set** — `COMMAND_HZ` in `.env`, default **15 / 17 / 19 Hz** — which the
frontend reads from `/api/config`. Nothing about the set is hardcoded client-side.

1. **Resting baseline** — three accepted windows with the disc *static*. Measures each command
   frequency's resting evidence (§6.2) and doubles as the contact check.
2. **8 trials at each command frequency** (`CAL_TRIALS_PER_FREQUENCY = 8`), in order.
3. **Threshold computation** (§10.2), once every frequency has its 8.
4. **3 shuffled validation trials per frequency** (`VALIDATION_TRIALS_PER_FREQUENCY = 3`).

Rejected trials are retried up to `MAX_TRIAL_ATTEMPTS = 6`. Every trial's stimulus starts only
after a 3 s "Get ready" lead-in and stops the moment the headset's result arrives, so the
analysis window contains the subject looking at the target and nothing else.

### 10.2 How thresholds are derived

For each command frequency, two distributions are built from the *same* recordings:

- **Positive evidence** — the frequency's own (baseline-corrected) evidence during its own
  trials.
- **Negative evidence** — the same frequency's evidence during every *other* frequency's
  trials, read from the per-target `evidence_db` array the firmware reports.

The threshold is placed midway between the medians:

```
evidence_threshold = clamp( (median(positive) + median(negative)) / 2,  0.5,  8.0 )
margin_threshold   = clamp( (median(+margin)  + median(−margin))  / 2,  0.25, 6.0 )
```

where a trial's margin for `f` is `evidence(f) − max(evidence of the others)`.

**Why the firmware reports evidence at every frequency.** It is what makes the negative
distribution free: every trial cued at one frequency is simultaneously a negative example for
all the others, so N × 8 trials yield positive *and* negative data for every command with no
separate "look at nothing" condition. Medians rather than means keep a single corrupted trial
from dragging a threshold.

**A profile is bound to its frequency set.** `calibration_profile.json` records the frequencies
it was made for and is ignored — not adapted — if `COMMAND_HZ` has changed since. A stale
profile is not a minor inaccuracy: the 10/15 Hz profile from the old montage, applied to the
new one, produced a **50% false-positive rate** with nothing on screen, because its thresholds
sat below the new noise floor.

### 10.3 Grading

Validation accuracy is graded **≥75% GOOD**, **≥50% FAIR**, else POOR, and reported against
chance (`100 / N`%). The summary also shows, per frequency, **which frequency each validation
trial was decoded as** — so a systematic bias like "the lowest frequency always wins" is visible
as a confusion pattern rather than hidden inside a percentage. Below chance, the problem is not
the thresholds: check contact, then check whether one frequency sits on a resting rhythm.

---

## 11. Software architecture

### 11.1 What exists today

```
ESP32  ──GET  /api/target──▶  Flask (main.py, :5000)  ◀──poll──  browser (index.html + app.js)
       ──POST /api/result──▶         │                                    │
                                     └── calibration_profile.json         └── flicker + calibration UI
                                     
                  public access via ngrok → https://<static-domain>
```

| Endpoint | Method | Purpose |
|---|---|---|
| `/` | GET | Renders the stimulus page. |
| `/api/state` | GET | Full state + last 30 history entries (browser polls at 750 ms). |
| `/api/target` | GET | **ESP32 poll.** Plain-text CSV, `Cache-Control: no-store`. |
| `/api/start` | POST | Browser starts a trial; increments `trial_id`. |
| `/api/stop` | POST | Ends the trial. |
| `/api/result` | POST | ESP32 posts a detection result. |
| `/api/calibration/{begin,status,cancel,profile}` | | Calibration state machine. |

`/api/target` returns a variable-length comma-separated record:

```
trial_id,active,evidence_threshold,margin_threshold,n,f1..fn,b1..bn

0,0,1.5000,0.5000,0                                              idle
3,1,1.5000,0.5000,3,15.0000,17.0000,19.0000,0.0000,0.0000,0.0000  baseline window (raw)
9,1,3.0129,0.2500,3,15.0000,17.0000,19.0000,3.5413,-0.1553,-0.4602 calibrated trial
```

`f1` is the **cued** target; the rest are competitors. `b1..bn` are each frequency's resting
baseline in dB, which the firmware subtracts before comparing (§6.2); they are trailing and
optional, so older firmware that stops after the frequencies still works. During a live
selection nothing is genuinely cued, so the server puts an arbitrary member first and reads back
`best_index`.

Plain text rather than JSON because the firmware scans it field by field with `strtoul`/`strtod`
— no JSON parser on the device and no allocation.

`/api/config` returns the command set, keys, trial counts and bands; the frontend reads it at
startup instead of hardcoding any of them.

`/api/frequencies?refresh_hz=…&band=…` returns the allocation for a display, so the frequency
set is decided in one place (`frequencies.py`) rather than duplicated in JavaScript.

**Firmware / server contract details that matter**

- The firmware records once per `trial_id` and **re-fetches the target after recording**, so a
  block is discarded if the frontend stopped or changed frequency mid-window.
- `lastProcessedTrialId` advances only on a successful POST, so a network failure retries
  rather than silently dropping a trial.
- **ngrok note:** every request sends `ngrok-skip-browser-warning: true`. Without it ngrok's
  free tier answers with an HTML interstitial instead of proxying, the `sscanf` matches fewer
  than three fields, and every poll fails. Verified directly against the live tunnel.

### 11.2 Target v1 architecture

New services on the compute unit, alongside what exists:

| Service | Responsibility |
|---|---|
| **Camera service** | Grabs frames; detects significant scene change. |
| **Scene service** | Gemini Call A → objects + boxes. Caches until the scene changes. |
| **Tag allocator** | Assigns frequencies from the budget (§6.5); ranks and pages objects (§7.1); enforces minimum angular separation. |
| **Renderer** | Draws the frame + tags; owns refresh measurement and quantisation (§7.2). Extends `app.js`. |
| **Decoder** | Currently on the ESP32; moves here in v2 (§6.4). |
| **Intent service** | Gemini Call B → intent menu. |
| **Action service** | Dispatches; owns the local HELP path. |
| **Logger** | Raw EEG, frames, tags, selections, outcomes, timings. |
| **Profile store** | Caregiver profile + calibration profile. |

### 11.3 Development tooling (built)

In `firmware/`, driving the ESP32 without opening the Arduino IDE:

```powershell
.\aura.ps1 build                          # compile
.\aura.ps1 flash -ServerBase "https://..." # compile + upload (releases COM4 first)
.\aura.ps1 monitor                        # serial → console + serial.log
.\aura.ps1 serve                          # Flask on :5000
python tunnel.py                          # ngrok on the static domain from .env
```

`SERVER_BASE` is a compile-time define (`AURA_SERVER_BASE`), so retargeting between the tunnel
and a LAN address is a flag rather than a source edit.

Two environment-specific notes worth recording, because both cost real time:

- **Windows Smart App Control is enforced on the dev machine** and blocks the current `ngrok.exe`
  on binary reputation — including ngrok's own self-updated build. `tunnel.py` therefore uses
  the ngrok **Python SDK**, whose embedded agent loads inside `python.exe`. Same tunnel, no
  blocked binary.
- The Windows Store Python reports its image name as `python3.13.exe`, not `python.exe`, which
  breaks any process lookup filtering on the latter.

---

## 12. Evaluation protocol

For the paper. Report all of it, including the failures.

### 12.1 Metrics

| Metric | Definition | Target (v1) |
|---|---|---|
| **Accuracy** | Correct selections / attempted selections | ≥ 80% |
| **Rejection rate** | Blocks discarded by the quality gates | Report; high is not failure |
| **Selection time** | Cue onset → committed selection | ≤ 10 s |
| **ITR** | Bits/min, standard Wolpaw formula | Report against N |
| **HELP false-positive rate** | Unintended HELP triggers per hour of use | **< 0.1 /h** |
| **HELP true-positive latency** | Intent → alert delivered | < 15 s |

The HELP false-positive rate is the metric that gates any real deployment. An assistive device
that cries wolf gets switched off, and then it is not there when it is needed.

### 12.2 Conditions

- Per subject: ≥ 3 sessions on different days (captures inter-session electrode variability —
  the thing the per-session re-check exists for).
- Report per-frequency accuracy separately; they will not be equal (see §10.2).
- Baselines: (a) fixed-menu SSVEP with no AI, (b) switch scanning, for selection time.
- Ablations: fundamental-only vs fundamental+harmonic; with vs without the artifact channel;
  1 ch vs 8 ch once ADS1299 lands.

### 12.3 Subjects

Healthy volunteers first — the system must work on easy cases before it is put in front of
someone who depends on it. Clinical subjects only after ethics approval and the §5.4 isolation
work.

---

## 13. Safety, privacy, regulatory

### 13.1 Photosensitivity

Seizures are most commonly provoked between **3 and 30 Hz**, with risk extending to ~60 Hz and
rare below 3 Hz. WCAG SC 2.3.1 and Section 508 both treat roughly **3–55 Hz** as the flicker
risk range, with a stricter threshold for saturated red. AURA's current 10 and 15 Hz sit close
to the worst of it.

Mitigations in §7.4. **Screening for personal or family history of photosensitive epilepsy is
mandatory** and belongs in the consent form. This risk is the primary reason full-field flicker
was abandoned (§7.1).

> **The real answer is the `high` frequency band (§6.5).** Stimulation above 20 Hz is markedly
> safer, and flicker in the **37–40 Hz** region is nearly imperceptible to the user — the
> stimulus effectively disappears while still evoking a response. Reported SNR for
> high-frequency SSVEP can match low-frequency SSVEP, though inter-subject variability is much
> higher and a 60 Hz phase-coded system produced responses too weak to be useful.
>
> Your 165 Hz display renders 30–40 Hz comfortably (`R/4` ≈ 41 Hz), so this is available now.
> **It is not free:** the firmware's 35 Hz low-pass would have to move, the second-harmonic
> evidence path becomes unusable (2f lands above any sane filter), and some users will simply
> not respond well. The right move is to treat band selection as a **per-user calibration
> outcome** — try `standard` first, fall back to `high` for anyone who reports discomfort or
> screens as a photosensitivity risk — rather than a global constant.

### 13.2 Electrical safety

See §5.4. Battery operation for v1; IEC 60601-1 for anything clinical.

### 13.3 Privacy — India, DPDP Act 2023

The camera films a private space containing people who are not the user: caregivers, family,
other patients. Under the **Digital Personal Data Protection Act, 2023** these are identifiable
personal data and the user is likely a person whose consent must be given by a lawful guardian.

| Concern | v1 position | v2 requirement |
|---|---|---|
| Frames sent to a cloud LLM | Accepted for prototype, with consent | On-device VLM — no frames leave |
| Bystanders in frame | Documented; consent from household | Local person-blur before any upload |
| Raw EEG | Logged locally | Encrypted at rest |
| Retention | Local disk, project duration | Defined policy, deletion on request |
| Consent | Written, from user and guardian | Same, plus bystander notice |

Also note that EEG is **health data**, attracting the strictest handling under DPDP.

### 13.4 Medical device classification

If AURA is presented as assisting a patient with a medical condition, Indian **CDSCO** rules
likely classify it as a medical device (risk class to be determined). For now it is
**research-only, not for clinical use**, and every artefact — including the demo — should say
so. The patent does not require the device to be certified; deployment does.

---

## 14. Novelty and patent claims

### 14.1 The core idea in one sentence

> An SSVEP brain–computer interface in which the flickering targets are **dynamically bound to
> physical objects detected in a live camera view of the user's environment**, and in which
> selecting an object causes a language model to **generate a context-specific menu of candidate
> intents that themselves become the next set of SSVEP targets**.

### 14.2 Prior art — a serious problem with the obvious claim

> ⚠ **A literature search found that both halves of §14.1 already exist.** The claim as first
> drafted is very likely anticipated. This section records what was found so the filing is not
> built on a false premise.

**Camera-detected objects carrying SSVEP stimuli — already published.**

| Work | What it does |
|---|---|
| *Study on Robot Grasping System of SSVEP-BCI Based on Augmented Reality Stimulus* (Tsinghua Science & Technology, 2022) | AR-presented SSVEP stimuli for robot grasping; 12 subjects. |
| *3D SSVEP Visual Stimulus in Augmented Reality for Robotic Arm Grasping* (ICCPR 2023) | A **depth camera** locates the object; the SSVEP stimulus **completely overlaps the target object and stays on it as the subject moves**. This is object-anchored tagging, essentially as described in §7.1. |
| *Brain-controlled prosthetic hand integrating AR-SSVEP augmentation, asynchronous control and machine vision assistance* (Heliyon, 2024) | Machine vision selects and augments SSVEP targets. |
| YOLOv4-based "intelligent BCI system switch" | Deep-learning object detection gating a BCI. |
| US 11,445,972 — *Brain–computer interface for user's visual focus detection* | Frequency-modulated stimuli, EEG decoding of which stimulus is attended. |

**LLM-driven intent inference in a BCI — also already published.**

| Work | What it does |
|---|---|
| *Human intention inference with a large language model can enhance brain-computer interface control* (bioRxiv, 2025) | LLM agent fuses neural + oculomotor signals with context to infer intent; 79% accuracy selecting arbitrary posts. |
| *MindChat: Enhancing BCI Spelling with Large Language Models* (2025) | LLM assists BCI spelling. |
| *Towards Predictive Communication: Fusion of LLMs and BCI* (Sensors, 2025) | Review; statistical language models already give ~30% bit-rate gains in BCI communication. |

**Consequence:** "SSVEP targets bound to camera-detected objects" is *not* novel. "An LLM
inferring user intent in a BCI" is *not* novel. Claim 1 must be narrowed to what the searches
did **not** turn up.

### 14.3 Where novelty appears to survive

Two things, and the second is stronger than the first:

**(a) The LLM's output becomes the next stimulus set — a closed generative loop.**
In every prior-art system found, the stimulus set is fixed at design time (a grid, a keyboard,
or a set of detected objects). In AURA the model's *generated* intents are themselves rendered
as new frequency-tagged SSVEP targets, so the interface's vocabulary is synthesised at runtime
and the same evoked-potential channel is reused to resolve it. The searches found LLMs
*interpreting* BCI output, and BCIs *selecting* detected objects, but not an LLM **defining the
stimulus alphabet** that the BCI then decodes.

**(b) The calibration method.** Deriving per-target evidence *and* margin thresholds from
positive and negative distributions harvested from the **same** trial set — every 15 Hz trial
serving as a negative example for 10 Hz (§10.2) — is implemented, measured, and was not found
in the surveyed work. It is narrower than (a) but far easier to defend because it is concrete
and reduced to practice.

### 14.4 Redrafted claim structure

**Claim 1 (independent).** A brain–computer interface method comprising: displaying a first set
of visual stimuli, each modulated at a distinct frequency and each spatially associated with an
object identified in a camera view of the user's environment; decoding electroencephalographic
signals to determine which stimulus is attended, thereby selecting an object; **submitting a
representation of the selected object to a generative language model to obtain a plurality of
candidate intents; rendering each said candidate intent as a further visual stimulus modulated
at a distinct frequency, thereby forming a second stimulus set whose membership is determined
at runtime by the output of said model**; and decoding said signals a second time to select one
candidate intent and dispatch a corresponding action.

The emphasised clause is what distinguishes it from the AR-SSVEP art. Everything before it is
conceded to be known.

**Dependent claims (retain):**

2. Wherein the candidate intents are generated using a stored user profile.
3. Wherein a persistent emergency stimulus is decoded and dispatched **without reference to the
   language model**.
4. Wherein the emergency stimulus requires a longer dwell and issues an abortable countdown.
5. Wherein the decision requires both an evidence threshold and a margin threshold relative to
   competing frequencies.
6. **Wherein said thresholds are derived per-frequency from positive and negative evidence
   distributions collected within a single calibration session, each trial of one frequency
   serving as a negative example for the others.**
7. Wherein a second EEG channel is used to reject blocks containing movement artifact.
8. Wherein the frequency set is confined to a single octave such that no second harmonic of any
   target coincides with another target.

Claims 5, 6 and 8 describe mechanisms already implemented and measured. **A professional
prior-art search before filing is strongly advised** — this one was a few hours of literature
review, not a patent-database search, and it already found anticipating art.

### 14.3 Draft claim structure

**Claim 1 (independent).** A brain–computer interface system comprising: an image sensor
capturing a scene in the user's field of view; a processor identifying objects in the scene; a
display rendering, for each identified object, a visual stimulus modulated at a distinct
frequency and spatially associated with that object; EEG electrodes positioned over the
occipital region; a decoder determining which modulation frequency is dominant in the EEG and
thereby selecting an object; wherein selection of an object causes a generative language model
to produce a set of candidate intents associated with that object, and each candidate intent is
rendered as a further visual stimulus modulated at a distinct frequency, such that a second
determination by the decoder selects an intent and dispatches a corresponding action.

**Dependent claims to include:**

2. Wherein the candidate intents are generated using a stored user profile.
3. Wherein a persistent emergency stimulus is decoded and dispatched without reference to the
   language model.
4. Wherein the emergency stimulus requires a longer dwell and issues an abortable countdown.
5. Wherein the decision requires both an evidence threshold and a margin threshold relative to
   competing frequencies.
6. Wherein said thresholds are derived per-frequency from positive and negative evidence
   distributions collected in a single calibration session.
7. Wherein a second EEG channel is used to reject blocks containing movement artifact.
8. Wherein modulation frequencies are quantised to the measured display refresh rate and the
   quantised value is used as the decoding target.
9. Wherein the frequency set excludes pairs in harmonic relation.
10. Wherein the stimuli spatially track their associated objects as the scene changes.

Claims 5, 6 and 8 are worth emphasising: they describe mechanisms already implemented and
measured, not aspirations.

---

## 15. Roadmap

| Phase | Contents | Gate |
|---|---|---|
| **v1.0 — demo** *(current + next steps)* | Camera + Gemini tags + intent menus on the tablet-on-arm rig; 2-channel EEG; help and TTS real, bed/chair displayed only. | Works end to end for one healthy subject. |
| **v1.1 — safety** | **Local HELP path with no network dependency** (§8.4). Local detector for Call A. Battery isolation (§5.4). | HELP FP rate < 0.1/h measured. |
| **v1.2 — paper** | 3+ subjects × 3+ sessions, ablations, baselines (§12). | Results written up. |
| **v2.0 — signal** | ADS1299, 8 channels, raw streaming, CCA/TRCA, 1–2 s windows, JFPM for 20+ targets. | ≤3 s per step. |
| **v2.1 — edge** | On-device VLM on Jetson Orin Nano or phone. Frames stop leaving the device. | Fully offline operation. |
| **v2.2 — form factor** | AR/VR passthrough; head-mounted camera. | — |
| **v3 — clinical** | Bed/chair actuation, IEC 60601, CDSCO pathway, clinical trial. | Regulatory. |

**Patent filing sits after v1.0** — the claims in §14.3 are supported by what v1.0
demonstrates, and filing need not wait for v2.

---

## 16. Open questions and risks

| # | Risk | Severity | Mitigation / status |
|---|---|---|---|
| 1 | **HELP depends on the network in v1** | **High** | First roadmap item (v1.1). Must not ship past a demo. |
| 2 | **Dry occipital electrodes are the weakest component in the system** | **High** | Measured comparison for short hair: **0.63 accuracy dry vs 0.88 water-based vs 0.96 gel**, with dry impedance 4–5× wet (wet ≈ 8.3 kΩ @ 10 Hz). That gap is larger than anything the decoder can recover. Modern *claw-shaped active* dry electrodes plus good algorithms have reached 93.2% at 1 s windows, so the answer is better electrodes, not better software. **Recommendation: switch v1 to water/saline-based electrodes** — nearly gel-grade accuracy, seconds to prepare, caregiver-friendly — and treat active dry as a v2 goal. |
| 3 | Frequency budget too small at 60 Hz (§6.5) | High | Buy a 120 Hz display; MORE-tile paging; JFPM in v2. |
| 4 | Gemini bounding boxes are not stable frame to frame, so tags jitter | Medium | Local detector for Call A (v1.1); cache and only re-detect on scene change. |
| 5 | Latency (7–10 s/step × 2 steps) frustrates users | Medium | Accepted for v1; v2 targets ≤3 s. |
| 6 | LLM proposes an irrelevant or wrong intent | Medium | Bounded schema, allow-list, always-present Cancel; user must confirm. |
| 7 | SSVEP fatigue over long sessions | Medium | Low modulation depth, rest periods, flicker only during trials. |
| 8 | Photosensitivity | Medium (severe if it occurs) | Screening + §7.4 mitigations. |
| 9 | Bystander privacy under DPDP | Medium | Consent for prototype; on-device VLM in v2. |
| 10 | Covert-attention SSVEP in late ALS may be too weak | Medium | Needs empirical testing; multi-channel helps most here. |
| 11 | The user cannot report discomfort | Medium | Caregiver checks; conservative defaults; hard stop always available. |
| 12 | **Alpha rhythm dominates any target near 10 Hz** | **High — mitigated** | Measured: 10 Hz won 12/14 trials regardless of stimulus, including two where the stimulus had been filtered out. Command set moved to 15/17/19 Hz; resting baseline subtracted per frequency (§6.2). Needs confirming on the new set. |
| 13 | Occipital signal is small: resting RMS 1–7 counts on a 12-bit ADC | High | Real SSVEP confirmed (12.9 dB staring vs covered) but clears threshold only ~half the time at 4 s. Better electrode contact and the ADS1299 upgrade are the levers; longer windows made it worse (§18). |
| 14 | Fatigue raises alpha over a session | Medium | Measured: 10 Hz pedestal rose from ~0.8 to ~5.3 dB across an evening. Keep sessions short; the baseline in §4.2 should be re-measured, not reused, each session. |

**Open questions still to resolve**

- Which specific display, and at what refresh rate? (Gates §6.5 — decide before buying.)
- Which alert channel for local HELP — buzzer, GPIO relay to nurse call, or paired phone?
- Tag layout for vertical-gaze-only users: a single column, or scale the whole layout into the
  reachable envelope?
- Does the artifact channel earn its place, or would a second occipital channel serve better?
  Testable by ablation (§12.2).
- Is 8 calibration trials per frequency enough for stable thresholds? The 15 Hz margin already
  sits on its clamp floor, which suggests not.

---

## 17. Glossary

| Term | Meaning |
|---|---|
| **SSVEP** | Steady-state visually evoked potential — the occipital cortex response that follows the frequency of a flickering stimulus the user attends to. |
| **Evidence** | SNR in dB of a target frequency against its spectral neighbours; the better of fundamental and penalised 2nd harmonic. |
| **Margin** | Evidence for the target minus evidence for the competing target. The discriminative quantity. |
| **Goertzel** | An efficient algorithm for the power at one specific frequency — cheaper than an FFT when only a few frequencies matter. |
| **CCA** | Canonical correlation analysis; the standard multi-channel SSVEP decoder. |
| **TRCA** | Task-related component analysis; learns per-user spatial filters from calibration data. Higher accuracy than CCA. |
| **JFPM** | Joint frequency-phase modulation — encoding targets by both frequency and phase to fit many targets in a narrow band. |
| **Midas touch** | The failure mode where a gaze interface acts on every glance, including unintentional ones. |
| **P2P** | Peak-to-peak, in raw ADC counts. |
| **AFE** | Analog front end — the amplification and filtering between electrode and ADC. |
| **ITR** | Information transfer rate, bits/min; the standard BCI throughput metric. |
| **AAC** | Augmentative and alternative communication. |
| **DPDP** | Digital Personal Data Protection Act, 2023 (India). |
| **CDSCO** | Central Drugs Standard Control Organisation — India's medical device regulator. |

---

## 18. Bench findings, 28 Aug 2026

The first session with electrodes on, in the order things were learned. Everything here is
measured on one subject, one evening, with the v1 hardware; sample sizes are small throughout.

### 18.1 What was established

- **A genuine SSVEP exists.** 15 Hz, staring at the disc: **+6.82 dB**. Same stimulus, eyes
  closed and hand over them: **−6.11 dB**. A 12.9 dB swing at the stimulus frequency, driven by
  gaze alone. Not alpha (15 Hz is above the alpha band), not 1/f.
- **It is intermittent.** Across staring trials the 15 Hz fundamental ranged 0.11–6.82 dB
  against a 2.48 dB threshold, and the misses tracked how still the subject held, not where
  they looked. The occipital channel rests at RMS 1–7 counts; the signal is small.
- **Gel is not optional.** Dry occipital contact railed the amplifier; gel fixed it with no
  other change (§5.3).
- **Alpha decides everything near 10 Hz.** With 10 and 15 Hz as the command pair, 10 Hz won
  12 of 14 trials whatever was displayed — including two trials at 41 Hz where the firmware's
  35 Hz low-pass had removed the stimulus entirely, leaving pure noise. Real 10 Hz SSVEP
  (5.5–7.1 dB when cued) rode on an alpha pedestal (−0.9 to 3.1 dB when not, rising to 3.5–7 dB
  late in the evening as the subject tired) that beat 15 Hz every time. The decoder was correct;
  the frequency choice was not.
- **Lowest-frequency-wins appeared even above alpha** (14 Hz won 4/4 in the 14–18.5 Hz band),
  but that data was collected before the trial-timing bug below was fixed and is not trusted.
- **An 8 s window made detection worse**, not the √T-predicted 3 dB better: 15 Hz evidence
  while staring fell from 0.11–6.82 dB to −6.13–1.78 dB. Fixation drift, movement and SSVEP
  adaptation over 11 s of staring outweigh the averaging gain. 4 s stands.
- **A stale calibration profile is dangerous.** Thresholds from the old montage, applied to the
  new one, produced `MATCH` on 3 of 6 windows with nothing on screen.

### 18.2 Bugs found and fixed

| Bug | Symptom | Cause |
|---|---|---|
| lwIP double-free | board rebooted after every POST (`pbuf_free: p->ref > 0`) | `WiFiClient` was a stack local, destroyed while lwIP still held its buffers; the same heap corruption surfaced as `LoadProhibited` panics inside the Wi-Fi driver and was first misdiagnosed as a power problem |
| Wi-Fi stuck "connected" | `Target request failed: -1` forever after the hotspot dropped | link status read `WL_CONNECTED` while DHCP/DNS never completed; recovery is now driven by five consecutive request failures, not link status |
| Contact floor | clean signal rejected as bad contact | `MIN_MAIN_VALID_P2P = 100` was calibrated against a drifting montage |
| Artifact burst on P2P | every calibration trial rejected | one blink is indistinguishable from continuous blinking by P2P; RMS separates them |
| Artifact ceiling | blinks reported as `CHECK_ARTIFACT_ELECTRODES` | 1500 was below what a blink produces |
| Trial started on click | operator still scrolling when the window opened; second click silently discarded the first trial | no lead-in, no re-entry guard, start button not disabled during the lead-in |
| Flicker ran to timeout | subject stared at a strobe for seconds after the answer existed | result polling began only after the flicker; now concurrent, stops on arrival |
| `high` band offered but unseeable | 41 Hz trials scored −16 dB | allocation returned frequencies above the firmware's 35 Hz low-pass; now clamped |
| Serial monitor died on unplug | no log after reconnect | now waits up to two minutes for the port to return |

### 18.3 What changed structurally as a result

- Command set is configurable (`COMMAND_HZ`), default **15 / 17 / 19 Hz**, read by the
  frontend from `/api/config`; the last hardcoded 10/15 is gone from firmware, server and UI.
- Calibration starts with a **resting baseline** (§4.2, §6.2) that the firmware subtracts
  per frequency; thresholds are derived from baseline-corrected evidence across *all* command
  frequencies (§10.2); validation reports a per-frequency confusion pattern (§10.3).
- A profile is bound to its frequency set and ignored if the set changes.
- Artifact rejection is on RMS (§6.3); contact gates retuned from measured distributions.
- Stimulus depth ~60% (§7.3); 3 s lead-in and stop-on-result on every trial (§10.1); the
  live and scene loops prefer the calibrated frequencies over a band allocation once a profile
  exists.

### 18.4 Next session

1. Plug the board in, then from `firmware/`: `.\aura.ps1 flash -ServerBase "http://<laptop-ip>:5000"`
   (the laptop's IP on the shared network; it was `192.168.1.15` on Sherieff's).
2. `python main.py`, then open the page and run **Guided calibration**. Expect ~10 minutes:
   3 baseline windows, 24 trials, 9 validation trials.
3. Read the summary against chance (33%) and look at the "Decoded as" line for each frequency.
   If one frequency wins regardless, the baseline did not cancel it — that is the finding.
4. Do it while fresh. Alpha rose across the evening; calibrating tired measures the wrong
   subject.

---

## Appendix A — Implemented constants

Firmware (`firmware/aura_ssvep/aura_ssvep.ino`):

```c
SAMPLE_RATE 250        RECORD_SECONDS 4       WARMUP_SECONDS 1
MAIN_EEG_PIN 35        ARTIFACT_PIN 34        analogReadResolution(12), ADC_11db
HIGH_PASS_HZ 3.0       LOW_PASS_HZ 35.0       NOTCH 50.0 Hz, Q 20
MAX_TARGETS 8          MIN_TARGETS 1          frequencies + baselines supplied per-trial
HARMONIC_PENALTY_DB 0.5
MIN_MAIN_VALID_P2P 25       MAX_MAIN_VALID_P2P 2200
MIN_ARTIFACT_VALID_P2P 40   MAX_ARTIFACT_VALID_P2P 3000
ARTIFACT_BURST_RMS 55.0     ARTIFACT_BURST_P2P 2800 (backstop)
MIN_FILTERED_RMS 1.0        MAX_MAIN_FILTERED_RMS 800.0
                            MAX_ARTIFACT_FILTERED_RMS 600.0
clipping: raw <= 20 or >= 4075          SNR clamp: ±30 dB
noise offsets: ±0.75, ±1.00, ±1.25 Hz   window: Hamming (0.54 − 0.46·cos)
MAX_CONSECUTIVE_FAILURES 5  (rebuild Wi-Fi)   WIFI_POWER_11dBm
```

Server (`main.py`):

```python
COMMAND_HZ default 15,17,19   (from .env; profile is bound to this set)
CAL_TRIALS_PER_FREQUENCY 8    VALIDATION_TRIALS_PER_FREQUENCY 3   BASELINE_WINDOWS 3
MIN_EVIDENCE_THRESHOLD 0.5    MAX_EVIDENCE_THRESHOLD 8.0
MIN_MARGIN_THRESHOLD 0.25     MAX_MARGIN_THRESHOLD 6.0
grading: >= 75% good, >= 50% fair, vs chance 100/N    history capped at 100
```

Frontend (`web/src/engine/clock.ts`):

```js
LUMINANCE_MIDDLE 128   LUMINANCE_AMPLITUDE 76   (~60% depth, per §7.3)
ACTIVE_SECONDS 8       SELECTION_SECONDS 8      (upper bounds; flicker stops on result)
READY_SECONDS 3        (lead-in before any trial records)
REST_SECONDS 10        MAX_TRIAL_ATTEMPTS 6     RESULT_POLL_INTERVAL_MS 500
MAX_REFRESH_FRACTION 0.25   (rendering ceiling; NOT a quantisation step)
refresh measurement: median of 120 requestAnimationFrame intervals
measured on the development display: 163.93 Hz
command set, trial counts, bands: from /api/config (fallback 15/17/19)
```

Allocation (`frequencies.py`):

```
bands       clear 14-20 (default) | standard 8.0-15.6 | comfort 11-20 | high 30-35
            each one octave; high is clamped to the decoder's 35 Hz low-pass
separation  1.5 Hz  (set by the decoder's +/-1.25 Hz noise sidebands)
```

## Appendix C — References

Stimulus and coding

- Manyakov, Chumerin, Robben, Combaz, van Vliet, Van Hulle (2013). *Sampled sinusoidal
  stimulation profile and multichannel fuzzy logic classification for monitor-based phase-coded
  SSVEP brain–computer interfacing.* J. Neural Eng. **10**(3):036011. — the sampled sinusoidal
  profile; six phase-coded targets where on/off gives four.
- Chen, Wang, Nakanishi, Gao, Jung, Gao (2015). *High-speed spelling with a noninvasive
  brain–computer interface.* PNAS **112**(44):E6058. — JFPM, 40 targets, 8.0–15.8 Hz at 0.2 Hz
  and 0.5π steps, 0.5 s stimulation, ITR 5.32 bits/s.

Decoding

- Chen, Wang, Gao, Jung, Gao (2015). *Filter bank canonical correlation analysis for
  implementing a high-speed SSVEP-based BCI.* J. Neural Eng. **12**:046008. — FBCCA; sub-bands
  spanning multiple harmonic bands (method M3) performed best.
- Nakanishi, Wang, Chen, Wang, Gao, Jung (2018). *Enhancing detection of SSVEPs for a
  high-speed brain speller using task-related component analysis.* IEEE TBME. — TRCA; online ITR
  325.33 ± 38.17 bits/min.

Hardware and human factors

- *A High-Speed SSVEP-Based BCI Using Dry EEG Electrodes.* Sci. Rep. **8**:14708 (2018). —
  93.2% at 1 s with dry electrodes.
- *Dry and water-based EEG electrodes in SSVEP-based BCI applications* (2013). — 0.63 dry /
  0.88 water / 0.96 gel for short hair.
- *Improving user experience of SSVEP BCI through low amplitude depth and high frequency
  stimuli design.* Sci. Rep. (2022). — depth 100%→30%; ~60% depth optimal at low frequency;
  94.6% vs 91.7%.
- W3C WCAG 2.x SC 2.3.1 *Three Flashes or Below Threshold*; ISO 9241-391; Section 508. —
  flicker risk band ~3–55 Hz.

Prior art relevant to §14

- *Study on Robot Grasping System of SSVEP-BCI Based on Augmented Reality Stimulus.* Tsinghua
  Science & Technology (2022).
- *3D SSVEP Visual Stimulus in Augmented Reality for Robotic Arm Grasping.* ICCPR (2023).
- *A novel brain-controlled prosthetic hand method integrating AR-SSVEP augmentation,
  asynchronous control, and machine vision assistance.* Heliyon (2024).
- *Human intention inference with a large language model can enhance brain-computer interface
  control.* bioRxiv (2025).
- *Towards Predictive Communication: The Fusion of Large Language Models and Brain–Computer
  Interface.* Sensors **25**(13):3987 (2025).
- US 11,445,972 — *Brain–computer interface for user's visual focus detection.*

## Appendix B — Hardware as verified

```
Chip     ESP32-D0WD-V3 (rev v3.1), 240 MHz dual core, 40 MHz crystal
MAC      cc:7b:5c:1e:d9:48
USB      Silicon Labs CP2102 (VID_10C4 & PID_EA60), COM4
FQBN     esp32:esp32:esp32          Core: esp32:esp32 3.3.11
Build    1,057,712 bytes flash (80%)   60,800 bytes RAM (18%)
Toolchain arduino-cli 1.5.0 (bundled with Arduino IDE 2.3.9)
```
