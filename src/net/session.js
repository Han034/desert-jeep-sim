import {
  MSG,
  PEER_TIMEOUT,
  SNAPSHOT_HZ,
  createIdentity,
  packState,
} from './protocol.js';
import { BroadcastChannelTransport, LoopbackTransport } from './transport.js';

/**
 * Çok oyunculu oturum.
 *
 * Otorite yok: her istemci kendi aracını simüle ediyor ve sonucu yayınlıyor.
 * Bu, hile açısından zayıf ama serbest dolaşan bir arazi simülasyonu için
 * doğru takas — otoriter bir sunucu, 240 Hz'lik araç fiziğini sunucuda
 * çalıştırmayı ve girdi tahmini/geri sarma kurmayı gerektirirdi; oynanışta
 * kazandıracağı tek şey ise başkasının aracına çarpmak olurdu, ki araçlar
 * zaten birbirinin içinden geçiyor.
 *
 * Harita, katılım anında bir kez tam olarak, sonrasında **fırça darbesi
 * başına** senkronlanıyor. Kim yollayacak sorusu, kimlik sıralamasıyla
 * çözülüyor: odadaki en küçük kimlikli oyuncu. Merkezî bir otorite kurmadan
 * tek bir kopya gönderilmesini garantiliyor.
 */

const TRANSPORTS = {
  sekme: () => new BroadcastChannelTransport(),
  yerel: () => new LoopbackTransport({ bots: 2 }),
};

export function createNetSession({
  vehicle,
  remotePlayers,
  weather,
  doc,
  onStroke,
  onMapReceived,
  onPeersChanged,
  onStatus,
}) {
  const identity = createIdentity(loadName());
  let transport = null;
  let sendTimer = 0;
  let pingTimer = 0;

  const state = {
    connected: false,
    room: '',
    kind: 'sekme',
    status: 'Bağlı değil',
    error: '',
  };

  const extras = { brake: 0, headlights: false };
  const knownIds = new Set();

  async function connect(kind, room, name, customTransport = null) {
    disconnect();
    if (name && name !== identity.name) {
      identity.name = name;
      saveName(name);
    }

    transport = customTransport ?? TRANSPORTS[kind]?.();
    if (!transport) throw new Error(`Bilinmeyen taşıma: ${kind}`);

    transport.onMessage = handleMessage;
    transport.onStatus = (text) => {
      state.status = text;
      onStatus?.(text);
    };

    try {
      await transport.connect(room, identity);
    } catch (error) {
      transport = null;
      state.error = error.message;
      state.status = 'Bağlanamadı';
      onStatus?.(state.status);
      throw error;
    }

    state.connected = true;
    state.room = room;
    state.kind = kind;
    state.error = '';
    transport.send({ k: MSG.HELLO, from: identity });
    onPeersChanged?.();
  }

  function disconnect() {
    if (!transport) return;
    transport.send({ k: MSG.BYE, from: identity });
    transport.close();
    transport = null;
    knownIds.clear();
    remotePlayers.clear();
    state.connected = false;
    state.status = 'Bağlı değil';
    onPeersChanged?.();
  }

  function handleMessage(message) {
    if (!message || message.from?.id === identity.id) return;
    const from = message.from;

    switch (message.k) {
      case MSG.HELLO: {
        const isNew = !knownIds.has(from.id);
        knownIds.add(from.id);
        remotePlayers.ensure(from);
        if (isNew) {
          // Karşılık ver: yeni gelen bizim varlığımızı ancak böyle öğrenir.
          transport.send({ k: MSG.HELLO, from: identity });
          if (shouldSendMap()) transport.send({ k: MSG.MAP, from: identity, doc: snapshotDoc() });
          onPeersChanged?.();
        }
        break;
      }

      case MSG.BYE:
        knownIds.delete(from.id);
        remotePlayers.remove(from.id);
        onPeersChanged?.();
        break;

      case MSG.STATE:
        if (!knownIds.has(from.id)) {
          knownIds.add(from.id);
          onPeersChanged?.();
        }
        remotePlayers.receive(from, message.s);
        break;

      case MSG.STROKE:
        onStroke?.(message.stroke);
        break;

      case MSG.MAP:
        onMapReceived?.(message.doc);
        break;

      case MSG.PING:
        transport.send({ k: MSG.PONG, from: identity, to: from.id, t: message.t });
        break;

      case MSG.PONG:
        if (message.to === identity.id) {
          remotePlayers.setPing(from.id, Math.round((performance.now() - message.t) ));
        }
        break;

      default:
        break;
    }
  }

  /** Haritayı odadaki en küçük kimlikli oyuncu yollar — tek kopya garantisi. */
  function shouldSendMap() {
    for (const id of knownIds) if (id < identity.id) return false;
    return true;
  }

  function snapshotDoc() {
    // Belge büyük olabilir; nesne listesi kopyalanmadan gönderilirse alıcı
    // tarafta paylaşılan diziyi değiştirmek gönderene de yansırdı
    // (`BroadcastChannel` yapısal kopya yapıyor ama Loopback yapmıyor).
    return JSON.parse(JSON.stringify(doc));
  }

  function broadcastStroke(stroke) {
    if (!transport) return;
    transport.send({ k: MSG.STROKE, from: identity, stroke });
  }

  function broadcastMap() {
    if (!transport) return;
    transport.send({ k: MSG.MAP, from: identity, doc: snapshotDoc() });
  }

  function update(dt, input, heightfield) {
    if (!transport) return;

    if (transport instanceof LoopbackTransport) transport.update(dt, heightfield);

    sendTimer += dt;
    if (sendTimer >= 1 / SNAPSHOT_HZ) {
      sendTimer = 0;
      extras.brake = Math.max(input?.brake ?? 0, input?.handbrake ?? 0);
      extras.headlights = weather.state.headlights;
      transport.send({ k: MSG.STATE, from: identity, s: packState(vehicle, extras) });
    }

    pingTimer += dt;
    if (pingTimer >= 2) {
      pingTimer = 0;
      transport.send({ k: MSG.PING, from: identity, t: performance.now() });
    }

    const dropped = remotePlayers.stale(PEER_TIMEOUT);
    for (const id of dropped) {
      knownIds.delete(id);
      remotePlayers.remove(id);
    }
    if (dropped.length) onPeersChanged?.();
  }

  return {
    identity,
    state,
    connect,
    disconnect,
    update,
    broadcastStroke,
    broadcastMap,
    get transport() {
      return transport;
    },
    get transportKinds() {
      return Object.keys(TRANSPORTS);
    },
  };
}

function loadName() {
  try {
    return localStorage.getItem('desert.playerName') || '';
  } catch {
    return '';
  }
}

function saveName(name) {
  try {
    localStorage.setItem('desert.playerName', name);
  } catch {
    // Gizli sekmede depo kapalı olabilir; isim oturumluk kalır.
  }
}
