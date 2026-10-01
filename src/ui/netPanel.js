/**
 * Çok oyunculu panel. `N` ile açılır.
 *
 * Taşıma seçenekleri kasten görünür: "Sekmeler arası" gerçek bir sunucu
 * olmadan çok oyunculuyu ikinci bir sekme açarak denemeyi mümkün kılıyor,
 * "Yerel test" ise ağ kodunun gecikme ve paket kaybı altındaki davranışını tek
 * sekmede gösteriyor.
 */
export function createNetPanel(root, { session, remotePlayers }) {
  const element = document.createElement('div');
  element.className = 'net hidden';
  element.innerHTML = `
    <div class="panel-head">
      <span>Çok oyunculu</span>
      <button class="panel-close n-close" title="Kapat (N)">×</button>
    </div>

    <div class="net-status">
      <span class="net-dot"></span>
      <span class="n-status">Bağlı değil</span>
    </div>

    <label class="panel-row">
      <span class="panel-label">Sürücü adı</span>
      <input class="net-input n-name" value="${escapeHtml(session.identity.name)}" spellcheck="false" maxlength="18">
    </label>

    <label class="panel-row">
      <span class="panel-label">Oda</span>
      <input class="net-input n-room" value="col" spellcheck="false" maxlength="24">
    </label>

    <label class="panel-row">
      <span class="panel-label">Bağlantı</span>
      <select class="panel-select n-kind">
        <option value="sekme">Sekmeler arası (sunucusuz)</option>
        <option value="yerel">Yerel test (gecikmeli botlar)</option>
        <option value="firebase" disabled>Firebase — kurulum gerekli</option>
      </select>
    </label>

    <div class="panel-actions">
      <button class="panel-button b-connect">Odaya gir</button>
      <button class="panel-button b-disconnect">Ayrıl</button>
    </div>

    <div class="net-peers n-peers"></div>

    <div class="panel-note">
      “Sekmeler arası”nı denemek için bu sayfayı ikinci bir sekmede açıp aynı
      oda adını girin. Harita ve arazi düzenlemeleri odayla paylaşılır.
      Firebase için <code>npm install firebase</code> ve
      <code>net/firebaseTransport.js</code> içindeki yapılandırma yeterli.
    </div>
  `;
  root.appendChild(element);

  const dot = element.querySelector('.net-dot');
  const statusText = element.querySelector('.n-status');
  const nameInput = element.querySelector('.n-name');
  const roomInput = element.querySelector('.n-room');
  const kindSelect = element.querySelector('.n-kind');
  const peerBox = element.querySelector('.n-peers');

  element.querySelector('.b-connect').addEventListener('click', async () => {
    try {
      statusText.textContent = 'Bağlanıyor…';
      await session.connect(kindSelect.value, roomInput.value.trim() || 'col', nameInput.value.trim());
    } catch (error) {
      statusText.textContent = error.message;
    }
    refresh();
  });

  element.querySelector('.b-disconnect').addEventListener('click', () => {
    session.disconnect();
    refresh();
  });

  element.querySelector('.n-close').addEventListener('click', () => toggle(false));

  function refresh() {
    dot.classList.toggle('online', session.state.connected);
    statusText.textContent = session.state.error || session.state.status;

    const peers = [...remotePlayers.peers.values()];
    if (peers.length === 0) {
      peerBox.innerHTML = session.state.connected
        ? '<div class="editor-empty">Odada başka kimse yok.</div>'
        : '';
      return;
    }
    peerBox.innerHTML = peers
      .map(
        (peer) => `
        <div class="net-peer">
          <span class="net-swatch" style="background:#${(peer.identity.color ?? 0x888888)
            .toString(16)
            .padStart(6, '0')}"></span>
          <span>${escapeHtml(peer.identity.name || peer.identity.id)}</span>
          <span class="net-ping">${peer.ping ? `${peer.ping} ms` : '—'}</span>
        </div>`
      )
      .join('');
  }
  refresh();

  let open = false;
  let refreshTimer = 0;

  function toggle(force) {
    open = force === undefined ? !open : force;
    element.classList.toggle('hidden', !open);
    if (open) refresh();
  }

  function update(dt) {
    if (!open) return;
    refreshTimer += dt;
    if (refreshTimer > 0.5) {
      refreshTimer = 0;
      refresh();
    }
  }

  return {
    element,
    toggle,
    refresh,
    update,
    setVisible(visible) {
      element.style.display = visible ? '' : 'none';
    },
    get isOpen() {
      return open;
    },
  };
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
