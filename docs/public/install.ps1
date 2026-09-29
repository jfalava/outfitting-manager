$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'This installer is for Windows PowerShell.'
}

if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [System.Runtime.InteropServices.Architecture]::X64) {
    throw 'The outfitting-manager CLI installer supports Windows x64.'
}

$repository = 'jfalava/outfitting-manager'
$archiveName = 'outfitting-manager-windows-x64.zip'
$headers = @{
    Accept = 'application/vnd.github+json'
    'User-Agent' = 'outfitting-manager-installer'
    'X-GitHub-Api-Version' = '2022-11-28'
}
$releases = @(Invoke-RestMethod -Uri "https://api.github.com/repos/$repository/releases?per_page=30" -Headers $headers)
$matchingReleases = @(
    $releases | Where-Object {
        $assetNames = @($_.assets | ForEach-Object { $_.name })
        $_.draft -eq $false -and
        $_.prerelease -eq $false -and
        $_.tag_name -match '^cli-v\d+\.\d+\.\d+$' -and
        $assetNames -contains $archiveName -and
        $assetNames -contains "$archiveName.sha256"
    }
)
$release = $matchingReleases |
    Sort-Object -Property { [version]($_.tag_name.Substring(5)) } -Descending |
    Select-Object -First 1

if ($null -eq $release) {
    throw "No stable release with $archiveName and its SHA-256 file was found."
}

$archiveAsset = $release.assets | Where-Object { $_.name -eq $archiveName } | Select-Object -First 1
$checksumAsset = $release.assets | Where-Object { $_.name -eq "$archiveName.sha256" } | Select-Object -First 1
$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "outfitting-manager-install-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
$stagedBinary = $null

try {
    $archivePath = Join-Path $temporaryDirectory $archiveName
    $checksumPath = "$archivePath.sha256"
    Invoke-WebRequest -Uri $archiveAsset.browser_download_url -OutFile $archivePath -Headers $headers
    Invoke-WebRequest -Uri $checksumAsset.browser_download_url -OutFile $checksumPath -Headers $headers

    $checksumText = Get-Content -LiteralPath $checksumPath -Raw
    if ($checksumText -notmatch '(?im)^\s*([0-9a-f]{64})(?:\s|$)') {
        throw "Invalid SHA-256 file for $archiveName."
    }
    $expectedHash = $Matches[1].ToLowerInvariant()
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "SHA-256 verification failed for $archiveName."
    }

    $extractDirectory = Join-Path $temporaryDirectory 'extracted'
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDirectory
    $sourceBinary = Join-Path $extractDirectory 'outfitting-manager.exe'
    if (-not (Test-Path -LiteralPath $sourceBinary -PathType Leaf)) {
        throw 'The release archive does not contain outfitting-manager.exe.'
    }

    $installDirectory = Join-Path $env:LOCALAPPDATA 'Programs\OutfittingManager'
    New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
    $binaryPath = Join-Path $installDirectory 'outfitting-manager.exe'
    $stagedBinary = Join-Path $installDirectory ".outfitting-manager-$PID.exe"
    Copy-Item -LiteralPath $sourceBinary -Destination $stagedBinary -Force
    Move-Item -LiteralPath $stagedBinary -Destination $binaryPath -Force

    $normalizedInstallDirectory = [System.IO.Path]::GetFullPath($installDirectory).TrimEnd('\')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $userPathEntries = @($userPath -split ';' | ForEach-Object { $_.Trim().TrimEnd('\') } | Where-Object { $_ })
    $pathAlreadySet = $userPathEntries | Where-Object {
        [string]::Equals($_, $normalizedInstallDirectory, [System.StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -First 1
    if (-not $pathAlreadySet) {
        $updatedUserPath = if ([string]::IsNullOrWhiteSpace($userPath)) {
            $installDirectory
        } else {
            "$userPath;$installDirectory"
        }
        [Environment]::SetEnvironmentVariable('Path', $updatedUserPath, 'User')
    }

    $currentPathEntries = @($env:Path -split ';' | ForEach-Object { $_.Trim().TrimEnd('\') })
    $currentPathHasInstallDirectory = $currentPathEntries | Where-Object {
        [string]::Equals($_, $normalizedInstallDirectory, [System.StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -First 1
    if (-not $currentPathHasInstallDirectory) {
        $env:Path = "$installDirectory;$env:Path"
    }

    Write-Host "Installed outfitting-manager $($release.tag_name.Substring(5)) to $binaryPath"
    Write-Host 'Added the install folder to your user PATH.'
}
finally {
    if ($stagedBinary) {
        Remove-Item -LiteralPath $stagedBinary -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
