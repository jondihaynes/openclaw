#!/usr/bin/env bash
# Usage: run-calendar.sh <label> <apk>
# Real app, real Gateway (no proxy): the Gateway CLI sends calendar.add to the paired Android app,
# the app writes the event into the emulator's calendar provider, and we read the stored event back.
set -u
export PATH="/c/Users/jondi/AppData/Local/Android/Sdk/platform-tools:/c/Users/jondi/AppData/Roaming/fnm/node-versions/v24.22.1/installation:$PATH"
export OPENCLAW_STATE_DIR=C:/ocs/state OPENCLAW_HOME=C:/ocs OPENCLAW_CONFIG_PATH=C:/ocs/openclaw.json
C=/c/Users/jondi/Documents/Coding/app-review-fixes/android-calendar-all-day-offset
LABEL=$1; APK=$2
PKG=ai.openclaw.app.debug
OUT=$C/result-$LABEL.txt
: > "$OUT"
say() { echo "$*" | tee -a "$OUT"; }
adb reverse tcp:18790 tcp:18789 >/dev/null
adb install -r -g "$APK" >/dev/null
adb shell am force-stop $PKG
adb shell pm grant $PKG android.permission.READ_CALENDAR
adb shell pm grant $PKG android.permission.WRITE_CALENDAR
# A local calendar the app can write to (the emulator image has no account).
if ! adb shell content query --uri content://com.android.calendar/calendars --projection _id:account_type | grep -q LOCAL; then
  adb shell "content insert --uri 'content://com.android.calendar/calendars?caller_is_syncadapter=true&account_name=proof&account_type=LOCAL' --bind account_name:s:proof --bind account_type:s:LOCAL --bind name:s:proof --bind calendar_displayName:s:Proof --bind calendar_color:i:-16776961 --bind calendar_access_level:i:700 --bind visible:i:1 --bind sync_events:i:1 --bind ownerAccount:s:proof --bind calendar_timezone:s:UTC"
fi
adb shell "content delete --uri content://com.android.calendar/events --where \"title='OffsetHoliday'\"" >/dev/null 2>&1
adb shell run-as $PKG rm -f cache/voice_e2e_result.json
adb shell am start -n $PKG/ai.openclaw.app.MainActivity >/dev/null
sleep 5
adb shell run-as $PKG am broadcast --user 0 -a $PKG.RUN_VOICE_E2E -n $PKG/ai.openclaw.app.VoiceE2eReceiver \
  --es mode connect --es host 127.0.0.1 --ei port 18790 --el connectTimeoutMs 300000 >/dev/null
for i in $(seq 1 110); do adb shell run-as $PKG cat cache/voice_e2e_result.json 2>/dev/null | grep -q '"ok"' && break; sleep 3; done
say "app connect result: $(adb shell run-as $PKG cat cache/voice_e2e_result.json)"
cd /c/oc-a
PARAMS='{"title":"OffsetHoliday","startISO":"2026-07-05T00:00:00+10:00","endISO":"2026-07-06T00:00:00+10:00","isAllDay":true}'
say "params: $PARAMS"
for ID in 04773cc8baa679e56323c6b33678ea4e75faa009adee91515e932913cd455730 323ec0bcd880b450872aa8bbe375840a09924f0d9f271f24381544b4a6ba35d7; do
  R=$(timeout 90 pnpm openclaw nodes invoke --node $ID --command calendar.add --params "$PARAMS" --json 2>&1 | tail -15)
  say "invoke via node $ID:"; say "$R"; if echo "$R" | grep -q "CALENDAR_NOT_FOUND\|not allowed\|does not support"; then continue; fi; break
done
say "--- stored event (content provider): dtstart/dtend are UTC epoch ms"
adb shell "content query --uri content://com.android.calendar/events --projection title:dtstart:dtend:allDay:eventTimezone --where \"title='OffsetHoliday'\"" | tee -a "$OUT"
for ms in $(adb shell "content query --uri content://com.android.calendar/events --projection dtstart --where \"title='OffsetHoliday'\"" | sed -n 's/.*dtstart=\([0-9]*\).*/\1/p'); do
  say "dtstart $ms = $(date -u -d @$((ms/1000)) '+%Y-%m-%d %H:%M UTC')"
done
adb exec-out screencap -p > "$C/screen-$LABEL.png"
