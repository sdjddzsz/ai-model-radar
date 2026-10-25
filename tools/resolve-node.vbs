' ============================================================
'  resolve-node.vbs - reusable VBScript helper (no side effects).
'
'  Why: WorkBuddy rotates its managed Node folder on every upgrade
'  (e.g. versions\22.22.2-3 -> versions\22.22.2-6) and deletes the
'  old one, so a hardcoded version path breaks with Windows Script
'  Host error 80070002. Resolve the path at runtime instead.
'
'  Use it like this:
'     Set fso  = CreateObject("Scripting.FileSystemObject")
'     base     = fso.GetParentFolderName(WScript.ScriptFullName)
'     ExecuteGlobal fso.OpenTextFile(fso.BuildPath(base, "tools\resolve-node.vbs"), 1).ReadAll
'     node = ResolveNode()          ' "" when nothing usable was found
'
'  Lookup order:
'    1) env var AILENS_NODE
'    2) versions\current   (WorkBuddy writes the active version)
'    3) newest subfolder of versions\ that contains node.exe
' ============================================================
Function ResolveNode()
  Dim fso, sh, base, ver, p, f, best, bestT
  ResolveNode = ""
  Set fso = CreateObject("Scripting.FileSystemObject")
  Set sh  = CreateObject("WScript.Shell")

  ' --- 1) explicit override -----------------------------------
  p = sh.ExpandEnvironmentStrings("%AILENS_NODE%")
  If p <> "%AILENS_NODE%" Then
    If fso.FileExists(p) Then
      ResolveNode = p
      Exit Function
    End If
  End If

  base = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.workbuddy\binaries\node\versions"

  ' --- 2) version manifest maintained by WorkBuddy ------------
  If fso.FileExists(base & "\current") Then
    On Error Resume Next
    ver = fso.OpenTextFile(base & "\current", 1).ReadAll
    On Error GoTo 0
    ver = Replace(Replace(Replace(ver, vbCr, ""), vbLf, ""), " ", "")
    If Len(ver) > 0 Then
      If fso.FileExists(base & "\" & ver & "\node.exe") Then
        ResolveNode = base & "\" & ver & "\node.exe"
        Exit Function
      End If
    End If
  End If

  ' --- 3) newest version folder --------------------------------
  If fso.FolderExists(base) Then
    For Each f In fso.GetFolder(base).SubFolders
      p = f.Path & "\node.exe"
      If fso.FileExists(p) Then
        If IsEmpty(bestT) Then
          best = p
          bestT = f.DateLastModified
        ElseIf DateDiff("s", bestT, f.DateLastModified) > 0 Then
          best = p
          bestT = f.DateLastModified
        End If
      End If
    Next
  End If

  If Not IsEmpty(bestT) Then ResolveNode = best
End Function
