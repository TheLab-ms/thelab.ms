#!/usr/bin/env python3
"""Cross-build a self-contained linux/arm64 RouterOS image without Docker.

Host requirements: Python 3.12+, Go 1.25+, Zig 0.15+, make, Perl, cc, curl.
Only source/data downloads are executed through these existing host tools.
"""

import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile


HERE = Path(__file__).resolve().parent
SOURCES = {
    "ffmpeg-8.0.1.tar.xz": (
        "https://ffmpeg.org/releases/ffmpeg-8.0.1.tar.xz",
        "05ee0b03119b45c0bdb4df654b96802e909e0a752f72e4fe3794f487229e5a41",
    ),
    "openssl-3.5.5.tar.gz": (
        "https://www.openssl.org/source/openssl-3.5.5.tar.gz",
        "b28c91532a8b65a1f983b4c28b7488174e4a01008e29ce8e69bd789f28bc2a89",
    ),
    "cacert-2025-12-02.pem": (
        "https://curl.se/ca/cacert-2025-12-02.pem",
        "f1407d974c5ed87d544bd931a278232e13925177e239fca370619aba63c757b4",
    ),
}


def run(args, cwd=HERE, env=None, log=None):
    subprocess.run(args, cwd=cwd, env=env, check=True,
                   stdout=log, stderr=subprocess.STDOUT if log else None)


def output(args, env=None):
    return subprocess.check_output(args, cwd=HERE, env=env, text=True).strip()


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def select_go(explicit):
    # Do not let an older Go launcher silently install another toolchain.
    env = {**os.environ, "GOTOOLCHAIN": "local", "GOWORK": "off"}
    env.pop("GOROOT", None)
    launcher = explicit or shutil.which("go")
    if not launcher:
        raise RuntimeError("Go 1.25+ is required (select an installed binary with --go)")
    candidates = [Path(launcher)]
    if not explicit:
        cache = Path(output([str(launcher), "env", "GOMODCACHE"], env))
        host = output([str(launcher), "env", "GOHOSTOS", "GOHOSTARCH"], env).splitlines()
        candidates += sorted(cache.glob(f"golang.org/toolchain@*.{host[0]}-{host[1]}/bin/go"))
    for candidate in candidates:
        version = output([str(candidate), "version"], env)
        match = re.search(r"go(\d+)\.(\d+)(?:\.(\d+))?", version)
        if match and tuple(map(int, match.groups(default="0"))) >= (1, 25, 0):
            print(f"Using {version}", flush=True)
            return str(candidate.resolve()), env
    raise RuntimeError("No installed Go 1.25+ found; use --go /path/to/go")


def download(cache, name):
    url, expected = SOURCES[name]
    target = cache / name
    if not target.exists():
        print(f"Downloading {name}", flush=True)
        with tempfile.TemporaryDirectory(dir=cache) as work:
            part = Path(work) / name
            run(["curl", "--fail", "--location", "--silent", "--show-error",
                 "--retry", "3", "--connect-timeout", "30", "--max-time", "600",
                 "--proto", "=https", "--proto-redir", "=https", "--output", str(part), url])
            if digest(part) != expected:
                raise RuntimeError(f"SHA-256 mismatch downloading {name}")
            part.replace(target)
    if digest(target) != expected:
        raise RuntimeError(f"SHA-256 mismatch in {target}; remove it and retry")
    return target


def extract(archive, destination):
    with tarfile.open(archive) as source:
        source.extractall(destination, filter="data")


def write(path, contents, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(contents.encode() if isinstance(contents, str) else contents)
    path.chmod(mode)


def wrappers(directory, zig):
    for name, command in {"cc": "cc -target aarch64-linux-musl -mcpu=generic",
                          "ar": "ar", "ranlib": "ranlib"}.items():
        write(directory / f"zig-{name}",
              f'#!/bin/sh\nexec {shlex.quote(zig)} {command} "$@"\n', 0o755)


def check_static_arm64(path):
    """Check ELF headers on the host; never execute a target binary to inspect it."""
    data = path.read_bytes()
    if data[:6] != b"\x7fELF\x02\x01" or struct.unpack_from("<H", data, 18)[0] != 183:
        raise RuntimeError(f"{path} is not a little-endian ARM64 ELF executable")
    phoff = struct.unpack_from("<Q", data, 32)[0]
    phsize, phnum = struct.unpack_from("<HH", data, 54)
    for index in range(phnum):
        kind, _, offset, _, _, size = struct.unpack_from("<IIQQQQ", data, phoff + index * phsize)
        if kind == 3:  # PT_INTERP
            raise RuntimeError(f"{path} requires a dynamic loader")
        if kind == 2:  # PT_DYNAMIC: static PIE is fine, DT_NEEDED is not.
            for entry in range(offset, offset + size, 16):
                if struct.unpack_from("<q", data, entry)[0] == 1:
                    raise RuntimeError(f"{path} requires shared libraries")


def build_ffmpeg(cache, archives, zig, jobs):
    key = hashlib.sha256(Path(__file__).read_bytes() + output([zig, "version"]).encode()).hexdigest()[:16]
    result = cache / f"ffmpeg-arm64-{key}"
    if (result / "ffmpeg").exists():
        check_static_arm64(result / "ffmpeg")
        print("Using cached ARM64 FFmpeg", flush=True)
        return result
    log_path = cache / "ffmpeg-build.log"
    print(f"Cross-compiling OpenSSL and FFmpeg (log: {log_path})", flush=True)
    with tempfile.TemporaryDirectory(prefix="native-", dir=cache) as temp, log_path.open("w") as log:
        work = Path(temp)
        extract(archives["openssl-3.5.5.tar.gz"], work)
        extract(archives["ffmpeg-8.0.1.tar.xz"], work)
        ssl = work / "openssl-3.5.5"
        ff = work / "ffmpeg-8.0.1"
        prefix = work / "ssl"
        env = os.environ.copy()
        # Prevent Homebrew headers/libraries from leaking into the target build.
        for name in ("CFLAGS", "CPPFLAGS", "CXXFLAGS", "LDFLAGS", "CPATH",
                     "LIBRARY_PATH", "SDKROOT", "MACOSX_DEPLOYMENT_TARGET"):
            env.pop(name, None)
        env.update(CC="./zig-cc", AR="./zig-ar", RANLIB="./zig-ranlib")
        wrappers(ssl, zig)
        run(["perl", "Configure", "linux-aarch64", "no-shared", "no-tests", "no-apps",
             "no-asm", "no-module", "no-dso", f"--prefix={prefix}", "--libdir=lib",
             "--openssldir=/etc/ssl"], ssl, env, log)
        run(["make", f"-j{jobs}", "build_libs"], ssl, env, log)
        run(["make", "install_dev"], ssl, env, log)
        wrappers(ff, zig)
        run(["sh", "configure", "--target-os=linux", "--arch=aarch64", "--enable-cross-compile",
             "--cc=./zig-cc", "--ar=./zig-ar", "--ranlib=./zig-ranlib", "--host-cc=cc",
             "--pkg-config=false", "--disable-autodetect", "--disable-shared", "--enable-static",
             "--disable-asm", "--disable-debug", "--disable-doc", "--disable-ffplay",
             "--disable-ffprobe", "--disable-everything", "--enable-ffmpeg", "--enable-network",
             "--enable-openssl", "--enable-protocol=file,pipe,tcp,tls,udp,rtp",
             "--enable-demuxer=rtsp,rtp,sdp,h264,hevc,mjpeg",
             "--enable-parser=h264,hevc,mjpeg", "--enable-decoder=h264,hevc,mjpeg",
             "--enable-encoder=mjpeg", "--enable-muxer=mpjpeg",
             "--enable-filter=scale,format,fps,null", "--enable-swscale",
             f"--extra-cflags=-I{shlex.quote(str(prefix / 'include'))}",
             f"--extra-ldflags=-static -L{shlex.quote(str(prefix / 'lib'))}"], ff, env, log)
        required = ("OPENSSL", "TLS_PROTOCOL", "RTSP_DEMUXER", "H264_DECODER", "HEVC_DECODER",
                    "MJPEG_ENCODER", "MPJPEG_MUXER", "SCALE_FILTER", "FPS_FILTER")
        config = (ff / "config.h").read_text() + (ff / "config_components.h").read_text()
        for feature in required:
            if f"#define CONFIG_{feature} 1" not in config:
                raise RuntimeError(f"FFmpeg feature {feature} was not enabled; see {log_path}")
        run(["make", f"-j{jobs}", "ffmpeg"], ff, env, log)
        check_static_arm64(ff / "ffmpeg")
        staged = work / "result"
        staged.mkdir()
        shutil.copy2(ff / "ffmpeg", staged / "ffmpeg")
        for name in ("COPYING.LGPLv2.1", "COPYING.LGPLv3", "LICENSE.md"):
            shutil.copy2(ff / name, staged / f"ffmpeg-{name}")
        shutil.copy2(ssl / "LICENSE.txt", staged / "openssl-LICENSE.txt")
        shutil.copy2(ff / "config.h", staged / "ffmpeg-config.h")
        shutil.copy2(ff / "config_components.h", staged / "ffmpeg-config_components.h")
        staged.replace(result)
    return result


def tar_add(archive, name, data=b"", mode=0o644, directory=False, uid=0):
    entry = tarfile.TarInfo(name)
    entry.mode, entry.uid, entry.gid = mode, uid, uid
    entry.type = tarfile.DIRTYPE if directory else tarfile.REGTYPE
    entry.size = 0 if directory else len(data)
    archive.addfile(entry, None if directory else io.BytesIO(data))


def json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def package(binary, native, certificates, destination, work, go_version):
    layer = work / "layer.tar"
    with tarfile.open(layer, "w", format=tarfile.USTAR_FORMAT) as tar:
        for directory in ("usr", "usr/local", "usr/local/bin", "usr/share", "usr/share/conwayedge",
                          "usr/share/conwayedge/licenses", "etc", "etc/ssl", "etc/ssl/certs", "dev", "proc"):
            tar_add(tar, directory, mode=0o755, directory=True)
        tar_add(tar, "data", mode=0o700, directory=True, uid=65532)
        tar_add(tar, "tmp", mode=0o1777, directory=True)
        tar_add(tar, "usr/local/bin/conwayedge", binary.read_bytes(), 0o755)
        tar_add(tar, "usr/local/bin/ffmpeg", (native / "ffmpeg").read_bytes(), 0o755)
        tar_add(tar, "etc/ssl/certs/ca-certificates.crt", certificates.read_bytes())
        tar_add(tar, "etc/passwd", b"conwayedge:x:65532:65532:conwayedge:/data:/sbin/nologin\n")
        tar_add(tar, "etc/group", b"conwayedge:x:65532:\n")
        for path in sorted(native.iterdir()):
            if path.name != "ffmpeg":
                tar_add(tar, f"usr/share/conwayedge/licenses/{path.name}", path.read_bytes())
        tar_add(tar, "usr/share/conwayedge/build.json", json_bytes({
            "go": go_version, "sources": SOURCES,
            "ffmpeg_configure": "See ffmpeg-config*.h and edgeproxy/build.py",
        }))
    layer_hash = digest(layer)
    config = json_bytes({
        "architecture": "arm64", "os": "linux",
        "config": {
            "User": "65532:65532", "WorkingDir": "/data",
            "Env": ["PATH=/usr/local/bin", "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt"],
            "Entrypoint": ["/usr/local/bin/conwayedge"],
            "Cmd": ["-lan", ":8080", "-tunnel", ":8081", "-data", "/data"],
            "ExposedPorts": {"8080/tcp": {}, "8081/tcp": {}},
            "Volumes": {"/data": {}}, "StopSignal": "SIGTERM",
        },
        "rootfs": {"type": "layers", "diff_ids": [f"sha256:{layer_hash}"]},
        "history": [{"created_by": "edgeproxy/build.py"}],
    })
    config_name = hashlib.sha256(config).hexdigest() + ".json"
    manifest = [{"Config": config_name, "RepoTags": ["conwayedge:arm64"],
                 "Layers": [f"{layer_hash}/layer.tar"]}]
    temporary = work / "image.tar.gz"
    with temporary.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.USTAR_FORMAT) as tar:
            tar_add(tar, "manifest.json", json_bytes(manifest))
            tar_add(tar, config_name, config)
            entry = tarfile.TarInfo(f"{layer_hash}/layer.tar")
            entry.size, entry.mode = layer.stat().st_size, 0o644
            with layer.open("rb") as stream:
                tar.addfile(entry, stream)
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Copy to the output filesystem before atomic rename (cache may be on another disk).
    with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as staged:
        staged_path = Path(staged.name)
        try:
            with temporary.open("rb") as source:
                shutil.copyfileobj(source, staged)
            staged.close()
            staged_path.chmod(0o644)
            staged_path.replace(destination)
        finally:
            staged_path.unlink(missing_ok=True)
    write(Path(str(destination) + ".sha256"), f"{digest(destination)}  {destination.name}\n")
    print(f"Built {destination} ({destination.stat().st_size / 1048576:.1f} MiB)", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--go", help="path to an installed Go 1.25+ binary")
    parser.add_argument("--cache", type=Path, default=HERE / ".build-cache")
    parser.add_argument("--output", type=Path, default=HERE / "dist/conwayedge-linux-arm64.tar.gz")
    parser.add_argument("--jobs", type=int, default=min(os.cpu_count() or 2, 8))
    args = parser.parse_args()
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    for tool in ("zig", "make", "perl", "cc", "curl"):
        if not shutil.which(tool):
            parser.error(f"required installed tool not found: {tool}")
    go, env = select_go(args.go)
    cache = args.cache.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    archives = {name: download(cache, name) for name in SOURCES}
    native = build_ffmpeg(cache, archives, shutil.which("zig"), args.jobs)
    with tempfile.TemporaryDirectory(prefix="image-", dir=cache) as temp:
        work = Path(temp)
        binary = work / "conwayedge"
        env.update(GOOS="linux", GOARCH="arm64", GOARM64="v8.0", CGO_ENABLED="0", GOFLAGS="")
        print("Cross-compiling edgeproxy for linux/arm64", flush=True)
        run([go, "build", "-mod=readonly", "-trimpath", "-buildvcs=false", "-ldflags=-s -w",
             "-o", str(binary), "."], env=env)
        check_static_arm64(binary)
        package(binary, native, archives["cacert-2025-12-02.pem"], args.output.resolve(), work,
                output([go, "version"], env))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(f"Build failed: {error}\nFor native compiler errors, see <cache>/ffmpeg-build.log")
