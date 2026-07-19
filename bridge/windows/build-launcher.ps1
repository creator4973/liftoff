$ErrorActionPreference = 'Stop'

$packageRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $PSScriptRoot 'LiftOffLauncher.cs'
$output = Join-Path $packageRoot 'LiftOff.exe'
$iconPng = Join-Path $packageRoot 'public\icons\liftoff-icon.png'
$icon = Join-Path $PSScriptRoot 'liftoff.ico'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path $compiler)) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}

if (-not (Test-Path $compiler)) {
    throw 'The Windows .NET Framework C# compiler was not found.'
}

if (Test-Path $iconPng) {
    $png = [IO.File]::ReadAllBytes($iconPng)
    $stream = [IO.MemoryStream]::new()
    $writer = [IO.BinaryWriter]::new($stream)
    $writer.Write([byte[]](0, 0, 1, 0, 1, 0))
    $writer.Write([byte[]](0, 0, 0, 0))
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$png.Length)
    $writer.Write([UInt32]22)
    $writer.Write($png)
    $writer.Flush()
    [IO.File]::WriteAllBytes($icon, $stream.ToArray())
    $writer.Dispose()
    $stream.Dispose()
}

$arguments = @(
    '/nologo',
    '/target:winexe',
    '/optimize+',
    "/out:$output",
    '/reference:System.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll'
)

if (Test-Path $icon) {
    $arguments += "/win32icon:$icon"
}

$arguments += $source
& $compiler @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Launcher compilation failed with exit code $LASTEXITCODE."
}

Write-Host "Built $output"
