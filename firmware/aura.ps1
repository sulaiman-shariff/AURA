<#
.SYNOPSIS
    Build / flash / monitor helper for the AURA SSVEP firmware.

.DESCRIPTION
    Wraps the arduino-cli that ships inside Arduino IDE 2.x, so the ESP32 can be
    driven without opening the IDE. The ESP32 core (esp32:esp32) installed by the
    IDE is reused as-is; no separate arduino-cli config is needed.

    Commands:
      build   [-ServerBase <url>]   compile the sketch
      flash   [-ServerBase <url>]   compile, then upload to the board
      monitor                       tail the serial output into serial.log
      serve                         run the Flask server on port 5000
      tunnel  [-Domain <domain>]    expose port 5000 through ngrok
      url                           print the public URL of a running tunnel

.EXAMPLE
    .\aura.ps1 flash -ServerBase "https://mellow-hen-1234.ngrok-free.app"
    .\aura.ps1 monitor
#>

param(
    [Parameter(Position = 0)]
    [ValidateSet("build", "flash", "monitor", "serve", "tunnel", "url")]
    [string]$Command = "build",

    # Overrides AURA_SERVER_BASE at compile time. Defaults to whatever the
    # sketch itself declares.
    [string]$ServerBase = "",

    [string]$Domain = "",

    [string]$Port = "COM4"
)

$ErrorActionPreference = "Stop"

$CLI = "$env:LOCALAPPDATA\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe"
$NGROK = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe\ngrok.exe"

$FQBN = "esp32:esp32:esp32"
$SKETCH = Join-Path $PSScriptRoot "aura_ssvep"
$BUILD = Join-Path $PSScriptRoot ".build"
$PROJECT = Split-Path $PSScriptRoot -Parent

function Get-BuildArgs {
    # --build-path keeps a warm object cache: the first ESP32 build with WiFi
    # and TLS takes minutes, subsequent ones seconds.
    $buildArgs = @("--fqbn", $FQBN, "--build-path", $BUILD)

    if ($ServerBase -ne "") {
        $escaped = '\"' + $ServerBase + '\"'
        $buildArgs += @(
            "--build-property",
            "compiler.cpp.extra_flags=-DAURA_SERVER_BASE=$escaped"
        )
    }

    return $buildArgs
}

function Stop-Monitor {
    # COM4 can only be held by one process, so any monitor must let go before
    # an upload can claim the port.
    # Match on the command line, not the image name: the Windows Store Python
    # launcher reports itself as python3.13.exe rather than python.exe.
    Get-CimInstance Win32_Process |
        Where-Object {
            $_.CommandLine -like "*monitor.py*" -and $_.Name -like "python*"
        } |
        ForEach-Object {
            Write-Host "Stopping serial monitor (PID $($_.ProcessId))"
            Stop-Process -Id $_.ProcessId -Force
        }
}

switch ($Command) {
    "build" {
        & $CLI compile @(Get-BuildArgs) $SKETCH
    }

    "flash" {
        & $CLI compile @(Get-BuildArgs) $SKETCH
        if (-not $?) { exit 1 }

        Stop-Monitor
        & $CLI upload -p $Port --fqbn $FQBN --input-dir $BUILD $SKETCH
    }

    "monitor" {
        python (Join-Path $PSScriptRoot "monitor.py") --port $Port
    }

    "serve" {
        python (Join-Path $PROJECT "main.py")
    }

    "tunnel" {
        if ($Domain -ne "") {
            & $NGROK http 5000 --domain=$Domain --log=stdout --log-format=logfmt
        }
        else {
            & $NGROK http 5000 --log=stdout --log-format=logfmt
        }
    }

    "url" {
        $tunnels = Invoke-RestMethod "http://127.0.0.1:4040/api/tunnels"
        $tunnels.tunnels | ForEach-Object { "$($_.public_url) -> $($_.config.addr)" }
    }
}
