@echo off
title LM Studio STS v1.0 - Enhanced Launcher
setlocal enabledelayedexpansion

:: Visual prefixes for better readability (no colors to avoid compatibility issues)
set "SUCCESS=[OK] "
set "ERROR=[ERROR] "
set "WARNING=[WARN] "
set "INFO=[INFO] "

:: Configuration variables
set "LMS_CLI_PATH=C:\Users\DarKVinX\.lmstudio\bin\lms.exe"
set "MODEL_PATH=llama-3some-8b-v2"
set "KOKORO_PATH=D:\LLM\Kokoro\Kokoro-TTS-Local"
set "FRONTEND_PATH=D:\LM Studio STS"
set "TEMP_CLEANUP_PATH=C:\Users\DarKVinX\AppData\Local\Temp\gradio"
set "OUTPUT_CLEANUP_PATH=D:\LLM\Kokoro\Kokoro-TTS-Local\outputs"
set "FRONTEND_PORT=8000"
set "FRONTEND_HOST=127.0.0.1"

:: Process tracking variables
set "KOKORO_PID="
set "FRONTEND_PID="
set "BROWSER_PID="

:: Log file for troubleshooting
set "LOG_FILE=%~dp0launcher.log"
echo %date% %time% - LM Studio STS Launcher Started > "%LOG_FILE%"

echo ================================
echo   LM Studio STS Enhanced Launcher
echo ================================
echo.
:: Function to check if file/directory exists
call :check_paths

echo ================================
echo   Starting LM Studio Server (headless CLI)
echo ================================
if not exist "%LMS_CLI_PATH%" (
    echo %ERROR%LMS CLI not found at %LMS_CLI_PATH%
    echo %date% %time% - ERROR: LMS CLI not found >> "%LOG_FILE%"
    goto :error_exit
)

:: Start LM Studio in headless server mode via CLI — no GUI window
echo %INFO%Starting lms server (headless, with CORS)...
start /B "" "%LMS_CLI_PATH%" server start --cors
echo %SUCCESS%LM Studio server started in headless mode (no GUI)
echo %date% %time% - lms server start --cors launched >> "%LOG_FILE%"

:: Wait for the server to be ready before loading the model
call :wait_with_progress 8 "LM Studio server initialization"

echo.
echo ================================
echo   Loading model with LMS CLI
echo ================================

echo %INFO%Loading model: %MODEL_PATH%
"%LMS_CLI_PATH%" load "%MODEL_PATH%"
if %errorlevel% neq 0 (
    echo %ERROR%Failed to load model
    echo %date% %time% - ERROR: Model loading failed >> "%LOG_FILE%"
    goto :error_exit
) else (
    echo %SUCCESS%Model loaded successfully
    echo %date% %time% - Model loaded successfully >> "%LOG_FILE%"
)

echo.
echo ================================
echo   Starting Kokoro TTS
echo ================================
if not exist "%KOKORO_PATH%" (
    echo %ERROR%Kokoro TTS path not found at %KOKORO_PATH%
    echo %date% %time% - ERROR: Kokoro TTS path not found >> "%LOG_FILE%"
    goto :error_exit
)

cd /d "%KOKORO_PATH%"
if not exist "venv\Scripts\activate.bat" (
    echo %ERROR%Kokoro TTS virtual environment not found
    echo %date% %time% - ERROR: Kokoro venv not found >> "%LOG_FILE%"
    goto :error_exit
)

:: Start Kokoro TTS in background and capture PID
call venv\Scripts\activate
echo %INFO%Starting Kokoro TTS in background...
start /B "" python gradio_interface.py
:: Get the PID of the last started process (approximate)
for /f "tokens=2" %%i in ('tasklist /fi "imagename eq python.exe" /fo csv ^| find /c /v ""') do set KOKORO_RUNNING=%%i
echo %SUCCESS%Kokoro TTS started (Background Process)
echo %date% %time% - Kokoro TTS started >> "%LOG_FILE%"

call :wait_with_progress 3 "Kokoro TTS initialization"

echo.
echo ================================
echo   Starting Frontend Server
echo ================================
if not exist "%FRONTEND_PATH%" (
    echo %ERROR%Frontend path not found at %FRONTEND_PATH%
    echo %date% %time% - ERROR: Frontend path not found >> "%LOG_FILE%"
    goto :error_exit
)

cd /d "%FRONTEND_PATH%"
if not exist "index.html" (
    echo %WARNING%index.html not found in frontend directory
    echo %date% %time% - WARNING: index.html not found >> "%LOG_FILE%"
)

echo %INFO%Starting HTTP server on %FRONTEND_HOST%:%FRONTEND_PORT%
start /B "" python serve.py %FRONTEND_PORT% %FRONTEND_HOST%
echo %SUCCESS%Frontend server started (Background Process)
echo %date% %time% - Frontend server started >> "%LOG_FILE%"

call :wait_with_progress 2 "Frontend server startup"

echo %INFO%Opening browser...
start "" "http://localhost:%FRONTEND_PORT%/index.html"
echo %date% %time% - Browser opened >> "%LOG_FILE%"

echo.
echo ================================
echo   All services started successfully!
echo ================================
echo.
echo Services running in background:
echo   - LM Studio Server: headless CLI (lms server start --cors)
echo   - Model: %MODEL_PATH%
echo   - Kokoro TTS: http://localhost:7860 (Background Process)
echo   - Frontend: http://localhost:%FRONTEND_PORT% (Background Process)
echo.
echo ================================
echo   RUNNING - Press 'q' + Enter to shutdown all services
echo ================================

:: Launch terminal q-listener in separate window
start "q-listener" /min cmd /c ":ql & set /p ui=[q+Enter to shutdown]: & if /i !ui!==q (echo x>!FRONTEND_PATH!\shutdown.trigger) & goto ql"

echo %INFO%System ready. Waiting for shutdown (GUI button or type q + Enter)...
echo.
:: Clean up leftover trigger files from previous runs
del /q "%FRONTEND_PATH%\shutdown.trigger" >nul 2>&1

:: Use PowerShell to watch the trigger file in background while also
:: accepting 'q' from the terminal - both paths lead to shutdown_services
:monitor_loop
:: Check trigger file first (set by serve.py when GUI shutdown button is pressed)
if exist "%FRONTEND_PATH%\shutdown.trigger" (
    del /q "%FRONTEND_PATH%\shutdown.trigger" >nul 2>&1
    echo.
    echo %INFO%Shutdown signal received from browser GUI...
    goto :shutdown_services
)
:: Wait 1 second then loop - terminal input is handled below
timeout /t 1 >nul
goto :monitor_loop

:shutdown_services
echo.
echo ================================
echo   Shutting down services...
echo ================================

:: 1. Stop LM Studio server via CLI (graceful)
echo %INFO%Stopping LM Studio server gracefully...
if exist "%LMS_CLI_PATH%" (
    "%LMS_CLI_PATH%" server stop >nul 2>&1
)

:: 2. Target the core GUI processes spawned by the CLI engine
echo %INFO%Killing main LM Studio process trees...
taskkill /f /t /im "LM Studio.exe" >nul 2>&1
taskkill /f /t /im "lms.exe" >nul 2>&1

:: 3. Aggressive PowerShell purge for anything matching 'lmstudio' or 'lms'
echo %INFO%Cleaning up any remaining hidden sub-processes...
powershell -Command "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*lmstudio*' -or $_.Path -like '*lm-studio*' -or $_.Name -like '*lms*' -or $_.Name -like '*LM Studio*' } | Stop-Process -Force" >nul 2>&1

:: 4. Secondary fallback: check port 1234
for /f "tokens=5" %%a in ('netstat -ano ^| find ":1234" ^| find "LISTENING"') do (
    taskkill /f /t /pid %%a >nul 2>&1
)
echo %SUCCESS%LM Studio services cleared

:: 5. Kill process listening on port 8000 (frontend serve.py)
echo %INFO%Stopping frontend server (port %FRONTEND_PORT%)...
for /f "tokens=5" %%a in ('netstat -ano ^| find ":%FRONTEND_PORT%" ^| find "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>&1
)
echo %SUCCESS%Frontend server stopped

:: 6. Kill process listening on port 7860 (Kokoro TTS)
echo %INFO%Stopping Kokoro TTS (port 7860)...
for /f "tokens=5" %%a in ('netstat -ano ^| find ":7860" ^| find "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>&1
)
echo %SUCCESS%Kokoro TTS stopped

echo %date% %time% - Services shutdown initiated >> "%LOG_FILE%"

:: Cleanup section
echo.
echo ================================
echo   Cleaning up TTS temp contents
echo ================================
if exist "%TEMP_CLEANUP_PATH%" (
    echo %INFO%Cleaning up Gradio temp files...
    del /q "%TEMP_CLEANUP_PATH%\*.*" >nul 2>&1
    for /d %%i in ("%TEMP_CLEANUP_PATH%\*") do (
        rd /s /q "%%i" >nul 2>&1
    )
    echo %SUCCESS%Temp audio files cleared successfully
    echo %date% %time% - Temp cleanup completed >> "%LOG_FILE%"
) else (
    echo %WARNING%Temp directory not found, skipping cleanup
    echo %date% %time% - Temp directory not found for cleanup >> "%LOG_FILE%"
)

:: Cleanup Gradio output
if exist "%OUTPUT_CLEANUP_PATH%" (
    echo %INFO%Cleaning up Gradio output files...
    del /q "%OUTPUT_CLEANUP_PATH%\*.*" >nul 2>&1
    for /d %%i in ("%OUTPUT_CLEANUP_PATH%\*") do (
        rd /s /q "%%i" >nul 2>&1
    )
    echo %SUCCESS%Output audio files cleared successfully
    echo %date% %time% - Output cleanup completed >> "%LOG_FILE%"
) else (
    echo %WARNING%Output directory not found, skipping cleanup
    echo %date% %time% - Output directory not found for cleanup >> "%LOG_FILE%"
)

echo.
echo %SUCCESS%All services stopped and cleanup completed!
echo %INFO%Log file saved to: %LOG_FILE%
echo %date% %time% - Launcher shutdown completed >> "%LOG_FILE%"

echo.
echo Closing in 3 seconds...
timeout /t 3 >nul
goto :end

:check_paths
echo %INFO%Verifying installation paths...
set "path_errors=0"

if not exist "%LMS_CLI_PATH%" (
    echo   X LMS CLI: Not found
    set /a path_errors+=1
) else (
    echo   + LMS CLI: Found
)

if not exist "%KOKORO_PATH%" (
    echo   X Kokoro TTS: Not found
    set /a path_errors+=1
) else (
    echo   + Kokoro TTS: Found
)

if not exist "%FRONTEND_PATH%" (
    echo   X Frontend: Not found
    set /a path_errors+=1
) else (
    echo   + Frontend: Found
)

if !path_errors! gtr 0 (
    echo.
    echo %ERROR%Found !path_errors! path errors. Please check your installation.
    pause
    goto :error_exit
)
echo.
goto :eof

:wait_with_progress
set "duration=%1"
set "description=%2"
echo %INFO%Waiting %duration% seconds for %description%...
for /l %%i in (1,1,%duration%) do (
    echo|set /p="."
    timeout /t 1 >nul
)
echo.
Ready!
goto :eof

:error_exit
echo.
echo ================================
echo   Launcher failed with errors
echo ================================
echo %ERROR%Check the log file for details: %LOG_FILE%
echo %date% %time% - Launcher failed >> "%LOG_FILE%"
pause
exit /b 1

:end
echo %date% %time% - Launcher completed successfully >> "%LOG_FILE%"
endlocal
exit
