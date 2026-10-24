# Prints, as JSON, the Windows UI Automation tree (the control view, which Narrator reads) of the window $hwnd, down
# $depth levels: each element's control type, name, keyboard focus and localized type, and, for an expandable one,
# its state. Run by e2e/win32.ts. Adapted from spike/b's e2e/uia-element.ps1, which read one element by name.
param([long]$hwnd, [int]$depth = 40)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8 # names as they are, em dashes and ellipses too (PowerShell 5.1 reads this file as ANSI: keep it ASCII)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$expand = [System.Windows.Automation.ExpandCollapsePattern]::Pattern
function Read-Element($el, [int]$d) {
  $c = $el.Current
  $node = [ordered]@{ type = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''; name = $c.Name; localized = $c.LocalizedControlType; focus = $c.HasKeyboardFocus }
  $ec = $null
  if ($el.TryGetCurrentPattern($expand, [ref]$ec)) { $node.expand = "$($ec.Current.ExpandCollapseState)" }
  if ($d -lt $depth) {
    $children = @()
    $child = $walker.GetFirstChild($el)
    while ($child) {
      $children += Read-Element $child ($d + 1)
      $child = $walker.GetNextSibling($child)
    }
    if ($children.Count) { $node.children = $children }
  }
  $node
}
$win = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
Read-Element $win 0 | ConvertTo-Json -Depth 100 -Compress
