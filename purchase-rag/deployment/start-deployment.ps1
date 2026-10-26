$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$runtimeDir = Join-Path $projectRoot 'work\deployment-runtime'
$pythonExe = Join-Path $projectRoot 'work\chunking-venv\Scripts\python.exe'
$lifecycleScript = Join-Path $PSScriptRoot 'lifecycle.py'
$tokenFile = Join-Path $runtimeDir 'gateway-token.dat'
$oldToken = $env:RAG_GATEWAY_TOKEN
$lifecycleExit = 1
try {
    if (!(Test-Path -LiteralPath $tokenFile -PathType Leaf)) { throw 'Missing encrypted token' }
    $encryptedToken = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
    $secureToken = ConvertTo-SecureString -String $encryptedToken
    $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    try { $env:RAG_GATEWAY_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer) }
    & $pythonExe -X utf8 $lifecycleScript start
    $lifecycleExit = $LASTEXITCODE
}
catch { Write-Host '시작하지 못했습니다. 원래 Windows 계정의 암호화 토큰과 실행 파일을 확인하세요.' }
finally {
    if ($null -eq $oldToken) { Remove-Item Env:RAG_GATEWAY_TOKEN -ErrorAction SilentlyContinue }
    else { $env:RAG_GATEWAY_TOKEN = $oldToken }
    $encryptedToken = $null
    $secureToken = $null
}
exit $lifecycleExit
