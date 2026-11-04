#!/usr/bin/env bash
# Usage: run-reconnect.sh <label> <apk> <flaky|normal> <seconds>
# Needs a Gateway on 127.0.0.1:18789 (auth none, loopback), the emulator running, and the device already approved.
# <seconds> = how long to watch after the first connect request reaches the proxy.
set -u
export PATH="/c/Users/jondi/AppData/Local/Android/Sdk/platform-tools:/c/Users/jondi/AppData/Roaming/fnm/node-versions/v24.22.1/installation:$PATH"
D=/c/Users/jondi/Documents/Coding/app-review-fixes/android-reconnect-backoff
LABEL=$1; APK=$2; MODE=$3; SECS=$4
PKG=ai.openclaw.app.debug
LOG=$D/proxy-$LABEL.log
: > "$LOG"
adb reverse tcp:18790 tcp:18790 >/dev/null
adb install -r -g "$APK" >/dev/null
adb shell am force-stop $PKG
adb logcat -c
MODE=$MODE LOG=$LOG node $D/flaky-proxy.cjs & PROXY=$!
sleep 1
(MSYS2_ARG_CONV_EXCL="*" adb shell screenrecord --time-limit 175 /sdcard/rec.mp4 &) ; sleep 1
adb shell am start -n $PKG/ai.openclaw.app.MainActivity >/dev/null
sleep 5
adb shell run-as $PKG am broadcast --user 0 -a $PKG.RUN_VOICE_E2E -n $PKG/ai.openclaw.app.VoiceE2eReceiver \
  --es mode connect --es host 127.0.0.1 --ei port 18790 --el connectTimeoutMs 120000 >/dev/null
for i in $(seq 1 150); do grep -q CONNECT "$LOG" && break; sleep 1; done
sleep "$SECS"
adb exec-out screencap -p > "$D/screen-$LABEL.png"
MSYS2_ARG_CONV_EXCL="*" adb shell pkill -INT screenrecord; sleep 3; MSYS2_ARG_CONV_EXCL="*" adb pull /sdcard/rec.mp4 "$(cygpath -w $D/rec-$LABEL.mp4)" >/dev/null 2>&1
kill $PROXY 2>/dev/null
adb logcat -d | grep -iE "openclaw|GatewaySession|Gateway" > "$D/logcat-$LABEL.txt"
echo "== $LABEL ($MODE, watched ${SECS}s after first connect): connect requests = $(grep -c CONNECT "$LOG")"
