import { Transport } from './transport.js';
import { MSG } from './protocol.js';

/**
 * Firebase Realtime Database taşıması.
 *
 * Bağlanmaya hazır ama **kasten bağlanmamış**: `firebase` paketi kurulu değil
 * ve depoda yapılandırma yok. Kurmak iki adım:
 *
 * ```bash
 * npm install firebase
 * ```
 *
 * ```js
 * // main.js — çok oyunculu panelde "Firebase" seçildiğinde
 * import { FirebaseTransport } from './net/firebaseTransport.js';
 * new FirebaseTransport({ apiKey: '…', databaseURL: 'https://…', projectId: '…' })
 * ```
 *
 * Veri düzeni, RTDB'nin ucuz olduğu yerlere göre seçildi:
 *
 * ```
 * rooms/{oda}/peers/{id}   → {name, color, t}      katılım listesi
 * rooms/{oda}/state/{id}   → [ …paketlenmiş dizi ] üzerine yazılır, birikmez
 * rooms/{oda}/events/{itl} → {k, from, …}          sıralı olay kuyruğu
 * rooms/{oda}/map          → harita belgesi
 * ```
 *
 * Kritik ayrım: **anlık görüntüler `set`, olaylar `push`**. Araç durumu saniyede
 * yirmi kez geliyor; kuyruğa yazılsa oda birkaç dakikada yüz binlerce düğüm
 * biriktirir. Kendi düğümünün üstüne yazmak ise sabit maliyetli ve geç kalan
 * paketin eskisini ezmesi tam olarak istenen davranış.
 *
 * `onDisconnect().remove()` sunucu tarafında çalıştığı için sekmesi çöken
 * oyuncu odadan kendiliğinden düşüyor; istemci tarafı zaman aşımı yalnız
 * yedek.
 */
export class FirebaseTransport extends Transport {
  constructor(config, { appName = 'desert' } = {}) {
    super();
    this.config = config;
    this.appName = appName;
    this.db = null;
    this.refs = {};
    this.unsubscribers = [];
    this.api = null;
  }

  async connect(room, identity) {
    this.room = room;
    this.identity = identity;

    let appModule;
    let dbModule;
    try {
      appModule = await import(/* @vite-ignore */ 'firebase/app');
      dbModule = await import(/* @vite-ignore */ 'firebase/database');
    } catch {
      throw new Error(
        'Firebase paketi kurulu değil. `npm install firebase` çalıştırın ve panelde yapılandırmayı girin.'
      );
    }

    this.api = dbModule;
    const app = appModule.getApps().find((a) => a.name === this.appName)
      ?? appModule.initializeApp(this.config, this.appName);
    this.db = dbModule.getDatabase(app);

    const base = `rooms/${room}`;
    const { ref, onValue, onChildAdded, onDisconnect, set, serverTimestamp, query, limitToLast } = dbModule;

    this.refs.self = ref(this.db, `${base}/peers/${identity.id}`);
    this.refs.selfState = ref(this.db, `${base}/state/${identity.id}`);
    this.refs.peers = ref(this.db, `${base}/peers`);
    this.refs.states = ref(this.db, `${base}/state`);
    this.refs.events = ref(this.db, `${base}/events`);
    this.refs.map = ref(this.db, `${base}/map`);

    await set(this.refs.self, { name: identity.name, color: identity.color, t: serverTimestamp() });
    onDisconnect(this.refs.self).remove();
    onDisconnect(this.refs.selfState).remove();

    // Katılım listesi: eş eklenip çıktıkça oturuma hello/bye olarak yansıyor.
    const knownPeers = new Set();
    this.unsubscribers.push(
      onValue(this.refs.peers, (snapshot) => {
        const value = snapshot.val() || {};
        for (const [id, peer] of Object.entries(value)) {
          if (id === identity.id || knownPeers.has(id)) continue;
          knownPeers.add(id);
          this.emit({ k: MSG.HELLO, from: { id, name: peer.name, color: peer.color } });
        }
        for (const id of [...knownPeers]) {
          if (value[id]) continue;
          knownPeers.delete(id);
          this.emit({ k: MSG.BYE, from: { id } });
        }
      })
    );

    // Araç durumları. `onValue` tüm ağacı getiriyor ama ağaç sabit boyutlu
    // (oyuncu başına bir düğüm), dolayısıyla trafiği belirleyen şey oyuncu
    // sayısı — kaç kare geçtiği değil.
    this.unsubscribers.push(
      onValue(this.refs.states, (snapshot) => {
        const value = snapshot.val() || {};
        for (const [id, packed] of Object.entries(value)) {
          if (id === identity.id || !packed) continue;
          this.emit({ k: MSG.STATE, from: { id }, s: packed });
        }
      })
    );

    // Olay kuyruğu: yalnız son elliyi dinliyoruz, yoksa yeni katılan odanın
    // bütün geçmişini baştan oynatır.
    this.unsubscribers.push(
      onChildAdded(query(this.refs.events, limitToLast(50)), (snapshot) => {
        const message = snapshot.val();
        if (!message || message.from?.id === identity.id) return;
        this.emit(message);
      })
    );

    this.connected = true;
    this.status(`Firebase odası: ${room}`);
  }

  send(message) {
    if (!this.connected || !this.api) return;
    const { set, push } = this.api;

    if (message.k === MSG.STATE) {
      set(this.refs.selfState, message.s);
    } else if (message.k === MSG.MAP) {
      set(this.refs.map, message.doc);
    } else if (message.k === MSG.HELLO || message.k === MSG.BYE) {
      // Katılım listesi zaten `peers` düğümünden türüyor.
    } else {
      push(this.refs.events, message);
    }
  }

  close() {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    if (this.api && this.refs.self) {
      this.api.remove(this.refs.self);
      this.api.remove(this.refs.selfState);
    }
    this.connected = false;
  }
}
