/**
 * Ağ protokolü.
 *
 * Mesajlar düz JSON — ikili paketleme yok. Sebebi hedef taşıma katmanı:
 * Firebase Realtime Database bir JSON ağacı ve `BroadcastChannel` yapısal
 * kopyalama kullanıyor; ikiliye çevirmek her ikisinde de gereksiz bir tur.
 *
 * Buna karşılık **anlık görüntüler düz dizi** olarak gidiyor, nesne olarak
 * değil: alan adları her paketle tekrar tekrar yollanmayacak kadar pahalı
 * (`{"px":12.3}` yerine `12.3`). Dizideki sıra bu dosyanın sözleşmesi.
 */

export const PROTOCOL_VERSION = 1;

export const MSG = {
  /** Odaya katılım duyurusu. Yeni gelen de, oradakiler de yollar. */
  HELLO: 'hello',
  /** Ayrılık. Taşıma katmanı sessizce koparsa zaman aşımı devreye girer. */
  BYE: 'bye',
  /** Araç durumu — saniyede `SNAPSHOT_HZ` kez. */
  STATE: 'state',
  /** Tek bir harita fırçası darbesi. */
  STROKE: 'stroke',
  /** Harita belgesinin tamamı — yeni katılan için. */
  MAP: 'map',
  /** Gecikme ölçümü. */
  PING: 'ping',
  PONG: 'pong',
};

/** Anlık görüntü gönderim hızı. */
export const SNAPSHOT_HZ = 20;
/**
 * Uzak araçların kaç saniye **geriden** oynatılacağı. İki anlık görüntü
 * arasında interpolasyon yapabilmek için elde en az bir paket fazlası olmalı;
 * gönderim aralığının iki katı, tek paket kaybını da yutuyor.
 */
export const INTERP_DELAY = 2 / SNAPSHOT_HZ;
/** Elde paket kalmayınca hızla ne kadar süre ileri sürüleceği. */
export const MAX_EXTRAPOLATION = 0.25;
/** Bu kadar süre haber alınamayan eş odadan düşer. */
export const PEER_TIMEOUT = 6;

/**
 * Araç durumunu düz diziye paketler.
 *
 * Süspansiyon uzunlukları ve tekerlek dönüş açıları da gidiyor: onlarsız uzak
 * jip zeminde süzülen bir kutu gibi görünüyor. Temas ve kayma bilgisi ise
 * uzak aracın **iz bırakabilmesi** için gerekli — çok oyunculu bir haritada
 * asıl görmek istediğin şey başkasının bıraktığı izler.
 */
export function packState(vehicle, extras) {
  const s = vehicle.state;
  const out = [
    r3(s.position.x),
    r3(s.position.y),
    r3(s.position.z),
    r4(s.quaternion.x),
    r4(s.quaternion.y),
    r4(s.quaternion.z),
    r4(s.quaternion.w),
    r2(s.velocity.x),
    r2(s.velocity.y),
    r2(s.velocity.z),
    r3(s.steerInput),
    r2(extras.brake),
    extras.headlights ? 1 : 0,
  ];
  for (const w of vehicle.wheels) {
    out.push(
      r3(w.suspLength),
      r3(w.steerAngle),
      r2(w.spinAngle % (Math.PI * 2)),
      w.grounded ? 1 : 0,
      r2(w.slide),
      r2(w.spin),
      r2(w.load)
    );
  }
  return out;
}

const WHEEL_STRIDE = 7;
const HEADER = 13;

export function unpackState(array, out) {
  out.px = array[0];
  out.py = array[1];
  out.pz = array[2];
  out.qx = array[3];
  out.qy = array[4];
  out.qz = array[5];
  out.qw = array[6];
  out.vx = array[7];
  out.vy = array[8];
  out.vz = array[9];
  out.steer = array[10];
  out.brake = array[11];
  out.headlights = array[12] === 1;
  for (let i = 0; i < 4; i++) {
    const o = HEADER + i * WHEEL_STRIDE;
    const w = out.wheels[i];
    w.suspLength = array[o];
    w.steerAngle = array[o + 1];
    w.spinAngle = array[o + 2];
    w.grounded = array[o + 3] === 1;
    w.slide = array[o + 4];
    w.spin = array[o + 5];
    w.load = array[o + 6];
  }
  return out;
}

export function makeStateSlot() {
  return {
    px: 0, py: 0, pz: 0,
    qx: 0, qy: 0, qz: 0, qw: 1,
    vx: 0, vy: 0, vz: 0,
    steer: 0,
    brake: 0,
    headlights: false,
    wheels: Array.from({ length: 4 }, () => ({
      suspLength: 0,
      steerAngle: 0,
      spinAngle: 0,
      grounded: false,
      slide: 0,
      spin: 0,
      load: 0,
    })),
  };
}

/** Oyuncu kimliği — oturum başına bir kez üretilir. */
export function createIdentity(name) {
  const id = Math.random().toString(36).slice(2, 10);
  return {
    id,
    name: name || `Sürücü-${id.slice(0, 4)}`,
    color: PLAYER_COLORS[hashString(id) % PLAYER_COLORS.length],
  };
}

/** Uzaktan ayırt edilebilen, çölde ve karda okunabilen gövde renkleri. */
export const PLAYER_COLORS = [
  0xd8563c, 0x3f7fd8, 0x4fae62, 0xd8a53c, 0x9a58c9, 0x2fb3ae, 0xd2528c, 0xc9c4b6,
];

function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const r4 = (v) => Math.round(v * 10000) / 10000;
