#!/usr/bin/env bash
# Usage: tap-download.sh <label> <watch-seconds>
# After prep-media.sh has connected the app: open Chat, record the screen, tap "Open" on the file card,
# take screenshots, and save logs. Tap positions are for the 1080x2400 emulator screen.
set -u
export PATH="/c/Users/jondi/AppData/Local/Android/Sdk/platform-tools:$PATH"
MD=/c/Users/jondi/Documents/Coding/app-review-fixes/android-media-download-timeout
L=$1; W=$2
adb shell input tap 228 886      # Chat button on the overview screen
sleep 12
adb exec-out screencap -p > $MD/$L-before-tap.png
(MSYS2_ARG_CONV_EXCL="*" adb shell screenrecord --time-limit 170 /sdcard/media.mp4 &)
sleep 2
adb logcat -c
adb shell input tap 182 1700     # "Open" on the big-report.pdf card
sleep 12; adb exec-out screencap -p > $MD/$L-t12s.png
sleep $((W - 12)); adb exec-out screencap -p > $MD/$L-t${W}s.png
MSYS2_ARG_CONV_EXCL="*" adb shell pkill -INT screenrecord; sleep 3
MSYS2_ARG_CONV_EXCL="*" adb pull /sdcard/media.mp4 "$(cygpath -w $MD/rec-$L.mp4)" >/dev/null 2>&1
adb logcat -d | grep -iE "openclaw|OkHttp|SocketTimeout|timeout" | tail -60 > $MD/logcat-$L.txt
echo TAP-DONE >> $MD/proxy-$L.log
cat $MD/proxy-$L.log
