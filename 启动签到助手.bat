@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
set "APP="
for /d %%D in ("%~dp0游戏社区签到助手-免安装版-v*") do (
    if exist "%%D\游戏社区签到助手\游戏社区签到助手.exe" set "APP=%%D\游戏社区签到助手\游戏社区签到助手.exe"
)
if defined APP (
    rem ---- 开机自启自愈：按用户设置把 Run 键刷新到最新版 exe ----
    rem （版本目录改名后旧 Run 键会失效导致"升级后自启失效"，这里每次启动都校正）
    set "AUTOON=1"
    set "SETTFILE=%APPDATA%\签到助手\settings.json"
    if exist "%SETTFILE%" (
        findstr /R /C:"autoStart[^,]*false" "%SETTFILE%" >nul 2>nul && set "AUTOON=0"
    )
    set "RUNPATH=HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
    set "RUNNAME=electron.app.游戏社区签到助手"
    if "!AUTOON!"=="1" (
        reg add "!RUNPATH!" /v "!RUNNAME!" /t REG_SZ /d "\"!APP!\" --hidden" /f >nul 2>nul
    ) else (
        reg delete "!RUNPATH!" /v "!RUNNAME!" /f >nul 2>nul
    )
    start "" "%APP%"
    exit /b 0
)
echo [提示] 未找到打包好的程序，请先打包或联系开发者。
pause
