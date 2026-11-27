"""Pin registered media while the desktop OpenCV matcher opens its inputs."""
from contextlib import ExitStack, contextmanager
import hashlib
import json
import os
from pathlib import Path
import runpy
import sys


@contextmanager
def pinned(asset):
    name = asset['file']
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        import msvcrt
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        create = kernel.CreateFileW
        create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                           wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        create.restype = wintypes.HANDLE
        # FILE_SHARE_READ excludes both replacement and in-place writers.
        handle = create(name, 0x80000000, 1, None, 3, 0x00200000, None)
        if handle == ctypes.c_void_p(-1).value:
            raise OSError('input_changed')
        fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
    else:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(fd)
        if not os.path.samestat(before, os.lstat(name)) or before.st_nlink != 1 or before.st_size != asset['size']:
            raise ValueError('input_changed')
        if hashlib.file_digest(stream, 'sha256').hexdigest() != asset['sha256']:
            raise ValueError('input_changed')
        stream.seek(0)
        # OpenCV opens its own handle. procfs resolves this exact open inode.
        yield name if os.name == 'nt' else '/proc/self/fd/' + str(fd)
        after = os.fstat(fd)
        if (not os.path.samestat(before, os.lstat(name)) or after.st_nlink != 1 or
                (before.st_size, before.st_ctime_ns, before.st_mtime_ns) !=
                (after.st_size, after.st_ctime_ns, after.st_mtime_ns)):
            raise ValueError('input_changed')


def main(request):
    original = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'scripts' / 'cover-frame.py'))
    with ExitStack() as stack:
        video = stack.enter_context(pinned(request['video']))
        if request.get('mode') == 'probe':
            cap = original['cv2'].VideoCapture(video)
            try:
                if not cap.isOpened():
                    raise ValueError('video_decode_failed')
                cv2 = original['cv2']
                return {'width': int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), 'height': int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))}
            finally:
                cap.release()
        cover = stack.enter_context(pinned(request['reference']))
        return original['match_cover'](video, cover, request['output'])


if __name__ == '__main__':
    try:
        result = main(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')))
        print(json.dumps({'ok': True, **result}), flush=True)
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}), flush=True)
        sys.exit(1)
