#!/bin/sh
# 把当前仓库安装到 DSH profile，并复制到 dsh-go 插件目录。
# 用法：./install.sh
# 可选：DSH_HOME=~/.dsh DSH_PROFILE=web ./install.sh
set -eu

SRC=$(cd "$(dirname "$0")" && pwd)
DSH_HOME=${DSH_HOME:-$HOME/.dsh}
PROFILE=${DSH_PROFILE:-web}
DEST="$DSH_HOME/dsh-go/plugins/dsh-flipper"

if [ ! -f "$SRC/package.json" ]; then
    echo "install.sh 必须在仓库根目录运行（找不到 package.json）" >&2
    exit 1
fi
if ! command -v dsh >/dev/null 2>&1; then
    echo "找不到 dsh 命令。请在 DSH App 的终端里运行，或把 dsh 加入 PATH。" >&2
    exit 1
fi

echo "安装到 $DEST"
mkdir -p "$(dirname "$DEST")"
if [ "$SRC" != "$DEST" ]; then
    rm -rf "$DEST"
    mkdir -p "$DEST"
    # 复制全部源码；排除本地构建产物和 git 元数据
    cp -R "$SRC"/. "$DEST"/
    rm -rf "$DEST/.git" "$DEST/node_modules" "$DEST/android/build" "$DEST/android/.gradle"
fi

dsh plugin --profile "$PROFILE" add "$DEST"
echo
echo "已安装。请重启 DSH 引擎（设置 → 引擎 → 重启引擎）。"
echo "手机用户记得安装 Android BLE 桥 APK：dist/flipper-ble-bridge-1.6.apk"
