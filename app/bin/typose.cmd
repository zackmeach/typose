@echo off
rem Typose's command-line launcher (spec 8.1). Usage: typose [--] FILE...
rem Every argument is a file to open, whatever it looks like: Typose gets them after "--", so none is taken
rem for a switch. Each goes on quoted, and is never expanded again, so percent signs, carets, ampersands
rem and exclamation marks in a name arrive as they are. The Typose it runs is two folders up, as in the
rem package (resources\bin). It doesn't wait for Typose to quit.
setlocal DisableDelayedExpansion
rem Read before any shift, which shifts the script's own path too.
set "exe=%~dp0..\..\Typose.exe"
if not exist "%exe%" goto missing
set args=
if "%~1"=="--" shift
:next
if "%~1"=="" goto run
set args=%args% "%~1"
shift
goto next
:run
start "" "%exe%" --%args%
exit /b 0
:missing
echo typose: no Typose at "%exe%" 1>&2
exit /b 1
