
"""Audit saved Docker layer metadata without extracting image files."""

from contextlib import nullcontext
import gzip
import hashlib
import json
from pathlib import Path
import posixpath
import re
import sys
import tarfile
import zlib


MAX_ARCHIVE_BYTES = 6 * 1024**3
MAX_LAYER_BYTES = 2 * 1024**3
MAX_METADATA_BYTES = 1024**2
MAX_HEADERS = 100_000
DIGEST = re.compile(r"sha256:[a-f0-9]{64}")
LAYER_REF = re.compile(r"(?:blobs/sha256/[a-f0-9]{64}|[a-f0-9]{64}/layer[.]tar)")
CONFIG_REF = re.compile(r"(?:blobs/sha256/[a-f0-9]{64}|[a-f0-9]{64}[.]json)")
SECRET_COMPONENT = re.compile(
    r"[.]evidence|[.]git|[.]ssh|[.]aws|[.]netrc|[.]npmrc|[.]env(?:[.].*)?"
    r"|access[.]token|id_(?:rsa|ed25519|ecdsa)|server[.]pem|cookies(?:-journal)?"
    r"|login data|local state|secure preferences|credentials[.]json|secrets[.]json"
    r"|captures|recordings|docker[.]sock",
    re.IGNORECASE,
)
SENSITIVE_SUFFIX = re.compile(
    r"[.](?:sqlite3?(?:[-.](?:wal|shm|journal))?|key|p12|pfx|ppk|kdbx|har|pcap(?:ng)?|mp4|mov|mkv|avi|m4a)$",
    re.IGNORECASE,
)
CA_BUNDLE = "opt/cover-runtime/lib/python3.12/site-packages/pip/_vendor/certifi/cacert.pem"
PROTECTED_ROOT = re.compile(r"(?:probe|workspace|volume[0-9]+)(?:/|$)", re.IGNORECASE)


class LayerAuditError(Exception):
    """A fixed diagnostic code. Archive names and payloads stay private."""


def normalized_path(name, *, root_allowed=False):
    if (not name or len(name) > 4096 or name.startswith("/") or "\\" in name or ":" in name or
            not name.isprintable()):
        raise LayerAuditError("INVALID_LAYER_PATH")
    if name.startswith("./"):
        name = name[2:]
    name = name.removesuffix("/")
    if root_allowed and name in ("", "."):
        return ""
    if any(part in ("", ".", "..") for part in name.split("/")):
        raise LayerAuditError("INVALID_LAYER_PATH")
    return name


def sensitive(path, *, public_cert_link=False):
    if not path:
        return False
    leaf = path.rsplit("/", 1)[-1]
    if PROTECTED_ROOT.match(path) or any(SECRET_COMPONENT.fullmatch(part) for part in path.split("/")):
        return True
    if SENSITIVE_SUFFIX.search(leaf):
        return True
    # These certificate paths are supplied by the OS and pip, and contain public roots.
    return (leaf.lower().endswith(".pem") and path != CA_BUNDLE and
            not (public_cert_link and (path.startswith("etc/ssl/certs/") or path == "usr/lib/ssl/cert.pem")))


def verify_member(member):
    name = normalized_path(member.name, root_allowed=member.isdir())
    if not name:
        return name
    if not (member.isreg() or member.isdir() or member.issym() or member.islnk()):
        raise LayerAuditError("INVALID_LAYER_MEMBER")
    parent, leaf = posixpath.split(name)
    if leaf.startswith(".wh."):
        if not member.isreg() or member.size or leaf == ".wh.":
            raise LayerAuditError("INVALID_LAYER_MEMBER")
        name = parent if leaf == ".wh..wh..opq" else normalized_path(posixpath.join(parent, leaf[4:]))
    probe_mountpoint = name == "probe" and member.isdir()
    if not probe_mountpoint and sensitive(name, public_cert_link=member.issym()):
        raise LayerAuditError("UNEXPECTED_LAYER_FILES")
    if member.islnk() or member.issym():
        target = member.linkname
        if not target or len(target) > 4096 or "\\" in target or ":" in target or not target.isprintable():
            raise LayerAuditError("INVALID_LAYER_PATH")
        if member.issym():
            # Apt and the virtualenv use relative as well as container-absolute symlinks.
            target = target[1:] if target.startswith("/") else posixpath.join(parent, target)
            target = posixpath.normpath(target)
        target = normalized_path(target)
        if sensitive(target):
            raise LayerAuditError("UNEXPECTED_LAYER_FILES")
    return normalized_path(member.name)


class DigestReader:
    def __init__(self, source):
        self.source = source
        self.hash = hashlib.sha256()
        self.size = 0
        self.last_read = b""

    def read(self, length):
        data = self.source.read(length)
        self.size += len(data)
        if self.size > MAX_LAYER_BYTES:
            raise LayerAuditError("IMAGE_LAYER_LIMIT_EXCEEDED")
        self.hash.update(data)
        self.last_read = data
        return data


def verify_layer(file, expected_digest):
    compressed = file.read(2) == b"\x1f\x8b"
    file.seek(0)
    with gzip.GzipFile(fileobj=file) if compressed else nullcontext(file) as data:
        reader = DigestReader(data)
        encountered = set()
        # Single-block reads preserve the actual end marker even when tarfile
        # accepts an invalid trailing header after one or more valid entries.
        with tarfile.open(fileobj=reader, mode="r|", bufsize=tarfile.BLOCKSIZE) as layer:
            for header_count, member in enumerate(layer, 1):
                if header_count > MAX_HEADERS:
                    raise LayerAuditError("IMAGE_LAYER_LIMIT_EXCEEDED")
                name = verify_member(member)
                if name in encountered:
                    raise LayerAuditError("DUPLICATE_LAYER_MEMBER")
                encountered.add(name)
        if reader.last_read != bytes(tarfile.BLOCKSIZE):
            raise LayerAuditError("INVALID_LAYER_TRAILER")
        padding_bytes = 0
        while chunk := reader.read(64 * 1024):
            if chunk.strip(b"\0"):
                raise LayerAuditError("INVALID_LAYER_TRAILER")
            padding_bytes += len(chunk)
        if padding_bytes < tarfile.BLOCKSIZE:
            raise LayerAuditError("INVALID_LAYER_TRAILER")
        if "sha256:" + reader.hash.hexdigest() != expected_digest:
            raise LayerAuditError("IMAGE_ARCHIVE_LAYER_MISMATCH")
        return len(encountered)


def read_metadata(archive, entries, name):
    member = entries.get(name)
    if not member or not member.isfile() or member.size > MAX_METADATA_BYTES:
        raise LayerAuditError("INVALID_IMAGE_ARCHIVE")
    with archive.extractfile(member) as file:
        contents = file.read()
    return contents, json.loads(contents)


def audit_archive(path, inspect, expected_tag, base_layers):
    if Path(path).stat().st_size > MAX_ARCHIVE_BYTES:
        raise LayerAuditError("IMAGE_ARCHIVE_LIMIT_EXCEEDED")
    if not isinstance(inspect, list) or len(inspect) != 1 or not isinstance(inspect[0], dict):
        raise LayerAuditError("IMAGE_ARCHIVE_CONFIG_MISMATCH")
    image_id = inspect[0].get("Id")
    diff_ids = inspect[0].get("RootFS", {}).get("Layers")
    if (not isinstance(image_id, str) or not DIGEST.fullmatch(image_id) or type(base_layers) is not int or
            not isinstance(diff_ids, list) or not 0 < base_layers < len(diff_ids) or
            any(not isinstance(value, str) or not DIGEST.fullmatch(value) for value in diff_ids)):
        raise LayerAuditError("IMAGE_ARCHIVE_CONFIG_MISMATCH")

    with tarfile.open(path, mode="r:") as archive:
        entries = {}
        for member in archive:
            name = normalized_path(member.name, root_allowed=member.isdir())
            if len(entries) >= 256 or name in entries or not (member.isfile() or member.isdir()):
                raise LayerAuditError("INVALID_IMAGE_ARCHIVE")
            entries[name] = member

        _, manifest = read_metadata(archive, entries, "manifest.json")
        if not isinstance(manifest, list) or len(manifest) != 1 or not isinstance(manifest[0], dict):
            raise LayerAuditError("IMAGE_ARCHIVE_MANIFEST_MISMATCH")
        entry = manifest[0]
        config_ref = entry.get("Config")
        layers = entry.get("Layers")
        if (entry.get("RepoTags") != [expected_tag] or not isinstance(config_ref, str) or
                not CONFIG_REF.fullmatch(config_ref) or not isinstance(layers, list) or
                len(layers) != len(diff_ids) or
                any(not isinstance(ref, str) or not LAYER_REF.fullmatch(ref) or ref not in entries or
                    not entries[ref].isfile() for ref in layers) or len(set(layers)) != len(layers)):
            raise LayerAuditError("IMAGE_ARCHIVE_MANIFEST_MISMATCH")

        config_bytes, config = read_metadata(archive, entries, config_ref)
        if ("sha256:" + hashlib.sha256(config_bytes).hexdigest() != image_id or not isinstance(config, dict) or
                config.get("rootfs") != {"type": "layers", "diff_ids": diff_ids}):
            raise LayerAuditError("IMAGE_ARCHIVE_CONFIG_MISMATCH")

        headers = 0
        for ref, digest in zip(layers[base_layers:], diff_ids[base_layers:]):
            with archive.extractfile(entries[ref]) as layer:
                headers += verify_layer(layer, digest)
        return {"auditedLayerCount": len(layers) - base_layers, "layerHeaderCount": headers}


def main():
    try:
        archive, inspect_path, tag, base_layers = sys.argv[1:]
        with open(inspect_path, encoding="utf-8") as file:
            inspect = json.load(file)
        print(json.dumps({"ok": True, **audit_archive(archive, inspect, tag, int(base_layers))}))
    except LayerAuditError as error:
        print(json.dumps({"ok": False, "problem": str(error)}))
        return 1
    except (AttributeError, EOFError, OSError, TypeError, ValueError, tarfile.TarError, zlib.error):
        print(json.dumps({"ok": False, "problem": "INVALID_IMAGE_ARCHIVE"}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
