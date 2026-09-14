#!/usr/bin/env python3
"""Build an Alpine linux/arm64 RouterOS archive using Python 3.12+, Go and curl.

Only edgeproxy is compiled. Target runtime packages are downloaded, verified
against build-packages.json, and unpacked without executing target programs.
"""

import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile


HERE = Path(__file__).resolve().parent
LOCK = HERE / "build-packages.json"
ALPINE = "https://dl-cdn.alpinelinux.org/alpine/v3.23"


def output(args, env=None):
    return subprocess.check_output(args, cwd=HERE, env=env, text=True).strip()


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def select_go(explicit):
    # Never let an older Go launcher silently install another toolchain.
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


def fetch(url, path):
    subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error",
                    "--retry", "3", "--connect-timeout", "30", "--max-time", "600",
                    "--proto", "=https", "--proto-redir", "=https", "--output", str(path), url], check=True)


def download(cache, package):
    target = cache / (package["url"].rsplit("/", 1)[1])
    if not target.exists():
        print(f"Downloading {target.name}", flush=True)
        with tempfile.TemporaryDirectory(dir=cache) as work:
            part = Path(work) / target.name
            fetch(package["url"], part)
            if digest(part) != package["sha256"]:
                raise RuntimeError(f"SHA-256 mismatch downloading {target.name}")
            part.replace(target)
    if digest(target) != package["sha256"]:
        raise RuntimeError(f"SHA-256 mismatch in {target}; remove it and retry")
    return target


def update_lock(cache):
    """Explicit maintenance operation: resolve one Alpine branch, then pin bytes."""
    packages, providers = {}, {}
    with tempfile.TemporaryDirectory(dir=cache) as temp:
        for repo in ("main", "community"):
            index = Path(temp) / f"{repo}.tar.gz"
            fetch(f"{ALPINE}/{repo}/aarch64/APKINDEX.tar.gz", index)
            with tarfile.open(index, ignore_zeros=True) as tar:
                text = tar.extractfile("APKINDEX").read().decode()
            for record in text.strip().split("\n\n"):
                fields = dict(line.split(":", 1) for line in record.splitlines() if ":" in line)
                name = fields["P"]
                package = {"name": name, "version": fields["V"],
                           "url": f"{ALPINE}/{repo}/aarch64/{name}-{fields['V']}.apk",
                           "license": fields.get("L", ""),
                           "dependencies": fields.get("D", "").split(),
                           "provides": fields.get("p", "").split()}
                packages[name] = package
                for provided in package["provides"]:
                    providers.setdefault(re.split(r"[=<>~]", provided)[0], []).append(name)
        selected = {}

        def resolve(dependency):
            if dependency.startswith("!"):
                return
            name = re.split(r"[=<>~]", dependency)[0]
            if name == "/bin/sh":
                name = "busybox-binsh"
            if name not in packages:
                choices = providers.get(name, [])
                if len(choices) != 1:
                    raise RuntimeError(f"Cannot uniquely resolve {dependency}: {choices}")
                name = choices[0]
            if name in selected:
                return
            package = packages[name]
            selected[name] = package
            for child in package["dependencies"]:
                resolve(child)

        # BusyBox provides a useful RouterOS console; the bundle needs no CA trigger.
        for name in ("ffmpeg", "ca-certificates-bundle", "busybox", "busybox-binsh"):
            resolve(name)
        for package in sorted(selected.values(), key=lambda p: p["name"]):
            target = cache / package["url"].rsplit("/", 1)[1]
            print(f"Pinning {target.name}", flush=True)
            # Refresh from HTTPS when updating the lock, rather than trusting cache bytes.
            part = Path(temp) / target.name
            fetch(package["url"], part)
            package["sha256"] = digest(part)
            part.replace(target)
        LOCK.write_text(json.dumps({"alpine": "3.23", "architecture": "aarch64",
                                    "packages": sorted(selected.values(), key=lambda p: p["name"])}, indent=2) + "\n")
    print(f"Pinned {len(selected)} runtime packages in {LOCK}")


def unpack_apk(archive, root):
    # APK v2 has concatenated gzip/tar streams (signature, control, payload).
    # ignore_zeros reads all streams; package scripts and metadata are not executed.
    with tarfile.open(archive, ignore_zeros=True) as tar:
        for member in tar:
            name = member.name.removeprefix("./")
            if not name or name.startswith("."):
                continue
            member.name = name
            # APK links are rooted in the target filesystem, never in the host.
            if member.issym() and member.linkname.startswith("/"):
                member.linkname = os.path.relpath(member.linkname.lstrip("/"), os.path.dirname(name) or ".")
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise RuntimeError(f"Unexpected special file in {archive}: {name}")
            tar.extract(member, root, filter="data")


def check_arm64(path, static=False):
    data = path.read_bytes()
    if data[:6] != b"\x7fELF\x02\x01" or struct.unpack_from("<H", data, 18)[0] != 183:
        raise RuntimeError(f"{path} is not a little-endian ARM64 ELF executable")
    if static:
        phoff = struct.unpack_from("<Q", data, 32)[0]
        phsize, phnum = struct.unpack_from("<HH", data, 54)
        for index in range(phnum):
            if struct.unpack_from("<I", data, phoff + index * phsize)[0] == 3:
                raise RuntimeError(f"{path} requires a dynamic loader")


def elf_dependencies(path):
    """Read ELF64 dynamic metadata without host readelf/ldd or target execution."""
    check_arm64(path)
    data = path.read_bytes()
    phoff = struct.unpack_from("<Q", data, 32)[0]
    phsize, phnum = struct.unpack_from("<HH", data, 54)
    segments = [struct.unpack_from("<IIQQQQQQ", data, phoff + i * phsize) for i in range(phnum)]
    interpreter, entries = None, []
    for kind, _, offset, _, _, size, _, _ in segments:
        if kind == 3:
            interpreter = data[offset:offset + size].rstrip(b"\0").decode()
        elif kind == 2:
            for pos in range(offset, offset + size, 16):
                tag, value = struct.unpack_from("<qQ", data, pos)
                if tag == 0:
                    break
                entries.append((tag, value))
    strings = next((value for tag, value in entries if tag == 5), None)
    if strings is None:
        return interpreter, [], []
    base = next(offset + strings - addr for kind, _, offset, addr, _, size, _, _ in segments
                if kind == 1 and addr <= strings < addr + size)

    def string(index):
        start = base + index
        return data[start:data.index(b"\0", start)].decode()

    needed = [string(value) for tag, value in entries if tag == 1]
    paths = [part for tag, value in entries if tag in (15, 29) for part in string(value).split(":")]
    return interpreter, needed, paths


def check_runtime(root):
    pending = [root / name for name in ("usr/local/bin/conwayedge", "usr/bin/ffmpeg", "bin/busybox")]
    checked = set()
    while pending:
        path = pending.pop().resolve()
        if not path.is_relative_to(root.resolve()):
            raise RuntimeError(f"Runtime link escapes image: {path}")
        if path in checked:
            continue
        checked.add(path)
        interpreter, needed, paths = elf_dependencies(path)
        if interpreter:
            pending.append(root / interpreter.lstrip("/"))
        search = []
        for directory in paths:
            directory = directory.replace("${ORIGIN}", str(path.parent)).replace("$ORIGIN", str(path.parent))
            candidate = Path(directory)
            search.append(candidate if candidate.is_relative_to(root) else root / directory.lstrip("/"))
        search += [root / "lib", root / "usr/lib"]
        for library in needed:
            candidate = next((directory / library for directory in search if (directory / library).is_file()), None)
            if candidate is None:
                raise RuntimeError(f"Missing runtime library {library} needed by {path.relative_to(root)}")
            pending.append(candidate)
    print(f"Verified ARM64 loader/library closure ({len(checked)} ELF files)", flush=True)


def json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def tar_add(archive, name, data):
    entry = tarfile.TarInfo(name)
    entry.mode, entry.size = 0o644, len(data)
    archive.addfile(entry, io.BytesIO(data))


def package(root, destination, work):
    layer = work / "layer.tar"

    def normalize(entry):
        entry.uid = entry.gid = 0
        entry.uname = entry.gname = ""
        entry.mtime = 0
        return entry

    with tarfile.open(layer, "w", format=tarfile.PAX_FORMAT) as tar:
        for path in sorted(root.rglob("*")):
            tar.add(path, arcname=path.relative_to(root), recursive=False, filter=normalize)
    layer_hash = digest(layer)
    config = json_bytes({
        "architecture": "arm64", "os": "linux",
        "config": {
            "User": "0:0", "WorkingDir": "/data",
            "Env": ["PATH=/usr/local/bin:/usr/bin:/bin", "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt"],
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
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent) as temp:
        image = Path(temp) / "image.tar.gz"
        with image.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|") as tar:
                tar_add(tar, "manifest.json", json_bytes(manifest))
                tar_add(tar, config_name, config)
                entry = tarfile.TarInfo(f"{layer_hash}/layer.tar")
                entry.size, entry.mode = layer.stat().st_size, 0o644
                with layer.open("rb") as stream:
                    tar.addfile(entry, stream)
        image.chmod(0o644)
        image.replace(destination)
    Path(str(destination) + ".sha256").write_text(f"{digest(destination)}  {destination.name}\n")
    print(f"Built {destination} ({destination.stat().st_size / 1048576:.1f} MiB)", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--go", help="path to an installed Go 1.25+ binary")
    parser.add_argument("--cache", type=Path, default=HERE / ".build-cache")
    parser.add_argument("--output", type=Path, default=HERE / "dist/conwayedge-linux-arm64.tar.gz")
    parser.add_argument("--update-lock", action="store_true", help="refresh pinned Alpine runtime packages and exit")
    args = parser.parse_args()
    if not shutil.which("curl"):
        parser.error("required installed tool not found: curl")
    cache = args.cache.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    if args.update_lock:
        update_lock(cache)
        return
    go, env = select_go(args.go)
    lock = json.loads(LOCK.read_text())
    if lock["architecture"] != "aarch64":
        raise RuntimeError("Runtime lock must target aarch64")
    with tempfile.TemporaryDirectory(prefix="image-", dir=cache) as temp:
        work = Path(temp)
        root = work / "root"
        root.mkdir()
        for dependency in lock["packages"]:
            unpack_apk(download(cache, dependency), root)
        for name in ("data", "tmp", "dev", "proc", "usr/local/bin", "usr/share/conwayedge"):
            (root / name).mkdir(parents=True, exist_ok=True)
        (root / "data").chmod(0o700)
        (root / "tmp").chmod(0o1777)
        (root / "etc/passwd").write_text("root:x:0:0:root:/data:/bin/sh\n")
        (root / "etc/group").write_text("root:x:0:\n")
        shutil.copy2(LOCK, root / "usr/share/conwayedge/build-packages.json")
        (root / "etc/alpine-release").write_text(lock["alpine"] + "\n")
        binary = root / "usr/local/bin/conwayedge"
        env.update(GOOS="linux", GOARCH="arm64", GOARM64="v8.0", CGO_ENABLED="0", GOFLAGS="")
        print("Cross-compiling edgeproxy for linux/arm64", flush=True)
        subprocess.run([go, "build", "-mod=readonly", "-trimpath", "-buildvcs=false", "-ldflags=-s -w",
                        "-o", str(binary), "."], cwd=HERE, env=env, check=True)
        check_arm64(binary, static=True)
        check_runtime(root)
        if not (root / "etc/ssl/certs/ca-certificates.crt").exists():
            raise RuntimeError("CA certificate bundle missing")
        package(root, args.output.resolve(), work)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError, tarfile.TarError) as error:
        sys.exit(f"Build failed: {error}")
