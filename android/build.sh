#!/bin/sh
# 不依赖 Gradle 的最小构建：aapt + javac + d8 + zipalign + apksigner。
# 需要 Debian/Ubuntu 的 android-sdk-platform-23、android-sdk-build-tools、apksigner。
set -eu

ROOT=$(cd "$(dirname "$0")" && pwd)
APP="$ROOT/app/src/main"
SDK=${ANDROID_SDK_ROOT:-/usr/lib/android-sdk}
PLATFORM="$SDK/platforms/android-23/android.jar"
BUILD_TOOLS=$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1)
AAPT="$BUILD_TOOLS/aapt"
D8="$BUILD_TOOLS/d8"
DX=$(command -v dalvik-exchange || command -v dx || true)
ZIPALIGN="$BUILD_TOOLS/zipalign"
APKSIGNER=$(command -v apksigner || true)
[ -n "$APKSIGNER" ] || APKSIGNER="$BUILD_TOOLS/apksigner"

if [ ! -f "$PLATFORM" ]; then
    echo "找不到 $PLATFORM，先装 android-sdk-platform-23" >&2
    exit 1
fi
if [ ! -x "$AAPT" ] || [ ! -x "$ZIPALIGN" ]; then
    echo "找不到 build-tools（aapt/zipalign），先装 android-sdk-build-tools" >&2
    exit 1
fi

OUT="$ROOT/build"
rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"

# Gradle 的 manifest 不带 package（AGP 8 用 namespace），aapt 需要 package。
sed 's|<manifest |<manifest package="com.dsh.flipperbridge" android:versionCode="7" android:versionName="1.6" |' \
    "$APP/AndroidManifest.xml" > "$OUT/AndroidManifest.xml"

"$AAPT" package -f -m -J "$OUT/gen" -M "$OUT/AndroidManifest.xml" -S "$APP/res" -I "$PLATFORM"
javac -source 8 -target 8 -encoding UTF-8 -cp "$PLATFORM" -d "$OUT/classes" \
    "$OUT/gen/com/dsh/flipperbridge/R.java" \
    "$APP"/java/com/dsh/flipperbridge/*.java

if [ -x "$D8" ]; then
    "$D8" --lib "$PLATFORM" --min-api 23 --output "$OUT/dex" \
        $(find "$OUT/classes" -name '*.class' | sort)
else
    "$DX" --dex --min-sdk-version=23 --output "$OUT/dex/classes.dex" "$OUT/classes"
fi

"$AAPT" package -f -M "$OUT/AndroidManifest.xml" -S "$APP/res" -I "$PLATFORM" -F "$OUT/app.unsigned.apk"
(cd "$OUT/dex" && "$AAPT" add "$OUT/app.unsigned.apk" classes.dex)
"$ZIPALIGN" -f 4 "$OUT/app.unsigned.apk" "$OUT/app.aligned.apk"

if [ ! -f "$ROOT/debug.keystore" ]; then
    keytool -genkeypair -keystore "$ROOT/debug.keystore" -storepass android \
        -alias androiddebugkey -keypass android \
        -dname "CN=Android Debug,O=Android,C=US" -keyalg RSA -keysize 2048 -validity 10000
fi

"$APKSIGNER" sign --ks "$ROOT/debug.keystore" --ks-pass pass:android \
    --key-pass pass:android --min-sdk-version 23 \
    --out "$ROOT/flipper-ble-bridge.apk" "$OUT/app.aligned.apk"
"$APKSIGNER" verify --verbose "$ROOT/flipper-ble-bridge.apk" | head -5
echo "APK: $ROOT/flipper-ble-bridge.apk"
