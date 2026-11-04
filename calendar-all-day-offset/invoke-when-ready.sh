#!/usr/bin/env bash
# Usage: invoke-when-ready.sh <label>
# Starts the installed app, connects it to the Gateway (debug hook), waits until the node shows "connected",
# then sends calendar.add from the Gateway CLI and reads the stored event back from the emulator calendar.
set -u
export PATH="/c/Users/jondi/AppData/Roaming/fnm/node-versions/v24.22.1/installation:/c/Users/jondi/AppData/Local/Android/Sdk/platform-tools:$PATH"
export OPENCLAW_STATE_DIR=C:/ocs/state OPENCLAW_HOME=C:/ocs OPENCLAW_CONFIG_PATH=C:/ocs/openclaw.json
C=/c/Users/jondi/Documents/Coding/app-review-fixes/android-calendar-all-day-offset
LABEL=$1; PKG=ai.openclaw.app.debug; NODE=04773cc8baa679e56323c6b33678ea4e75faa009adee91515e932913cd455730
OUT=$C/result-$LABEL.txt; : > "$OUT"
say() { echo "$*" | tee -a "$OUT"; }
adb reverse tcp:18790 tcp:18789 >/dev/null
adb shell "content delete --uri content://com.android.calendar/events --where \"title='OffsetHoliday'\"" >/dev/null 2>&1
adb shell am force-stop $PKG
adb shell am start -n $PKG/ai.openclaw.app.MainActivity >/dev/null
sleep 6
adb shell run-as $PKG am broadcast --user 0 -a $PKG.RUN_VOICE_E2E -n $PKG/ai.openclaw.app.VoiceE2eReceiver \
  --es mode connect --es host 127.0.0.1 --ei port 18790 --el connectTimeoutMs 600000 >/dev/null
cd /c/oc-a
for i in $(seq 1 120); do
  timeout 60 pnpm openclaw nodes describe --node $NODE 2>&1 | grep -q "paired · connected" && break
  sleep 5
done
say "apk installed: $(adb shell dumpsys package $PKG | grep -m1 lastUpdateTime)"
PARAMS='{"title":"OffsetHoliday","startISO":"2026-07-05T00:00:00+10:00","endISO":"2026-07-06T00:00:00+10:00","isAllDay":true}'
say "calendar.add params: $PARAMS"
say "$(timeout 90 pnpm openclaw nodes invoke --node $NODE --command calendar.add --params "$PARAMS" --json 2>&1 | tail -22)"
Q=$(adb shell "content query --uri content://com.android.calendar/events --projection title:dtstart:dtend:allDay")
say "stored event: $Q"
for ms in $(echo "$Q" | sed -n 's/.*dtstart=\([0-9]*\).*/\1/p'); do say "dtstart $ms = $(date -u -d @$((ms/1000)) '+%Y-%m-%d %H:%M UTC')"; done
adb exec-out screencap -p > "$C/screen-$LABEL.png"
echo DONE >> "$OUT"
