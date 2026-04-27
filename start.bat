@echo off
REM Mapleproof — Windows startup script
REM Auto-generates SSL cert and starts server with camera access

setlocal enabledelayedexpansion

echo.
echo   🍁 Mapleproof - Starting with Camera Access
echo.

REM Check if Node is installed
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo   ERROR: Node.js not found!
    echo   Download from: https://nodejs.org/
    pause
    exit /b 1
)

REM Check if OpenSSL is installed
where openssl >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo   ERROR: OpenSSL not found!
    pause
    exit /b 1
)

REM Check if cert exists
if not exist cert.pem (
    echo   Generating self-signed SSL certificate...
    openssl req -x509 -newkey rsa:4096 -nodes -out cert.pem -keyout key.pem -days 365 -subj "/C=CA/ST=Ontario/L=Toronto/O=Mapleproof/CN=localhost"
    if !ERRORLEVEL! EQU 0 (
        echo   ✓ Certificate generated
    ) else (
        echo   ERROR: Could not generate certificate
        pause
        exit /b 1
    )
) else (
    echo   ✓ Certificate found
)

echo.

REM Check if node_modules exists
if not exist node_modules (
    echo   Installing dependencies...
    call npm install
    echo.
)

REM Start server
echo   Starting server...
echo.
node server.js
