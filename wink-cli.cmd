@echo off
node "%~dp0src\cli.js" %*
exit /b %errorlevel%
