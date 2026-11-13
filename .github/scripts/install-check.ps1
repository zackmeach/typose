# The Windows installer end to end, for CI's Windows runner (test.yml's installer step). Don't run it on a machine you
# use: it installs into the current user's profile and registry. It installs silently, then checks that:
#   - the install is per user;
#   - Typose is under OpenWithProgids for exactly the types app/build/installer.nsh lists, and the default app for none;
#   - Electron's WER module is left out, and the third-party notices ship;
#   - the open command the registration names launches Typose, which opens the .jsonl it names;
#   - an uninstall removes the registration.
# Every check prints ok or FAIL, and any FAIL exits 1. Keep this file ASCII: Windows PowerShell 5.1 reads it as ANSI.
param([string]$Installer = (Resolve-Path "$PSScriptRoot/../../app/dist/Typose-*-setup.exe").Path)
$ErrorActionPreference = 'Stop'
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
# A registered command line, as its executable and its arguments with %1 replaced.
function Split-Command([string]$command, [string]$file) {
  if ($command -match '^"([^"]+)"\s*(.*)$') { $Matches[1], ($Matches[2] -replace '%1', $file) } else { $null, $null }
}

Check (-not (Entry) -and -not (Registered)) 'nothing is installed or registered before the install'
Write-Host "Installing $Installer"
$run = Start-Process $Installer -ArgumentList '/S' -Wait -PassThru
Check ($run.ExitCode -eq 0) "the silent install exits 0 (it exited $($run.ExitCode))"
$entry = Entry
if (-not $entry) { Write-Host 'FAIL: no uninstall entry names Typose after the install'; exit 1 }
$uninstaller, $null = Split-Command $entry.UninstallString ''
$dir = Split-Path -Parent $uninstaller # the entry has no InstallLocation
Check ($entry.PSPath -like '*HKEY_CURRENT_USER*' -and $dir -like "$env:LOCALAPPDATA\*") "installed per user: uninstall entry $($entry.PSPath -replace '^.*::', ''), in $dir"

# Registration
$registered = @(Registered)
Check (($registered -join ' ') -eq (($types | Sort-Object) -join ' ')) "Typose is under OpenWithProgids for exactly installer.nsh's types (found: $($registered -join ', '))"
foreach ($type in $types) {
  $app = DefaultApp $type
  $key = [Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey(".$type")
  $class = if ($key) { $key.GetValue('') } else { $null }
  Check ($app -notlike '*\Typose.exe' -and $class -ne $progId) ".$type's default app isn't Typose: it opens with $app, and its class is '$class'"
}

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
Check (-not (Test-Path -LiteralPath $dir)) 'after the uninstall the install directory is gone'

if ($script:failed) { Write-Host "$($script:failed) check(s) failed"; exit 1 }
Write-Host 'every check passed'
