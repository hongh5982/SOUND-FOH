; Sound FOH installer hooks.
; Equalizer APO (GPL-2.0, https://sourceforge.net/projects/equalizerapo/) is installed alongside Sound FOH,
; unchanged and silently, only when it isn't on the PC yet. Its own device picker is closed, because
; Sound FOH switches Equalizer APO on for the chosen speaker itself.

!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$PROGRAMFILES64\EqualizerAPO\EqualizerAPO.dll" eapo_done 0
  IfFileExists "$INSTDIR\eapo\EqualizerAPO-x64-1.4.2.exe" 0 eapo_done
    DetailPrint "Installing audio engine..."
    nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$$p = Start-Process -FilePath '$INSTDIR\eapo\EqualizerAPO-x64-1.4.2.exe' -ArgumentList '/S' -PassThru; $$t = 0; while (-not $$p.HasExited -and $$t -lt 600) { Get-Process DeviceSelector,Configurator -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Milliseconds 300; $$t++ }; for ($$i = 0; $$i -lt 10; $$i++) { Get-Process DeviceSelector,Configurator -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Milliseconds 300 }"`
    Pop $0
  eapo_done:
  Delete "$INSTDIR\eapo\EqualizerAPO-x64-1.4.2.exe"
  RMDir "$INSTDIR\eapo"
!macroend
