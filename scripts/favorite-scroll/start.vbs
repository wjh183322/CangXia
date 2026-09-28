Option Explicit
Dim fs, shell, root, node, command
Set fs = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fs.GetParentFolderName(fs.GetParentFolderName(fs.GetParentFolderName(WScript.ScriptFullName)))
node = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fs.FileExists(node) Then
  MsgBox "Node.js 24+ is required.", 16, "Favorite Scroll"
  WScript.Quit 1
End If
shell.CurrentDirectory = root
command = Chr(34) & node & Chr(34) & " " & Chr(34) & root & "\scripts\favorite-scroll\launch.mjs" & Chr(34)
shell.Run command, 0, False
