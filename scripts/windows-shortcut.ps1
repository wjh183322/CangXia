# Native Unicode Shell Link target reader used by both installed-edition smoke checks.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

public static class EditionShortcut
{
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink {}

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW
    {
        [PreserveSig]
        int GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path,
            int capacity, IntPtr findData, uint flags);
    }

    public static string ReadTarget(string shortcut)
    {
        const uint RawPath = 4;
        object link = new ShellLink();
        try
        {
            ((IPersistFile)link).Load(shortcut, 0);
            var target = new StringBuilder(32768);
            int result = ((IShellLinkW)link).GetPath(target, target.Capacity, IntPtr.Zero, RawPath);
            Marshal.ThrowExceptionForHR(result);
            return result == 0 ? target.ToString() : "";
        }
        finally
        {
            Marshal.ReleaseComObject(link);
        }
    }
}
'@

function Assert-ShortcutTarget([string]$shortcut, [string]$expected) {
  if (!(Test-Path -LiteralPath $shortcut -PathType Leaf)) { throw "Missing shortcut: $shortcut" }
  try {
    $target = [EditionShortcut]::ReadTarget($shortcut)
  } catch {
    $failure = $_.Exception.GetBaseException()
    $size = (Get-Item -LiteralPath $shortcut).Length
    throw "Unicode Shell Link reader could not load $shortcut ($size bytes, HRESULT $('0x{0:X8}' -f $failure.HResult)): $($failure.Message)"
  }
  if ([string]::IsNullOrWhiteSpace($target)) { throw "Shortcut has no filesystem target: $shortcut" }
  if (!(Test-Path -LiteralPath $target -PathType Leaf)) { throw "Broken shortcut: $shortcut points to missing file $target" }
  if ($target -ne $expected) { throw "Wrong shortcut target: $shortcut points to $target, expected $expected" }
}
