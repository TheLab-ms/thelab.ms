"""Packaging checks that run on the build host without Docker or Linux emulation."""

import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

import build


class BuildTests(unittest.TestCase):
    def test_image_round_trip(self):
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp)
            root = work / "root"
            (root / "data").mkdir(parents=True)
            (root / "data").chmod(0o700)
            (root / "bin").mkdir()
            (root / "bin/program").write_bytes(b"program")
            (root / "bin/program").chmod(0o755)
            (root / "bin/link").symlink_to("program")
            destination = work / "image.tar.gz"
            build.package(root, destination, work)
            with tarfile.open(destination) as image:
                manifest = json.load(image.extractfile("manifest.json"))[0]
                config_bytes = image.extractfile(manifest["Config"]).read()
                self.assertEqual(hashlib.sha256(config_bytes).hexdigest() + ".json", manifest["Config"])
                config = json.loads(config_bytes)
                self.assertEqual((config["os"], config["architecture"]), ("linux", "arm64"))
                self.assertEqual(config["config"]["User"], "65532:65532")
                self.assertEqual(config["config"]["Entrypoint"], ["/usr/local/bin/conwayedge"])
                layer_bytes = image.extractfile(manifest["Layers"][0]).read()
                self.assertEqual(config["rootfs"]["diff_ids"], ["sha256:" + hashlib.sha256(layer_bytes).hexdigest()])
            with tarfile.open(fileobj=io.BytesIO(layer_bytes)) as layer:
                data = layer.getmember("data")
                self.assertEqual((data.uid, data.gid, data.mode), (65532, 65532, 0o700))
                self.assertEqual(layer.getmember("bin/program").mode, 0o755)
                self.assertEqual(layer.getmember("bin/link").linkname, "program")
            checksum = Path(str(destination) + ".sha256").read_text().split()[0]
            self.assertEqual(checksum, build.digest(destination))

    def test_apk_streams_and_target_absolute_symlink(self):
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp)
            control, payload = io.BytesIO(), io.BytesIO()
            with tarfile.open(fileobj=control, mode="w") as tar:
                build.tar_add(tar, ".PKGINFO", b"pkgname = fixture\n")
                build.tar_add(tar, ".post-install", b"must never run")
            with tarfile.open(fileobj=payload, mode="w") as tar:
                build.tar_add(tar, "bin/busybox", b"fixture")
                link = tarfile.TarInfo("bin/sh")
                link.type, link.linkname = tarfile.SYMTYPE, "/bin/busybox"
                tar.addfile(link)
            apk = work / "fixture.apk"
            apk.write_bytes(gzip.compress(control.getvalue()) + gzip.compress(payload.getvalue()))
            root = work / "root"
            root.mkdir()
            build.unpack_apk(apk, root)
            self.assertEqual((root / "bin/sh").read_bytes(), b"fixture")
            self.assertTrue((root / "bin/sh").resolve().is_relative_to(root.resolve()))
            self.assertFalse((root / ".PKGINFO").exists())
            self.assertFalse((root / ".post-install").exists())

    def test_rejects_corrupt_cached_download(self):
        with tempfile.TemporaryDirectory() as temp:
            cache = Path(temp)
            (cache / "fixture.apk").write_bytes(b"corrupt")
            with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
                build.download(cache, {"url": "https://invalid.example/fixture.apk", "sha256": "0" * 64})


if __name__ == "__main__":
    unittest.main()
