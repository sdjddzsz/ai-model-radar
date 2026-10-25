' AILens gateway watchdog entry (scheduled task AILensGatewayWatch, every minute).
' Run(..., 0, False) = hidden window, async - the task was built on this entry
' because it never flashes a console window (see llm-gateway-watch.mjs header).
'
' node.exe is resolved at runtime (tools\resolve-node.vbs): WorkBuddy rotates
' its managed Node folder on every upgrade, so a hardcoded version path used to
' break with WSH error 80070002 ("system cannot find the file specified").
' The real watchdog logic lives in llm-gateway-watch.mjs.
Set fso  = CreateObject("Scripting.FileSystemObject")
base     = fso.GetParentFolderName(WScript.ScriptFullName)

Set ts   = fso.OpenTextFile(fso.BuildPath(base, "tools\resolve-node.vbs"), 1)
lib      = ts.ReadAll
ts.Close
ExecuteGlobal lib

node = ResolveNode()
If node = "" Then
  ' Never pop a dialog here: this entry runs every minute. Log quietly and go.
  On Error Resume Next
  Set lf = fso.OpenTextFile(fso.BuildPath(base, "gateway-watch-error.log"), 8, True)
  lf.WriteLine Now & "  node.exe not found (set AILENS_NODE or check %USERPROFILE%\.workbuddy\binaries\node\versions)"
  lf.Close
  On Error GoTo 0
  WScript.Quit 1
End If

script = fso.BuildPath(base, "llm-gateway-watch.mjs")
CreateObject("WScript.Shell").Run """" & node & """ """ & script & """", 0, False
