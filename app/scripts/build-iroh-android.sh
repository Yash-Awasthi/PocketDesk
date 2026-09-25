#!/usr/bin/env bash
# Rebuilds libiroh_ffi.so for arm64 with 16 KB ELF alignment into app/src/main/jniLibs.
# iroh-android 1.1.0 ships 4 KB-aligned libraries that crash on 16 KB-page devices;
# the upstream fix (iroh-ffi #283) is not in a release yet. Drop this once it is.
# Needs rustup with the aarch64-linux-android target, cargo-ndk 3.5.4 and ANDROID_NDK_HOME; on Windows
# without MSVC, a windows-gnu toolchain plus a full MinGW (dlltool and as) on PATH.
set -eu
VERSION=v1.1.0 # must match computer.iroh:iroh-android in app/build.gradle.kts
OUT="$(cd "$(dirname "$0")/.." && pwd)/app/src/main/jniLibs"
WORK="$(mktemp -d)"
git clone -q --depth 1 --branch "$VERSION" https://github.com/n0-computer/iroh-ffi "$WORK/iroh-ffi"
cd "$WORK/iroh-ffi"
mkdir -p .cargo
printf '[target.aarch64-linux-android]\nrustflags = ["-C", "link-arg=-Wl,-z,max-page-size=16384"]\n' > .cargo/config.toml
cargo ndk -o "$OUT" -t arm64-v8a --platform 24 build --release --lib
echo "built $OUT/arm64-v8a/libiroh_ffi.so"
