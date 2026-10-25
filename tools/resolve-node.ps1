# ============================================================
#  resolve-node.ps1 - reusable PowerShell helper (no side effects).
#
#  Why: WorkBuddy rotates its managed Node folder on every upgrade
#  (e.g. versions\22.22.2-3 -> versions\22.22.2-6) and deletes the
#  old one, so a hardcoded version path breaks with Windows Script
#  Host error 80070002. Resolve the path at runtime instead.
#
#  Use it like this:
#      . (Join-Path $PSScriptRoot 'tools\resolve-node.ps1')
#      $node = Resolve-AilensNode     # $null when nothing usable was found
#
#  Lookup order:
#    1) env var AILENS_NODE
#    2) versions\current   (WorkBuddy writes the active version)
#    3) newest subfolder of versions\ that contains node.exe
#    4) node.exe found on PATH
# ============================================================
function Resolve-AilensNode {
    if ($env:AILENS_NODE -and (Test-Path -LiteralPath $env:AILENS_NODE)) { return $env:AILENS_NODE }

    $base = Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions'

    # version manifest maintained by WorkBuddy (plain text file, no newline)
    $cur = Join-Path $base 'current'
    if (Test-Path -LiteralPath $cur) {
        $ver = ((Get-Content -LiteralPath $cur -Raw) -replace '\s', '')
        if ($ver) {
            $p = Join-Path $base (Join-Path $ver 'node.exe')
            if (Test-Path -LiteralPath $p) { return $p }
        }
    }

    # newest version folder that actually holds node.exe
    $cand = Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            ForEach-Object { Join-Path $_.FullName 'node.exe' } |
            Where-Object { Test-Path -LiteralPath $_ } |
            Select-Object -First 1
    if ($cand) { return $cand }

    # last resort: whatever PATH has
    $g = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($g) { return $g.Source }

    return $null
}
