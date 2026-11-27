"""Build the self-contained, pinned first-install kit for a given NAS IPv4 address."""
import argparse
from ipaddress import IPv4Address
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

source = Path(__file__).resolve().parent
repo = source.parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("address", type=IPv4Address)
parser.add_argument("output", type=Path)
args = parser.parse_args()
project = "cangxia-server-041-rc"
files = {
    name: (source / name).read_text(encoding="utf-8").replace("NAS_HOST", str(args.address)).encode()
    for name in ["compose.yaml", "安装说明.txt"]
}
files["prepare.mjs"] = (source / "prepare.mjs").read_text(encoding="utf-8").encode()
files["install/first-install"] = (project + "\n").encode()
for name in ["chromium-seccomp.json", "chromium-seccomp.LICENSE"]:
    files[name] = (repo / "feasibility/nas-b" / name).read_bytes()
with ZipFile(args.output, "x") as archive:
    for name, data in files.items():
        entry = ZipInfo(f"{project}/{name}")
        entry.create_system = 3
        entry.external_attr = 0o100644 << 16
        archive.writestr(entry, data, compress_type=ZIP_DEFLATED)
