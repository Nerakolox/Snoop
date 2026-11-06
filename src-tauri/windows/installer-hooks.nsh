; 0.3.0 把 bundle.publisher 从 Feedra 改成了 Duskbit。
;
; Tauri 的 NSIS 模板用 publisher 作为厂商名，把上一次的安装目录记在
;   HKLM\Software\<publisher>\<productName>
; 升级时只有读到这个键才会装回原目录，否则回落到 C:\Program Files\<productName>。
; 0.3.0 因此把应用另装了一份到 C 盘，旧版本留在原目录，桌面也可能多出快捷方式。
;
; 这里在首次从旧品牌版本升级时补读旧键，把安装目录接回原位置。
; 只在新厂商键还不存在时生效：已经装过 0.3.0 及以上的用户不受影响，
; 避免把已经迁移到新目录的安装又搬回去。
;
; 注意：当前 installMode 固定为 perMachine，旧安装目录记录在 HKLM。

!macro NSIS_HOOK_PREINSTALL
  Push $0
  Push $1
  Push $2

  ; 新厂商键已经写过，说明不是第一次从旧品牌版本升级
  ReadRegStr $0 SHCTX "${MANUPRODUCTKEY}" ""
  ${If} $0 == ""
    ; 旧版（publisher = Feedra）留下的安装目录
    ReadRegStr $1 HKLM "Software\Feedra\${PRODUCTNAME}" ""
    ${If} $1 != ""
    ${AndIf} ${FileExists} "$1\${MAINBINARYNAME}.exe"
      ; Section Install 已经按默认目录 SetOutPath 过一次。
      ; 同时改 $INSTDIR 和输出目录，后续 File、注册表和快捷方式才会落到旧目录。
      StrCpy $2 $INSTDIR
      StrCpy $INSTDIR $1

      ; 默认目录是刚才 SetOutPath 建出来的空目录，能删就删；有内容时 RMDir 会安全失败。
      ; 先删再 SetOutPath，避免极端情况下把马上要用的目标目录删掉。
      ${If} $2 != $INSTDIR
        RMDir "$2"
      ${EndIf}
      SetOutPath $INSTDIR
    ${EndIf}
  ${EndIf}

  Pop $2
  Pop $1
  Pop $0
!macroend
