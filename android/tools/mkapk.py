"""把 classes.dex 塞进 aapt2 产出的 APK，并保证 resources.arsc 不被压缩。

由 build-apk.cmd 调用，工作目录是 android/，产物是 build/unsigned.apk。
"""
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ANDROID = os.path.dirname(HERE)
BASE = os.path.join(ANDROID, "build", "base.apk")
DEX = os.path.join(ANDROID, "build", "dex", "classes.dex")
OUT = os.path.join(ANDROID, "build", "unsigned.apk")

if not os.path.exists(DEX):
    sys.exit("找不到 build/dex/classes.dex，先跑 d8")
if not os.path.exists(BASE):
    sys.exit("找不到 build/base.apk，先跑 aapt2 link")

src = zipfile.ZipFile(BASE, "r")
dst = zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED)

for item in src.infolist():
    data = src.read(item.filename)
    stored = item.filename == "resources.arsc"
    zi = zipfile.ZipInfo(item.filename, date_time=item.date_time)
    zi.compress_type = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
    zi.external_attr = item.external_attr
    dst.writestr(zi, data)
    print("  %-42s %s %d" % (item.filename, "store" if stored else "deflate", len(data)))

with open(DEX, "rb") as f:
    dst.writestr(zipfile.ZipInfo("classes.dex", date_time=(2026, 1, 1, 0, 0, 0)),
                 f.read(), compress_type=zipfile.ZIP_DEFLATED)
    print("  %-42s %s" % ("classes.dex", "deflate"))

dst.close()
src.close()
print("unsigned: %d bytes" % os.path.getsize(OUT))
