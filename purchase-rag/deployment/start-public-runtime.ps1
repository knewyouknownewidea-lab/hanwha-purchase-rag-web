$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ragRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoRoot = [IO.Path]::GetFullPath((Join-Path $ragRoot '..'))
$pythonCandidates = @(
    (Join-Path $repoRoot 'work\chunking-venv\Scripts\python.exe'),
    (Join-Path $repoRoot '..\.venv-scope-tests\Scripts\python.exe')
)
$runtimePython = $pythonCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (!$runtimePython) { throw 'RAG Python environment is missing. Install backend requirements first.' }
Push-Location -LiteralPath $ragRoot
try {
    # Python decrypts the existing Windows-user DPAPI file in memory. No secret arguments.
    & $runtimePython -X utf8 -m deployment.local_runtime --public @args
    $runtimeExit = $LASTEXITCODE
}
finally { Pop-Location }
exit $runtimeExit
