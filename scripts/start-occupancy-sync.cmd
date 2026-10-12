@echo off
setlocal
chcp 65001 >nul
title Sincronizacion Motel - Ocupacion e Informes
cd /d "%~dp0\.."
if not exist ".venv-sync\Scripts\python.exe" (
  echo No se encontro el entorno Python de sincronizacion.
  echo Ejecute primero la instalacion del sincronizador.
  echo.
  pause
  exit /b 1
)
".venv-sync\Scripts\python.exe" "scripts\sync_occupancy.py"
echo.
echo La sincronizacion se detuvo. Revise el mensaje anterior.
pause
