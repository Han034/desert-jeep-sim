import * as THREE from 'three';
import { WORLD } from '../config/settings.js';
import { BIOME_IDS, BIOMES, BOUNDARY, PATH } from '../config/biomes.js';
import { createSimplex2D, makeFbm, makeRidged } from '../utils/noise.js';
import { catmullRom, clamp, clamp01, smoothstep } from '../utils/math.js';

/**
 * Haritanın yükseklik alanı ve bölge (biyom) dağılımı.
 *
 * Açılışta bir kez CPU'da üretilir ve iki tüketiciye birden servis edilir:
 *
 *  - `sampleHeight()` / `sampleBiome()` → süspansiyon, lastik tutuşu, nesne
 *    yerleştirme, kamera
 *  - `texture` / `biomeTexture` / `pathTexture` → arazi shader'ı
 *
 * Yükseklik hem CPU'da hem GPU'da aynı Catmull-Rom bikübik filtresiyle
 * örneklendiği için fizik ile görüntünün ayrışması mümkün değil. Bilineer
 * yerine bikübik: 2 m'lik ızgarada bilineer örnekleme, yakın kabuğun 0.125 m'lik
 * vertex'lerinde ızgara kırıkları olarak görünürdü.
 */

/** Bölge ağırlıklarının çözünürlüğü — geçişler yumuşak olduğu için seyrek olabilir. */
const BIOME_RES = 512;
/** Patika maskesi çözünürlüğü (oynanabilir alan üzerinde). */
const PATH_RES = 768;

/**
 * Tek bir bölgenin arazi katmanı. Tüm biyomlar aynı fonksiyondan, farklı
 * parametrelerle çıkıyor: kum tepesi ile orman tepeciği arasındaki fark
 * `ridge` ve `exponent` değerlerinde.
 */
function makeHeightLayer(params, seed) {
  const noise = createSimplex2D(seed);
  const warpNoise = createSimplex2D(seed ^ 0x9e37);
  const baseFbm = makeFbm(noise, { octaves: params.octaves, lacunarity: 2.11, gain: 0.52 });
  const ridged = makeRidged(noise, { octaves: 4, lacunarity: 2.07, gain: 0.48 });

  const windCos = Math.cos(WORLD.windAngle);
  const windSin = Math.sin(WORLD.windAngle);

  return function layer(x, z) {
    // Alan bükümü: düz paralel sırtları organik kavislere sokar.
    const wx = x + warpNoise(x * params.warpScale + 11.3, z * params.warpScale - 4.1) * params.warpStrength;
    const wz = z + warpNoise(x * params.warpScale - 7.7, z * params.warpScale + 2.9) * params.warpStrength;

    const nx = wx * params.scale;
    const nz = wz * params.scale;

    // Rüzgâr yönünde sıkıştırılmış koordinatlar → uzun, paralel sırtlar.
    const along = nx * windCos + nz * windSin;
    const across = -nx * windSin + nz * windCos;

    const swell = baseFbm(nx * 0.42, nz * 0.42);

    let h;
    if (params.ridge > 0.01) {
      const n = noise((along + swell * 0.55) * 2.35, across * 0.72);
      const t = 1 - Math.abs(n);
      // Asimetrik profil: bir yüz yatık (rüzgâr yüzü), diğeri dik (kayma yüzü).
      const crest = n < 0 ? Math.pow(t, 1.85) : Math.pow(t, 0.95);
      const secondary = ridged(along * 3.2, across * 1.35) * 0.1;
      h = crest * params.ridge + secondary + swell * 0.36 + 0.16;
    } else {
      // Sırtsız biyomlar: yumuşak, yuvarlak tepecikler.
      h = swell * 0.6 + baseFbm(nx * 1.4 + 5.2, nz * 1.4 - 3.1) * 0.22 + 0.5;
    }

    h = clamp01(h * 0.82);
    return Math.pow(h, params.exponent) * params.amplitude;
  };
}

/**
 * Bölge ağırlıkları. Harita dört çeyreğe bölünüyor ama sınırlar düz çizgi
 * değil: düşük frekanslı bir gürültü sınırı büküyor, ayrıca `blend` genişliği
 * boyunca iki bölge birbirine karışıyor.
 */
export function makeBiomeSampler(seed = 5150) {
  const warp = createSimplex2D(seed);

  return function weightsAt(x, z, out) {
    const wx = x + warp(x * BOUNDARY.warpScale, z * BOUNDARY.warpScale) * BOUNDARY.warpStrength;
    const wz = z + warp(x * BOUNDARY.warpScale + 31.7, z * BOUNDARY.warpScale - 12.3) * BOUNDARY.warpStrength;

    const px = smoothstep(-BOUNDARY.blend, BOUNDARY.blend, wx);
    const pz = smoothstep(-BOUNDARY.blend, BOUNDARY.blend, wz);

    out[0] = (1 - px) * (1 - pz); // çöl
    out[1] = px * (1 - pz); // orman
    out[2] = (1 - px) * pz; // kar
    out[3] = px * pz; // çayır
    return out;
  };
}

export async function createHeightfield({ seed = 20260811, onProgress } = {}) {
  const genRes = WORLD.heightRes;
  const res = genRes * WORLD.heightDetail;
  const extent = WORLD.heightExtent;
  const genTexel = extent / genRes;
  const texelSize = extent / res;
  const half = extent * 0.5;

  const gen = new Float32Array(genRes * genRes);
  const weightsAt = makeBiomeSampler(seed ^ 0x51ab);
  const layers = BIOME_IDS.map((id, i) => makeHeightLayer(BIOMES[id].height, seed + i * 7919));
  const reposeTan = BIOME_IDS.map((id) => Math.tan((BIOMES[id].height.repose * Math.PI) / 180));

  // Bölge ağırlıkları kendi (daha seyrek) ızgarasında tutuluyor; hem GPU
  // dokusunu hem CPU sorgularını besliyor.
  const biomeData = new Uint8Array(BIOME_RES * BIOME_RES * 4);
  const biomeStep = extent / BIOME_RES;
  const w = [0, 0, 0, 0];

  for (let j = 0; j < BIOME_RES; j++) {
    const z = -half + (j + 0.5) * biomeStep;
    for (let i = 0; i < BIOME_RES; i++) {
      const x = -half + (i + 0.5) * biomeStep;
      weightsAt(x, z, w);
      const o = (j * BIOME_RES + i) * 4;
      biomeData[o] = Math.round(w[0] * 255);
      biomeData[o + 1] = Math.round(w[1] * 255);
      biomeData[o + 2] = Math.round(w[2] * 255);
      biomeData[o + 3] = Math.round(w[3] * 255);
    }
  }
  if (onProgress) onProgress(0.08);
  await yieldToBrowser();

  // --- yükseklik: bölge katmanlarının ağırlıklı karışımı --------------------
  const cellRepose = new Float32Array(genRes * genRes);
  const rowsPerChunk = 48;

  for (let row0 = 0; row0 < genRes; row0 += rowsPerChunk) {
    const row1 = Math.min(genRes, row0 + rowsPerChunk);
    for (let j = row0; j < row1; j++) {
      const z = -half + (j + 0.5) * genTexel;
      const rowOffset = j * genRes;
      for (let i = 0; i < genRes; i++) {
        const x = -half + (i + 0.5) * genTexel;
        weightsAt(x, z, w);

        let h = 0;
        let repose = 0;
        for (let b = 0; b < 4; b++) {
          // Ağırlığı ihmal edilebilir katmanı hiç hesaplama: hücrelerin büyük
          // çoğunluğu tek bir bölgenin içinde ve bu, üretimi üçte bire indiriyor.
          if (w[b] < 0.004) continue;
          h += layers[b](x, z) * w[b];
          repose += reposeTan[b] * w[b];
        }
        gen[rowOffset + i] = h;
        cellRepose[rowOffset + i] = repose;
      }
    }
    if (onProgress) onProgress(0.08 + (row1 / genRes) * 0.5);
    await yieldToBrowser();
  }

  // --- oynanabilir alanın kenarındaki çanak seti ---------------------------
  for (let j = 0; j < genRes; j++) {
    const z = -half + (j + 0.5) * genTexel;
    const rowOffset = j * genRes;
    for (let i = 0; i < genRes; i++) {
      const x = -half + (i + 0.5) * genTexel;
      gen[rowOffset + i] += rimHeight(x, z);
    }
  }

  const EROSION_PASSES = 16;
  for (let pass = 0; pass < EROSION_PASSES; pass++) {
    relaxToAngleOfRepose(gen, cellRepose, genRes, genTexel);
    if (onProgress) onProgress(0.58 + ((pass + 1) / EROSION_PASSES) * 0.28);
    await yieldToBrowser();
  }

  // --- editör ızgarasına büyüt --------------------------------------------
  // Aşınmadan sonra: aşınma geçişi komşuluk tabanlı ve maliyeti hücre sayısıyla
  // doğrusal, ince ızgarada çalıştırmanın hiçbir faydası olmazdı.
  const data = await upsampleBicubic(gen, genRes, res, onProgress);

  // --- patika ------------------------------------------------------------
  const pathData = buildPathMask();

  /**
   * Yol araziye gömülüyor. Sadece renk değiştirmek yolu boyalı bir şerit gibi
   * gösteriyordu; birkaç santimlik çöküntü, kenarlarında gölge oluşturup onu
   * gerçekten aşınmış bir geçit haline getiriyor.
   *
   * Aşınmadan sonra uygulanıyor: bu derinlik duruş açısını zorlamayacak kadar
   * sığ, ama aşınmadan önce yapılsa geçişler onu düzleyip yok ederdi.
   */
  for (let j = 0; j < res; j++) {
    const z = -half + (j + 0.5) * texelSize;
    const rowOffset = j * res;
    for (let i = 0; i < res; i++) {
      const x = -half + (i + 0.5) * texelSize;
      const mask = samplePathMask(pathData, x, z);
      if (mask > 0) data[rowOffset + i] -= mask * PATH.depth;
    }
  }

  if (onProgress) onProgress(0.96);
  await yieldToBrowser();

  const texture = new THREE.DataTexture(data, res, res, THREE.RedFormat, THREE.FloatType);
  // Bikübik filtreyi shader'da elle yaptığımız için donanım filtresi NEAREST
  // kalmalı; R32F'in lineer filtrelenmesi WebGL2 çekirdeğinde garanti değil.
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  const biomeTexture = new THREE.DataTexture(
    biomeData,
    BIOME_RES,
    BIOME_RES,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  biomeTexture.magFilter = THREE.LinearFilter;
  biomeTexture.minFilter = THREE.LinearFilter;
  biomeTexture.wrapS = THREE.ClampToEdgeWrapping;
  biomeTexture.wrapT = THREE.ClampToEdgeWrapping;
  biomeTexture.colorSpace = THREE.NoColorSpace;
  biomeTexture.generateMipmaps = false;
  biomeTexture.needsUpdate = true;

  const pathTexture = new THREE.DataTexture(
    pathData,
    PATH_RES,
    PATH_RES,
    THREE.RedFormat,
    THREE.UnsignedByteType
  );
  pathTexture.magFilter = THREE.LinearFilter;
  pathTexture.minFilter = THREE.LinearFilter;
  pathTexture.wrapS = THREE.ClampToEdgeWrapping;
  pathTexture.wrapT = THREE.ClampToEdgeWrapping;
  pathTexture.colorSpace = THREE.NoColorSpace;
  pathTexture.generateMipmaps = false;
  pathTexture.needsUpdate = true;

  if (onProgress) onProgress(1);

  return new Heightfield({
    data,
    res,
    extent,
    texture,
    biomeData,
    biomeRes: BIOME_RES,
    biomeTexture,
    pathData,
    pathRes: PATH_RES,
    pathTexture,
  });
}

/**
 * Bikübik büyütme. Aynı Catmull-Rom çekirdeği hem CPU örneklemesinde hem
 * shader'da kullanıldığı için, büyütülmüş ızgara kaba ızgaranın *tam olarak*
 * gördüğü yüzey: yeni ayrıntı eklemiyor, sadece fırçanın oyabileceği
 * çözünürlüğü artırıyor.
 */
async function upsampleBicubic(src, srcRes, dstRes, onProgress) {
  if (dstRes === srcRes) return src;

  const dst = new Float32Array(dstRes * dstRes);
  const scale = srcRes / dstRes;
  const rowsPerChunk = 128;
  const rows = [0, 0, 0, 0];

  const at = (i, j) => {
    const ii = i < 0 ? 0 : i >= srcRes ? srcRes - 1 : i;
    const jj = j < 0 ? 0 : j >= srcRes ? srcRes - 1 : j;
    return src[jj * srcRes + ii];
  };

  for (let row0 = 0; row0 < dstRes; row0 += rowsPerChunk) {
    const row1 = Math.min(dstRes, row0 + rowsPerChunk);
    for (let j = row0; j < row1; j++) {
      // Texel merkezlerini hizala: kaynak ve hedef ızgaralar aynı dünya
      // koordinatlarını kaplıyor ama farklı adımlarla örnekliyor.
      const gz = (j + 0.5) * scale - 0.5;
      const j0 = Math.floor(gz);
      const tz = gz - j0;
      const out = j * dstRes;

      for (let i = 0; i < dstRes; i++) {
        const gx = (i + 0.5) * scale - 0.5;
        const i0 = Math.floor(gx);
        const tx = gx - i0;
        for (let r = -1; r <= 2; r++) {
          rows[r + 1] = catmullRom(at(i0 - 1, j0 + r), at(i0, j0 + r), at(i0 + 1, j0 + r), at(i0 + 2, j0 + r), tx);
        }
        dst[out + i] = catmullRom(rows[0], rows[1], rows[2], rows[3], tz);
      }
    }
    if (onProgress) onProgress(0.86 + (row1 / dstRes) * 0.08);
    await yieldToBrowser();
  }

  return dst;
}

/**
 * Oynanabilir alanın kenarında yükselen çanak kenarı. Görünmez duvar yerine
 * doğal bir set: sürücü sınıra vardığını hisseder ama manzara kesilmez, uzak
 * kabuk ötede devam eder.
 *
 * Rampa neredeyse sabit eğimli (~30°): smoothstep kullanılsaydı ortası 45°'yi
 * aşar ve aşınma geçişi bu duvarı düzeltmek için onlarca iterasyon harcardı.
 */
function rimHeight(x, z) {
  const edge = Math.max(Math.abs(x), Math.abs(z));
  const t = clamp01((edge - 196) / 145);
  const ramp = t * 0.68 + t * t * (3 - 2 * t) * 0.32;
  return ramp * 82;
}

/** Patika maskesinin en yakın komşu okuması (üretim sırasında kullanılır). */
function samplePathMask(mask, x, z) {
  const extent = WORLD.playfield;
  const half = extent * 0.5;
  if (Math.abs(x) >= half || Math.abs(z) >= half) return 0;
  const step = extent / PATH_RES;
  const i = clamp(Math.floor((x + half) / step), 0, PATH_RES - 1);
  const j = clamp(Math.floor((z + half) / step), 0, PATH_RES - 1);
  return mask[j * PATH_RES + i] / 255;
}

/** Patika maskesini kontrol noktalarından geçen eğriyi rasterleyerek üretir. */
function buildPathMask() {
  const mask = new Uint8Array(PATH_RES * PATH_RES);
  const extent = WORLD.playfield;
  const half = extent * 0.5;
  const step = extent / PATH_RES;

  // Kontrol noktalarını Catmull-Rom ile yoğun bir çoklu-çizgiye çevir.
  const pts = PATH.points;
  const dense = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let s = 0; s < 12; s++) {
      const t = s / 12;
      dense.push([
        catmullRom(p0[0], p1[0], p2[0], p3[0], t),
        catmullRom(p0[1], p1[1], p2[1], p3[1], t),
      ]);
    }
  }
  dense.push(pts[pts.length - 1]);

  const halfWidth = PATH.width * 0.5;
  const reach = halfWidth + PATH.feather;

  for (let s = 0; s < dense.length - 1; s++) {
    const [ax, az] = dense[s];
    const [bx, bz] = dense[s + 1];
    const segX = bx - ax;
    const segZ = bz - az;
    const segLenSq = segX * segX + segZ * segZ || 1;

    const minI = Math.max(0, Math.floor((Math.min(ax, bx) - reach + half) / step));
    const maxI = Math.min(PATH_RES - 1, Math.ceil((Math.max(ax, bx) + reach + half) / step));
    const minJ = Math.max(0, Math.floor((Math.min(az, bz) - reach + half) / step));
    const maxJ = Math.min(PATH_RES - 1, Math.ceil((Math.max(az, bz) + reach + half) / step));

    for (let j = minJ; j <= maxJ; j++) {
      const wz = -half + (j + 0.5) * step;
      for (let i = minI; i <= maxI; i++) {
        const wx = -half + (i + 0.5) * step;
        const t = clamp01(((wx - ax) * segX + (wz - az) * segZ) / segLenSq);
        const dx = wx - (ax + segX * t);
        const dz = wz - (az + segZ * t);
        const dist = Math.sqrt(dx * dx + dz * dz);
        const v = 1 - smoothstep(halfWidth, halfWidth + PATH.feather, dist);
        if (v <= 0) continue;
        const idx = j * PATH_RES + i;
        const scaled = Math.round(v * 255);
        if (scaled > mask[idx]) mask[idx] = scaled;
      }
    }
  }

  return mask;
}

/**
 * Termal aşınma: duruş açısını aşan her yamaçtan malzeme alıp aşağıdaki
 * komşulara taşır.
 *
 * Gürültü tek başına inandırıcı arazi üretmez — ham fraktal 60-80°'lik
 * duvarlarla dolu ve kaya gibi görünür. Gerçek zeminin eğimi duruş açısını
 * aşamaz; malzeme kayıp yığılır. Bu geçiş tam olarak bunu yapıyor ve her
 * bölgenin karakterini kendiliğinden ortaya çıkarıyor: çölde keskin tepe
 * çizgisiyle biten kayma yüzü, ormanda daha dik durabilen yamaçlar.
 *
 * Duruş açısı hücre başına okunuyor, çünkü bölgeden bölgeye değişiyor.
 * Gauss-Seidel: yeni değerler aynı geçişte okunuyor, kopya tampon gerekmiyor.
 */
function relaxToAngleOfRepose(data, cellRepose, res, cellSize) {
  const excess = [0, 0, 0, 0];
  const neighbour = [0, 0, 0, 0];

  for (let j = 0; j < res; j++) {
    const row = j * res;
    for (let i = 0; i < res; i++) {
      const idx = row + i;
      const h = data[idx];
      const maxDelta = cellRepose[idx] * cellSize;

      neighbour[0] = i > 0 ? idx - 1 : -1;
      neighbour[1] = i < res - 1 ? idx + 1 : -1;
      neighbour[2] = j > 0 ? idx - res : -1;
      neighbour[3] = j < res - 1 ? idx + res : -1;

      let total = 0;
      let peak = 0;
      for (let k = 0; k < 4; k++) {
        const n = neighbour[k];
        const diff = n < 0 ? 0 : h - data[n] - maxDelta;
        const e = diff > 0 ? diff : 0;
        excess[k] = e;
        total += e;
        if (e > peak) peak = e;
      }
      if (total <= 0) continue;

      // Fazlalığın yarısı taşınır: tamamı taşınırsa sistem salınır.
      const moved = peak * 0.5;
      data[idx] = h - moved;
      const scale = moved / total;
      for (let k = 0; k < 4; k++) {
        if (excess[k] > 0) data[neighbour[k]] += excess[k] * scale;
      }
    }
  }
}

function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export class Heightfield {
  constructor(options) {
    this.data = options.data;
    this.res = options.res;
    this.extent = options.extent;
    this.texelSize = options.extent / options.res;
    this.half = options.extent * 0.5;
    this.texture = options.texture;

    this.biomeData = options.biomeData;
    this.biomeRes = options.biomeRes;
    this.biomeTexture = options.biomeTexture;

    this.pathData = options.pathData;
    this.pathRes = options.pathRes;
    this.pathTexture = options.pathTexture;

    /** İz sistemi tarafından takılan rut ızgarası (varsa yükseklik buna eklenir). */
    this.rutfield = null;
    this._weights = [0, 0, 0, 0];

    /**
     * Prosedürel arazinin el değmemiş kopyası. Harita editörü fırça darbelerini
     * *bunun üstüne* yeniden oynatarak çalışıyor: kaydedilen belge birkaç kilobayt
     * darbe listesi oluyor, 16 MB'lık bir yükseklik ızgarası değil. Aynı kopya
     * "araziyi sıfırla" ve geri alma için de tek doğruluk kaynağı.
     */
    this.baseData = null;
    this.baseBiomeData = null;

    /** Bekleyen doku yüklemesinin sınırlayıcı kutusu (texel), yoksa null. */
    this._dirty = null;
    this._biomeDirty = null;
  }

  /** Editör açılmadan önce bir kez: prosedürel hali sakla. */
  snapshotBase() {
    if (!this.baseData) this.baseData = this.data.slice();
    if (!this.baseBiomeData) this.baseBiomeData = this.biomeData.slice();
  }

  /** Yükseklik ızgarasını el değmemiş prosedürel haline döndürür. */
  restoreBase() {
    if (!this.baseData) return;
    this.data.set(this.baseData);
    this.biomeData.set(this.baseBiomeData);
    this.markDirty(0, 0, this.res - 1, this.res - 1);
    this.markBiomeDirty(0, 0, this.biomeRes - 1, this.biomeRes - 1);
  }

  /** Dünya koordinatını ızgara indeksine (kesirli) çevirir. */
  toGrid(x, z, out = _tmpGrid) {
    out.i = (x + this.half) / this.texelSize - 0.5;
    out.j = (z + this.half) / this.texelSize - 0.5;
    return out;
  }

  markDirty(i0, j0, i1, j1) {
    const box = this._dirty;
    if (!box) {
      this._dirty = { i0, j0, i1, j1 };
      return;
    }
    if (i0 < box.i0) box.i0 = i0;
    if (j0 < box.j0) box.j0 = j0;
    if (i1 > box.i1) box.i1 = i1;
    if (j1 > box.j1) box.j1 = j1;
  }

  markBiomeDirty(i0, j0, i1, j1) {
    const box = this._biomeDirty;
    if (!box) {
      this._biomeDirty = { i0, j0, i1, j1 };
      return;
    }
    if (i0 < box.i0) box.i0 = i0;
    if (j0 < box.j0) box.j0 = j0;
    if (i1 > box.i1) box.i1 = i1;
    if (j1 > box.j1) box.j1 = j1;
  }

  /**
   * Kirlenen bölgeyi GPU'ya yükler.
   *
   * Tamamını yüklemek (`needsUpdate = true`) 2048² R32F'te kare başına 16 MB
   * demek — fırçayı sürüklerken saniyede bir gigabayt. `copyTextureToTexture`
   * aynı dokuyu hem kaynak hem hedef alarak `texSubImage2D` yapıyor: yalnız
   * fırçanın dokunduğu dikdörtgen gidiyor.
   */
  flushTexture(renderer) {
    if (this._dirty) {
      const { i0, j0, i1, j1 } = this._dirty;
      this._dirty = null;
      _copyMin.set(i0, j0);
      _copyMax.set(i1 + 1, j1 + 1);
      _copyBox.set(_copyMin, _copyMax);
      renderer.copyTextureToTexture(this.texture, this.texture, _copyBox, _copyMin);
    }
    if (this._biomeDirty) {
      const { i0, j0, i1, j1 } = this._biomeDirty;
      this._biomeDirty = null;
      _copyMin.set(i0, j0);
      _copyMax.set(i1 + 1, j1 + 1);
      _copyBox.set(_copyMin, _copyMax);
      renderer.copyTextureToTexture(this.biomeTexture, this.biomeTexture, _copyBox, _copyMin);
    }
  }

  /**
   * Kameradan çıkan ışının araziyle kesişimi — editörde fareyi zemine
   * düşürmek için. Kaba adımlarla yüzeyin altına inilene kadar yürüyor, sonra
   * ikiye bölerek daralıyor: yükseklik alanı tek değerli olduğu için bu
   * yeterli ve genel bir ışın-üçgen testinden çok daha ucuz.
   */
  raycast(origin, direction, out = new THREE.Vector3(), maxDistance = 4000) {
    let t = 0;
    let prevT = 0;
    let prevAbove = origin.y - this.sampleBase(origin.x, origin.z) > 0;
    // Işın ne kadar yataysa adım o kadar uzun olabilir: yüzeye yaklaşma hızı
    // düşer ve kısa adımlar boşa gider.
    const step = Math.max(1.5, this.texelSize * 1.5);

    for (let i = 0; i < 900 && t < maxDistance; i++) {
      t += step * (1 + t * 0.01);
      const x = origin.x + direction.x * t;
      const y = origin.y + direction.y * t;
      const z = origin.z + direction.z * t;
      const above = y - this.sampleBase(x, z) > 0;
      if (above !== prevAbove) {
        let lo = prevT;
        let hi = t;
        for (let k = 0; k < 24; k++) {
          const mid = (lo + hi) * 0.5;
          const mx = origin.x + direction.x * mid;
          const my = origin.y + direction.y * mid;
          const mz = origin.z + direction.z * mid;
          if (my - this.sampleBase(mx, mz) > 0 === prevAbove) lo = mid;
          else hi = mid;
        }
        const hit = (lo + hi) * 0.5;
        return out.set(
          origin.x + direction.x * hit,
          origin.y + direction.y * hit,
          origin.z + direction.z * hit
        );
      }
      prevAbove = above;
      prevT = t;
    }
    return null;
  }

  /** Tam sayı ızgara okuması, kenarlarda kelepçelenir. */
  at(i, j) {
    const ii = i < 0 ? 0 : i >= this.res ? this.res - 1 : i;
    const jj = j < 0 ? 0 : j >= this.res ? this.res - 1 : j;
    return this.data[jj * this.res + ii];
  }

  /** Sadece arazi katmanı — iz oyukları hariç. */
  sampleBase(x, z) {
    const gx = (x + this.half) / this.texelSize - 0.5;
    const gz = (z + this.half) / this.texelSize - 0.5;
    const i0 = Math.floor(gx);
    const j0 = Math.floor(gz);
    const tx = gx - i0;
    const tz = gz - j0;

    const rows = [0, 0, 0, 0];
    for (let r = -1; r <= 2; r++) {
      rows[r + 1] = catmullRom(
        this.at(i0 - 1, j0 + r),
        this.at(i0, j0 + r),
        this.at(i0 + 1, j0 + r),
        this.at(i0 + 2, j0 + r),
        tx
      );
    }
    return catmullRom(rows[0], rows[1], rows[2], rows[3], tz);
  }

  /**
   * Aracın gerçekte üstünde durduğu yükseklik: arazi + kendi bıraktığı izin
   * oyuğu. Rut ızgarası bağlıysa tekerlekler kendi izine oturur.
   */
  sampleHeight(x, z) {
    const base = this.sampleBase(x, z);
    return this.rutfield ? base - this.rutfield.sampleDepth(x, z) : base;
  }

  /** Merkezi farkla yüzey normali. `out` verilirse ona yazar. */
  sampleNormal(x, z, out = new THREE.Vector3()) {
    const d = 0.6;
    const hl = this.sampleHeight(x - d, z);
    const hr = this.sampleHeight(x + d, z);
    const hd = this.sampleHeight(x, z - d);
    const hu = this.sampleHeight(x, z + d);
    return out.set(hl - hr, 2 * d, hd - hu).normalize();
  }

  /** Yüzey eğimi (radyan) — kuma saplanma ve nesne yerleştirme için. */
  sampleSlope(x, z) {
    const n = this.sampleNormal(x, z, _tmpNormal);
    return Math.acos(clamp(n.y, -1, 1));
  }

  /** Bölge ağırlıkları (bilineer). `out` dört elemanlı dizi. */
  sampleBiome(x, z, out = this._weights) {
    const step = this.extent / this.biomeRes;
    const gx = clamp((x + this.half) / step - 0.5, 0, this.biomeRes - 1.001);
    const gz = clamp((z + this.half) / step - 0.5, 0, this.biomeRes - 1.001);
    const i0 = Math.floor(gx);
    const j0 = Math.floor(gz);
    const tx = gx - i0;
    const tz = gz - j0;
    const i1 = Math.min(i0 + 1, this.biomeRes - 1);
    const j1 = Math.min(j0 + 1, this.biomeRes - 1);

    const d = this.biomeData;
    const oa = (j0 * this.biomeRes + i0) * 4;
    const ob = (j0 * this.biomeRes + i1) * 4;
    const oc = (j1 * this.biomeRes + i0) * 4;
    const od = (j1 * this.biomeRes + i1) * 4;

    for (let c = 0; c < 4; c++) {
      const top = d[oa + c] + (d[ob + c] - d[oa + c]) * tx;
      const bottom = d[oc + c] + (d[od + c] - d[oc + c]) * tx;
      out[c] = (top + (bottom - top) * tz) / 255;
    }
    return out;
  }

  /** Baskın bölgenin kimliği — arayüzde göstermek için. */
  dominantBiome(x, z) {
    const w = this.sampleBiome(x, z);
    let best = 0;
    for (let i = 1; i < 4; i++) if (w[i] > w[best]) best = i;
    return BIOME_IDS[best];
  }

  /** Patika maskesi 0-1 (bilineer). */
  samplePath(x, z) {
    const extent = WORLD.playfield;
    const half = extent * 0.5;
    if (Math.abs(x) >= half || Math.abs(z) >= half) return 0;
    const step = extent / this.pathRes;
    const gx = (x + half) / step - 0.5;
    const gz = (z + half) / step - 0.5;
    const i0 = clamp(Math.floor(gx), 0, this.pathRes - 1);
    const j0 = clamp(Math.floor(gz), 0, this.pathRes - 1);
    const i1 = Math.min(i0 + 1, this.pathRes - 1);
    const j1 = Math.min(j0 + 1, this.pathRes - 1);
    const tx = clamp01(gx - i0);
    const tz = clamp01(gz - j0);
    const d = this.pathData;
    const top = d[j0 * this.pathRes + i0] + (d[j0 * this.pathRes + i1] - d[j0 * this.pathRes + i0]) * tx;
    const bottom = d[j1 * this.pathRes + i0] + (d[j1 * this.pathRes + i1] - d[j1 * this.pathRes + i0]) * tx;
    return (top + (bottom - top) * tz) / 255;
  }

  /** Verilen noktanın oynanabilir alan içinde kalıp kalmadığı. */
  isInsidePlayfield(x, z, margin = 0) {
    const limit = WORLD.playfield * 0.5 - margin;
    return Math.abs(x) < limit && Math.abs(z) < limit;
  }

  /** Shader'lara verilecek ortak uniform seti. */
  get uniforms() {
    return {
      uHeightMap: { value: this.texture },
      uHeightExtent: { value: this.extent },
      uHeightRes: { value: this.res },
      uBiomeMap: { value: this.biomeTexture },
      uPathMap: { value: this.pathTexture },
      uPathExtent: { value: WORLD.playfield },
    };
  }
}

const _tmpNormal = new THREE.Vector3();
const _tmpGrid = { i: 0, j: 0 };
const _copyMin = new THREE.Vector2();
const _copyMax = new THREE.Vector2();
const _copyBox = new THREE.Box2();
