import sys
import os
import subprocess
import shutil
import threading
import socket
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import TCPServer
from PyQt6.QtCore import QUrl, QTimer, Qt, QEvent, pyqtSignal, QObject
from PyQt6.QtGui import QColor, QIcon, QPixmap, QPainter, QFont, QKeyEvent
from PyQt6.QtWidgets import QApplication, QMainWindow, QMessageBox
from PyQt6.QtWebEngineWidgets import QWebEngineView
from PyQt6.QtWebEngineCore import QWebEnginePage, QWebEngineSettings, QWebEngineProfile

# ==========================================
# CONFIGURAZIONE PERCORSI 
# ==========================================
LM_STUDIO_PATH = r"D:\LLM\LM Studio\LM Studio.exe"
LMS_CLI_PATH = r"C:\Users\DarKVinX\.lmstudio\bin\lms.exe"
MODEL_PATH = "llama-3some-8b-v2"  

KOKORO_PATH = r"D:\LLM\Kokoro\Kokoro-TTS-Local"
TEMP_CLEANUP_PATH = r"C:\Users\DarKVinX\AppData\Local\Temp\gradio"
OUTPUT_CLEANUP_PATH = r"D:\LLM\Kokoro\Kokoro-TTS-Local\outputs"
FRONTEND_PORT = 8000

# ============================================================
# FIX CORS: Handler personalizzato che aggiunge gli header necessari
# ============================================================
class CORSHTTPRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200, "OK")
        self.end_headers()

    def log_message(self, format, *args):
        pass # Mantiene la console pulita


class StandaloneChatApp(QMainWindow):
    # Segnale thread-safe per aggiornare la UI dal boot thread
    loading_update = pyqtSignal(int, str, str, str)

    def __init__(self):
        super().__init__()
        self.setWindowTitle("LM Studio STS Chat - Full Desktop App")
        # ==========================================
        # IMPOSTAZIONE ICONA
        # ==========================================
        icon_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons", "icon.png")
        if os.path.exists(icon_path):
            self.setWindowIcon(QIcon(icon_path))
        else:
            print(f"[Python] AVVISO: Icona non trovata in {icon_path}")
        # ==========================================
        self.resize(1820, 980)

        self.subprocesses = []
        self.http_server = None
        self.backend_ready = False
        self.loading_update.connect(self._run_loading_js)

        self.clean_environment()
        self.start_internal_web_server()
        threading.Thread(target=self.boot_sequence_thread, daemon=True).start()

        self.web_view = QWebEngineView()

        # FIX FLICKERING: sfondo opaco e rendering stabile
        self.web_view.setStyleSheet("background-color: #0a0a0b;")
        self.web_view.page().setBackgroundColor(QColor("#0a0a0b"))
        # Disabilita il rendering trasparente che causa il flickering
        self.web_view.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent, True)
        self.web_view.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground, False)

        # Profilo di archiviazione persistente per localStorage
        self.profile = QWebEngineProfile("ChatStorageProfile", self.web_view)
        storage_dir = os.path.join(os.path.expanduser("~"), ".lmstudio_sts_data")
        self.profile.setPersistentStoragePath(storage_dir)
        
        self.profile.clearHttpCache()
        
        self.page = QWebEnginePage(self.profile, self.web_view)
        self.web_view.setPage(self.page)
        # Riapplica il colore di sfondo dopo aver impostato la pagina
        self.page.setBackgroundColor(QColor("#0a0a0b"))

        self.show_loading_screen("Inizializzazione ecosistema...")
        self.web_view.page().featurePermissionRequested.connect(self.handle_permission_requested)
        
        settings = self.web_view.settings()
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessRemoteUrls, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.JavascriptEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalStorageEnabled, True)
        
        self.setCentralWidget(self.web_view)

        self.connection_timer = QTimer()
        self.connection_timer.timeout.connect(self.check_system_status)
        self.connection_timer.start(1000)

        # Event filter globale: intercetta ESC e F11 anche quando
        # il focus è dentro QWebEngineView (che altrimenti "mangia" i tasti)
        QApplication.instance().installEventFilter(self)

    def show_loading_screen(self, message):
        self.web_view.setHtml("""
            <html>
            <head>
            <style>
              * { box-sizing: border-box; margin: 0; padding: 0; }
              body {
                background-color: #0a0a0b;
                color: white;
                font-family: 'Segoe UI', -apple-system, sans-serif;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                overflow: hidden;
              }
              body::before {
                content: '';
                position: fixed;
                inset: 0;
                background:
                  radial-gradient(circle at 20% 80%, rgba(29,112,245,0.08) 0%, transparent 50%),
                  radial-gradient(circle at 80% 20%, rgba(26,86,219,0.06) 0%, transparent 50%);
                pointer-events: none;
              }
              .container {
                text-align: center;
                width: 540px;
                max-width: 90vw;
              }
              .logo {
                font-size: 13px;
                font-weight: 600;
                color: #a3a3a3;
                letter-spacing: 0.15em;
                text-transform: uppercase;
                margin-bottom: 10px;
              }
              h2 {
                color: #1d70f5;
                font-size: 26px;
                font-weight: 600;
                letter-spacing: -0.03em;
                margin-bottom: 8px;
              }
              #status-msg {
                color: #a3a3a3;
                font-size: 14px;
                min-height: 20px;
                margin-bottom: 24px;
                transition: opacity 0.3s;
              }
              .progress-track {
                background: rgba(255,255,255,0.07);
                border-radius: 6px;
                height: 6px;
                width: 100%;
                overflow: hidden;
                margin-bottom: 8px;
                border: 1px solid rgba(255,255,255,0.06);
              }
              #progress-bar {
                height: 100%;
                width: 0%;
                background: linear-gradient(90deg, #1d70f5, #1a56db);
                border-radius: 6px;
                transition: width 0.6s cubic-bezier(0.4,0,0.2,1);
                position: relative;
                overflow: hidden;
              }
              #progress-bar::after {
                content: '';
                position: absolute;
                inset: 0;
                background: linear-gradient(90deg, transparent, rgba(255,255,255,0.25), transparent);
                animation: shimmer 1.8s infinite;
              }
              @keyframes shimmer {
                0%   { transform: translateX(-100%); }
                100% { transform: translateX(100%); }
              }
              #progress-label {
                text-align: right;
                font-size: 11px;
                color: #1d70f5;
                font-weight: 600;
                margin-bottom: 20px;
                font-variant-numeric: tabular-nums;
              }
              .console-box {
                background: rgba(255,255,255,0.03);
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 10px;
                padding: 12px 14px;
                text-align: left;
                max-height: 140px;
                overflow-y: auto;
                font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
                font-size: 11.5px;
                line-height: 1.7;
                color: #737373;
              }
              .console-box::-webkit-scrollbar { width: 4px; }
              .console-box::-webkit-scrollbar-track { background: transparent; }
              .console-box::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
              .log-line { display: block; }
              .log-line.ok   { color: #10b981; }
              .log-line.warn { color: #f59e0b; }
              .log-line.err  { color: #ef4444; }
              .log-line.info { color: #60b4ff; }
              .dots::after {
                content: '';
                animation: dots 1.4s steps(4, end) infinite;
              }
              @keyframes dots {
                0%   { content: ''; }
                25%  { content: '.'; }
                50%  { content: '..'; }
                75%  { content: '...'; }
                100% { content: ''; }
              }
            </style>
            </head>
            <body>
              <div class="container">
                <div class="logo">LM Studio STS</div>
                <h2>Creazione ecosistema in corso</h2>
                <div id="status-msg"><span class="dots">Inizializzazione</span></div>
                <div class="progress-track">
                  <div id="progress-bar"></div>
                </div>
                <div id="progress-label">0%</div>
                <div class="console-box" id="console-log">
                  <span class="log-line info">&gt; Avvio sequenza di boot...</span>
                </div>
              </div>
              <script>
                function setProgress(pct, msg, logText, logType) {
                  document.getElementById('progress-bar').style.width = pct + '%';
                  document.getElementById('progress-label').textContent = pct + '%';
                  if (msg) {
                    var s = document.getElementById('status-msg');
                    s.style.opacity = '0';
                    setTimeout(function() {
                      s.innerHTML = msg;
                      s.style.opacity = '1';
                    }, 150);
                  }
                  if (logText) {
                    var box = document.getElementById('console-log');
                    var line = document.createElement('span');
                    line.className = 'log-line' + (logType ? ' ' + logType : '');
                    line.textContent = '> ' + logText;
                    box.appendChild(document.createElement('br'));
                    box.appendChild(line);
                    box.scrollTop = box.scrollHeight;
                  }
                }
              </script>
            </body>
            </html>
        """)

    def update_loading(self, pct, msg="", log_text="", log_type=""):
        """Emette il segnale thread-safe — può essere chiamato da qualsiasi thread."""
        self.loading_update.emit(pct, msg, log_text, log_type)

    def _run_loading_js(self, pct, msg, log_text, log_type):
        """Slot eseguito nel main thread: aggiorna la UI via JavaScript."""
        def esc(s): return s.replace("'", "\\'").replace("\n", " ")
        js = f"if(typeof setProgress==='function') setProgress({pct}, '{esc(msg)}', '{esc(log_text)}', '{esc(log_type)}');"
        try:
            self.web_view.page().runJavaScript(js)
        except Exception:
            pass

    def clean_environment(self):
        print("[Python] Pulizia preventiva dei processi...")
        try:
            subprocess.Popen(["taskkill", "/f", "/im", "lms.exe"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.Popen(["taskkill", "/f", "/im", "LM Studio.exe"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass
        
        print("[Python] Svuotamento cache audio...")
        for path in [TEMP_CLEANUP_PATH, OUTPUT_CLEANUP_PATH]:
            if os.path.exists(path):
                try:
                    for filename in os.listdir(path):
                        file_path = os.path.join(path, filename)
                        if os.path.isfile(file_path): os.unlink(file_path)
                        elif os.path.isdir(file_path): shutil.rmtree(file_path)
                except Exception:
                    pass

    def start_internal_web_server(self):
        def run_server():
            # Ci spostiamo nella cartella dello script per servire i file statici
            os.chdir(os.path.dirname(os.path.abspath(__file__)))
            
            TCPServer.allow_reuse_address = True
            # Usiamo il nostro CORSHTTPRequestHandler invece di SimpleHTTPRequestHandler
            with TCPServer(("", FRONTEND_PORT), CORSHTTPRequestHandler) as httpd:
                self.http_server = httpd
                httpd.serve_forever()

        threading.Thread(target=run_server, daemon=True).start()

    def boot_sequence_thread(self):
        try:
            # 1. Avvia LM Studio in modalità server headless (nessuna GUI)
            print("[Python] Step 1: Avvio di LM Studio server (headless)...")
            self.update_loading(10, "Avvio server LM Studio...", "Step 1: Avvio LM Studio server (headless)", "info")
            if os.path.exists(LMS_CLI_PATH):
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startupinfo.wShowWindow = 0  # SW_HIDE
                p_lms = subprocess.Popen(
                    [LMS_CLI_PATH, "server", "start", "--cors"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    startupinfo=startupinfo,
                    creationflags=subprocess.CREATE_NO_WINDOW
                )
                self.subprocesses.append(p_lms)
                self.update_loading(20, "LM Studio avviato, attesa inizializzazione...", "lms.exe avviato con successo", "ok")
            else:
                print(f"[Python] ERRORE: lms.exe non trovato in {LMS_CLI_PATH}")
                self.update_loading(20, "Attenzione: lms.exe non trovato", f"ERRORE: lms.exe non trovato in {LMS_CLI_PATH}", "err")
            
            self.update_loading(25, "Attesa avvio server LLM<span class='dots'></span>", "In attesa che il server LLM sia pronto (8s)...", "")
            time.sleep(8)

            # 2. Carica il modello
            print(f"[Python] Step 2: Caricamento del modello '{MODEL_PATH}'...")
            self.update_loading(40, f"Caricamento modello: {MODEL_PATH}<span class='dots'></span>", f"Step 2: Caricamento modello '{MODEL_PATH}'", "info")
            if os.path.exists(LMS_CLI_PATH):
                subprocess.run(
                    [LMS_CLI_PATH, "load", MODEL_PATH], 
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    text=True, encoding='utf-8', errors='ignore'
                )
                self.update_loading(60, "Modello caricato in memoria", f"Modello '{MODEL_PATH}' caricato con successo", "ok")
            
           # 3. Avvia Kokoro con FIX per UnicodeEncodeError (UTF-8 Forzato)
            print("[Python] Step 3: Avvio di Kokoro TTS...")
            self.update_loading(70, "Avvio motore TTS Kokoro<span class='dots'></span>", "Step 3: Avvio Kokoro TTS...", "info")
            
            venv_python = os.path.join(KOKORO_PATH, "venv", "Scripts", "python.exe")
            venv_scripts = os.path.join(KOKORO_PATH, "venv", "Scripts")
            
            # Prepariamo un ambiente di sistema pulito
            env = os.environ.copy()
            env["PATH"] = venv_scripts + os.pathsep + env.get("PATH", "")
            env["VIRTUAL_ENV"] = os.path.join(KOKORO_PATH, "venv")
            env["PYTHONUNBUFFERED"] = "1"
            
            # ==========================================
            # FIX CRITICO PER UNICODEENCODEERROR (cp1252)
            # Forziamo Python a usare UTF-8 per tutti i print e gli output di testo
            # ==========================================
            env["PYTHONIOENCODING"] = "utf-8"
            env["PYTHONUTF8"] = "1"
            
            if "PYTHONHOME" in env:
                del env["PYTHONHOME"]

            if os.path.exists(venv_python):
                # Apriamo il file di log specificando tassativamente encoding="utf-8"
                log_file_path = os.path.join(KOKORO_PATH, "kokoro_debug.log")
                log_file = open(log_file_path, "w", encoding="utf-8")
                
                p_kokoro = subprocess.Popen(
                    [venv_python, "gradio_interface.py"],
                    cwd=KOKORO_PATH,
                    env=env,
                    stdout=log_file,
                    stderr=log_file,
                    creationflags=subprocess.CREATE_NO_WINDOW
                )
                self.subprocesses.append(p_kokoro)
                print(f"[Python] Processo Kokoro allocato in UTF-8. Diagnostica in: {log_file_path}")
                self.update_loading(85, "Kokoro TTS in avvio, attesa servizi<span class='dots'></span>", f"Kokoro avviato (log: {log_file_path})", "ok")
            else:
                print(f"[Python] ERRORE CRITICO: Non trovo l'eseguibile Python in {venv_python}")
                self.update_loading(85, "Attenzione: Python venv non trovato", f"ERRORE: Python non trovato in {venv_python}", "err")

            self.backend_ready = True
            self.update_loading(95, "Verifica connessione ai servizi<span class='dots'></span>", "Backend pronto. Verifica porte in corso...", "ok")
        except Exception as e:
            print(f"[Python] Errore boot: {e}")
            self.update_loading(0, "Errore durante l'avvio", f"Errore boot: {e}", "err")

    def check_system_status(self):
        if not self.backend_ready: return
        a_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        a_socket.settimeout(0.3)
        if a_socket.connect_ex(("127.0.0.1", 7860)) == 0:
            print("[Python] Tutto pronto! Servizi online.")
            self.update_loading(100, "Tutto pronto! Avvio interfaccia...", "Tutti i servizi online. Caricamento UI...", "ok")
            self.connection_timer.stop()
            # Breve pausa per mostrare il 100% prima del redirect
            QTimer.singleShot(600, lambda: self.web_view.setUrl(QUrl(f"http://127.0.0.1:{FRONTEND_PORT}/index.html")))
        a_socket.close()

    def handle_permission_requested(self, url, feature):
        if feature == QWebEnginePage.Feature.MediaAudioCapture:
            self.web_view.page().setFeaturePermission(url, feature, QWebEnginePage.PermissionPolicy.PermissionGrantedByUser)

    def eventFilter(self, obj, event):
        """Intercetta i tasti a livello globale, anche quando il focus è in QWebEngineView."""
        if event.type() == QEvent.Type.KeyPress:
            key = event.key()
            if key == Qt.Key.Key_Escape:
                self._confirm_exit()
                return True  # blocca la propagazione
            if key == Qt.Key.Key_F11:
                if self.isFullScreen():
                    self.showMaximized()
                else:
                    self.showFullScreen()
                return True
        return super().eventFilter(obj, event)

    def keyPressEvent(self, event):
        """Fallback nel caso il focus sia sulla finestra principale."""
        super().keyPressEvent(event)

    def _confirm_exit(self):
        msg = QMessageBox(self)
        msg.setWindowTitle("Chiudi applicazione")
        msg.setText("Sei sicuro di voler chiudere?")
        msg.setIcon(QMessageBox.Icon.Question)
        msg.setStandardButtons(QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No)
        msg.setDefaultButton(QMessageBox.StandardButton.No)
        msg.setStyleSheet("""
            QMessageBox {
                background-color: #1a1a2e;
                color: #e0e0e0;
            }
            QLabel {
                color: #e0e0e0;
                font-size: 14px;
            }
            QPushButton {
                background-color: #1d70f5;
                color: white;
                border: none;
                padding: 6px 20px;
                border-radius: 4px;
                font-size: 13px;
                min-width: 70px;
            }
            QPushButton:hover {
                background-color: #1a56db;
            }
            QPushButton[text="No"] {
                background-color: #374151;
            }
            QPushButton[text="No"]:hover {
                background-color: #4b5563;
            }
        """)
        if msg.exec() == QMessageBox.StandardButton.Yes:
            self.close()

    def closeEvent(self, event):
        print("[Python] Chiusura applicazione...")

        # 1. Ferma il server LMS CLI — usa run() sincrono con timeout
        if os.path.exists(LMS_CLI_PATH):
            try:
                subprocess.run(
                    [LMS_CLI_PATH, "server", "stop"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                    timeout=10  # aspetta fino a 10 secondi
                )
                print("[Python] lms server stop completato.")
            except subprocess.TimeoutExpired:
                print("[Python] lms server stop timeout — forzo kill.")
            except Exception as e:
                print(f"[Python] Errore lms server stop: {e}")

        # 2. Fallback: kill diretto di lms.exe e LM Studio.exe se ancora attivi
        for proc_name in ["lms.exe", "LM Studio.exe"]:
            try:
                subprocess.run(
                    ["taskkill", "/f", "/im", proc_name],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    creationflags=subprocess.CREATE_NO_WINDOW
                )
            except Exception:
                pass

        # 3. Termina i subprocess interni (Kokoro, ecc.)
        if self.http_server:
            self.http_server.shutdown()
        for p in self.subprocesses:
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    p.kill()

        # 4. Cleanup audio temp/output
        for path in [TEMP_CLEANUP_PATH, OUTPUT_CLEANUP_PATH]:
            if os.path.exists(path):
                try:
                    shutil.rmtree(path)
                    os.makedirs(path)
                    print(f"[Python] Cleanup: {path}")
                except Exception as e:
                    print(f"[Python] Errore cleanup {path}: {e}")

        event.accept()

def _load_app_icon() -> QIcon:
    import os
    # 1. Diamo priorità assoluta al file .ico che Windows digerisce perfettamente
    ico_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "icons", "icon.ico"
    )
    if os.path.exists(ico_path):
        return QIcon(ico_path)
        
    # Fallback 2: se non c'è il .ico, prova il .png originale
    png_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "icons", "icon.png"
    )
    if os.path.exists(png_path):
        return QIcon(png_path)
    
    # Fallback 3: Generazione dinamica se mancano entrambi i file
    print("[Python] AVVISO: Nessun file icona trovato. Genero icona di fallback...")
    pix = QPixmap(256, 256)
    pix.fill(Qt.GlobalColor.transparent)
    p = QPainter(pix)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    p.setRenderHint(QPainter.RenderHint.TextAntialiasing)
    p.setFont(QFont("Segoe UI Emoji", int(256 * 0.7)))
    p.drawText(pix.rect(), Qt.AlignmentFlag.AlignCenter, "💬")
    p.end()
    return QIcon(pix)

if __name__ == "__main__":
    # IMPORTANTE: Inizializza l'applicazione PRIMA di qualunque operazione grafica o ctypes
    app = QApplication(sys.argv)
    app.setApplicationName("LM Studio STS Chat")

    # FIX RESET CACHE WINDOWS: Cambiamo l'ID stringa inserendo un valore unico (v2)
    # Questo costringe Windows a ignorare la vecchia cache delle icone corrotta.
    import ctypes
    myappid = 'darkvinx.lmstudio.stschat.final.v2' 
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(myappid)
    except Exception as e:
        print(f"[Python] Errore ctypes: {e}")

    # Carica l'icona (.ico o .png)
    icon = _load_app_icon()
    
    # Applica l'icona sia a livello globale (Taskbar) che alla finestra specifica
    app.setWindowIcon(icon)

    main_window = StandaloneChatApp()
    main_window.setWindowIcon(icon) 
    
    # Mostriamo la finestra prima in modalità normale per forzare l'aggiornamento
    # della Taskbar di Windows, poi passiamo al Fullscreen.
    main_window.show()
    QTimer.singleShot(100, main_window.showFullScreen) # Ritardo di 100ms per stabilizzare Windows
    
    sys.exit(app.exec())
