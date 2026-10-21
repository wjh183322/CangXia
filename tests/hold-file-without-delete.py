import ctypes,sys
from ctypes import wintypes
kernel=ctypes.WinDLL('kernel32',use_last_error=True)
kernel.CreateFileW.argtypes=[wintypes.LPCWSTR,wintypes.DWORD,wintypes.DWORD,wintypes.LPVOID,wintypes.DWORD,wintypes.DWORD,wintypes.HANDLE]
kernel.CreateFileW.restype=wintypes.HANDLE
kernel.CloseHandle.argtypes=[wintypes.HANDLE]
handle=kernel.CreateFileW(sys.argv[1],0x80000000,3,None,3,0x80,None)
if handle==wintypes.HANDLE(-1).value:
 raise ctypes.WinError(ctypes.get_last_error())
try:
 print('READY',flush=True)
 sys.stdin.readline()
finally:
 kernel.CloseHandle(handle)
