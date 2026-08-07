$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($env:NEXTEST_ENV)) {
  throw 'nextest did not provide NEXTEST_ENV; refusing to run an unobservable DNS control'
}

$bypass = '*'
Add-Content -LiteralPath $env:NEXTEST_ENV -Value "NO_PROXY=$bypass" -Encoding Ascii
Add-Content -LiteralPath $env:NEXTEST_ENV -Value "no_proxy=$bypass" -Encoding Ascii
