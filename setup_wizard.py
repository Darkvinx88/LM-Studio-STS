"""
LM Studio STS — Setup Wizard
Generates RunLMStudioTTS.bat with user-specific paths.
Requirements: Python 3.8+ (tkinter is included in standard Python for Windows)
"""

import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import os
import sys
import subprocess
import threading
import json

# ── Config file (remembers previous settings) ─────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(SCRIPT_DIR, ".sts_config.json")

DEFAULTS = {
    "lms_cli":      "",
    "model_path":   "llama-3some-8b-v2",
    "kokoro_path":  "",
    "frontend_path": SCRIPT_DIR,
    "frontend_port": "8000",
    "frontend_host": "127.0.0.1",
}

def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r") as f:
                saved = json.load(f)
                merged = DEFAULTS.copy()
                merged.update(saved)
                return merged
        except Exception:
            pass
    # Auto-detect lms.exe from common locations
    cfg = DEFAULTS.copy()
    candidates = [
        os.path.expandvars(r"%LOCALAPPDATA%\..\..\.lmstudio\bin\lms.exe"),
        os.path.expandvars(r"%USERPROFILE%\.lmstudio\bin\lms.exe"),
        r"C:\Users\Public\.lmstudio\bin\lms.exe",
    ]
    for c in candidates:
        if os.path.exists(c):
            cfg["lms_cli"] = os.path.normpath(c)
            break
    cfg["frontend_path"] = SCRIPT_DIR
    return cfg

def save_config(cfg):
    try:
        with open(CONFIG_FILE, "w") as f:
            json.dump(cfg, f, indent=2)
    except Exception:
        pass


# ── BAT template ───────────────────────────────────────────────────────────
BAT_TEMPLATE = r"""@echo off
title LM Studio STS v1.0 - Enhanced Launcher
setlocal enabledelayedexpansion

set "SUCCESS=[OK] "
set "ERROR=[ERROR] "
set "WARNING=[WARN] "
set "INFO=[INFO] "

set "LMS_CLI_PATH={lms_cli}"
set "MODEL_PATH={model_path}"
set "KOKORO_PATH={kokoro_path}"
set "FRONTEND_PATH={frontend_path}"
set "TEMP_CLEANUP_PATH=%LOCALAPPDATA%\Temp\gradio"
set "OUTPUT_CLEANUP_PATH={kokoro_path}\outputs"
set "FRONTEND_PORT={frontend_port}"
set "FRONTEND_HOST={frontend_host}"

set "LOG_FILE=%~dp0launcher.log"
echo %date% %time% - LM Studio STS Launcher Started > "%LOG_FILE%"

echo ================================
echo   LM Studio STS Enhanced Launcher
echo ================================
echo.
call :check_paths

echo ================================
echo   Starting LM Studio Server (headless CLI)
echo ================================
if not exist "%LMS_CLI_PATH%" (
    echo %ERROR%LMS CLI not found at %LMS_CLI_PATH%
    goto :error_exit
)

echo %INFO%Starting lms server (headless, with CORS)...
start /B "" "%LMS_CLI_PATH%" server start --cors
echo %SUCCESS%LM Studio server started in headless mode
echo %date% %time% - lms server start --cors launched >> "%LOG_FILE%"

call :wait_with_progress 8 "LM Studio server initialization"

echo.
echo ================================
echo   Loading model with LMS CLI
echo ================================
echo %INFO%Loading model: %MODEL_PATH%
"%LMS_CLI_PATH%" load "%MODEL_PATH%"
if %errorlevel% neq 0 (
    echo %ERROR%Failed to load model
    goto :error_exit
) else (
    echo %SUCCESS%Model loaded successfully
)

echo.
echo ================================
echo   Starting Kokoro TTS
echo ================================
if not exist "%KOKORO_PATH%" (
    echo %ERROR%Kokoro TTS path not found at %KOKORO_PATH%
    goto :error_exit
)

cd /d "%KOKORO_PATH%"
if not exist "venv\Scripts\activate.bat" (
    echo %ERROR%Kokoro TTS virtual environment not found
    goto :error_exit
)

call venv\Scripts\activate
echo %INFO%Starting Kokoro TTS in background...
start /B "" python gradio_interface.py
echo %SUCCESS%Kokoro TTS started
echo %date% %time% - Kokoro TTS started >> "%LOG_FILE%"

call :wait_with_progress 3 "Kokoro TTS initialization"

echo.
echo ================================
echo   Starting Frontend Server
echo ================================
cd /d "%FRONTEND_PATH%"

echo %INFO%Starting HTTP server on %FRONTEND_HOST%:%FRONTEND_PORT%
start /B "" python serve.py %FRONTEND_PORT% %FRONTEND_HOST%
echo %SUCCESS%Frontend server started
echo %date% %time% - Frontend server started >> "%LOG_FILE%"

call :wait_with_progress 2 "Frontend server startup"

echo %INFO%Opening browser...
start "" "http://localhost:%FRONTEND_PORT%/index.html"

echo.
echo ================================
echo   All services started successfully!
echo ================================
echo.
echo   - LM Studio: headless (port 1234)
echo   - Kokoro TTS: http://localhost:7860
echo   - Frontend:   http://localhost:%FRONTEND_PORT%
echo.
echo ================================
echo   RUNNING - Press 'q' + Enter to shutdown
echo ================================

del /q "%FRONTEND_PATH%\shutdown.trigger" >nul 2>&1

:monitor_loop
if exist "%FRONTEND_PATH%\shutdown.trigger" (
    del /q "%FRONTEND_PATH%\shutdown.trigger" >nul 2>&1
    echo.
    echo %INFO%Shutdown signal received from browser...
    goto :shutdown_services
)
timeout /t 1 >nul
goto :monitor_loop

:shutdown_services
echo.
echo ================================
echo   Shutting down services...
echo ================================

echo %INFO%Stopping LM Studio server...
if exist "%LMS_CLI_PATH%" "%LMS_CLI_PATH%" server stop >nul 2>&1
taskkill /f /t /im "LM Studio.exe" >nul 2>&1
taskkill /f /t /im "lms.exe" >nul 2>&1
powershell -Command "Get-Process -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -like '*lmstudio*' -or $_.Name -like '*lms*' }} | Stop-Process -Force" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| find ":1234" ^| find "LISTENING"') do taskkill /f /t /pid %%a >nul 2>&1
echo %SUCCESS%LM Studio cleared

echo %INFO%Stopping frontend (port %FRONTEND_PORT%)...
for /f "tokens=5" %%a in ('netstat -ano ^| find ":%FRONTEND_PORT%" ^| find "LISTENING"') do taskkill /f /pid %%a >nul 2>&1
echo %SUCCESS%Frontend stopped

echo %INFO%Stopping Kokoro TTS (port 7860)...
for /f "tokens=5" %%a in ('netstat -ano ^| find ":7860" ^| find "LISTENING"') do taskkill /f /pid %%a >nul 2>&1
echo %SUCCESS%Kokoro TTS stopped

echo.
echo ================================
echo   Cleaning up TTS temp files
echo ================================
if exist "%TEMP_CLEANUP_PATH%" (
    del /q "%TEMP_CLEANUP_PATH%\*.*" >nul 2>&1
    for /d %%i in ("%TEMP_CLEANUP_PATH%\*") do rd /s /q "%%i" >nul 2>&1
    echo %SUCCESS%Temp files cleared
)
if exist "%OUTPUT_CLEANUP_PATH%" (
    del /q "%OUTPUT_CLEANUP_PATH%\*.*" >nul 2>&1
    for /d %%i in ("%OUTPUT_CLEANUP_PATH%\*") do rd /s /q "%%i" >nul 2>&1
    echo %SUCCESS%Output files cleared
)

echo.
echo %SUCCESS%All services stopped!
timeout /t 3 >nul
goto :end

:check_paths
echo %INFO%Verifying installation paths...
set "path_errors=0"
if not exist "%LMS_CLI_PATH%" ( echo   X LMS CLI: Not found & set /a path_errors+=1 ) else echo   + LMS CLI: Found
if not exist "%KOKORO_PATH%"  ( echo   X Kokoro TTS: Not found & set /a path_errors+=1 ) else echo   + Kokoro TTS: Found
if not exist "%FRONTEND_PATH%" ( echo   X Frontend: Not found & set /a path_errors+=1 ) else echo   + Frontend: Found
if !path_errors! gtr 0 ( echo. & echo %ERROR%Found !path_errors! path errors. & pause & goto :error_exit )
echo.
goto :eof

:wait_with_progress
set "duration=%1"
echo %INFO%Waiting %1 seconds for %2...
for /l %%i in (1,1,%1) do ( echo|set /p="." & timeout /t 1 >nul )
echo. & echo Ready!
goto :eof

:error_exit
echo.
echo ================================
echo   Launcher failed with errors
echo ================================
pause
exit /b 1

:end
endlocal
exit
"""


# ── GUI ────────────────────────────────────────────────────────────────────
class SetupWizard(tk.Tk):
    def __init__(self):
        super().__init__()
        self.cfg = load_config()
        self.title("LM Studio STS — Setup Wizard")
        self.resizable(False, False)
        self._build_ui()
        self._center()

    def _center(self):
        self.update_idletasks()
        w, h = self.winfo_width(), self.winfo_height()
        sw, sh = self.winfo_screenwidth(), self.winfo_screenheight()
        self.geometry(f"+{(sw-w)//2}+{(sh-h)//2}")

    def _build_ui(self):
        # ── Styles ──
        style = ttk.Style(self)
        style.theme_use("clam")
        BG   = "#0f1117"
        CARD = "#1a1d27"
        ACC  = "#1d6fe8"
        FG   = "#e2e4ea"
        MUT  = "#6b6f80"
        INP  = "#252836"

        self.configure(bg=BG)
        style.configure("TFrame",       background=BG)
        style.configure("Card.TFrame",  background=CARD)
        style.configure("TLabel",       background=BG,   foreground=FG,  font=("Segoe UI", 9))
        style.configure("Head.TLabel",  background=BG,   foreground=FG,  font=("Segoe UI", 13, "bold"))
        style.configure("Sub.TLabel",   background=BG,   foreground=MUT, font=("Segoe UI", 9))
        style.configure("Card.TLabel",  background=CARD, foreground=FG,  font=("Segoe UI", 9))
        style.configure("CardH.TLabel", background=CARD, foreground=MUT, font=("Segoe UI", 8, "bold"))
        style.configure("TEntry",       fieldbackground=INP, foreground=FG, insertcolor=FG,
                         bordercolor="#2e3245", relief="flat", font=("Segoe UI", 9))
        style.map("TEntry", fieldbackground=[("focus", INP)])
        style.configure("Acc.TButton",  background=ACC,  foreground="white",
                         font=("Segoe UI", 9, "bold"), padding=(12, 6), relief="flat")
        style.map("Acc.TButton", background=[("active", "#1558c0")])
        style.configure("Ghost.TButton", background=CARD, foreground=MUT,
                         font=("Segoe UI", 8), padding=(6, 3), relief="flat")
        style.map("Ghost.TButton", background=[("active", "#252836")], foreground=[("active", FG)])
        style.configure("TCheckbutton", background=BG, foreground=FG, font=("Segoe UI", 9))
        style.map("TCheckbutton", background=[("active", BG)])

        # ── Root padding ──
        root = ttk.Frame(self, padding=24)
        root.pack(fill="both", expand=True)

        # Header
        ttk.Label(root, text="⚙  LM Studio STS", style="Head.TLabel").pack(anchor="w")
        ttk.Label(root, text="Configure paths and generate the launcher script", style="Sub.TLabel").pack(anchor="w", pady=(2, 16))

        # ── Path entries ──
        self.entries = {}

        fields = [
            ("lms_cli",       "LMS CLI (lms.exe)",     True,  "Executable — usually in ~/.lmstudio/bin/"),
            ("model_path",    "Model name/path",        False, "As shown in LM Studio (e.g. llama-3some-8b-v2)"),
            ("kokoro_path",   "Kokoro TTS folder",      True,  "Root folder containing gradio_interface.py + venv/"),
            ("frontend_path", "Frontend folder",        True,  "Folder where index.html, serve.py, script.js live"),
        ]

        for key, label, is_browse, hint in fields:
            self._path_row(root, key, label, is_browse, hint)

        # ── Network row ──
        net = ttk.Frame(root, style="TFrame")
        net.pack(fill="x", pady=(4, 0))
        self._small_field(net, "frontend_host", "Host", 14).pack(side="left")
        ttk.Label(net, text="  Port  ", style="TLabel").pack(side="left")
        self._small_field(net, "frontend_port", "Port", 7).pack(side="left")

        # ── Divider ──
        ttk.Separator(root).pack(fill="x", pady=16)

        # ── Status card ──
        self.status_card = ttk.Frame(root, style="Card.TFrame", padding=12)
        self.status_card.pack(fill="x", pady=(0, 12))
        ttk.Label(self.status_card, text="STATUS", style="CardH.TLabel").pack(anchor="w")
        self.status_lbl = ttk.Label(self.status_card, text="Fill in the paths above, then click Verify.", style="Card.TLabel")
        self.status_lbl.pack(anchor="w", pady=(4, 0))

        # ── Buttons ──
        btn_row = ttk.Frame(root, style="TFrame")
        btn_row.pack(fill="x")
        ttk.Button(btn_row, text="Verify paths", style="Ghost.TButton",
                   command=self._verify).pack(side="left")
        ttk.Button(btn_row, text="Generate launcher.bat  →", style="Acc.TButton",
                   command=self._generate).pack(side="right")

    # ── helpers ──
    def _path_row(self, parent, key, label, is_browse, hint):
        f = ttk.Frame(parent, style="TFrame")
        f.pack(fill="x", pady=(0, 10))

        header = ttk.Frame(f, style="TFrame")
        header.pack(fill="x")
        ttk.Label(header, text=label, style="TLabel").pack(side="left")
        ttk.Label(header, text=hint, style="Sub.TLabel").pack(side="left", padx=(8, 0))

        row = ttk.Frame(f, style="TFrame")
        row.pack(fill="x", pady=(3, 0))

        var = tk.StringVar(value=self.cfg.get(key, ""))
        e = ttk.Entry(row, textvariable=var, font=("Segoe UI", 9))
        e.pack(side="left", fill="x", expand=True)
        self.entries[key] = var

        if is_browse:
            def browse(k=key, v=var, lbl=label):
                if "exe" in lbl.lower():
                    path = filedialog.askopenfilename(
                        title=f"Select {lbl}",
                        filetypes=[("Executable", "*.exe"), ("All", "*.*")]
                    )
                else:
                    path = filedialog.askdirectory(title=f"Select {lbl}")
                if path:
                    v.set(os.path.normpath(path))
            ttk.Button(row, text="Browse", style="Ghost.TButton", command=browse).pack(side="left", padx=(6, 0))

    def _small_field(self, parent, key, label, w):
        f = ttk.Frame(parent, style="TFrame")
        ttk.Label(f, text=label, style="TLabel").pack(anchor="w")
        var = tk.StringVar(value=self.cfg.get(key, ""))
        ttk.Entry(f, textvariable=var, width=w, font=("Segoe UI", 9)).pack()
        self.entries[key] = var
        return f

    def _get_values(self):
        return {k: v.get().strip() for k, v in self.entries.items()}

    def _verify(self):
        vals = self._get_values()
        lines = []
        ok = True

        checks = [
            ("lms_cli",       os.path.isfile,    "lms.exe"),
            ("kokoro_path",   os.path.isdir,     "Kokoro folder"),
            ("frontend_path", os.path.isdir,     "Frontend folder"),
        ]
        for key, fn, name in checks:
            v = vals[key]
            if not v:
                lines.append(f"✗  {name}: not set")
                ok = False
            elif not fn(v):
                lines.append(f"✗  {name}: path not found")
                ok = False
            else:
                lines.append(f"✓  {name}: OK")

        # Check venv
        venv = os.path.join(vals["kokoro_path"], "venv", "Scripts", "activate.bat")
        if vals["kokoro_path"] and not os.path.exists(venv):
            lines.append("✗  Kokoro venv/Scripts/activate.bat: not found")
            ok = False
        elif vals["kokoro_path"]:
            lines.append("✓  Kokoro venv: OK")

        # Check serve.py
        srv = os.path.join(vals["frontend_path"], "serve.py")
        if vals["frontend_path"] and not os.path.exists(srv):
            lines.append("⚠  serve.py not found in frontend folder")
        elif vals["frontend_path"]:
            lines.append("✓  serve.py: OK")

        color = "#22c55e" if ok else "#ef4444"
        self.status_lbl.configure(
            text="\n".join(lines),
            foreground=color
        )
        return ok

    def _generate(self):
        if not self._verify():
            if not messagebox.askyesno("Paths not verified",
                                       "Some paths have issues. Generate the .bat anyway?"):
                return

        vals = self._get_values()
        save_config(vals)

        bat_content = BAT_TEMPLATE.format(
            lms_cli=vals["lms_cli"],
            model_path=vals["model_path"],
            kokoro_path=vals["kokoro_path"],
            frontend_path=vals["frontend_path"],
            frontend_port=vals["frontend_port"],
            frontend_host=vals["frontend_host"],
        )

        out_path = os.path.join(SCRIPT_DIR, "RunLMStudioTTS.bat")
        try:
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(bat_content)
        except Exception as e:
            messagebox.showerror("Error", f"Could not write file:\n{e}")
            return

        msg = (
            f"RunLMStudioTTS.bat generated successfully!\n\n"
            f"Location: {out_path}\n\n"
            f"Run it as Administrator for best results."
        )
        if messagebox.askyesno("Done!", msg + "\n\nOpen folder now?"):
            subprocess.Popen(f'explorer /select,"{out_path}"')


# ── Entry point ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    app = SetupWizard()
    app.mainloop()
