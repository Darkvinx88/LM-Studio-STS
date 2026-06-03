// ui-extras.js — Mobile sidebar toggle & misc UI enhancements
// Included after script.js

document.addEventListener('DOMContentLoaded', () => {
  const sidebar        = document.getElementById('sidebar');
  const overlay        = document.getElementById('sidebarOverlay');
  const sidebarToggle  = document.getElementById('sidebarToggle');
  const emptyState     = document.getElementById('emptyState');
  const chatEl         = document.getElementById('chat');
  const topbarModel    = document.getElementById('topbarModel');
  const modelText      = document.getElementById('modelText');

  // ── Sidebar toggle (mobile) ──────────────────────────────────
  function openSidebar()  { sidebar.classList.add('open');  overlay.classList.add('open'); }
  function closeSidebar() { sidebar.classList.remove('open'); overlay.classList.remove('open'); }

  if (sidebarToggle) sidebarToggle.addEventListener('click', openSidebar);
  if (overlay)       overlay.addEventListener('click', closeSidebar);

  // ── Empty state: hide when messages appear ───────────────────
  if (emptyState && chatEl) {
    const observer = new MutationObserver(() => {
      const hasMessages = chatEl.querySelector('.message');
      if (emptyState) emptyState.style.display = hasMessages ? 'none' : '';
    });
    observer.observe(chatEl, { childList: true });
    if (chatEl.querySelector('.message') && emptyState) emptyState.style.display = 'none';
  }

  // ── Topbar model sync ────────────────────────────────────────
  if (topbarModel && modelText) {
    const syncModel = () => { topbarModel.textContent = modelText.textContent; };
    new MutationObserver(syncModel).observe(modelText, { childList: true, characterData: true, subtree: true });
    syncModel();
  }

  // ── Auto-resize textarea ─────────────────────────────────────
  const chatInput = document.getElementById('promptInput');
  if (chatInput) {
    chatInput.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 200) + 'px';
    });
  }

  // ── Typing indicator: use new bubble style ───────────────────
  const chatWrap = document.querySelector('.chat-wrap');
  if (chatWrap) {
    chatWrap.addEventListener('DOMNodeInserted', (e) => {
      const node = e.target;
      if (node?.classList?.contains('message')) {
        const bubble = node.querySelector('.bubble.typing');
        if (bubble) {
          bubble.className = 'typing-indicator';
          bubble.innerHTML = '<span></span><span></span><span></span>';
        }
      }
    }, { once: false });
  }

  // ── Shutdown button ──────────────────────────────────────────
  const shutdownBtn = document.getElementById('shutdownBtn');
  if (shutdownBtn) {
    shutdownBtn.addEventListener('click', async () => {
      if (!confirm('Spegnere tutti i servizi e chiudere?')) return;

      shutdownBtn.disabled = true;
      shutdownBtn.style.opacity = '0.4';

      // Show shutdown screen immediately — don't wait for server response
      const showDone = () => {
        document.body.innerHTML = `
          <div style="height:100vh;display:flex;flex-direction:column;align-items:center;
                      justify-content:center;background:#0d0d0f;color:#8e8e99;
                      font-family:system-ui,sans-serif;gap:12px;">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#1d70f5" stroke-width="1.5">
              <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>
            </svg>
            <p style="font-size:15px;color:#e8e8ea;margin:0">Servizi spenti.</p>
            <p style="font-size:13px;margin:0">Puoi chiudere questa scheda.</p>
          </div>`;
      };

      try {
        // timeout 2s — if server dies before responding, fetch rejects, that's fine
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 2000);
        await fetch('http://127.0.0.1:8000/shutdown', { signal: controller.signal });
      } catch (_) {
        // expected — server killed itself
      } finally {
        showDone();
      }
    });
  }

});
