@echo off
rem PCGuard 설치: 이 파일을 더블클릭하세요. 관리자 권한을 요청한 뒤 install.ps1을 실행합니다.
rem 설치 EXE(IExpress)가 임시 폴더를 지우지 않도록 관리자 창이 끝날 때까지 기다립니다.
chcp 65001 >nul
net session >nul 2>&1
if errorlevel 1 (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs -Wait"
    exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
