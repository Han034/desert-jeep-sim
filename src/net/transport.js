/**
 * Taşıma katmanı.
 *
 * Oturum mantığı (`net/session.js`) mesajların **nasıl** taşındığını bilmiyor;
 * yalnız şu sözleşmeyi görüyor:
 *
 * ```js
 * await transport.connect(room, identity)   // odaya gir
 * transport.send(message)                   // herkese yayınla
 * transport.onMessage = (message) => {}     // gelen
 * transport.close()
 * ```
 *
 * Mesajlar `{k: tür, from: kimlik, ...}` biçiminde düz nesneler. Taşıma
 * katmanının tek sorumluluğu onları başkalarına ulaştırmak — kim odada, kim
 * zaman aşımına uğradı, hangi anlık görüntü ne zaman oynatılacak, hepsi
 * oturumun işi. Bu ayrım sayesinde Firebase'e geçiş, tek dosya eklemek
 * (`firebaseTransport.js`) ve panelde bir seçenek değiştirmekten ibaret.
 *
 * Kendi mesajını geri almamak taşıma katmanının sorumluluğunda: `BroadcastChannel`
 * bunu zaten yapmıyor, Firebase yapacağı için orada gönderenin kimliğine
 * bakılıyor.
 */

export class Transport {
  constructor() {
    this.onMessage = null;
    this.onStatus = null;
    this.identity = null;
    this.room = null;
    this.connected = false;
  }

  // eslint-disable-next-line no-unused-vars
  async connect(room, identity) {
    throw new Error('Transport.connect uygulanmadı');
  }

  // eslint-disable-next-line no-unused-vars
  send(message) {
    throw new Error('Transport.send uygulanmadı');
  }

  close() {}

  emit(message) {
    if (this.onMessage) this.onMessage(message);
  }

  status(text) {
    if (this.onStatus) this.onStatus(text);
  }
}

/**
 * Aynı tarayıcıdaki sekmeler arası taşıma.
 *
 * Sunucu gerektirmiyor ve **gerçekten çalışan** çok oyunculu veriyor: iki sekme
 * açıp ikisinde de aynı odaya girmek yetiyor. Amacı gösteri değil doğrulama —
 * interpolasyon, iz paylaşımı ve harita senkronu Firebase'e bağlanmadan önce
 * burada sınanıyor. Aynı makinede olduğu için gecikme sıfır; jitter ve kayıp
 * `LoopbackTransport` ile taklit ediliyor.
 */
export class BroadcastChannelTransport extends Transport {
  constructor() {
    super();
    this.channel = null;
  }

  async connect(room, identity) {
    this.room = room;
    this.identity = identity;
    this.channel = new BroadcastChannel(`desert.room.${room}`);
    this.channel.onmessage = (event) => this.emit(event.data);
    this.connected = true;
    this.status(`Sekme kanalı: ${room}`);
  }

  send(message) {
    if (this.channel) this.channel.postMessage(message);
  }

  close() {
    this.channel?.close();
    this.channel = null;
    this.connected = false;
  }
}

/**
 * Sahte eşlerle çalışan yerel taşıma — ağ kodunu tek sekmede sınamak için.
 *
 * Gerçek bir bağlantının kötü yanlarını taklit ediyor: gecikme, jitter ve paket
 * kaybı. İnterpolasyon tamponunun boyutunu ayarlarken tek işe yarayan araç bu;
 * gecikmesiz bir kanalda tampon her zaman doğru görünüyor.
 */
export class LoopbackTransport extends Transport {
  constructor({ latency = 0.08, jitter = 0.03, loss = 0.02, bots = 1 } = {}) {
    super();
    this.latency = latency;
    this.jitter = jitter;
    this.loss = loss;
    this.botCount = bots;
    this.bots = [];
    this.timers = new Set();
  }

  async connect(room, identity) {
    this.room = room;
    this.identity = identity;
    this.connected = true;

    for (let i = 0; i < this.botCount; i++) {
      const bot = {
        identity: { id: `bot${i}`, name: `Test botu ${i + 1}`, color: 0x4fae62 },
        phase: (i / this.botCount) * Math.PI * 2,
      };
      this.bots.push(bot);
      this.deliver({ k: 'hello', from: bot.identity });
    }
    this.status(`Yerel test: ${this.botCount} bot`);
  }

  send() {
    // Sahte eşler dinlemiyor; gönderilen her şey yutuluyor.
  }

  /** Botları haritada dolaştırır — kare döngüsünden çağrılır. */
  update(dt, heightfield) {
    this.time = (this.time || 0) + dt;
    for (const bot of this.bots) {
      const t = this.time * 0.25 + bot.phase;
      const x = Math.cos(t) * 70;
      const z = Math.sin(t * 1.3) * 70;
      const y = heightfield ? heightfield.sampleHeight(x, z) + 0.5 : 0;
      const heading = Math.atan2(-Math.sin(t) * 70, Math.cos(t * 1.3) * 1.3 * 70);
      const half = heading * 0.5;
      const state = [
        x, y, z,
        0, Math.sin(half), 0, Math.cos(half),
        0, 0, 0,
        0, 0, 0,
      ];
      for (let i = 0; i < 4; i++) state.push(0.62, 0, this.time * 6, 1, 0, 0, 4400);
      this.deliver({ k: 'state', from: bot.identity, s: state, t: this.time });
    }
  }

  deliver(message) {
    if (Math.random() < this.loss) return;
    const delay = (this.latency + (Math.random() - 0.5) * this.jitter) * 1000;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.emit(message);
    }, Math.max(0, delay));
    this.timers.add(timer);
  }

  close() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.bots.length = 0;
    this.connected = false;
  }
}
