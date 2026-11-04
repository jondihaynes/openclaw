#!/usr/bin/env bash
# Usage: prep-media.sh <label> <apk> <slow|stall>
# Installs the APK, starts the media proxy in front of the real Gateway, starts the app and connects it.
# The file attachment then shows up in Chat and a tap on it starts the real download.
set -u
export PATH="/c/Users/jondi/AppData/Local/Android/Sdk/platform-tools:/c/Users/jondi/AppData/Roaming/fnm/node-versions/v24.22.1/installation:$PATH"
MD=/c/Users/jondi/Documents/Coding/app-review-fixes/android-media-download-timeout
LABEL=$1; APK=$2; MODE=$3; PKG=ai.openclaw.app.debug
for p in $(netstat -ano | grep ":18790.*LISTENING" | awk '{print $5}' | sort -u); do taskkill //F //PID $p >/dev/null; done
adb reverse tcp:18790 tcp:18790 >/dev/null
adb install -r -g "$APK" >/dev/null
adb shell am force-stop $PKG
: > "$MD/proxy-$LABEL.log"
MODE=$MODE LOG="$MD/proxy-$LABEL.log" node "$MD/media-proxy.cjs" &
sleep 1
adb shell run-as $PKG rm -f cache/voice_e2e_result.json
adb shell am start -n $PKG/ai.openclaw.app.MainActivity >/dev/null
sleep 8
adb shell run-as $PKG am broadcast --user 0 -a $PKG.RUN_VOICE_E2E -n $PKG/ai.openclaw.app.VoiceE2eReceiver \
  --es mode connect --es host 127.0.0.1 --ei port 18790 --el connectTimeoutMs 600000 >/dev/null
for i in $(seq 1 200); do adb shell run-as $PKG cat cache/voice_e2e_result.json 2>/dev/null | grep -q '"ok"' && break; sleep 3; done
adb shell run-as $PKG cat cache/voice_e2e_result.json
echo
echo PREP-DONE
wait
