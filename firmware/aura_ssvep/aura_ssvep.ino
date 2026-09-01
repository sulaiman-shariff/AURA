#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <math.h>

// =========================================================
// Network configuration
// =========================================================

/*
 * The SSID contains U+2019 (a curly apostrophe), not an ASCII quote -- Apple
 * devices and many routers name themselves that way, and the two look the
 * same on screen. It is written as explicit UTF-8 bytes so the sketch does
 * not depend on the source file's encoding, and as separate string literals
 * so the  escape cannot swallow the following 's' as another hex digit.
 *
 * The ESP32-WROOM-32 is 2.4 GHz only: it will never see a 5 GHz-only
 * network however correct the credentials are. On an iPhone hotspot that
 * means "Maximize Compatibility" must be on.
 */
const char *WIFI_SSID = "Suha" "\xE2\x80\x99" "s iPhone";
const char *WIFI_PASSWORD = "hellothere";

/*
 * Server base URL. Do not put a trailing slash here.
 *
 * Overridable at build time so the same sketch can target the
 * public tunnel or a LAN address without editing this file:
 *
 *   --build-property "compiler.cpp.extra_flags=-DAURA_SERVER_BASE=\"http://192.168.1.25:5000\""
 */
#ifndef AURA_SERVER_BASE
#define AURA_SERVER_BASE "https://REPLACE-ME.ngrok-free.app"
#endif

const char *SERVER_BASE = AURA_SERVER_BASE;

// =========================================================
// EEG channel configuration
// =========================================================

// Rear O1/O2 SSVEP channel.
constexpr int MAIN_EEG_PIN = 35;

// Temple/side artifact channel.
constexpr int ARTIFACT_PIN = 34;

// =========================================================
// Sampling configuration
// =========================================================

constexpr int SAMPLE_RATE = 250;

/*
 * Analysis window.
 *
 * Tried 8 s on the theory that Goertzel SNR grows with sqrt(T), which
 * predicted about +3 dB. Measured, it went the other way: 15 Hz evidence
 * while staring fell from 0.11-6.82 dB at 4 s to -6.13-1.78 dB at 8 s.
 *
 * The sqrt(T) argument only holds if the extra time contains more of the
 * same signal. Over 11 s of staring it does not -- fixation drifts, the
 * subject moves, and the SSVEP itself adapts under prolonged stimulation.
 * Back to 4 s, which is also what the SSVEP literature typically uses.
 */
constexpr int RECORD_SECONDS = 4;

constexpr int SAMPLE_COUNT =
    SAMPLE_RATE * RECORD_SECONDS;

constexpr int WARMUP_SECONDS = 1;

constexpr int WARMUP_SAMPLES =
    SAMPLE_RATE * WARMUP_SECONDS;

constexpr uint32_t SAMPLE_PERIOD_US =
    1000000UL / SAMPLE_RATE;

// =========================================================
// Frequency analysis
// =========================================================


/*
 * The server sends the active frequency set with every poll, so the
 * firmware no longer hard-codes which frequencies are commands. Index 0
 * is always the cued target -- during calibration that is the frequency
 * being trained, and the remainder are its competitors; during a live
 * selection nothing is truly "cued", so the server puts an arbitrary
 * member first and reads back best_index instead.
 */
constexpr int MAX_TARGETS = 8;

// Below this the target set is unusable and the block is skipped.
constexpr int MIN_TARGETS = 1;

// Software filtering.
constexpr float HIGH_PASS_HZ = 3.0f;

// Preserve the 30 Hz second harmonic of the 15 Hz target.
constexpr float LOW_PASS_HZ = 35.0f;

// India mains rejection.
constexpr float NOTCH_FREQUENCY_HZ = 50.0f;
constexpr float NOTCH_Q = 20.0f;

// Fallback detection thresholds, used only if the server has not
// yet supplied a calibrated per-target evidence/margin threshold
// (e.g. very first boot, or an older server response format).
constexpr float DEFAULT_EVIDENCE_THRESHOLD_DB = 1.5f;
constexpr float DEFAULT_MARGIN_THRESHOLD_DB = 0.50f;

// The second harmonic is accepted as target evidence,
// but receives a small penalty.
constexpr float HARMONIC_PENALTY_DB = 0.5f;

// =========================================================
// Signal/contact quality
// =========================================================

// Any ADC rail hit indicates bad contact or saturation.
constexpr int MAX_MAIN_CLIPPED_SAMPLES = 0;
constexpr int MAX_ARTIFACT_CLIPPED_SAMPLES = 0;

/*
 * Retuned for the gelled Config B montage (O2 vs right mastoid).
 *
 * The previous floor of 100 was calibrated against a poorly-contacted
 * setup whose resting P2P sat at 490-985 -- most of which was electrode
 * drift, not signal. With gel and a proper reference the baseline is far
 * cleaner and SMALLER: 42-70 P2P with zero clipping, while still yielding
 * 6 dB of frequency-specific SSVEP evidence. The old floor rejected that
 * as "bad contact", which had it exactly backwards.
 *
 * The floor exists to catch a DISCONNECTED electrode. On this hardware a
 * disconnected input rails (P2P 4095) or sits dead flat (P2P near 0), so
 * 25 separates those from a clean recording with room to spare.
 */
constexpr int MIN_MAIN_VALID_P2P = 25;
constexpr int MAX_MAIN_VALID_P2P = 2200;

/*
 * Measured on the temple-to-temple montage, which is effectively a
 * horizontal EOG derivation and so is far more active than the old
 * placement (which rested at 159-497):
 *
 *   still, fixating :  545  707  761  765  882      (max 882)
 *   blinking ~1/s   :  982 1384 1580 2529           (min 982)
 *
 * The ceiling is a CONTACT check, so it must sit above anything a blink
 * can produce -- at 1500 a hard blink (2529) was reported as
 * CHECK_ARTIFACT_ELECTRODES, blaming the electrodes for an eye movement.
 */
constexpr int MIN_ARTIFACT_VALID_P2P = 40;
constexpr int MAX_ARTIFACT_VALID_P2P = 3000;

/*
 * Burst = discard this window as contaminated.
 *
 * Measured on this montage, P2P cannot tell the two cases apart but RMS
 * separates them cleanly:
 *
 *   still, fixating       P2P  545-882    RMS  27-44
 *   ONE blink in a window P2P 1311-1617   RMS  25-27   <- keep
 *   continuous blinking   P2P  982-2529   RMS  64-146  <- discard
 *
 * A single blink is a large isolated excursion: it dominates P2P while
 * leaving RMS at the resting level, and it barely perturbs a Goertzel
 * averaged over 1000 samples. Sustained blinking raises RMS by 3-5x and
 * genuinely corrupts the estimate. So the burst test is on RMS.
 *
 * Two P2P thresholds in a row (900, then 1300) rejected every calibration
 * trial because they were measuring the wrong thing -- the statistic was
 * the bug, not its value.
 *
 * The P2P backstop stays for a single excursion so violent it would swamp
 * the window regardless.
 */
constexpr float ARTIFACT_BURST_RMS = 55.0f;
constexpr int ARTIFACT_BURST_P2P = 2800;

// Filtered-signal sanity limits.
constexpr float MIN_FILTERED_RMS = 1.0f;
constexpr float MAX_MAIN_FILTERED_RMS = 800.0f;
constexpr float MAX_ARTIFACT_FILTERED_RMS = 600.0f;

// =========================================================
// Buffers
// =========================================================

float mainSamples[SAMPLE_COUNT];
float artifactSamples[SAMPLE_COUNT];

float windowValues[SAMPLE_COUNT];

unsigned long lastProcessedTrialId = 0;

/*
 * Network clients live at file scope and are reused for every request.
 *
 * They used to be stack locals inside fetchTarget() and postResult(). That
 * destroyed the client on every return, tearing down the socket while lwIP
 * still held references to its packet buffers -- which tripped
 *
 *   assert failed: pbuf_free ... (pbuf_free: p->ref > 0)
 *
 * immediately after a POST completed, and rebooted the board. The resulting
 * heap corruption also surfaced as LoadProhibited panics deep inside the
 * Wi-Fi driver (lmacProcessAckTimeout, ppResortTxAMPDU) with no application
 * frame in the backtrace, which made it look like an unrelated RF or power
 * fault. It was neither.
 *
 * Constructing WiFiClientSecure per call was wasteful too: it allocates a
 * TLS context every poll even when the URL is plain http.
 */
WiFiClient plainClient;
WiFiClientSecure secureClient;

// =========================================================
// Structures
// =========================================================

struct TargetState
{
    unsigned long trialId;
    bool active;

    // Active frequency set. hz[0] is the cued target.
    int count;
    float hz[MAX_TARGETS];

    /*
     * Each frequency's resting evidence in dB, measured by the server during
     * calibration with nothing flickering. Subtracted before targets are
     * compared, so the decision is "how much more than resting" rather than
     * "how much" -- the only fair contest when one frequency sits on the
     * alpha rhythm and the others do not. Zero when unknown.
     */
    float baselineDb[MAX_TARGETS];

    // Per-target thresholds supplied by the server, derived from the
    // calibration profile (or defaults before calibration has run).
    float evidenceThreshold;
    float marginThreshold;
};

struct ChannelStats
{
    int minimumRaw;
    int maximumRaw;
    int clippedSamples;

    float rms;
    float differenceRms;
};

struct Biquad
{
    float b0;
    float b1;
    float b2;
    float a1;
    float a2;

    float z1;
    float z2;
};

struct DetectionResult
{
    float detectedHz;

    // Evidence and margin for the *cued* target (index 0). marginDb is
    // signed: negative means a competitor beat the cued target. The
    // calibration profile is built from these two, so their meaning must
    // not drift.
    float scoreDb;
    float marginDb;

    // Winner across the whole set, which is what a live selection uses.
    // With a two-frequency set and the cued target winning, bestIndex is
    // 0 and bestMarginDb equals marginDb.
    int targetCount;
    int bestIndex;
    float bestHz;
    float bestEvidenceDb;
    float bestMarginDb;

    float evidenceDb[MAX_TARGETS];

    float mainFundamentalSnrDb;
    float mainHarmonicSnrDb;

    float artifactFundamentalSnrDb;
    float artifactHarmonicSnrDb;

    // Strongest non-cued frequency and its evidence in this same window.
    // Reported explicitly so the server can build positive/negative
    // calibration distributions from a single trial set.
    float competitorHz;
    float competitorEvidenceDb;

    int mainPeakToPeak;
    int artifactPeakToPeak;

    int mainClipped;
    int artifactClipped;

    bool mainContactGood;
    bool artifactContactGood;

    bool signalValid;
    bool artifactRejected;
    bool confident;
    bool match;

    const char *source;
    const char *reason;
};

// =========================================================
// Wi-Fi
// =========================================================

/*
 * Consecutive failed server requests before the radio is torn down and
 * rebuilt. Five is roughly ten seconds of failures, which is long enough
 * that a transient blip does not trigger it and short enough that an
 * unattended device recovers on its own.
 */
constexpr int MAX_CONSECUTIVE_FAILURES = 5;

int consecutiveFailures = 0;

/*
 * Fully tear the station down.
 *
 * Needed because of a failure mode seen in practice: if the access point
 * disappears, connectWiFi() times out and reports failure, but the
 * supplicant keeps trying in the background. It then associates without
 * anyone printing success, so WiFi.status() reads WL_CONNECTED while DHCP
 * and DNS never completed -- and every request fails with -1 forever, with
 * nothing to trigger a retry because the code believes it is connected.
 * Calling begin() again in that state just logs
 * "sta is connecting, cannot set config" and changes nothing.
 */
void resetWiFiRadio()
{
    Serial.println("Resetting Wi-Fi radio");

    WiFi.disconnect(true, true);
    delay(200);

    WiFi.mode(WIFI_OFF);
    delay(200);

    WiFi.mode(WIFI_STA);
    delay(100);
}

void connectWiFi()
{
    if (WiFi.status() == WL_CONNECTED)
    {
        return;
    }

    Serial.print("Connecting to Wi-Fi");

    // Drop any half-open association first, or begin() is ignored.
    WiFi.disconnect(false, false);
    delay(100);

    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);

    /*
     * Reduced transmit power. Harmless, but NOT the fix it was first taken
     * for: the crashes it was added against (LoadProhibited inside the
     * Wi-Fi driver) were heap corruption from a WiFiClient being destroyed
     * while lwIP still held its buffers -- fixed by making the clients
     * file-scope. Kept because 11 dBm is ample for a device a few metres
     * from its access point and it lowers the peak draw on a 3.3 V rail
     * that also feeds two BioAmp Pills.
     */
    WiFi.setTxPower(WIFI_POWER_11dBm);

    WiFi.begin(
        WIFI_SSID,
        WIFI_PASSWORD
    );

    unsigned long startedAt = millis();

    while (
        WiFi.status() != WL_CONNECTED &&
        millis() - startedAt < 20000
    )
    {
        delay(500);
        Serial.print(".");
    }

    Serial.println();

    if (WiFi.status() == WL_CONNECTED)
    {
        Serial.println("Wi-Fi connected");

        Serial.print("ESP32 IP: ");
        Serial.print(WiFi.localIP());

        // Below about -75 dBm the radio retries heavily, which is the
        // other route into the same low-MAC crash.
        Serial.print("  RSSI: ");
        Serial.print(WiFi.RSSI());
        Serial.println(" dBm");
    }
    else
    {
        Serial.println("Wi-Fi connection failed");
    }
}

bool beginHttpRequest(
    HTTPClient &http,
    WiFiClient &plainClient,
    WiFiClientSecure &secureClient,
    const String &url
)
{
    if (url.startsWith("https://"))
    {
        // Suitable for a temporary development tunnel.
        secureClient.setInsecure();

        return http.begin(
            secureClient,
            url
        );
    }

    return http.begin(
        plainClient,
        url
    );
}

// =========================================================
// Fetch current frontend target
// =========================================================

bool fetchTarget(TargetState &target)
{
    if (WiFi.status() != WL_CONNECTED)
    {
        return false;
    }

    HTTPClient http;

    String url =
        String(SERVER_BASE) +
        "/api/target";

    http.setTimeout(5000);

    if (
        !beginHttpRequest(
            http,
            plainClient,
            secureClient,
            url
        )
    )
    {
        Serial.println(
            "Could not initialise target request"
        );

        return false;
    }

    /*
     * Without this header the ngrok free tier answers browser-like
     * requests with an HTML interstitial instead of proxying, and
     * the sscanf below would then match fewer than three fields.
     */
    http.addHeader(
        "ngrok-skip-browser-warning",
        "true"
    );

    int statusCode = http.GET();

    if (statusCode != HTTP_CODE_OK)
    {
        Serial.print("Target request failed: ");
        Serial.println(statusCode);

        http.end();
        return false;
    }

    String response = http.getString();
    http.end();

    return parseTarget(response, target);
}

/*
 * Target response format:
 *
 *   trial_id,active,evidence_threshold,margin_threshold,n,f1,f2,...,fn
 *
 * The frequency count is variable, so this is scanned field by field
 * rather than with sscanf. Returning false leaves `target` untouched.
 */
bool parseTarget(
    const String &response,
    TargetState &target
)
{
    const char *cursor = response.c_str();
    char *end = nullptr;

    unsigned long trialId = strtoul(cursor, &end, 10);

    if (end == cursor || *end != ',')
    {
        Serial.print("Invalid target response: ");
        Serial.println(response);

        return false;
    }

    cursor = end + 1;
    long activeValue = strtol(cursor, &end, 10);

    if (end == cursor || *end != ',')
    {
        Serial.print("Invalid target response: ");
        Serial.println(response);

        return false;
    }

    cursor = end + 1;
    float evidenceThreshold = strtod(cursor, &end);

    if (end == cursor || *end != ',')
    {
        Serial.print("Invalid target response: ");
        Serial.println(response);

        return false;
    }

    cursor = end + 1;
    float marginThreshold = strtod(cursor, &end);

    if (end == cursor || *end != ',')
    {
        Serial.print("Invalid target response: ");
        Serial.println(response);

        return false;
    }

    cursor = end + 1;
    long count = strtol(cursor, &end, 10);

    if (end == cursor || count < 0)
    {
        Serial.print("Invalid target response: ");
        Serial.println(response);

        return false;
    }

    if (count > MAX_TARGETS)
    {
        // Decode as many as will fit rather than failing outright; the
        // server is told the real count in the result.
        Serial.print("Target set truncated to ");
        Serial.println(MAX_TARGETS);

        count = MAX_TARGETS;
    }

    float frequencies[MAX_TARGETS];

    for (int i = 0; i < count; i++)
    {
        if (*end != ',')
        {
            Serial.print("Target list too short: ");
            Serial.println(response);

            return false;
        }

        cursor = end + 1;
        frequencies[i] = strtod(cursor, &end);

        if (end == cursor)
        {
            Serial.print("Invalid frequency in: ");
            Serial.println(response);

            return false;
        }
    }

    /*
     * Optional trailing baselines, one per frequency. Absent on an older
     * server, in which case every baseline is zero and evidence is raw.
     */
    float baselines[MAX_TARGETS];

    for (int i = 0; i < count; i++)
    {
        baselines[i] = 0.0f;
    }

    for (int i = 0; i < count && *end == ','; i++)
    {
        cursor = end + 1;
        float value = strtod(cursor, &end);

        if (end == cursor)
        {
            break;
        }

        baselines[i] = value;
    }

    target.trialId = trialId;
    target.active = activeValue == 1;
    target.evidenceThreshold = evidenceThreshold;
    target.marginThreshold = marginThreshold;
    target.count = (int)count;

    for (int i = 0; i < count; i++)
    {
        target.hz[i] = frequencies[i];
        target.baselineDb[i] = baselines[i];
    }

    return true;
}

const char *jsonBoolean(bool value)
{
    return value ? "true" : "false";
}

// =========================================================
// Post result to Python server
// =========================================================

bool postResult(
    const TargetState &target,
    const DetectionResult &result,
    const ChannelStats &mainStats,
    const ChannelStats &artifactStats
)
{
    if (WiFi.status() != WL_CONNECTED)
    {
        return false;
    }

    HTTPClient http;

    String url =
        String(SERVER_BASE) +
        "/api/result";

    http.setTimeout(7000);

    if (
        !beginHttpRequest(
            http,
            plainClient,
            secureClient,
            url
        )
    )
    {
        Serial.println(
            "Could not initialise result request"
        );

        return false;
    }

    http.addHeader(
        "Content-Type",
        "application/json"
    );

    // See the note in fetchTarget().
    http.addHeader(
        "ngrok-skip-browser-warning",
        "true"
    );

    String json;

    // Grown for the per-target evidence and frequency arrays.
    json.reserve(1500);

    json = "{";

    json += "\"trial_id\":";
    json += String(target.trialId);

    json += ",\"target_hz\":";
    json += String(target.hz[0], 4);

    json += ",\"target_count\":";
    json += String(result.targetCount);

    json += ",\"best_index\":";
    json += String(result.bestIndex);

    json += ",\"best_hz\":";
    json += String(result.bestHz, 4);

    json += ",\"best_evidence_db\":";
    json += String(result.bestEvidenceDb, 4);

    json += ",\"best_margin_db\":";
    json += String(result.bestMarginDb, 4);

    json += ",\"evidence_db\":[";

    for (int i = 0; i < result.targetCount; i++)
    {
        if (i > 0)
        {
            json += ",";
        }

        json += String(result.evidenceDb[i], 4);
    }

    json += "]";

    json += ",\"baseline_db\":[";

    for (int i = 0; i < result.targetCount; i++)
    {
        if (i > 0)
        {
            json += ",";
        }

        json += String(target.baselineDb[i], 4);
    }

    json += "]";

    json += ",\"target_set_hz\":[";

    for (int i = 0; i < result.targetCount; i++)
    {
        if (i > 0)
        {
            json += ",";
        }

        json += String(target.hz[i], 4);
    }

    json += "]";

    json += ",\"evidence_threshold\":";
    json += String(target.evidenceThreshold, 4);

    json += ",\"margin_threshold\":";
    json += String(target.marginThreshold, 4);

    json += ",\"detected_hz\":";
    json += String(result.detectedHz, 4);

    json += ",\"score\":";
    json += String(result.scoreDb, 4);

    json += ",\"margin\":";
    json += String(result.marginDb, 4);

    json += ",\"p2p\":";
    json += String(result.mainPeakToPeak);

    json += ",\"confident\":";
    json += jsonBoolean(result.confident);

    json += ",\"match\":";
    json += jsonBoolean(result.match);

    json += ",\"target_score\":";
    json += String(
        result.scoreDb,
        4
    );

    json += ",\"main_fundamental_snr_db\":";
    json += String(
        result.mainFundamentalSnrDb,
        4
    );

    json += ",\"main_harmonic_snr_db\":";
    json += String(
        result.mainHarmonicSnrDb,
        4
    );

    json += ",\"artifact_target_score\":";
    json += String(
        result.artifactFundamentalSnrDb,
        4
    );

    json += ",\"artifact_fundamental_snr_db\":";
    json += String(
        result.artifactFundamentalSnrDb,
        4
    );

    json += ",\"artifact_harmonic_snr_db\":";
    json += String(
        result.artifactHarmonicSnrDb,
        4
    );

    // Explicit competitor evidence: the SNR of the *other* command
    // frequency in this same window. This is what lets the server
    // build separate positive/negative distributions per command.
    json += ",\"competitor_hz\":";
    json += String(
        result.competitorHz,
        4
    );

    json += ",\"competitor_evidence_db\":";
    json += String(
        result.competitorEvidenceDb,
        4
    );

    json += ",\"main_p2p\":";
    json += String(result.mainPeakToPeak);

    json += ",\"artifact_p2p\":";
    json += String(result.artifactPeakToPeak);

    json += ",\"main_clipped\":";
    json += String(result.mainClipped);

    json += ",\"artifact_clipped\":";
    json += String(result.artifactClipped);

    json += ",\"main_rms\":";
    json += String(mainStats.rms, 4);

    json += ",\"artifact_rms\":";
    json += String(artifactStats.rms, 4);

    json += ",\"main_difference_rms\":";
    json += String(
        mainStats.differenceRms,
        4
    );

    json += ",\"artifact_difference_rms\":";
    json += String(
        artifactStats.differenceRms,
        4
    );

    json += ",\"main_contact_good\":";
    json += jsonBoolean(
        result.mainContactGood
    );

    json += ",\"artifact_contact_good\":";
    json += jsonBoolean(
        result.artifactContactGood
    );

    json += ",\"signal_valid\":";
    json += jsonBoolean(
        result.signalValid
    );

    json += ",\"artifact_rejected\":";
    json += jsonBoolean(
        result.artifactRejected
    );

    json += ",\"source\":\"";
    json += result.source;
    json += "\"";

    json += ",\"reason\":\"";
    json += result.reason;
    json += "\"";

    json += "}";

    int statusCode = http.POST(json);

    if (statusCode <= 0)
    {
        Serial.print("Result POST failed: ");
        Serial.println(statusCode);

        http.end();
        return false;
    }

    Serial.print("Server response: ");
    Serial.println(http.getString());

    http.end();

    return (
        statusCode >= 200 &&
        statusCode < 300
    );
}

// =========================================================
// Signal initialization
// =========================================================

void initialiseWindow()
{
    for (int i = 0; i < SAMPLE_COUNT; i++)
    {
        windowValues[i] =
            0.54f -
            0.46f *
            cosf(
                2.0f *
                PI *
                i /
                (SAMPLE_COUNT - 1)
            );
    }
}

void waitUntilMicros(uint32_t targetTime)
{
    while ((int32_t)(micros() - targetTime) < 0)
    {
        delayMicroseconds(20);
    }
}

// =========================================================
// Channel statistics
// =========================================================

void resetChannelStats(ChannelStats &stats)
{
    stats.minimumRaw = 4095;
    stats.maximumRaw = 0;
    stats.clippedSamples = 0;

    stats.rms = 0.0f;
    stats.differenceRms = 0.0f;
}

void updateRawStats(
    ChannelStats &stats,
    int rawValue
)
{
    if (rawValue < stats.minimumRaw)
    {
        stats.minimumRaw = rawValue;
    }

    if (rawValue > stats.maximumRaw)
    {
        stats.maximumRaw = rawValue;
    }

    if (
        rawValue <= 20 ||
        rawValue >= 4075
    )
    {
        stats.clippedSamples++;
    }
}

void removeMean(float *values)
{
    float mean = 0.0f;

    for (int i = 0; i < SAMPLE_COUNT; i++)
    {
        mean += values[i];
    }

    mean /= SAMPLE_COUNT;

    for (int i = 0; i < SAMPLE_COUNT; i++)
    {
        values[i] -= mean;
    }
}

void calculateFilteredStats(
    const float *values,
    ChannelStats &stats
)
{
    float sumSquares = 0.0f;
    float differenceSquares = 0.0f;

    for (int i = 0; i < SAMPLE_COUNT; i++)
    {
        sumSquares +=
            values[i] *
            values[i];

        if (i > 0)
        {
            float difference =
                values[i] -
                values[i - 1];

            differenceSquares +=
                difference *
                difference;
        }
    }

    stats.rms =
        sqrtf(
            sumSquares /
            SAMPLE_COUNT
        );

    stats.differenceRms =
        sqrtf(
            differenceSquares /
            (SAMPLE_COUNT - 1)
        );
}

// =========================================================
// 50 Hz notch filter
// =========================================================

void configureNotch(
    Biquad &filter,
    float notchFrequency,
    float q
)
{
    float omega =
        2.0f *
        PI *
        notchFrequency /
        SAMPLE_RATE;

    float cosine = cosf(omega);

    float alpha =
        sinf(omega) /
        (2.0f * q);

    float a0 =
        1.0f + alpha;

    filter.b0 =
        1.0f / a0;

    filter.b1 =
        (-2.0f * cosine) / a0;

    filter.b2 =
        1.0f / a0;

    filter.a1 =
        (-2.0f * cosine) / a0;

    filter.a2 =
        (1.0f - alpha) / a0;

    filter.z1 = 0.0f;
    filter.z2 = 0.0f;
}

float processBiquad(
    Biquad &filter,
    float input
)
{
    float output =
        filter.b0 * input +
        filter.z1;

    filter.z1 =
        filter.b1 * input -
        filter.a1 * output +
        filter.z2;

    filter.z2 =
        filter.b2 * input -
        filter.a2 * output;

    return output;
}

// =========================================================
// Dual-channel sampling
// =========================================================

void collectSamples(
    ChannelStats &mainStats,
    ChannelStats &artifactStats
)
{
    resetChannelStats(mainStats);
    resetChannelStats(artifactStats);

    const float deltaTime =
        1.0f / SAMPLE_RATE;

    const float highPassRC =
        1.0f /
        (
            2.0f *
            PI *
            HIGH_PASS_HZ
        );

    const float lowPassRC =
        1.0f /
        (
            2.0f *
            PI *
            LOW_PASS_HZ
        );

    const float highPassAlpha =
        highPassRC /
        (highPassRC + deltaTime);

    const float lowPassAlpha =
        deltaTime /
        (lowPassRC + deltaTime);

    float previousMain =
        analogRead(MAIN_EEG_PIN);

    float previousArtifact =
        analogRead(ARTIFACT_PIN);

    float highPassMain = 0.0f;
    float lowPassMain = 0.0f;

    float highPassArtifact = 0.0f;
    float lowPassArtifact = 0.0f;

    Biquad mainNotch;
    Biquad artifactNotch;

    configureNotch(
        mainNotch,
        NOTCH_FREQUENCY_HZ,
        NOTCH_Q
    );

    configureNotch(
        artifactNotch,
        NOTCH_FREQUENCY_HZ,
        NOTCH_Q
    );

    uint32_t nextSampleTime = micros();

    const int totalSamples =
        WARMUP_SAMPLES +
        SAMPLE_COUNT;

    for (int i = 0; i < totalSamples; i++)
    {
        waitUntilMicros(nextSampleTime);

        nextSampleTime +=
            SAMPLE_PERIOD_US;

        int rawMain =
            analogRead(MAIN_EEG_PIN);

        int rawArtifact =
            analogRead(ARTIFACT_PIN);

        // Main EEG filtering.

        highPassMain =
            highPassAlpha *
            (
                highPassMain +
                rawMain -
                previousMain
            );

        previousMain = rawMain;

        float notchedMain =
            processBiquad(
                mainNotch,
                highPassMain
            );

        lowPassMain +=
            lowPassAlpha *
            (
                notchedMain -
                lowPassMain
            );

        // Artifact-channel filtering.

        highPassArtifact =
            highPassAlpha *
            (
                highPassArtifact +
                rawArtifact -
                previousArtifact
            );

        previousArtifact = rawArtifact;

        float notchedArtifact =
            processBiquad(
                artifactNotch,
                highPassArtifact
            );

        lowPassArtifact +=
            lowPassAlpha *
            (
                notchedArtifact -
                lowPassArtifact
            );

        if (i >= WARMUP_SAMPLES)
        {
            int sampleIndex =
                i - WARMUP_SAMPLES;

            mainSamples[sampleIndex] =
                lowPassMain;

            artifactSamples[sampleIndex] =
                lowPassArtifact;

            updateRawStats(
                mainStats,
                rawMain
            );

            updateRawStats(
                artifactStats,
                rawArtifact
            );
        }
    }

    removeMean(mainSamples);
    removeMean(artifactSamples);

    calculateFilteredStats(
        mainSamples,
        mainStats
    );

    calculateFilteredStats(
        artifactSamples,
        artifactStats
    );
}

// =========================================================
// Goertzel frequency analysis
// =========================================================

float powerAtFrequency(
    const float *values,
    float frequency
)
{
    if (
        frequency <= 0.0f ||
        frequency >= SAMPLE_RATE / 2.0f
    )
    {
        return 0.0f;
    }

    float omega =
        2.0f *
        PI *
        frequency /
        SAMPLE_RATE;

    float coefficient =
        2.0f * cosf(omega);

    float previous = 0.0f;
    float previous2 = 0.0f;

    for (int i = 0; i < SAMPLE_COUNT; i++)
    {
        float input =
            values[i] *
            windowValues[i];

        float current =
            input +
            coefficient * previous -
            previous2;

        previous2 = previous;
        previous = current;
    }

    float power =
        previous2 * previous2 +
        previous * previous -
        coefficient *
        previous *
        previous2;

    return power > 0.0f
        ? power
        : 0.0f;
}

float localSnrDb(
    const float *values,
    float frequency
)
{
    if (
        frequency <= 2.0f ||
        frequency >= SAMPLE_RATE / 2.0f - 2.0f
    )
    {
        return -30.0f;
    }

    float signalPower =
        powerAtFrequency(
            values,
            frequency
        );

    const float offsets[] = {
        -1.25f,
        -1.00f,
        -0.75f,
         0.75f,
         1.00f,
         1.25f
    };

    float noisePower = 0.0f;

    for (float offset : offsets)
    {
        noisePower +=
            powerAtFrequency(
                values,
                frequency + offset
            );
    }

    noisePower /=
        sizeof(offsets) /
        sizeof(offsets[0]);

    float snrDb =
        10.0f *
        log10f(
            (signalPower + 1.0f) /
            (noisePower + 1.0f)
        );

    if (snrDb > 30.0f)
    {
        snrDb = 30.0f;
    }

    if (snrDb < -30.0f)
    {
        snrDb = -30.0f;
    }

    return snrDb;
}

// =========================================================
// Detection
// =========================================================

/*
 * Evidence for one frequency on one channel: the better of the
 * fundamental and the penalised second harmonic. The harmonic is only
 * consulted when it survives the low-pass.
 */
float evidenceAt(
    const float *values,
    float frequency,
    float *fundamentalOut,
    float *harmonicOut
)
{
    float fundamental =
        localSnrDb(
            values,
            frequency
        );

    float harmonicHz =
        frequency * 2.0f;

    float harmonic = -30.0f;

    if (harmonicHz <= LOW_PASS_HZ)
    {
        harmonic =
            localSnrDb(
                values,
                harmonicHz
            );
    }

    if (fundamentalOut != nullptr)
    {
        *fundamentalOut = fundamental;
    }

    if (harmonicOut != nullptr)
    {
        *harmonicOut = harmonic;
    }

    return fmaxf(
        fundamental,
        harmonic - HARMONIC_PENALTY_DB
    );
}

DetectionResult analyseSamples(
    const TargetState &target,
    const ChannelStats &mainStats,
    const ChannelStats &artifactStats
)
{
    const int count = target.count;

    const float evidenceThreshold =
        target.evidenceThreshold;

    const float marginThreshold =
        target.marginThreshold;

    float evidence[MAX_TARGETS];

    float mainFundamentalSnrDb = -30.0f;
    float mainHarmonicSnrDb = -30.0f;

    for (int i = 0; i < count; i++)
    {
        float fundamental = -30.0f;
        float harmonic = -30.0f;

        evidence[i] =
            evidenceAt(
                mainSamples,
                target.hz[i],
                &fundamental,
                &harmonic
            )
            - target.baselineDb[i];

        // Index 0 is the cued target; its component SNRs are reported
        // separately so the server can see which one carried the trial.
        if (i == 0)
        {
            mainFundamentalSnrDb = fundamental;
            mainHarmonicSnrDb = harmonic;
        }
    }

    const char *source =
        mainFundamentalSnrDb >=
            (mainHarmonicSnrDb - HARMONIC_PENALTY_DB)
        ? "fundamental"
        : "second_harmonic";

    // Artifact channel, evaluated at the cued frequency only. A genuine
    // SSVEP should not appear here; if it does, the "artifact" electrode
    // is picking up occipital signal and the montage is wrong.
    float artifactFundamentalSnrDb = -30.0f;
    float artifactHarmonicSnrDb = -30.0f;

    evidenceAt(
        artifactSamples,
        target.hz[0],
        &artifactFundamentalSnrDb,
        &artifactHarmonicSnrDb
    );

    // Winner across the whole set.
    int bestIndex = 0;

    for (int i = 1; i < count; i++)
    {
        if (evidence[i] > evidence[bestIndex])
        {
            bestIndex = i;
        }
    }

    int secondIndex = -1;

    for (int i = 0; i < count; i++)
    {
        if (i == bestIndex)
        {
            continue;
        }

        if (
            secondIndex < 0 ||
            evidence[i] > evidence[secondIndex]
        )
        {
            secondIndex = i;
        }
    }

    float bestEvidenceDb = evidence[bestIndex];

    /*
     * With a single target there is nothing to be better than, so margin
     * is not meaningful; report a large value and let the evidence
     * threshold alone decide. This is the dwell case (a lone HELP tile).
     */
    float bestMarginDb =
        secondIndex >= 0
        ? bestEvidenceDb - evidence[secondIndex]
        : 60.0f;

    // Strongest competitor to the *cued* target, which is what the
    // calibration profile is built from.
    int competitorIndex = -1;

    for (int i = 1; i < count; i++)
    {
        if (
            competitorIndex < 0 ||
            evidence[i] > evidence[competitorIndex]
        )
        {
            competitorIndex = i;
        }
    }

    float targetEvidenceDb = evidence[0];

    float competitorHz =
        competitorIndex >= 0
        ? target.hz[competitorIndex]
        : 0.0f;

    float competitorEvidenceDb =
        competitorIndex >= 0
        ? evidence[competitorIndex]
        : -30.0f;

    // Signed, exactly as before: negative means a competitor won.
    float targetMarginDb =
        competitorIndex >= 0
        ? targetEvidenceDb - competitorEvidenceDb
        : 60.0f;

    int mainPeakToPeak =
        mainStats.maximumRaw -
        mainStats.minimumRaw;

    int artifactPeakToPeak =
        artifactStats.maximumRaw -
        artifactStats.minimumRaw;

    bool mainClipped =
        mainStats.clippedSamples >
        MAX_MAIN_CLIPPED_SAMPLES;

    bool artifactClipped =
        artifactStats.clippedSamples >
        MAX_ARTIFACT_CLIPPED_SAMPLES;

    bool mainP2pGood =
        mainPeakToPeak >=
            MIN_MAIN_VALID_P2P &&
        mainPeakToPeak <=
            MAX_MAIN_VALID_P2P;

    bool artifactP2pGood =
        artifactPeakToPeak >=
            MIN_ARTIFACT_VALID_P2P &&
        artifactPeakToPeak <=
            MAX_ARTIFACT_VALID_P2P;

    bool mainRmsGood =
        mainStats.rms >=
            MIN_FILTERED_RMS &&
        mainStats.rms <=
            MAX_MAIN_FILTERED_RMS;

    bool artifactRmsGood =
        artifactStats.rms >=
            MIN_FILTERED_RMS &&
        artifactStats.rms <=
            MAX_ARTIFACT_FILTERED_RMS;

    bool mainContactGood =
        !mainClipped &&
        mainP2pGood &&
        mainRmsGood &&
        mainStats.minimumRaw > 20 &&
        mainStats.maximumRaw < 4075;

    bool artifactContactGood =
        !artifactClipped &&
        artifactP2pGood &&
        artifactRmsGood &&
        artifactStats.minimumRaw > 20 &&
        artifactStats.maximumRaw < 4075;

    bool artifactBurst =
        artifactContactGood &&
        (
            artifactStats.rms > ARTIFACT_BURST_RMS ||
            artifactPeakToPeak > ARTIFACT_BURST_P2P
        );

    bool signalValid =
        mainContactGood &&
        artifactContactGood;

    bool artifactRejected =
        artifactBurst;

    /*
     * A selection is committed when the winner clears both thresholds.
     * `match` additionally requires the winner to be the cued target,
     * which is what calibration and validation score against.
     */
    bool confident =
        signalValid &&
        !artifactRejected &&
        bestEvidenceDb >= evidenceThreshold &&
        bestMarginDb >= marginThreshold;

    bool targetMatch =
        confident &&
        bestIndex == 0;

    // Always report the strongest frequency, confident or not; the
    // server decides what to do with a low-confidence answer.
    float displayedFrequency = target.hz[bestIndex];

    const char *reason =
        "LOW_CONFIDENCE";

    if (!mainContactGood)
    {
        reason =
            "CHECK_MAIN_ELECTRODES";
    }
    else if (!artifactContactGood)
    {
        reason =
            "CHECK_ARTIFACT_ELECTRODES";
    }
    else if (artifactBurst)
    {
        reason =
            "ARTIFACT_REJECTED";
    }
    else if (targetMatch)
    {
        reason =
            "MATCH";
    }
    else if (confident)
    {
        reason =
            "NO_MATCH";
    }

    DetectionResult result;

    result.detectedHz =
        displayedFrequency;

    result.scoreDb =
        targetEvidenceDb;

    result.marginDb =
        targetMarginDb;

    result.targetCount = count;
    result.bestIndex = bestIndex;
    result.bestHz = target.hz[bestIndex];
    result.bestEvidenceDb = bestEvidenceDb;
    result.bestMarginDb = bestMarginDb;

    for (int i = 0; i < MAX_TARGETS; i++)
    {
        result.evidenceDb[i] =
            i < count
            ? evidence[i]
            : -30.0f;
    }

    result.mainFundamentalSnrDb =
        mainFundamentalSnrDb;

    result.mainHarmonicSnrDb =
        mainHarmonicSnrDb;

    result.artifactFundamentalSnrDb =
        artifactFundamentalSnrDb;

    result.artifactHarmonicSnrDb =
        artifactHarmonicSnrDb;

    result.competitorHz =
        competitorHz;

    result.competitorEvidenceDb =
        competitorEvidenceDb;

    result.mainPeakToPeak =
        mainPeakToPeak;

    result.artifactPeakToPeak =
        artifactPeakToPeak;

    result.mainClipped =
        mainStats.clippedSamples;

    result.artifactClipped =
        artifactStats.clippedSamples;

    result.mainContactGood =
        mainContactGood;

    result.artifactContactGood =
        artifactContactGood;

    result.signalValid =
        signalValid;

    result.artifactRejected =
        artifactRejected;

    result.confident =
        confident;

    result.match =
        targetMatch;

    result.source =
        source;

    result.reason =
        reason;

    return result;
}

// =========================================================
// Serial output
// =========================================================

void printResult(
    const TargetState &target,
    const ChannelStats &mainStats,
    const ChannelStats &artifactStats,
    const DetectionResult &result
)
{
    Serial.println();

    Serial.print("Cued: ");
    Serial.print(target.hz[0], 2);

    Serial.print(" Hz | Winner: ");
    Serial.print(result.bestHz, 2);

    Serial.print(" Hz (#");
    Serial.print(result.bestIndex);

    Serial.print(" of ");
    Serial.print(result.targetCount);

    Serial.print(") | Evidence: ");
    Serial.print(result.bestEvidenceDb, 2);

    Serial.print(" dB | Margin: ");
    Serial.print(result.bestMarginDb, 2);

    Serial.println(" dB");

    Serial.print("Cued evidence: ");
    Serial.print(result.scoreDb, 2);

    Serial.print(" dB | Cued margin: ");
    Serial.print(result.marginDb, 2);

    Serial.println(" dB");

    Serial.print("Set |");

    for (int i = 0; i < result.targetCount; i++)
    {
        Serial.print(" ");
        Serial.print(target.hz[i], 2);

        Serial.print("Hz:");
        Serial.print(result.evidenceDb[i], 1);

        Serial.print(i == result.bestIndex ? "* |" : " |");
    }

    Serial.println();

    Serial.print("Thresholds | Evidence>=");
    Serial.print(target.evidenceThreshold, 2);

    Serial.print(" dB | Margin>=");
    Serial.print(target.marginThreshold, 2);

    Serial.println(" dB");

    Serial.print("Main fundamental: ");
    Serial.print(
        result.mainFundamentalSnrDb,
        2
    );

    Serial.print(" dB | Main 2f: ");
    Serial.print(
        result.mainHarmonicSnrDb,
        2
    );

    Serial.print(" dB | Source: ");
    Serial.println(result.source);

    Serial.print("Competitor ");
    Serial.print(result.competitorHz, 1);

    Serial.print(" Hz evidence: ");
    Serial.print(result.competitorEvidenceDb, 2);

    Serial.println(" dB");

    Serial.print("Artifact fundamental: ");
    Serial.print(
        result.artifactFundamentalSnrDb,
        2
    );

    Serial.print(" dB | Artifact 2f: ");
    Serial.print(
        result.artifactHarmonicSnrDb,
        2
    );

    Serial.println(" dB");

    Serial.print("MAIN MIN:");
    Serial.print(mainStats.minimumRaw);

    Serial.print(" MAX:");
    Serial.print(mainStats.maximumRaw);

    Serial.print(" P2P:");
    Serial.print(result.mainPeakToPeak);

    Serial.print(" CLIP:");
    Serial.print(result.mainClipped);

    Serial.print(" RMS:");
    Serial.print(mainStats.rms, 1);

    Serial.print(" dRMS:");
    Serial.println(
        mainStats.differenceRms,
        1
    );

    Serial.print("ART  MIN:");
    Serial.print(artifactStats.minimumRaw);

    Serial.print(" MAX:");
    Serial.print(artifactStats.maximumRaw);

    Serial.print(" P2P:");
    Serial.print(result.artifactPeakToPeak);

    Serial.print(" CLIP:");
    Serial.print(result.artifactClipped);

    Serial.print(" RMS:");
    Serial.print(artifactStats.rms, 1);

    Serial.print(" dRMS:");
    Serial.println(
        artifactStats.differenceRms,
        1
    );

    Serial.print("CONTACT | Main:");
    Serial.print(
        result.mainContactGood
        ? "GOOD"
        : "CHECK"
    );

    Serial.print(" | Artifact:");
    Serial.println(
        result.artifactContactGood
        ? "GOOD"
        : "CHECK"
    );

    Serial.print("RESULT: ");
    Serial.println(result.reason);
}

// =========================================================
// Setup
// =========================================================

void setup()
{
    Serial.begin(115200);
    delay(1000);

    pinMode(MAIN_EEG_PIN, INPUT);
    pinMode(ARTIFACT_PIN, INPUT);

    analogReadResolution(12);

    analogSetPinAttenuation(
        MAIN_EEG_PIN,
        ADC_11db
    );

    analogSetPinAttenuation(
        ARTIFACT_PIN,
        ADC_11db
    );

    initialiseWindow();

    Serial.println();
    Serial.println(
        "Dual-channel SSVEP detector"
    );

    Serial.println(
        "Main EEG channel: GPIO 35"
    );

    Serial.println(
        "Artifact channel: GPIO 34"
    );

    Serial.print("Sampling rate: ");
    Serial.print(SAMPLE_RATE);
    Serial.println(" Hz");

    // Derived, not hardcoded: this banner previously claimed 4 seconds while
    // the window was actually 8.
    Serial.print("Recording window: ");
    Serial.print(RECORD_SECONDS);
    Serial.print(" s (+ ");
    Serial.print(WARMUP_SECONDS);
    Serial.println(" s warm-up)");

    Serial.println(
        "Filters: 3 Hz HPF, 50 Hz notch, 35 Hz LPF"
    );

    Serial.print(
        "Decision frequencies: supplied per-trial by the server, up to "
    );
    Serial.println(MAX_TARGETS);

    Serial.println(
        "Evidence/margin thresholds are fetched per-trial "
        "from the server's calibration profile."
    );

    Serial.print("Server: ");
    Serial.println(SERVER_BASE);

    Serial.println();

    connectWiFi();
}

// =========================================================
// Main loop
// =========================================================

void loop()
{
    if (WiFi.status() != WL_CONNECTED)
    {
        connectWiFi();

        if (WiFi.status() != WL_CONNECTED)
        {
            delay(2000);
            return;
        }
    }

    TargetState target;

    if (!fetchTarget(target))
    {
        consecutiveFailures++;

        /*
         * The radio can report a healthy association while the connection
         * is unusable, so repeated request failures -- not link status --
         * are what trigger recovery.
         */
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES)
        {
            Serial.print(consecutiveFailures);
            Serial.println(
                " consecutive request failures; rebuilding the connection"
            );

            resetWiFiRadio();
            connectWiFi();

            consecutiveFailures = 0;
        }

        delay(1000);
        return;
    }

    consecutiveFailures = 0;

    if (
        !target.active ||
        target.count < MIN_TARGETS
    )
    {
        delay(300);
        return;
    }

    // Record once for each frontend trial.
    if (
        target.trialId ==
        lastProcessedTrialId
    )
    {
        delay(250);
        return;
    }

    Serial.println();

    Serial.print("Recording trial ");
    Serial.print(target.trialId);

    Serial.print(" - ");
    Serial.print(target.count);

    Serial.print(" target(s), cued ");
    Serial.print(target.hz[0], 3);

    Serial.println(" Hz");

    ChannelStats mainStats;
    ChannelStats artifactStats;

    collectSamples(
        mainStats,
        artifactStats
    );

    /*
     * Ensure that the frontend did not stop or move
     * to another frequency during recording.
     */
    TargetState currentTarget;

    if (!fetchTarget(currentTarget))
    {
        Serial.println(
            "Could not verify current trial"
        );

        delay(500);
        return;
    }

    if (
        !currentTarget.active ||
        currentTarget.trialId !=
            target.trialId
    )
    {
        Serial.println(
            "Trial changed during recording; "
            "discarding block"
        );

        delay(250);
        return;
    }

    DetectionResult result =
        analyseSamples(
            target,
            mainStats,
            artifactStats
        );

    printResult(
        target,
        mainStats,
        artifactStats,
        result
    );

    if (
        postResult(
            target,
            result,
            mainStats,
            artifactStats
        )
    )
    {
        lastProcessedTrialId =
            target.trialId;
    }
    else
    {
        Serial.println(
            "Result was not posted; "
            "trial may be retried"
        );
    }
}
