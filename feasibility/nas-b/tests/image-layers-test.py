
import gzip
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from audit_image_layers import LayerAuditError, audit_archive


IMAGE = "ghcr.io/wjh183322/cangxia-server-probe:synthetic"
PRIVATE_BYTES = b"synthetic private content never logged"


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def entry(name, content=b"", type=tarfile.REGTYPE, linkname=""):
    member = tarfile.TarInfo(name)
    member.type = type
    member.linkname = linkname
    member.size = len(content)
    return member, content


def archive_bytes(members):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for member, contents in members:
            archive.addfile(member, io.BytesIO(contents))
    return output.getvalue()


class LayerAuditTest(unittest.TestCase):
    def make_archive(self, *layers, transform=None, legacy=False):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "fixture.tar"
        # The base belongs to the pinned, separately verified distribution.
        base = archive_bytes([entry("etc/base/.env"), entry("root/.ssh", type=tarfile.DIRTYPE)])
        layers = [base, *[archive_bytes(layer) for layer in layers]]
        if legacy:
            blobs = [(f"{index:064x}/layer.tar", data) for index, data in enumerate(layers)]
        else:
            compressed = [gzip.compress(data, mtime=0) for data in layers]
            blobs = [("blobs/sha256/" + digest(data).split(":")[1], data) for data in compressed]
        config = json.dumps({"rootfs": {"type": "layers", "diff_ids": [digest(data) for data in layers]}}).encode()
        config_id = digest(config)
        config_path = config_id.split(":")[1] + ".json" if legacy else "blobs/sha256/" + config_id.split(":")[1]
        inspect = [{"Id": config_id, "RootFS": {"Type": "layers", "Layers": [digest(data) for data in layers]}}]
        manifests = [{"Config": config_path, "RepoTags": [IMAGE], "Layers": [name for name, _ in blobs]}]
        if transform:
            transform(manifests, inspect)
        path.write_bytes(archive_bytes([
            *[entry(name, data) for name, data in blobs],
            entry(config_path, config), entry("manifest.json", json.dumps(manifests).encode())
        ]))
        return path, inspect

    def audit(self, *layers, **options):
        path, inspect = self.make_archive(*layers, **options)
        return audit_archive(path, inspect, IMAGE, 1)

    def test_audits_saved_gzip_and_legacy_raw_layers_without_reading_base_headers(self):
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                result = self.audit([
                    entry("./usr/bin/ffmpeg"), entry("root/.wh..npm"),
                    entry("opt/cover-runtime/bin/python", type=tarfile.SYMTYPE, linkname="/usr/bin/python3.12"),
                    entry("etc/ssl/certs/Trusted_Root.pem", type=tarfile.SYMTYPE,
                          linkname="/usr/share/ca-certificates/mozilla/Trusted_Root.crt"),
                ], legacy=legacy)
                self.assertEqual(result["auditedLayerCount"], 1)
                self.assertEqual(result["layerHeaderCount"], 4)

    def test_accepts_the_exact_empty_regular_whiteout_for_the_pinned_base_ssh_directory(self):
        self.assertEqual(self.audit([entry("root/.wh..ssh")])["layerHeaderCount"], 1)

    def test_rejects_ssh_content_and_malformed_or_other_ssh_whiteouts(self):
        for member, problem in [
            (entry("root/.ssh", type=tarfile.DIRTYPE), "UNEXPECTED_LAYER_FILES"),
            (entry("root/.ssh/private", PRIVATE_BYTES), "UNEXPECTED_LAYER_FILES"),
            (entry("home/pwuser/.wh..ssh"), "UNEXPECTED_LAYER_FILES"),
            (entry("root/.wh..ssh", PRIVATE_BYTES), "INVALID_LAYER_MEMBER"),
            (entry("root/.wh..ssh", type=tarfile.DIRTYPE), "INVALID_LAYER_MEMBER"),
            (entry("root/.wh..ssh", type=tarfile.SYMTYPE, linkname="/root/.ssh"), "INVALID_LAYER_MEMBER"),
            (entry("root/.wh..ssh", linkname="/root/.ssh"), "UNEXPECTED_LAYER_FILES"),
        ]:
            with self.subTest(name=member[0].name, type=member[0].type):
                with self.assertRaisesRegex(LayerAuditError, "^" + problem + "$"):
                    self.audit([member])

    def test_accepts_debian_multiarch_names_and_links(self):
        package = "var/lib/dpkg/info/libavcodec60:amd64"
        result = self.audit([
            entry(package + ".list"),
            entry(package + ".md5sums"),
            entry("var/lib/dpkg/info/cangxia-test-link", type=tarfile.SYMTYPE, linkname="libavcodec60:amd64.list"),
        ])
        self.assertEqual(result["layerHeaderCount"], 3)

    def test_rejects_windows_drive_prefixes_in_member_names_and_links(self):
        for name in ("C:/Windows/private", "d:relative", "./Z:/nested"):
            with self.subTest(name=name):
                with self.assertRaisesRegex(LayerAuditError, "^INVALID_LAYER_PATH$"):
                    self.audit([entry(name)])
                with self.assertRaisesRegex(LayerAuditError, "^INVALID_LAYER_PATH$"):
                    self.audit([entry("usr/share/test-link", type=tarfile.SYMTYPE, linkname=name)])

    def test_rejects_an_earlier_token_hidden_by_a_later_opaque_whiteout(self):
        final = [entry("opt/vendor/.wh..wh..opq"), entry("opt/vendor/public")]
        self.assertEqual(self.audit(final)["auditedLayerCount"], 1)
        with self.assertRaisesRegex(LayerAuditError, "^UNEXPECTED_LAYER_FILES$"):
            self.audit([entry("opt/vendor/access.token", PRIVATE_BYTES)], final)

    def test_rejects_an_earlier_secret_alias_overwritten_by_a_later_regular_file(self):
        final = [entry("opt/vendor/settings", b"synthetic public content")]
        self.assertEqual(self.audit(final)["auditedLayerCount"], 1)
        with self.assertRaisesRegex(LayerAuditError, "^UNEXPECTED_LAYER_FILES$"):
            self.audit([entry("opt/vendor/settings", type=tarfile.SYMTYPE, linkname="/opt/vendor/access.token")], final)

    def test_rejects_sensitive_names_and_bad_paths_anywhere_in_added_layers(self):
        for bad in ("usr/share/any/.evidence/log.json", "var/cache/browser/Cookies", "opt/elsewhere/server.pem",
                    "lib/.env.local", "var/tmp/library.sqlite-wal", "etc/team/capture.har",
                    "/etc/bad", "usr/../etc/bad", "usr\\private\\identity", "usr/bad\nnewline"):
            with self.subTest(bad=bad):
                with self.assertRaisesRegex(LayerAuditError, "^(INVALID_LAYER_PATH|UNEXPECTED_LAYER_FILES)$"):
                    self.audit([entry(bad, PRIVATE_BYTES)])

    def test_rejects_sensitive_link_targets_and_escaping_link_paths(self):
        with self.assertRaisesRegex(LayerAuditError, "^UNEXPECTED_LAYER_FILES$"):
            self.audit([entry("var/lib/alias", type=tarfile.SYMTYPE, linkname="/opt/actual/access.token")])
        with self.assertRaisesRegex(LayerAuditError, "^INVALID_LAYER_PATH$"):
            self.audit([entry("alias", type=tarfile.SYMTYPE, linkname="../external")])

    def test_failed_cli_does_not_print_a_layer_path_or_payload(self):
        secret_path = "opt/vendor/.evidence/private-name"
        archive, inspect = self.make_archive([entry(secret_path, PRIVATE_BYTES)])
        inspect_path = archive.with_suffix(".json")
        inspect_path.write_text(json.dumps(inspect), encoding="utf-8")
        command = [
            sys.executable, "-B", str(Path(__file__).resolve().parents[1] / "scripts" / "audit_image_layers.py"),
            str(archive), str(inspect_path), IMAGE, "1",
        ]
        result = subprocess.run(command, capture_output=True, timeout=10, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(json.loads(result.stdout), {"ok": False, "problem": "UNEXPECTED_LAYER_FILES"})
        self.assertNotIn(secret_path.encode(), result.stdout)
        self.assertNotIn(PRIVATE_BYTES, result.stdout)

    def test_rejects_archive_aliases_order_mismatch_and_inconsistent_inspect(self):
        def reverse_added_layers(manifest, _):
            manifest[0]["Layers"][1:] = reversed(manifest[0]["Layers"][1:])
        with self.assertRaisesRegex(LayerAuditError, "^IMAGE_ARCHIVE_MANIFEST_MISMATCH$"):
            self.audit([entry("usr/bin/ffmpeg")], transform=lambda manifest, _: manifest.append(manifest[0]))
        with self.assertRaisesRegex(LayerAuditError, "^IMAGE_ARCHIVE_LAYER_MISMATCH$"):
            self.audit([entry("usr/bin/ffmpeg")], [entry("usr/bin/ffprobe")],
                       transform=reverse_added_layers)
        with self.assertRaisesRegex(LayerAuditError, "^IMAGE_ARCHIVE_CONFIG_MISMATCH$"):
            self.audit([entry("usr/bin/ffmpeg")],
                       transform=lambda _, inspect: inspect[0]["RootFS"]["Layers"].reverse())


if __name__ == "__main__":
    unittest.main()
