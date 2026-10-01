import { WORLD } from '../config/settings.js';
import { clamp, clamp01, smoothstep } from '../utils/math.js';

/**
 * Arazi fırçaları.
 *
 * Her fırça darbesi tek bir küçük nesne: `{t, x, z, r, s}`. Harita belgesinin
 * sakladığı şey bu liste — 16 MB'lık bir yükseklik ızgarası değil, birkaç
 * kilobayt. Yükleme, prosedürel araziyi geri alıp darbeleri sırayla yeniden
 * oynatmak demek.
 *
 * Bu tercihin bedeli, darbelerin **sırasının önemli olması**: `smooth` ve
 * `flatten` o anki yüzeyi okuyor. Karşılığında geri alma bedavaya geliyor
 * (listenin sonunu at, baştan oyna), ağ üzerinden tek darbe göndermek mümkün
 * oluyor ve belge insan tarafından okunabilir kalıyor.
 *
 * `flatten` hedef yüksekliğini darbenin *içinde* saklıyor: yoksa yeniden
 * oynatma, o an tıklanan noktanın yüksekliğini bilemez ve harita farklı açılırdı.
 */

/** Fırçanın etki edebileceği alan — çanak kenarının dışına taşmasın. */
const EDIT_LIMIT = WORLD.playfield * 0.5;

/**
 * Darbeyi yükseklik ızgarasına uygular ve dokunulan dikdörtgeni kirli işaretler.
 * `heightfield.flushTexture(renderer)` çağrılana kadar GPU'ya bir şey gitmez.
 */
export function applyTerrainStroke(heightfield, stroke) {
  const { res, texelSize, half, data } = heightfield;
  const radius = Math.max(texelSize * 1.5, stroke.r);
  const invRadius = 1 / radius;

  const i0 = clamp(Math.floor((stroke.x - radius + half) / texelSize), 0, res - 1);
  const i1 = clamp(Math.ceil((stroke.x + radius + half) / texelSize), 0, res - 1);
  const j0 = clamp(Math.floor((stroke.z - radius + half) / texelSize), 0, res - 1);
  const j1 = clamp(Math.ceil((stroke.z + radius + half) / texelSize), 0, res - 1);
  if (i1 < i0 || j1 < j0) return;

  const tool = stroke.t;

  for (let j = j0; j <= j1; j++) {
    const z = -half + (j + 0.5) * texelSize;
    if (Math.abs(z) > EDIT_LIMIT) continue;
    const row = j * res;

    for (let i = i0; i <= i1; i++) {
      const x = -half + (i + 0.5) * texelSize;
      if (Math.abs(x) > EDIT_LIMIT) continue;

      const dx = x - stroke.x;
      const dz = z - stroke.z;
      const dist = Math.sqrt(dx * dx + dz * dz) * invRadius;
      if (dist >= 1) continue;

      // Yumuşak kenarlı fırça: sert kenar, üst üste binen darbelerde halka
      // izleri bırakıyor.
      const falloff = smoothstep(1, 0, dist);
      const idx = row + i;

      if (tool === 'yukselt' || tool === 'alcalt') {
        data[idx] += stroke.s * falloff;
      } else if (tool === 'duzle') {
        data[idx] += (stroke.h - data[idx]) * clamp01(Math.abs(stroke.s) * falloff);
      } else if (tool === 'yumusat') {
        // Beş noktalı ortalama. Gauss-Seidel değil: komşuların bu darbede
        // güncellenmiş değerlerini okumak, fırçayı tarama yönüne doğru
        // kaydırıyordu.
        const l = i > 0 ? data[idx - 1] : data[idx];
        const r = i < res - 1 ? data[idx + 1] : data[idx];
        const d = j > 0 ? data[idx - res] : data[idx];
        const u = j < res - 1 ? data[idx + res] : data[idx];
        const avg = (l + r + d + u) * 0.25;
        data[idx] += (avg - data[idx]) * clamp01(Math.abs(stroke.s) * falloff);
      } else if (tool === 'puruzlendir') {
        // Konuma bağlı deterministik gürültü: yeniden oynatmada aynı çıkıyor.
        data[idx] += hashNoise(i, j) * stroke.s * falloff;
      }
    }
  }

  heightfield.markDirty(i0, j0, i1, j1);
}

/**
 * Bölge boyası. Ağırlıklar hedef bölgeye doğru çekiliyor ve toplam 255'te
 * tutuluyor — shader dört kanalı ağırlık olarak okuduğu için toplamın kayması
 * zemini soluklaştırırdı.
 */
export function applyBiomeStroke(heightfield, stroke) {
  const { biomeRes, biomeData, extent, half } = heightfield;
  const step = extent / biomeRes;
  const radius = Math.max(step * 1.5, stroke.r);
  const invRadius = 1 / radius;
  const target = stroke.b | 0;

  const i0 = clamp(Math.floor((stroke.x - radius + half) / step), 0, biomeRes - 1);
  const i1 = clamp(Math.ceil((stroke.x + radius + half) / step), 0, biomeRes - 1);
  const j0 = clamp(Math.floor((stroke.z - radius + half) / step), 0, biomeRes - 1);
  const j1 = clamp(Math.ceil((stroke.z + radius + half) / step), 0, biomeRes - 1);
  if (i1 < i0 || j1 < j0) return;

  for (let j = j0; j <= j1; j++) {
    const z = -half + (j + 0.5) * step;
    for (let i = i0; i <= i1; i++) {
      const x = -half + (i + 0.5) * step;
      const dx = x - stroke.x;
      const dz = z - stroke.z;
      const dist = Math.sqrt(dx * dx + dz * dz) * invRadius;
      if (dist >= 1) continue;

      const amount = clamp01(smoothstep(1, 0, dist) * stroke.s);
      const o = (j * biomeRes + i) * 4;
      for (let c = 0; c < 4; c++) {
        const want = c === target ? 255 : 0;
        biomeData[o + c] = Math.round(biomeData[o + c] + (want - biomeData[o + c]) * amount);
      }
    }
  }

  heightfield.markBiomeDirty(i0, j0, i1, j1);
}

export function applyStroke(heightfield, stroke) {
  if (stroke.t === 'biyom') applyBiomeStroke(heightfield, stroke);
  else applyTerrainStroke(heightfield, stroke);
}

/** Konumdan türeyen, [-1,1] aralığında tekrarlanabilir gürültü. */
function hashNoise(i, j) {
  let h = (i * 374761393 + j * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return (((h ^ (h >>> 16)) >>> 0) / 4294967295) * 2 - 1;
}
