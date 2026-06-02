@echo off
cd /d "%~dp0"

:: Activate virtual environment

call venv\Scripts\activate.bat

:: Run  in the venv
python STS.py