' AILens 8765 panel watchdog - legacy launcher.
' Since 2026-10-03 the panel check is merged into llm-gateway-watch.mjs
' (the AILensPanelWatch task was deleted), so this file is normally unused.
' Kept working anyway: node.exe is resolved at runtime instead of being
' hardcoded to a WorkBuddy Node version folder that upgrades delete.
Set fso  = CreateObject("Scripting.FileSystemObject")
base     = fso.GetParentFolderName(WScript.ScriptFullName)

Set ts   = fso.OpenTextFile(fso.BuildPath(base, "tools\resolve-node.vbs"), 1)
lib      = ts.ReadAll
ts.Close
ExecuteGlobal lib

node = ResolveNode()
If node = "" Then
  On Error Resume Next
  Set lf = fso.OpenTextFile(fso.BuildPath(base, "panel-watch.log"), 8, True)
  lf.WriteLine Now & "  node.exe not found (set AILENS_NODE or check %USERPROFILE%\.workbuddy\binaries\node\versions)"
  lf.Close
  On Error GoTo 0
  WScript.Quit 1
End If

script = fso.BuildPath(base, "panel-watch.mjs")
If fso.FileExists(script) Then
  CreateObject("WScript.Shell").Run """" & node & """ """ & script & """", 0, False
Else
  On Error Resume Next
  Set lf = fso.OpenTextFile(fso.BuildPath(base, "panel-watch.log"), 8, True)
  lf.WriteLine Now & "  panel-watch.mjs missing - panel check now lives in llm-gateway-watch.mjs"
  lf.Close
  On Error GoTo 0
End If
