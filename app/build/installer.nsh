; electron-builder's NSIS include (its default path, build/installer.nsh). The installer registers Typose as an
; "Open with" choice for the types below and never as their default app. electron-builder's own `fileAssociations`
; can't do that: its APP_ASSOCIATE writes each extension's default value. Per user, in HKCU: the install is per-user
; and never elevates. .github/scripts/install-check.ps1 holds the same list and checks the installed result against it.
;
; The types the core reads by name: Markdown (core/typose-core/src/md.rs:74), CSV and TSV
; (core/typose-node/src/csv.rs:6), JSON, JSONL and YAML (core/typose-node/src/structured.rs:8); and plain text and
; logs, which open as text (core/typose-node/src/lib.rs:852) and which the folder sidebar lists
; (core/typose-core/src/local/folder.rs:207).

!define TYPOSE_PROGID "Typose.File"

!macro typoseTypes MACRO
  !insertmacro ${MACRO} md
  !insertmacro ${MACRO} markdown
  !insertmacro ${MACRO} txt
  !insertmacro ${MACRO} log
  !insertmacro ${MACRO} csv
  !insertmacro ${MACRO} tsv
  !insertmacro ${MACRO} json
  !insertmacro ${MACRO} jsonc
  !insertmacro ${MACRO} jsonl
  !insertmacro ${MACRO} ndjson
  !insertmacro ${MACRO} yaml
  !insertmacro ${MACRO} yml
!macroend

!macro typoseOpenWith EXT
  WriteRegNone HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${TYPOSE_PROGID}"
!macroend

; Only the value Typose wrote: the extension's key, its default and other apps' entries stay as they were.
!macro typoseNoOpenWith EXT
  DeleteRegValue HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${TYPOSE_PROGID}"
!macroend

!macro customInstall
  WriteRegStr HKCU "Software\Classes\${TYPOSE_PROGID}\DefaultIcon" "" "$appExe,0"
  WriteRegStr HKCU "Software\Classes\${TYPOSE_PROGID}\shell\open\command" "" '"$appExe" "%1"'
  !insertmacro typoseTypes typoseOpenWith
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)' ; SHCNE_ASSOCCHANGED
!macroend

; Also runs, from the old version, when a newer one installs over it; the new installer then registers again.
!macro customUnInstall
  !insertmacro typoseTypes typoseNoOpenWith
  DeleteRegKey HKCU "Software\Classes\${TYPOSE_PROGID}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
