; Snoop 0.3.1 Windows NSIS compatibility hotfix.
; Keep bundle.publisher = Duskbit, but recover the old Feedra install path.
; Only inspect paths containing a real snoop.exe. Never delete install folders.
; perMachine => HKLM and the common desktop by default.

!macro NSIS_HOOK_PREINSTALL
  Push $0
  Push $1
  Push $2

  ReadRegStr $0 HKLM "Software\Feedra\${PRODUCTNAME}" ""
  ReadRegStr $1 HKLM "Software\Duskbit\${PRODUCTNAME}" ""
  StrCpy $2 ""

  ; Prefer an existing Duskbit install if the executable really exists.
  ${If} $1 != ""
  ${AndIf} ${FileExists} "$1\${MAINBINARYNAME}.exe"
    StrCpy $2 $1
  ${EndIf}

  ; Migrate old Feedra installations even if Duskbit already has a stale
  ; C:\Program Files\Snoop record from the broken 0.3.0 installer.
  ; Never override an intentionally chosen non-default Duskbit path.
  ${If} $0 != ""
  ${AndIf} ${FileExists} "$0\${MAINBINARYNAME}.exe"
    ${If} $2 == ""
      StrCpy $2 $0
    ${ElseIf} $1 == "$PROGRAMFILES\${PRODUCTNAME}"
      StrCpy $2 $0
    ${ElseIf} $1 == "$PROGRAMFILES64\${PRODUCTNAME}"
      StrCpy $2 $0
    ${EndIf}
  ${EndIf}

  ${If} $2 != ""
    StrCpy $INSTDIR $2
    SetOutPath $INSTDIR
    DetailPrint "Snoop existing install directory: $INSTDIR"
  ${EndIf}

  Pop $2
  Pop $1
  Pop $0
!macroend

; A perMachine NSIS install creates the public desktop shortcut. On upgrade,
; the current user may already have a private/OneDrive desktop shortcut.
; If that private shortcut points at the installed snoop.exe, keep it and
; remove the public one; never delete the user's private shortcut.
;
; The public shortcut is only created on the finish page in GUI mode, which
; runs AFTER this hook, so do not require it to exist or to already point at
; the new $INSTDIR (after a broken 0.3.0 upgrade it still points at
; C:\Program Files\Snoop). Delete it if present and suppress recreation.
!macro NSIS_HOOK_POSTINSTALL
  Push $0

  SetShellVarContext current
  !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $0

  ${If} $0 == 1
    SetShellVarContext all
    ${If} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
      DetailPrint "Snoop: removed duplicate common desktop shortcut"
    ${EndIf}
    ; In the Tauri NSIS finish page, skip recreating the public shortcut.
    StrCpy $NoShortcutMode 1
  ${EndIf}

  ; Restore the shell/registry context expected by the rest of the template.
  !insertmacro SetContext

  Pop $0
!macroend
