# Generate all site icons + og-image from a single square source image.
# Usage: powershell -ExecutionPolicy Bypass -File site/tools/make-icons.ps1 -Source <path-to-png>
# Writes into site/assets/: icon-64, icon-192, icon-512, apple-touch-icon (180), og-image (1200x630).
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [string]$OutDir
)
if (-not $OutDir) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $OutDir = Join-Path $scriptDir "..\assets"
}
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($Source)
Write-Host ("source: {0}x{1}" -f $src.Width, $src.Height)

function Resize-Square([System.Drawing.Image]$img, [int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Black) # source art has pure-black background
  $g.DrawImage($img, 0, 0, $size, $size)
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host ("wrote {0} ({1}x{1})" -f $path, $size)
}

Resize-Square $src 64  (Join-Path $OutDir "icon-64.png")
Resize-Square $src 192 (Join-Path $OutDir "icon-192.png")
Resize-Square $src 512 (Join-Path $OutDir "icon-512.png")
Resize-Square $src 180 (Join-Path $OutDir "apple-touch-icon.png")
function Save-Jpeg([System.Drawing.Bitmap]$bmp, [string]$path, [int]$quality) {
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
  $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
  $bmp.Save($path, $codec, $params)
  $params.Dispose()
  Write-Host ("wrote {0} (q{1})" -f $path, $quality)
}

# Hero mascot: 1024px JPEG q90 — the art is opaque on pure black, JPEG is ~10x lighter.
$mascot = New-Object System.Drawing.Bitmap(1024, 1024)
$g = [System.Drawing.Graphics]::FromImage($mascot)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Black)
$g.DrawImage($src, 0, 0, 1024, 1024)
$g.Dispose()
Save-Jpeg $mascot (Join-Path $OutDir "trex-mascot.jpg") 90
$mascot.Dispose()

# og-image 1200x630: artwork centered on a seamless black canvas.
$og = New-Object System.Drawing.Bitmap(1200, 630)
$g = [System.Drawing.Graphics]::FromImage($og)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Black)
$d = 580
$g.DrawImage($src, [int]((1200 - $d) / 2), [int]((630 - $d) / 2), $d, $d)
$g.Dispose()
Save-Jpeg $og (Join-Path $OutDir "og-image.jpg") 90
$og.Dispose()
$src.Dispose()
