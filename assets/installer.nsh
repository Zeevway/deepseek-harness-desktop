!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "nsDialogs.nsh"
!include "StrFunc.nsh"
!include "WinVer.nsh"
!include "x64.nsh"

!ifdef BUILD_UNINSTALLER
${UnStrStr}
!else
${StrStr}
!endif

!define MIN_FREE_SPACE_MB 1024
!define /ifndef INSTALL_REGISTRY_KEY "Software\${APP_GUID}"
!define /ifndef UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"

Var powershellPreviousOutDir

!macro PowerShellWorkingDirectoryBegin
  StrCpy $powershellPreviousOutDir "$OUTDIR"
  SetOutPath "$SYSDIR"
!macroend

!macro PowerShellWorkingDirectoryEnd
  SetOutPath "$powershellPreviousOutDir"
!macroend

!ifndef BUILD_UNINSTALLER
Var previousInstallDir
Var rollbackRoot
Var backupComplete
Var preflightError
Var preflightLabel
Var previousExecutableName
Var previousVersion
Var previousInstallTrusted
Var previousInstallToken
Var installInstanceToken
Var installMarkerBackupCreated
Var registryTokenBefore
Var registryTokenBeforeExists
Var identityRollbackError
Var installerDiagnosticLog
Var installerDiagnosticOnly
Var commandLineInstallDir
Var freshInstallDirectoryArgument

Function WriteInstallerDiagnostic
  Exch $0
  Push $1
  ${If} $installerDiagnosticLog != ""
    ClearErrors
    FileOpen $1 "$installerDiagnosticLog" a
    ${IfNot} ${Errors}
      FileSeek $1 0 END
      FileWrite $1 "$0$\r$\n"
      FileClose $1
    ${EndIf}
  ${EndIf}
  ClearErrors
  Pop $1
  Pop $0
FunctionEnd

!macro InstallerDiagnostic MESSAGE
  Push "${MESSAGE}"
  Call WriteInstallerDiagnostic
!macroend

Function GenerateInstallInstanceToken
  !insertmacro InstallerDiagnostic "token:start"
  !insertmacro PowerShellWorkingDirectoryBegin
  nsExec::ExecToStack '"powershell.exe" -NoProfile -NonInteractive -Command "[Console]::Write([Guid]::NewGuid().ToString([string][char]78))"'
  Pop $0
  Pop $installInstanceToken
  !insertmacro PowerShellWorkingDirectoryEnd
  ${If} $0 != 0
  ${OrIf} $installInstanceToken == ""
    !insertmacro InstallerDiagnostic "token:failed exit=$0"
    Abort "无法生成安装实例安全标识，安装已中止。"
  ${EndIf}
  !insertmacro InstallerDiagnostic "token:complete"
FunctionEnd

Function RollbackInstallIdentityCommit
  StrCpy $identityRollbackError ""

  ${If} $installMarkerBackupCreated == "1"
    System::Call 'kernel32::MoveFileExW(w "$INSTDIR\.dsh-desktop-install.json.rollback", w "$INSTDIR\.dsh-desktop-install.json", i 9) i.r1'
    ${If} $1 == 0
      StrCpy $identityRollbackError "无法恢复旧的安装安全标记。"
    ${EndIf}
  ${Else}
    ClearErrors
    Delete "$INSTDIR\.dsh-desktop-install.json"
    ${If} ${FileExists} "$INSTDIR\.dsh-desktop-install.json"
      StrCpy $identityRollbackError "无法移除未提交的安装安全标记。"
    ${EndIf}
  ${EndIf}

  ${If} $registryTokenBeforeExists == "1"
    ClearErrors
    WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallInstanceToken "$registryTokenBefore"
    ${If} ${Errors}
      StrCpy $identityRollbackError "无法恢复旧的注册表安装标识。"
    ${EndIf}
    ClearErrors
    ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallInstanceToken
    ${If} ${Errors}
      StrCpy $identityRollbackError "无法回读恢复后的注册表安装标识。"
    ${ElseIf} $0 != $registryTokenBefore
      StrCpy $identityRollbackError "恢复后的注册表安装标识不一致。"
    ${EndIf}
  ${Else}
    ClearErrors
    DeleteRegValue SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallInstanceToken
    ClearErrors
    ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallInstanceToken
    ${IfNot} ${Errors}
      StrCpy $identityRollbackError "无法移除未提交的注册表安装标识。"
    ${EndIf}
  ${EndIf}

  Delete "$INSTDIR\.dsh-desktop-install.json.tmp"
  ${If} $installMarkerBackupCreated != "1"
    Delete "$INSTDIR\.dsh-desktop-install.json.rollback"
  ${EndIf}
FunctionEnd

Function SecureInstallDirectory
  !insertmacro PowerShellWorkingDirectoryBegin
  nsExec::ExecToStack '"powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\protect-install-directory.ps1" -Path "$INSTDIR" -Recursive $freshInstallDirectoryArgument'
  Pop $0
  Pop $1
  !insertmacro PowerShellWorkingDirectoryEnd
  ${If} $0 != 0
    StrCpy $preflightError "无法验证或收紧安装目录权限：$1"
  ${EndIf}
FunctionEnd

Function CheckPreviousInstallTrust
  StrCpy $previousInstallTrusted "0"
  ${If} $previousInstallDir == ""
    Return
  ${EndIf}
  ${IfNot} ${FileExists} "$previousInstallDir\${PRODUCT_FILENAME}.exe"
  ${AndIfNot} ${FileExists} "$previousInstallDir\${PRODUCT_NAME}.exe"
    Return
  ${EndIf}
  ${IfNot} ${FileExists} "$previousInstallDir\Uninstall ${PRODUCT_FILENAME}.exe"
    Return
  ${EndIf}

  ClearErrors
  FileOpen $0 "$previousInstallDir\.dsh-desktop-install.json" r
  ${If} ${Errors}
    Return
  ${EndIf}
  FileRead $0 $1
  FileClose $0
  ${StrStr} $2 "$1" '"appId":"${APP_ID}"'
  ${If} $2 == ""
    Return
  ${EndIf}
  ; Legacy installations did not have a random token. Registry path + marker +
  ; executable + uninstaller are accepted once, then upgraded to token binding.
  ${If} $previousInstallToken != ""
    ${StrStr} $2 "$1" '"installInstance":"$previousInstallToken"'
    ${If} $2 == ""
      Return
    ${EndIf}
  ${Else}
    ${StrStr} $2 "$1" '"installInstance":"'
    ${If} $2 != ""
      ; A token-aware marker with a missing registry token is corruption, not legacy.
      Return
    ${EndIf}
  ${EndIf}
  StrCpy $previousInstallTrusted "1"
FunctionEnd

Function ValidateInstallDirectory
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8

  StrCpy $preflightError ""
  ${GetRoot} "$INSTDIR" $0
  ${If} $0 == ""
    StrCpy $preflightError "无法识别安装目录所在的磁盘。"
    Goto validate_done
  ${EndIf}
  StrCpy $0 "$0\"
  GetFullPathName $1 "$INSTDIR"
  ${If} $1 == $0
    StrCpy $preflightError "不能把应用直接安装到磁盘根目录，请选择一个专用文件夹。"
    Goto validate_done
  ${EndIf}

  System::Call 'kernel32::GetDriveTypeW(w r0) i.r1'
  ${If} $1 != 3
    StrCpy $preflightError "安装目录必须位于本机固定磁盘，不能使用网络盘或可移动磁盘。"
    Goto validate_done
  ${EndIf}

  System::Call 'kernel32::GetVolumeInformationW(w r0, w .r2, i ${NSIS_MAX_STRLEN}, *i .r3, *i .r4, *i .r5, w .r6, i ${NSIS_MAX_STRLEN}) i.r7'
  ${If} $7 == 0
    StrCpy $preflightError "无法读取目标磁盘的文件系统信息。"
    Goto validate_done
  ${EndIf}
  ${If} $6 != "NTFS"
    StrCpy $preflightError "安装目录必须位于 NTFS 磁盘，当前文件系统为 $6。"
    Goto validate_done
  ${EndIf}

  ; electron-builder bundles NSIS 3.0.4.1 without the optional DriveSpace plug-in.
  ; Compare free clusters instead so the preflight remains self-contained.
  System::Call 'kernel32::GetDiskFreeSpaceW(w r0, *i .r1, *i .r2, *i .r3, *i .r4) i.r5'
  ${If} $5 == 0
    StrCpy $preflightError "无法读取目标磁盘的可用空间。"
    Goto validate_done
  ${EndIf}
  IntOp $6 $1 * $2
  ${If} $6 <= 0
    StrCpy $preflightError "目标磁盘报告了无效的簇大小。"
    Goto validate_done
  ${EndIf}
  IntOp $7 ${MIN_FREE_SPACE_MB} * 1048576
  IntOp $7 $7 + $6
  IntOp $7 $7 - 1
  IntOp $7 $7 / $6
  ${If} $3 < $7
    StrCpy $preflightError "目标磁盘可用空间不足，需要至少 ${MIN_FREE_SPACE_MB} MiB。"
    Goto validate_done
  ${EndIf}

  !insertmacro PowerShellWorkingDirectoryBegin
  nsExec::ExecToStack '"powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\protect-install-directory.ps1" -Path "$INSTDIR" -ValidateOnly $freshInstallDirectoryArgument'
  Pop $1
  Pop $2
  !insertmacro PowerShellWorkingDirectoryEnd
  ${If} $1 != 0
    StrCpy $preflightError "安装路径安全检查失败：$2"
    Goto validate_done
  ${EndIf}

  StrCpy $8 "0"
  ${IfNot} ${FileExists} "$INSTDIR\."
    StrCpy $8 "1"
    Goto validate_done
  ${EndIf}

  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r1'
  ${If} $1 == -1
    StrCpy $preflightError "无法读取安装目录属性。"
    Goto validate_remove_created
  ${EndIf}
  IntOp $2 $1 & 0x400
  ${If} $2 != 0
    StrCpy $preflightError "安装目录不能是符号链接或目录联接点，请选择本机真实目录。"
    Goto validate_remove_created
  ${EndIf}

  ${If} $8 == "0"
    StrCmp "$INSTDIR" "$previousInstallDir" validate_write_access
    ClearErrors
    FindFirst $4 $5 "$INSTDIR\*"
validate_entry_loop:
    ${If} ${Errors}
      FindClose $4
      Goto validate_write_access
    ${EndIf}
    StrCmp $5 "." validate_next_entry
    StrCmp $5 ".." validate_next_entry
    FindClose $4

    StrCpy $preflightError "所选安装目录不是当前注册的安装位置且不为空。请选择新的空目录。"
    Goto validate_done

validate_next_entry:
    ClearErrors
    FindNext $4 $5
    Goto validate_entry_loop
  ${EndIf}

validate_write_access:
  ClearErrors
  GetTempFileName $7 "$INSTDIR"
  ${If} ${Errors}
    StrCpy $preflightError "无法写入安装目录，请检查磁盘权限。"
  ${Else}
    Delete "$7"
  ${EndIf}

validate_remove_created:
validate_done:
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function CleanupCompletedRollback
  ${IfNot} ${FileExists} "$rollbackRoot\."
    Return
  ${EndIf}

  StrCpy $3 "0"
  ReadRegStr $4 HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${If} $4 == ""
    ReadRegStr $4 HKLM "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${EndIf}
  ClearErrors
  FileOpen $0 "$rollbackRoot\previous-install.json" r
  ${If} ${Errors}
    Abort "检测到无法读取的上一版备份：$rollbackRoot。为避免丢失回滚版本，安装已中止。"
  ${EndIf}

rollback_state_loop:
  ClearErrors
  FileRead $0 $1
  ${If} ${Errors}
    FileClose $0
    ${If} $previousInstallTrusted == "1"
    ${AndIf} $3 == "1"
      Goto rollback_state_cleanup_closed
    ${EndIf}
    Abort "上一版备份尚未通过健康确认：$rollbackRoot。请先在应用内恢复或处理该备份。"
  ${EndIf}
  ${If} $4 != ""
    ${StrStr} $2 "$1" '"version": "$4"'
    ${If} $2 != ""
      StrCpy $3 "1"
    ${EndIf}
  ${EndIf}
  ${StrStr} $2 "$1" '"state"'
  ${If} $2 != ""
    ${StrStr} $2 "$1" '"healthy"'
    ${If} $2 != ""
      Goto rollback_state_cleanup
    ${EndIf}
    ${StrStr} $2 "$1" '"restored"'
    ${If} $2 != ""
      Goto rollback_state_cleanup
    ${EndIf}
  ${EndIf}
  Goto rollback_state_loop

rollback_state_cleanup:
  FileClose $0
rollback_state_cleanup_closed:
  ClearErrors
  RMDir /r "$rollbackRoot"
  ${If} ${Errors}
    Abort "无法轮换已完成的上一版备份：$rollbackRoot。请关闭占用该目录的程序后重试。"
  ${EndIf}
FunctionEnd

Function BackupPreviousInstall
  ${If} $backupComplete == "1"
    Return
  ${EndIf}
  ${If} $previousInstallDir == ""
    Return
  ${EndIf}
  ReadRegStr $previousVersion HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${If} $previousVersion == ""
    ReadRegStr $previousVersion HKLM "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${EndIf}
  ${If} $previousVersion == "${VERSION}"
    ; A repair install cannot roll back to the same application version.
    Return
  ${EndIf}
  StrCpy $previousExecutableName "${PRODUCT_FILENAME}.exe"
  ${IfNot} ${FileExists} "$previousInstallDir\$previousExecutableName"
    StrCpy $previousExecutableName "${PRODUCT_NAME}.exe"
    ${IfNot} ${FileExists} "$previousInstallDir\$previousExecutableName"
      Return
    ${EndIf}
  ${EndIf}

  ${GetParent} "$previousInstallDir" $0
  StrCpy $rollbackRoot "$0\.dsh-desktop-previous"

  Call CleanupCompletedRollback
  ${If} ${FileExists} "$rollbackRoot\."
    Abort "检测到尚未处理的上一版备份：$rollbackRoot。请先在应用内完成健康确认或手动恢复，再重新升级。"
  ${EndIf}

  !insertmacro PowerShellWorkingDirectoryBegin
  nsExec::ExecToStack '"powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\protect-install-directory.ps1" -Path "$rollbackRoot" -Recursive'
  Pop $7
  Pop $8
  !insertmacro PowerShellWorkingDirectoryEnd
  ${If} $7 != 0
    RMDir /r "$rollbackRoot"
    Abort "无法保护升级回滚目录，安装已中止；不会修改当前版本。$\r$\n$8"
  ${EndIf}
  ClearErrors
  CreateDirectory "$rollbackRoot\app"
  ${If} ${Errors}
    RMDir /r "$rollbackRoot"
    Abort "无法创建升级回滚目录：$rollbackRoot"
  ${EndIf}

  SetOutPath "$PLUGINSDIR"
  File "/oname=restore-previous-install.ps1" "${PROJECT_DIR}\scripts\restore-previous-install.ps1"
  File "/oname=create-previous-install-manifest.ps1" "${PROJECT_DIR}\scripts\create-previous-install-manifest.ps1"
  ClearErrors
  CopyFiles /SILENT "$PLUGINSDIR\restore-previous-install.ps1" "$rollbackRoot\restore-previous-install.ps1"
  ${If} ${Errors}
    RMDir /r "$rollbackRoot"
    Abort "无法保存升级恢复脚本，安装已中止；不会修改当前版本。"
  ${EndIf}
  ${IfNot} ${FileExists} "$rollbackRoot\restore-previous-install.ps1"
    RMDir /r "$rollbackRoot"
    Abort "升级恢复脚本校验失败，安装已中止；不会修改当前版本。"
  ${EndIf}

  ClearErrors
  CopyFiles /SILENT "$previousInstallDir\*.*" "$rollbackRoot\app"
  ${If} ${Errors}
    RMDir /r "$rollbackRoot"
    Abort "复制上一版程序失败，安装已中止；不会修改当前版本。"
  ${EndIf}
  ${IfNot} ${FileExists} "$rollbackRoot\app\$previousExecutableName"
    RMDir /r "$rollbackRoot"
    Abort "上一版程序备份不完整，安装已中止；不会修改当前版本。"
  ${EndIf}
  !insertmacro PowerShellWorkingDirectoryBegin
  nsExec::ExecToStack '"powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\protect-install-directory.ps1" -Path "$rollbackRoot" -Recursive'
  Pop $7
  Pop $8
  !insertmacro PowerShellWorkingDirectoryEnd
  ${If} $7 != 0
    RMDir /r "$rollbackRoot"
    Abort "升级回滚副本未通过链接和权限校验，安装已中止；不会修改当前版本。$\r$\n$8"
  ${EndIf}

  ${If} $previousVersion == ""
    StrCpy $previousVersion "unknown"
  ${EndIf}
  StrCpy $1 "$previousVersion"

  !insertmacro PowerShellWorkingDirectoryBegin
  nsExec::ExecToStack '"powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\create-previous-install-manifest.ps1" -OutputPath "$rollbackRoot\previous-install.json" -Version "$1" -ProductName "${PRODUCT_NAME}" -InstallMode "CurrentUser" -InstallDirectory "$previousInstallDir" -BackupDirectory "$rollbackRoot\app" -ExecutableName "$previousExecutableName" -AppGuid "${APP_GUID}" -UninstallAppKey "${UNINSTALL_APP_KEY}"'
  Pop $7
  Pop $8
  !insertmacro PowerShellWorkingDirectoryEnd
  ${If} $7 != 0
    RMDir /r "$rollbackRoot"
    Abort "无法生成 UTF-8 升级回滚清单，安装已中止；不会修改当前版本。$\r$\n$8"
  ${EndIf}
  ${IfNot} ${FileExists} "$rollbackRoot\previous-install.json"
    RMDir /r "$rollbackRoot"
    Abort "升级回滚清单校验失败，安装已中止；不会修改当前版本。"
  ${EndIf}

  StrCpy $backupComplete "1"
FunctionEnd

Function CheckInstallerArchitecture
  !ifdef APP_ARM64
    !ifndef APP_64
      ${If} ${IsNativeARM64}
        Goto architecture_ok
      ${EndIf}
      Abort "此安装包仅支持 Windows ARM64，请下载与电脑架构匹配的版本。"
    !endif
  !endif
  !ifdef APP_64
    !ifndef APP_ARM64
      ${If} ${RunningX64}
        Goto architecture_ok
      ${EndIf}
      ${If} ${IsNativeARM64}
        Goto architecture_ok
      ${EndIf}
      Abort "此安装包仅支持 64 位 Windows。"
    !endif
  !endif
architecture_ok:
FunctionEnd

!macro customInit
  ReadEnvStr $installerDiagnosticLog "DSH_INSTALLER_DIAGNOSTIC_LOG"
  ReadEnvStr $installerDiagnosticOnly "DSH_INSTALLER_DIAGNOSTIC_ONLY"
  ${If} $installerDiagnosticLog != ""
    SetErrorLevel 31
  ${EndIf}
  !insertmacro InstallerDiagnostic "customInit:start installMode=$installMode"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "/oname=protect-install-directory.ps1" "${PROJECT_DIR}\scripts\protect-install-directory.ps1"
  !insertmacro InstallerDiagnostic "customInit:helper-extracted"
  ${If} $installMode == "all"
    !insertmacro InstallerDiagnostic "customInit:unsupported-all-users"
    Abort "DeepSeek Harness Desktop 仅支持为当前 Windows 用户安装。"
  ${EndIf}
  StrCpy $backupComplete "0"
  StrCpy $previousInstallDir ""
  StrCpy $previousInstallToken ""
  StrCpy $installInstanceToken ""
  ReadRegStr $previousInstallDir HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $previousInstallToken HKCU "${INSTALL_REGISTRY_KEY}" InstallInstanceToken
  Call CheckPreviousInstallTrust
  !insertmacro InstallerDiagnostic "customInit:hkcu previousTrusted=$previousInstallTrusted"
  ${If} $previousInstallTrusted != "1"
    StrCpy $previousInstallDir ""
    StrCpy $previousInstallToken ""
    ReadRegStr $previousInstallDir HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $previousInstallToken HKLM "${INSTALL_REGISTRY_KEY}" InstallInstanceToken
    Call CheckPreviousInstallTrust
    !insertmacro InstallerDiagnostic "customInit:hklm previousTrusted=$previousInstallTrusted"
    ${If} $previousInstallTrusted != "1"
      StrCpy $previousInstallDir ""
      StrCpy $previousInstallToken ""
    ${EndIf}
  ${EndIf}
  StrCpy $freshInstallDirectoryArgument ""
  ${If} $previousInstallTrusted != "1"
    StrCpy $freshInstallDirectoryArgument "-AllowFreshInstallDirectory"
  ${EndIf}
  ${If} $previousInstallTrusted == "1"
  ${AndIf} $previousInstallToken != ""
    StrCpy $installInstanceToken "$previousInstallToken"
  ${Else}
    ${If} $installerDiagnosticLog != ""
      SetErrorLevel 32
    ${EndIf}
    Call GenerateInstallInstanceToken
  ${EndIf}
  !insertmacro InstallerDiagnostic "customInit:identity-ready"

  ${If} ${AtLeastWin10}
    Goto supported_windows
  ${EndIf}
  !insertmacro InstallerDiagnostic "customInit:unsupported-windows"
  Abort "DeepSeek Harness Desktop 需要 Windows 10 或更高版本。"
supported_windows:
  !insertmacro InstallerDiagnostic "customInit:windows-supported"
  ${If} $installerDiagnosticLog != ""
    SetErrorLevel 33
  ${EndIf}
  Call CheckInstallerArchitecture
  !insertmacro InstallerDiagnostic "customInit:architecture-supported"

  ${If} $installerDiagnosticLog != ""
    SetErrorLevel 34
  ${EndIf}
  !insertmacro GetDParameter $commandLineInstallDir
  !insertmacro InstallerDiagnostic "customInit:d-parameter=$commandLineInstallDir previous=$previousInstallDir"
  ${If} $previousInstallDir != ""
    StrCpy $INSTDIR "$previousInstallDir"
  ${ElseIf} $commandLineInstallDir == ""
    StrCpy $INSTDIR "D:\DeepSeek Harness Desktop"
    ${If} $installerDiagnosticLog != ""
      SetErrorLevel 35
    ${EndIf}
    Call ValidateInstallDirectory
    !insertmacro InstallerDiagnostic "customInit:d-drive path=$INSTDIR error=$preflightError"
    ${If} $preflightError != ""
      StrCpy $INSTDIR "$LOCALAPPDATA\Programs\DeepSeek Harness Desktop"
      ${If} $installerDiagnosticLog != ""
        SetErrorLevel 36
      ${EndIf}
      Call ValidateInstallDirectory
      !insertmacro InstallerDiagnostic "customInit:fallback path=$INSTDIR error=$preflightError"
      ${If} $preflightError != ""
        !insertmacro InstallerDiagnostic "customInit:no-valid-default-directory"
        Abort "D 盘不可用，Windows 用户目录也未通过安装检查：$preflightError"
      ${EndIf}
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONINFORMATION "D 盘未通过固定磁盘、NTFS、空间或写入检查，将改用当前 Windows 用户的应用目录。你可以在下一页选择其它目录。"
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ${If} ${Silent}
    !insertmacro InstallerDiagnostic "customInit:silent-preflight path=$INSTDIR"
    ${If} $installerDiagnosticLog != ""
      SetErrorLevel 37
    ${EndIf}
    Call ValidateInstallDirectory
    !insertmacro InstallerDiagnostic "customInit:silent-preflight-result error=$preflightError"
    ${If} $preflightError != ""
      Abort "安装目录未通过检查：$preflightError"
    ${EndIf}
    ${If} $installerDiagnosticLog != ""
      SetErrorLevel 38
    ${EndIf}
    Call SecureInstallDirectory
    !insertmacro InstallerDiagnostic "customInit:silent-secure-result error=$preflightError"
    ${If} $preflightError != ""
      Abort "安装目录安全检查失败：$preflightError"
    ${EndIf}
    Call BackupPreviousInstall
  ${EndIf}
  ${If} $installerDiagnosticLog != ""
    SetErrorLevel 0
  ${EndIf}
  !insertmacro InstallerDiagnostic "customInit:complete path=$INSTDIR"
  ${If} $installerDiagnosticOnly == "1"
    !insertmacro InstallerDiagnostic "customInit:diagnostic-only-success"
    SetErrorLevel 0
    Quit
  ${EndIf}
!macroend

Function PreflightPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 28u "安装前检查"
  Pop $0
  CreateFont $1 "$(^Font)" "11" "600"
  SendMessage $0 ${WM_SETFONT} $1 0

  Call ValidateInstallDirectory
  ${If} $preflightError == ""
    StrCpy $1 "目录：$INSTDIR$\r$\n已通过：本机固定磁盘、NTFS、至少 ${MIN_FREE_SPACE_MB} MiB 可用空间、可写入。"
  ${Else}
    StrCpy $1 "目录：$INSTDIR$\r$\n未通过：$preflightError$\r$\n请返回上一步更换目录。"
  ${EndIf}
  ${NSD_CreateLabel} 0 40u 100% 60u "$1"
  Pop $preflightLabel
  nsDialogs::Show
FunctionEnd

Function PreflightPageLeave
  ${If} $previousInstallDir != ""
  ${AndIf} $INSTDIR != $previousInstallDir
    MessageBox MB_OK|MB_ICONSTOP "升级必须保留原安装目录：$previousInstallDir。若要更换目录，请先卸载旧版且保留用户数据，再重新安装。"
    Abort
  ${EndIf}
  Call ValidateInstallDirectory
  ${If} $preflightError != ""
    MessageBox MB_OK|MB_ICONSTOP "$preflightError"
    Abort
  ${EndIf}
  Call SecureInstallDirectory
  ${If} $preflightError != ""
    MessageBox MB_OK|MB_ICONSTOP "$preflightError"
    Abort
  ${EndIf}
  Call BackupPreviousInstall
FunctionEnd

!macro customPageAfterChangeDir
  Page custom PreflightPageCreate PreflightPageLeave
!macroend

!macro customInstall
  !insertmacro PowerShellWorkingDirectoryBegin
  nsExec::ExecToStack '"powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\protect-install-directory.ps1" -Path "$INSTDIR" -Recursive'
  Pop $0
  Pop $1
  !insertmacro PowerShellWorkingDirectoryEnd
  ${If} $0 != 0
    Abort "安装目录权限保护失败，应用不会启动。$\r$\n$1"
  ${EndIf}

  StrCpy $registryTokenBefore ""
  StrCpy $registryTokenBeforeExists "0"
  ClearErrors
  ReadRegStr $registryTokenBefore SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallInstanceToken
  ${IfNot} ${Errors}
    StrCpy $registryTokenBeforeExists "1"
  ${EndIf}

  StrCpy $installMarkerBackupCreated "0"
  ClearErrors
  Delete "$INSTDIR\.dsh-desktop-install.json.rollback"
  ${If} ${FileExists} "$INSTDIR\.dsh-desktop-install.json.rollback"
    Abort "无法清理旧的安装标记事务文件，安装未开始提交。"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\.dsh-desktop-install.json"
    ClearErrors
    CopyFiles /SILENT "$INSTDIR\.dsh-desktop-install.json" "$INSTDIR\.dsh-desktop-install.json.rollback"
    ${If} ${Errors}
      Delete "$INSTDIR\.dsh-desktop-install.json.rollback"
      Abort "无法备份旧的安装安全标记，安装未开始提交。"
    ${EndIf}
    ${IfNot} ${FileExists} "$INSTDIR\.dsh-desktop-install.json.rollback"
      Abort "旧的安装安全标记备份未通过校验，安装未开始提交。"
    ${EndIf}
    StrCpy $installMarkerBackupCreated "1"
  ${EndIf}

  ClearErrors
  FileOpen $0 "$INSTDIR\.dsh-desktop-install.json.tmp" w
  ${If} ${Errors}
    Delete "$INSTDIR\.dsh-desktop-install.json.rollback"
    Abort "无法创建安装安全标记，安装未完成。"
  ${EndIf}
  FileWrite $0 '{"appId":"${APP_ID}","version":"${VERSION}","installInstance":"$installInstanceToken"}$\r$\n'
  FileClose $0
  ${If} ${Errors}
    Delete "$INSTDIR\.dsh-desktop-install.json.tmp"
    Delete "$INSTDIR\.dsh-desktop-install.json.rollback"
    Abort "安装安全标记写入不完整，安装未完成。"
  ${EndIf}
  FileOpen $0 "$INSTDIR\.dsh-desktop-install.json.tmp" r
  ${If} ${Errors}
    Delete "$INSTDIR\.dsh-desktop-install.json.tmp"
    Delete "$INSTDIR\.dsh-desktop-install.json.rollback"
    Abort "无法校验安装安全标记，安装未完成。"
  ${EndIf}
  FileRead $0 $1
  FileClose $0
  ${StrStr} $2 "$1" '"appId":"${APP_ID}"'
  ${If} $2 == ""
    Delete "$INSTDIR\.dsh-desktop-install.json.tmp"
    Delete "$INSTDIR\.dsh-desktop-install.json.rollback"
    Abort "安装安全标记校验失败，安装未完成。"
  ${EndIf}
  ${StrStr} $2 "$1" '"installInstance":"$installInstanceToken"'
  ${If} $2 == ""
    Delete "$INSTDIR\.dsh-desktop-install.json.tmp"
    Delete "$INSTDIR\.dsh-desktop-install.json.rollback"
    Abort "安装实例安全标识校验失败，安装未完成。"
  ${EndIf}

  System::Call 'kernel32::MoveFileExW(w "$INSTDIR\.dsh-desktop-install.json.tmp", w "$INSTDIR\.dsh-desktop-install.json", i 9) i.r1'
  ${If} $1 == 0
    Call RollbackInstallIdentityCommit
    ${If} $identityRollbackError != ""
      Abort "无法提交安装安全标记，且旧状态恢复失败：$identityRollbackError"
    ${EndIf}
    Abort "无法提交安装安全标记；旧状态已恢复。"
  ${EndIf}

  ClearErrors
  WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallInstanceToken "$installInstanceToken"
  ${If} ${Errors}
    Call RollbackInstallIdentityCommit
    ${If} $identityRollbackError != ""
      Abort "无法保存安装实例安全标识，且旧状态恢复失败：$identityRollbackError"
    ${EndIf}
    Abort "无法保存安装实例安全标识；旧状态已恢复。"
  ${EndIf}
  ClearErrors
  ReadRegStr $3 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallInstanceToken
  ${If} ${Errors}
    Call RollbackInstallIdentityCommit
    ${If} $identityRollbackError != ""
      Abort "无法回读安装实例安全标识，且旧状态恢复失败：$identityRollbackError"
    ${EndIf}
    Abort "无法回读安装实例安全标识；旧状态已恢复。"
  ${EndIf}
  ${If} $3 != $installInstanceToken
    Call RollbackInstallIdentityCommit
    ${If} $identityRollbackError != ""
      Abort "安装实例安全标识回读不一致，且旧状态恢复失败：$identityRollbackError"
    ${EndIf}
    Abort "安装实例安全标识回读不一致；旧状态已恢复。"
  ${EndIf}

  ClearErrors
  Delete "$INSTDIR\.dsh-desktop-install.json.rollback"
  ${If} ${FileExists} "$INSTDIR\.dsh-desktop-install.json.rollback"
    Call RollbackInstallIdentityCommit
    ${If} $identityRollbackError != ""
      Abort "无法完成安装标识事务，且旧状态恢复失败：$identityRollbackError"
    ${EndIf}
    Abort "无法完成安装标识事务；旧状态已恢复。"
  ${EndIf}
  StrCpy $installMarkerBackupCreated "0"
!macroend
!endif

!ifdef BUILD_UNINSTALLER
Var keepDataRadio
Var deleteDataRadio
Var unDeleteUserData
Var repairStage
Var uninstallerDiagnosticLog

Function un.WriteUninstallerDiagnostic
  Exch $R9
  Push $R8
  ${If} $uninstallerDiagnosticLog != ""
    ClearErrors
    FileOpen $R8 "$uninstallerDiagnosticLog" a
    ${IfNot} ${Errors}
      FileSeek $R8 0 END
      FileWrite $R8 "$R9$\r$\n"
      FileClose $R8
    ${EndIf}
  ${EndIf}
  ClearErrors
  Pop $R8
  Pop $R9
FunctionEnd

!macro UninstallerDiagnostic MESSAGE
  Push "${MESSAGE}"
  Call un.WriteUninstallerDiagnostic
!macroend

Function un.RepairMoveTopLevel
  Exch $R0
  Push $R1
  Push $R2
  Push $R3

  ; Moving a directory within one NTFS volume is atomic and does not traverse
  ; its children. Keep the protected install root in place, but move each of
  ; its immediate children as one transaction unit so a large unpacked runtime
  ; does not make repair time proportional to its file count.
  FindFirst $R1 $R2 "$INSTDIR\*.*"
repair_move_loop:
  StrCmp $R2 "" repair_move_complete
  StrCmp $R2 "." repair_move_next
  StrCmp $R2 ".." repair_move_next
  ClearErrors
  Rename "$INSTDIR\$R2" "$repairStage\$R2"
  StrCmp "$R2" "Uninstall ${PRODUCT_FILENAME}.exe" 0 +2
  ClearErrors
  ${If} ${Errors}
    StrCpy $R3 "$INSTDIR\$R2"
    Goto repair_move_done
  ${EndIf}

repair_move_next:
  FindNext $R1 $R2
  Goto repair_move_loop

repair_move_complete:
  StrCpy $R3 0

repair_move_done:
  FindClose $R1
  StrCpy $R0 $R3
  Pop $R3
  Pop $R2
  Pop $R1
  Exch $R0
FunctionEnd

Function un.RepairRestoreTopLevel
  Exch $R0
  Push $R1
  Push $R2
  Push $R3

  FindFirst $R1 $R2 "$repairStage\*.*"
repair_restore_loop:
  StrCmp $R2 "" repair_restore_complete
  StrCmp $R2 "." repair_restore_next
  StrCmp $R2 ".." repair_restore_next
  ClearErrors
  Rename "$repairStage\$R2" "$INSTDIR\$R2"
  ${If} ${Errors}
    StrCpy $R3 "$repairStage\$R2"
    Goto repair_restore_done
  ${EndIf}

repair_restore_next:
  FindNext $R1 $R2
  Goto repair_restore_loop

repair_restore_complete:
  StrCpy $R3 0

repair_restore_done:
  FindClose $R1
  StrCpy $R0 $R3
  Pop $R3
  Pop $R2
  Pop $R1
  Exch $R0
FunctionEnd

!macro customUnInit
  ; Parse the documented silent-uninstall switch before any custom page or
  ; section runs. electron-builder also parses this switch later, but keeping
  ; our explicit data choice independent avoids relying on template ordering.
  ReadEnvStr $uninstallerDiagnosticLog "DSH_UNINSTALLER_DIAGNOSTIC_LOG"
  StrCpy $unDeleteUserData "0"
  ${StdUtils.TestParameter} $0 "delete-app-data"
  ${If} $0 == "true"
    StrCpy $unDeleteUserData "1"
  ${EndIf}
  ${GetParameters} $R8
  !insertmacro UninstallerDiagnostic "customUnInit: parameters=$R8 parsed=$0 delete=$unDeleteUserData installMode=$installMode appData=$APPDATA"
!macroend

Function un.DataPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 28u "卸载数据选项"
  Pop $0
  CreateFont $1 "$(^Font)" "11" "600"
  SendMessage $0 ${WM_SETFONT} $1 0

  ${NSD_CreateRadioButton} 0 38u 100% 14u "仅卸载程序，保留 API Key、会话、设置和日志（推荐）"
  Pop $keepDataRadio
  ${NSD_Check} $keepDataRadio
  ${NSD_CreateRadioButton} 0 62u 100% 14u "同时删除本 Windows 用户默认位置中的 API Key、会话、设置和日志"
  Pop $deleteDataRadio
  ${NSD_CreateLabel} 0 86u 100% 34u "删除的数据无法通过卸载程序恢复。工作区原文件和自定义 Harness 数据目录不会被删除。"
  Pop $0
  nsDialogs::Show
FunctionEnd

Function un.DataPageLeave
  ${NSD_GetState} $deleteDataRadio $0
  ${If} $0 == ${BST_CHECKED}
    MessageBox MB_YESNO|MB_ICONEXCLAMATION "确定删除默认位置中的 API Key、会话、设置和日志吗？自定义 Harness 数据目录会保留。" IDYES +2
    Abort
    StrCpy $unDeleteUserData "1"
  ${Else}
    StrCpy $unDeleteUserData "0"
  ${EndIf}
FunctionEnd

!macro customUnWelcomePage
  UninstPage custom un.DataPageCreate un.DataPageLeave
!macroend

!macro customUnInstallSection
Section "un.-Finalize DeepSeek Harness Desktop cleanup"
  SectionIn RO
  ${StdUtils.TestParameter} $R8 "updated"
  !insertmacro UninstallerDiagnostic "customUnInstallSection:start delete=$unDeleteUserData builderDelete=$isDeleteAppData updated=$R8 installMode=$installMode appData=$APPDATA localAppData=$LOCALAPPDATA"
  ${IfNot} ${isUpdated}
    ${If} $unDeleteUserData == "1"
    ${OrIf} $isDeleteAppData == "1"
      !insertmacro UninstallerDiagnostic "customUnInstallSection:delete-start product=$APPDATA\${PRODUCT_NAME}"
      RMDir /r "$APPDATA\${APP_FILENAME}"
      RMDir /r "$APPDATA\${PRODUCT_NAME}"
      RMDir /r "$LOCALAPPDATA\${APP_FILENAME}-updater"
      RMDir /r "$LOCALAPPDATA\${PRODUCT_NAME}-updater"
      !ifdef APP_PRODUCT_FILENAME
        RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
        RMDir /r "$LOCALAPPDATA\${APP_PRODUCT_FILENAME}-updater"
      !endif
      !ifdef APP_PACKAGE_NAME
        RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
        RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater"
      !endif
      ${If} ${FileExists} "$APPDATA\${PRODUCT_NAME}\."
        !insertmacro UninstallerDiagnostic "customUnInstallSection:delete-incomplete product=$APPDATA\${PRODUCT_NAME}"
      ${Else}
        !insertmacro UninstallerDiagnostic "customUnInstallSection:delete-complete product=$APPDATA\${PRODUCT_NAME}"
      ${EndIf}
    ${EndIf}

    ${GetParent} "$INSTDIR" $0
    StrCpy $1 "$0\.dsh-desktop-previous"
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File "/oname=cleanup-install-remnants.ps1" "${PROJECT_DIR}\scripts\cleanup-install-remnants.ps1"
    !insertmacro PowerShellWorkingDirectoryBegin
    nsExec::ExecToStack '"powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\cleanup-install-remnants.ps1" -InstallDirectory "$INSTDIR" -RollbackRoot "$1" -AppId "${APP_ID}"'
    Pop $2
    Pop $3
    !insertmacro PowerShellWorkingDirectoryEnd
    ${If} $2 != 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "程序已卸载，但已完成的升级备份未能自动清理：$3"
    ${EndIf}
  ${EndIf}
  !insertmacro UninstallerDiagnostic "customUnInstallSection:complete"
SectionEnd
!macroend
!endif

!macro customRemoveFiles
  GetFullPathName $R2 "$INSTDIR"
  ${GetRoot} "$R2" $R3
  ${If} $R2 == $R3
    Abort "Refusing to remove a drive root. No files were removed."
  ${EndIf}

  ClearErrors
  FileOpen $R2 "$INSTDIR\.dsh-desktop-install.json" r
  ${If} ${Errors}
    Abort "Unable to verify that $INSTDIR belongs to DeepSeek Harness Desktop. No files were removed."
  ${EndIf}
  FileRead $R2 $R3
  FileClose $R2
  ReadRegStr $R5 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallInstanceToken
  ${If} $R5 == ""
    Abort "The registered installation token is missing. No files were removed."
  ${EndIf}
  !ifdef BUILD_UNINSTALLER
    ${UnStrStr} $R4 "$R3" '"appId":"${APP_ID}"'
  !else
    ${StrStr} $R4 "$R3" '"appId":"${APP_ID}"'
  !endif
  ${If} $R4 == ""
    Abort "The installation marker in $INSTDIR is invalid. No files were removed."
  ${EndIf}
  !ifdef BUILD_UNINSTALLER
    ${UnStrStr} $R4 "$R3" '"installInstance":"$R5"'
  !else
    ${StrStr} $R4 "$R3" '"installInstance":"$R5"'
  !endif
  ${If} $R4 == ""
    Abort "The installation marker token does not match the registry. No files were removed."
  ${EndIf}
  ${IfNot} ${FileExists} "$INSTDIR\${PRODUCT_FILENAME}.exe"
    Abort "The registered application executable is missing. No files were removed."
  ${EndIf}
  ${IfNot} ${FileExists} "$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe"
    Abort "The registered uninstaller is missing. No files were removed."
  ${EndIf}

  ${If} ${isUpdated}
    ; Keep repair moves on the install volume while preserving the protected root.
    ${GetParent} "$INSTDIR" $R6
    StrCpy $repairStage "$R6\.dsh-desktop-repair-${APP_GUID}"
    ${If} ${FileExists} "$repairStage\."
      Abort "A previous repair staging directory still exists. No files were removed."
    ${EndIf}
    CreateDirectory "$repairStage"
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File "/oname=protect-install-directory.ps1" "${PROJECT_DIR}\scripts\protect-install-directory.ps1"
    !insertmacro PowerShellWorkingDirectoryBegin
    nsExec::ExecToStack '"powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\protect-install-directory.ps1" -Path "$repairStage" -Recursive -AllowFreshInstallDirectory'
    Pop $R0
    Pop $R1
    !insertmacro PowerShellWorkingDirectoryEnd
    ${If} $R0 != 0
      RMDir /r "$repairStage"
      Abort "Unable to protect the repair staging directory. No files were removed."
    ${EndIf}
    SetOutPath "$TEMP"
    Push ""
    Call un.RepairMoveTopLevel
    Pop $R0

    ${If} $R0 != 0
      DetailPrint "File is busy, aborting repair cleanup: $R0"
      Push ""
      Call un.RepairRestoreTopLevel
      Pop $R1
      ${If} $R1 != 0
        Abort "Unable to clear the previous installation, and recovery was incomplete. Remaining files were preserved in $repairStage."
      ${EndIf}
      RMDir /r "$repairStage"
      Abort "Unable to clear the previous installation for repair. Existing files were restored."
    ${EndIf}
    RMDir /r /REBOOTOK "$repairStage"
  ${Else}
    ; Keep a same-volume, short temporary path so long Harness paths remain removable.
    SetOutPath "$TEMP"
    ${GetParent} "$INSTDIR" $R0
    ClearErrors
    GetTempFileName $R1 "$R0"

    ${If} ${Errors}
      Abort "Unable to reserve a temporary path beside $INSTDIR."
    ${EndIf}

    Delete "$R1"
    ClearErrors
    Rename "$INSTDIR" "$R1"

    ${If} ${Errors}
      Abort "Unable to move the previous installation out of $INSTDIR."
    ${EndIf}

    RMDir /r /REBOOTOK "$R1"
  ${EndIf}
!macroend
