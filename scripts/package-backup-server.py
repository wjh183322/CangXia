"""Append the current service sources to an existing trusted docker-save image.

The base archive already includes Node 24, OpenSSL and the Linux/amd64 runtime.
No executable is run and no service data or credentials enter the image.
"""
import argparse
import hashlib
import io
import json
import tarfile
import time
from pathlib import Path


def item(archive, name, data):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mtime = 0
    info.mode = 0o644
    archive.addfile(info, io.BytesIO(data))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--tag', default='cangxia-backup-server:0.2.1')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    layer = io.BytesIO()
    with tarfile.open(fileobj=layer, mode='w') as archive:
        for folder in ['backup-server', 'shared']:
            for file in sorted((root / folder).glob('*')):
                if file.is_file():
                    item(archive, 'app/' + file.relative_to(root).as_posix(), file.read_bytes())
    data = layer.getvalue()
    sha = hashlib.sha256(data).hexdigest()
    layer_name = sha + '/layer.tar'
    with tarfile.open(args.base, 'r:*') as source:
        manifest = json.load(source.extractfile('manifest.json'))
        if len(manifest) != 1:
            raise ValueError('Expected exactly one base image')
        original = manifest[0]
        config = json.load(source.extractfile(original['Config']))
        if config['architecture'] != 'amd64' or config['os'] != 'linux':
            raise ValueError('Unexpected base platform')
        if config['config']['Cmd'] != ['node', 'backup-server/index.mjs']:
            raise ValueError('Unexpected base entry point')
        config['rootfs']['diff_ids'].append('sha256:' + sha)
        config.setdefault('history', []).append({'created_by': 'CangXia source update ' + args.tag})
        serialized = json.dumps(config, separators=(',', ':')).encode()
        config_name = hashlib.sha256(serialized).hexdigest() + '.json'
        updated = {**original, 'Config': config_name, 'RepoTags': [args.tag], 'Layers': original['Layers'] + [layer_name]}
        with tarfile.open(args.output, 'w') as output:
            for entry in source:
                if entry.name in ['manifest.json', 'repositories']:
                    continue
                output.addfile(entry, source.extractfile(entry) if entry.isfile() else None)
            item(output, layer_name, data)
            item(output, sha + '/VERSION', b'1.0')
            item(output, config_name, serialized)
            item(output, 'manifest.json', json.dumps([updated]).encode())
    # Verify the new image's payload and layer digest before delivery.
    with tarfile.open(args.output, 'r:') as archive:
        actual = archive.extractfile(layer_name).read()
        if hashlib.sha256(actual).hexdigest() != sha:
            raise ValueError('Layer checksum mismatch')
        with tarfile.open(fileobj=io.BytesIO(actual), mode='r:') as payload:
            for file in (root / 'backup-server').glob('*.mjs'):
                if payload.extractfile('app/backup-server/' + file.name).read() != file.read_bytes():
                    raise ValueError('Service source mismatch')
    print(json.dumps({'tag': args.tag, 'platform': 'linux/amd64', 'verified': True, 'bytes': Path(args.output).stat().st_size}))


if __name__ == '__main__':
    main()
