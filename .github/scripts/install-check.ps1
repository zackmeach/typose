# The Windows installer end to end, for CI's Windows runner (test.yml's installer step) only: it installs into the
# current user's profile and registry. It installs silently, then checks that:
#   - the install is per user;
#   - Typose.exe's version resource names Typose, its version and its publisher;
#   - Typose is under OpenWithProgids for exactly the types app/build/installer.nsh lists. It's no type's class, and the
#     install writes no type's default value or user choice (UserChoice). For a type with no user choice, Windows itself
#     may now open Typose (the only app registered, or the only one besides a perceived-type fallback) or ask which app
#     to use: the check prints each type's app before the install and after it;
#   - Electron's WER module is left out, and the third-party notices ship;
#   - the open command the registration names launches Typose, which opens the .jsonl it names;
#   - installing again over the install (the upgrade path: the old uninstaller runs first) leaves the same registration;
#   - an uninstall removes the registration, and leaves each type's key exactly as it was before the install.
# Every check prints ok or FAIL, and any FAIL exits 1. Keep this file ASCII: Windows PowerShell 5.1 reads it as ANSI.
param([string]$Installer = (Resolve-Path "$PSScriptRoot/../../app/dist/Typose-*-setup.exe").Path)
$ErrorActionPreference = 'Stop'
if (-not $env:GITHUB_ACTIONS) { throw "install-check.ps1 runs on CI only: it installs into the current user's profile" }
$types = 'md', 'markdown', 'txt', 'log', 'csv', 'tsv', 'json', 'jsonc', 'jsonl', 'ndjson', 'yaml', 'yml' # installer.nsh's
$progId = 'Typose.File'
$classes = 'HKCU:\Software\Classes'
$uninstall = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
$script:failed = 0
function Check([bool]$ok, [string]$what) {
  if ($ok) { Write-Host "ok: $what" } else { Write-Host "FAIL: $what"; $script:failed++ }
}
function Entry { Get-ChildItem $uninstall -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object DisplayName -like 'Typose*' }
# The extensions whose OpenWithProgids names Typose's class.
function Registered {
  Get-ChildItem -LiteralPath $classes -Name | Where-Object {
    $_.StartsWith('.') -and (Get-ItemProperty -LiteralPath "$classes\$_\OpenWithProgids" -Name $progId -ErrorAction SilentlyContinue)
  } | ForEach-Object { $_.Substring(1) } | Sort-Object
}
Add-Type -Namespace Win32 -Name Assoc -MemberDefinition @'
[DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
public static extern int AssocQueryString(int flags, int str, string assoc, string extra, System.Text.StringBuilder outBuf, ref int outLen);
'@
# What opens a type when it's double-clicked, as the shell resolves it (the user's choice first). ASSOCF_INIT_IGNOREUNKNOWN
# (0x400): a type nothing is associated with answers nothing, not the Open With dialog. ASSOCSTR_EXECUTABLE (2). The verb
# is a real null, for the default verb: PowerShell passes $null to a string parameter as "", a verb nothing has.
function DefaultApp([string]$ext) {
  $out = [Text.StringBuilder]::new(1024)
  $length = 1024
  if ([Win32.Assoc]::AssocQueryString(0x400, 2, ".$ext", [NullString]::Value, $out, [ref]$length) -eq 0) { $out.ToString() } else { '(none)' }
}
# The class the user chose for a type in Open with's "Always", or '' if they never chose.
function UserChoice([string]$ext) {
  "$((Get-ItemProperty -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.$ext\UserChoice" -ErrorAction SilentlyContinue).ProgId)"
}
# A registry key's values and subkeys, theirs too, as one string; '-' when there's no key.
function Dump($key) {
  if (-not $key) { return '-' }
  $parts = @($key.GetValueNames() | Sort-Object | ForEach-Object { "$_=$($key.GetValueKind($_)):$($key.GetValue($_))" })
  $parts += @($key.GetSubKeyNames() | Sort-Object | ForEach-Object { "$_{$(Dump $key.OpenSubKey($_))}" })
  $parts -join ' '
}
$hkcu = [Microsoft.Win32.Registry]::CurrentUser
function TypeKey([string]$ext) { Dump $hkcu.OpenSubKey("Software\Classes\.$ext") }
function TypeDefault([string]$ext) { $found = $hkcu.OpenSubKey("Software\Classes\.$ext"); if ($found) { "$($found.GetValue(''))" } else { '' } }
# A registered command line, as its executable and its arguments with %1 replaced.
function Split-Command([string]$command, [string]$file) {
  if ($command -match '^"([^"]+)"\s*(.*)$') { $Matches[1], ($Matches[2] -replace '%1', $file) } else { $null, $null }
}

Check (-not (Entry) -and -not (Registered)) 'nothing is installed or registered before the install'
$app = @{}; $key = @{}; $default = @{}; $choice = @{} # each type before the install
foreach ($type in $types) { $app[$type] = DefaultApp $type; $key[$type] = TypeKey $type; $default[$type] = TypeDefault $type; $choice[$type] = UserChoice $type }
function Install([string]$what) {
  Write-Host "$what`: $Installer"
  $run = Start-Process $Installer -ArgumentList '/S' -Wait -PassThru
  Check ($run.ExitCode -eq 0) "the silent $what exits 0 (it exited $($run.ExitCode))"
}
# Typose under OpenWithProgids for installer.nsh's types, and no type's class, default value or user choice.
function Check-Registration([string]$when) {
  $registered = @(Registered)
  Check (($registered -join ' ') -eq (($types | Sort-Object) -join ' ')) "$when, Typose is under OpenWithProgids for exactly installer.nsh's types (found: $($registered -join ', '))"
  foreach ($type in $types) {
    $merged = [Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey(".$type")
    $class = if ($merged) { $merged.GetValue('') } else { $null }
    $now = TypeDefault $type
    $chosen = UserChoice $type
    Check ($class -ne $progId -and $now -eq $default[$type] -and $chosen -eq $choice[$type]) ("$when, .$type`: its class isn't Typose's ('$class'), " +
      "and its default value ('$now') and user choice ('$chosen') are as before; it opened with $($app[$type]) before the install, $(DefaultApp $type) now")
  }
}

Install 'install'
$entry = Entry
if (-not $entry) { Write-Host 'FAIL: no uninstall entry names Typose after the install'; exit 1 }
$uninstaller, $null = Split-Command $entry.UninstallString ''
$dir = Split-Path -Parent $uninstaller # the entry has no InstallLocation
Check ($entry.PSPath -like '*HKEY_CURRENT_USER*' -and $dir -like "$env:LOCALAPPDATA\*") "installed per user: uninstall entry $($entry.PSPath -replace '^.*::', ''), in $dir"
$version = (Get-Content -Raw -LiteralPath "$PSScriptRoot/../../app/package.json" | ConvertFrom-Json).version
$info = (Get-Item -LiteralPath "$dir\Typose.exe").VersionInfo
Check ($info.ProductName -eq 'Typose' -and $info.FileDescription -eq 'Typose' -and $info.FileVersion -eq $version -and $info.CompanyName -eq 'Typose contributors') ("Typose.exe's version resource: " +
  "ProductName '$($info.ProductName)', FileDescription '$($info.FileDescription)', FileVersion '$($info.FileVersion)', CompanyName '$($info.CompanyName)'")
Check-Registration 'after the install'

# What ships
Check (-not (Test-Path -LiteralPath "$dir\electron_wer.dll")) 'electron_wer.dll is left out'
Check (Test-Path -LiteralPath "$dir\resources\THIRD-PARTY-NOTICES.txt") 'resources\THIRD-PARTY-NOTICES.txt ships'

# Launch through the registered open command, as Explorer's Open with does
$command = (Get-ItemProperty -LiteralPath "$classes\$progId\shell\open\command" -ErrorAction SilentlyContinue).'(default)'
Check ($command -eq "`"$dir\Typose.exe`" `"%1`"") "the open command is `"<install dir>\Typose.exe`" `"%1`" (it's $command)"
$file = Join-Path ([IO.Path]::GetTempPath()) 'install-check.jsonl'
Set-Content -LiteralPath $file -Value '{"check":1}', '{"check":2}' -Encoding ascii
$exe, $arguments = Split-Command $command "$file"
$title = "install-check.jsonl $([char]0x2014) Typose"
$opened = $false
if ($exe) {
  $launch = @{ FilePath = $exe; PassThru = $true }
  if ($arguments) { $launch.ArgumentList = $arguments }
  $typose = Start-Process @launch
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $until = (Get-Date).AddSeconds(60)
  # Opened: the window names the file, and the card's JSONL status counts its two records parsed (renderer/card.ts's
  # jsonlCounts). The Rows view gives the records themselves no accessible text.
  while (-not $opened -and -not $typose.HasExited -and (Get-Date) -lt $until) {
    Start-Sleep -Milliseconds 500
    $typose.Refresh()
    if ($typose.MainWindowHandle -eq 0) { continue }
    $window = [Windows.Automation.AutomationElement]::FromHandle($typose.MainWindowHandle)
    $opened = $window.Current.Name -eq $title -and [bool]($window.FindAll([Windows.Automation.TreeScope]::Descendants,
      [Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.Name -like '2 lines * 2 parsed * 0 failed*' } | Select-Object -First 1)
  }
  $shown = if ($typose.HasExited) { "it exited $($typose.ExitCode)" } else { "its window is '$($typose.MainWindowTitle)'" }
  if (-not $typose.HasExited) {
    taskkill /PID $typose.Id | Out-Null # WM_CLOSE, as a user's close
    if (-not $typose.WaitForExit(15000)) { Stop-Process -Id $typose.Id -Force }
  }
}
Check $opened "the installed app opens a .jsonl named on its command line within 60 s ($shown)"

# Installing over an install runs the old version's uninstaller first, as an upgrade does.
Install 'reinstall'
Check-Registration 'after the reinstall'

# Uninstall
$exe, $arguments = Split-Command $entry.QuietUninstallString ''
Start-Process $exe -ArgumentList $arguments -Wait
# The uninstaller re-runs itself from a temporary copy, so the wait above can end first: its last step deletes the entry.
$until = (Get-Date).AddSeconds(120)
while ((Entry) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 500 }
Check (-not (Entry)) 'the uninstall removes its uninstall entry'
$left = @(Registered)
Check ($left.Count -eq 0) "after the uninstall no type lists Typose under OpenWithProgids (left: $($left -join ', '))"
Check (-not (Test-Path -LiteralPath "$classes\$progId")) "after the uninstall HKCU\Software\Classes\$progId is gone"
$changed = @($types | Where-Object { (TypeKey $_) -ne $key[$_] -or (UserChoice $_) -ne $choice[$_] } |
  ForEach-Object { ".$_ was '$($key[$_])' (user choice '$($choice[$_])'), is '$(TypeKey $_)' (user choice '$(UserChoice $_)')" })
Check ($changed.Count -eq 0) "after the uninstall each type's HKCU\Software\Classes key and user choice are exactly as before the install$(if ($changed) { ': ' + ($changed -join '; ') })"
Check (-not (Test-Path -LiteralPath $dir)) 'after the uninstall the install directory is gone'

if ($script:failed) { Write-Host "$($script:failed) check(s) failed"; exit 1 }
Write-Host 'every check passed'
