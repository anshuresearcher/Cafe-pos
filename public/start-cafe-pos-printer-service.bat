@echo off
cd /d "%~dp0"
echo Starting Slash POS Printer Service...
node cafe-pos-printer-service.js
pause
