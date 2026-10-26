$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$pythonExe = Join-Path $projectRoot 'work\chunking-venv\Scripts\python.exe'
$lifecycleScript = Join-Path $PSScriptRoot 'lifecycle.py'
& $pythonExe -X utf8 $lifecycleScript stop
exit $LASTEXITCODE
