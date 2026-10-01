/**
 * Bölge (biyom) tanımları.
 *
 * Harita dört çeyreğe bölünüyor ve sınırlar gürültüyle bükülüyor, böylece
 * geçişler cetvelle çizilmiş gibi durmuyor. Her şey — arazi biçimi, zemin
 * rengi, lastik tutuşu, iz rengi, hangi nesnelerin serpileceği — burada veri
 * olarak duruyor. İleride bir harita üretim aracı yazıldığında üreteceği şey
 * tam olarak bu yapı olacak; motor tarafında değiştirilecek kod yok.
 *
 * Sıra önemli: aynı sıra hem CPU ağırlık dizisinde hem de GPU'ya giden RGBA
 * dokusunun kanallarında kullanılıyor (R=çöl, G=orman, B=kar, A=çayır).
 */

export const BIOME_IDS = ['col', 'orman', 'kar', 'cayir'];

/** Çeyrek yerleşimi: [x<0,z<0], [x>0,z<0], [x<0,z>0], [x>0,z>0]. */
export const BIOME_QUADRANTS = ['col', 'orman', 'kar', 'cayir'];

/** Sınır yumuşama genişliği (m) ve sınırı büken gürültünün gücü (m). */
export const BOUNDARY = { blend: 34, warpScale: 0.0042, warpStrength: 26 };

export const BIOMES = {
  col: {
    label: 'Çöl',
    /**
     * Arazi katmanı. `ridge` sırt keskinliğini, `exponent` tepelerin altta
     * geniş üstte sivri olma derecesini verir.
     */
    height: {
      amplitude: 26,
      scale: 1 / 215,
      warpScale: 0.0038,
      warpStrength: 68,
      ridge: 0.72,
      octaves: 3,
      exponent: 1.18,
      /** Kumun duruş açısı — aşınma geçişi yamaçları buna indirir. */
      repose: 32,
    },
    ground: {
      colorA: 0xd9ab6d,
      colorB: 0xc59254,
      colorSteep: 0xb8834a,
      /** Ezilmiş zeminin rengi (iz oyuklarında görünür). */
      packedTint: 0xcbb497,
      roughness: 0.97,
      /** Rüzgâr dalgacıklarının gücü — sadece çölde belirgin. */
      ripple: 1.0,
      /** İnce benek/parıltı miktarı. */
      sparkle: 1.0,
      /** Yüksek frekanslı doku miktarı (çim, kar taneleri vb.). */
      grain: 0.045,
    },
    /** Lastik davranışı çarpanları — taban değerler `settings.VEHICLE.sand`. */
    tyre: { grip: 1.0, rolling: 1.0, bog: 1.0 },
    /** İz derinliği ve rüzgârla silinme hızı çarpanları. */
    track: { depth: 1.0, erosion: 1.0 },
    scatter: [
      { kind: 'rock', density: 150, minRadius: 7, maxSlope: 0.62 },
      { kind: 'deadBush', density: 230, minRadius: 5, maxSlope: 0.42 },
      { kind: 'bones', density: 30, minRadius: 12, maxSlope: 0.55 },
    ],
  },

  orman: {
    label: 'Orman',
    height: {
      amplitude: 17,
      scale: 1 / 155,
      warpScale: 0.0052,
      warpStrength: 44,
      ridge: 0.18,
      octaves: 4,
      exponent: 1.0,
      // Orman toprağı kökleriyle tutunur; kumdan dik durabilir.
      repose: 40,
    },
    ground: {
      // İki uç birbirinden uzak tutuluyor: yakın renkler seçilince orman
      // zemini tek ton bir muşamba gibi görünüyordu.
      colorA: 0x5f5834,
      colorB: 0x2c3a1b,
      colorSteep: 0x6b5b3a,
      packedTint: 0x6b5738,
      roughness: 0.94,
      ripple: 0.0,
      sparkle: 0.15,
      grain: 0.16,
    },
    tyre: { grip: 1.06, rolling: 0.92, bog: 0.55 },
    track: { depth: 0.75, erosion: 0.25 },
    scatter: [
      { kind: 'pine', density: 420, minRadius: 6.5, maxSlope: 0.62 },
      { kind: 'rock', density: 60, minRadius: 8, maxSlope: 0.6 },
      { kind: 'fern', density: 320, minRadius: 4, maxSlope: 0.55 },
      { kind: 'log', density: 40, minRadius: 10, maxSlope: 0.5 },
    ],
  },

  kar: {
    label: 'Karlı',
    height: {
      amplitude: 31,
      scale: 1 / 195,
      warpScale: 0.0034,
      warpStrength: 58,
      ridge: 0.45,
      octaves: 4,
      exponent: 1.12,
      repose: 38,
    },
    ground: {
      // Gerçek kar %90 yansıtır ama o değerle render edilince ton eşleme
      // beyaza kırpıyor ve arazinin hacmi tamamen kayboluyor. Biraz kısılıyor
      // ki gölgeler ve tepe kıvrımları okunabilsin.
      colorA: 0xd6dfec,
      colorB: 0xc2cfe2,
      colorSteep: 0x9fb0c8,
      // Ezilen kar sıkışır, mavimsi ve koyu bir iz bırakır.
      packedTint: 0x8299b8,
      roughness: 0.72,
      // Rüzgârın kar üstünde bıraktığı sastrugi çizgileri.
      ripple: 0.55,
      sparkle: 2.4,
      grain: 0.05,
    },
    // Kar kaygan: tutuş belirgin şekilde düşük, yuvarlanma direnci yüksek.
    tyre: { grip: 0.62, rolling: 1.35, bog: 1.15 },
    track: { depth: 1.25, erosion: 0.7 },
    scatter: [
      { kind: 'snowPine', density: 260, minRadius: 8, maxSlope: 0.6 },
      { kind: 'rock', density: 70, minRadius: 9, maxSlope: 0.55 },
      { kind: 'deadBush', density: 70, minRadius: 7, maxSlope: 0.4 },
    ],
  },

  cayir: {
    label: 'Çayır',
    height: {
      amplitude: 10,
      scale: 1 / 135,
      warpScale: 0.006,
      warpStrength: 30,
      ridge: 0.06,
      octaves: 4,
      exponent: 1.0,
      repose: 42,
    },
    ground: {
      // Yeşilin içinde kurumuş ve gölgeli lekeler: tek ton çim halı gibi
      // duruyordu.
      colorA: 0x87994c,
      colorB: 0x43602a,
      colorSteep: 0x8a7c42,
      // Çimin altındaki toprak.
      packedTint: 0x6d5533,
      roughness: 0.93,
      ripple: 0.0,
      sparkle: 0.2,
      grain: 0.22,
    },
    tyre: { grip: 1.12, rolling: 0.8, bog: 0.35 },
    track: { depth: 0.6, erosion: 0.15 },
    scatter: [
      { kind: 'grassTuft', density: 900, minRadius: 2.4, maxSlope: 0.6 },
      { kind: 'broadleaf', density: 90, minRadius: 11, maxSlope: 0.45 },
      { kind: 'rock', density: 40, minRadius: 9, maxSlope: 0.5 },
      { kind: 'fern', density: 160, minRadius: 5, maxSlope: 0.5 },
    ],
  },
};

/**
 * Çayır bölgesinden geçen toprak patika. Kontrol noktaları çeyreğin içinde
 * dolanıyor; yol, bunlardan geçen bir eğri olarak bir maske dokusuna
 * çiziliyor (bkz. `sim/heightfield.js`).
 */
export const PATH = {
  biome: 'cayir',
  /** İki tekerlek izi genişliğinde bir arazi yolu. */
  width: 5.2,
  /** Kenarın yumuşama payı (m) — çime karıştığı aşınmış bant. */
  feather: 2.4,
  /** Yolun araziye gömülme derinliği (m): yıllarca ezilmiş zemin çöker. */
  depth: 0.12,
  points: [
    [14, 236],
    [46, 196],
    [38, 150],
    [72, 118],
    [126, 104],
    [168, 132],
    [196, 178],
    [214, 226],
  ],
  /** Patika üstünde zemin: sıkışmış toprak, çimden daha tutuşlu. */
  ground: { color: 0x9c7d4e, roughness: 0.9 },
  tyre: { grip: 1.22, rolling: 0.62, bog: 0.12 },
};

export const BIOME_LIST = BIOME_IDS.map((id) => BIOMES[id]);

/** Shader'a tek seferde gidecek düz diziler. */
export function biomeUniformArrays() {
  return {
    colorA: BIOME_LIST.map((b) => b.ground.colorA),
    colorB: BIOME_LIST.map((b) => b.ground.colorB),
    colorSteep: BIOME_LIST.map((b) => b.ground.colorSteep),
    packedTint: BIOME_LIST.map((b) => b.ground.packedTint),
    roughness: BIOME_LIST.map((b) => b.ground.roughness),
    ripple: BIOME_LIST.map((b) => b.ground.ripple),
    sparkle: BIOME_LIST.map((b) => b.ground.sparkle),
    grain: BIOME_LIST.map((b) => b.ground.grain),
  };
}
