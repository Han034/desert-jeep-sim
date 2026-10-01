import { WORLD } from '../config/settings.js';
import { clamp } from '../utils/math.js';

/**
 * İz haritasının CPU'daki ikizi.
 *
 * GPU'daki iz haritasını fizik için geri okumak (readPixels) her karede boru
 * hattını durdururdu. Bunun yerine damga konumları zaten CPU'da hesaplandığı
 * için aynı damgalar buraya da işleniyor. Sonuç: süspansiyon ray-cast'i kendi
 * bıraktığın oyuğu görür — izinin üstünden geçtiğinde araç hendeğe oturur.
 *
 * Görsel oyuktan sığ tutuluyor (7 cm'e karşı 15 cm): daha derini, tekerleğin
 * kendi kazdığı çukura sürekli batıp daha da kazdığı bir geri besleme
 * döngüsüne yol açıyor.
 */
export class Rutfield {
  constructor({ resolution = 1024, maxDepth = 0.07 } = {}) {
    this.res = resolution;
    this.extent = WORLD.playfield;
    this.cell = this.extent / resolution;
    this.half = this.extent * 0.5;
    this.maxDepth = maxDepth;
    this.data = new Uint8Array(resolution * resolution);
    this.decayDebt = 0;
  }

  clear() {
    this.data.fill(0);
    this.decayDebt = 0;
  }

  /** Dünya koordinatını hücre koordinatına çevirir (kesirli). */
  toCell(v) {
    return (v + this.half) / this.cell - 0.5;
  }

  /** Metre cinsinden oyuk derinliği, bilineer. */
  sampleDepth(x, z) {
    if (Math.abs(x) >= this.half || Math.abs(z) >= this.half) return 0;

    const gx = this.toCell(x);
    const gz = this.toCell(z);
    const i0 = Math.floor(gx);
    const j0 = Math.floor(gz);
    const tx = gx - i0;
    const tz = gz - j0;

    const res = this.res;
    const i1 = clamp(i0 + 1, 0, res - 1);
    const j1 = clamp(j0 + 1, 0, res - 1);
    const ic = clamp(i0, 0, res - 1);
    const jc = clamp(j0, 0, res - 1);

    const d = this.data;
    const a = d[jc * res + ic];
    const b = d[jc * res + i1];
    const c = d[j1 * res + ic];
    const e = d[j1 * res + i1];

    const top = a + (b - a) * tx;
    const bottom = c + (e - c) * tx;
    return ((top + (bottom - top) * tz) / 255) * this.maxDepth;
  }

  /**
   * Bir tekerleğin bu karede taradığı parçayı ızgaraya işler. Kapsül profili
   * GPU fırçasıyla aynı: ortada düz taban, kenarda hızla çıkan duvar.
   */
  stampSegment(x0, z0, x1, z1, halfWidth, strength) {
    if (strength <= 0.001) return;

    const reach = halfWidth * 1.15 + this.cell;
    const minX = Math.min(x0, x1) - reach;
    const maxX = Math.max(x0, x1) + reach;
    const minZ = Math.min(z0, z1) - reach;
    const maxZ = Math.max(z0, z1) + reach;

    const res = this.res;
    const i0 = clamp(Math.floor(this.toCell(minX)), 0, res - 1);
    const i1 = clamp(Math.ceil(this.toCell(maxX)), 0, res - 1);
    const j0 = clamp(Math.floor(this.toCell(minZ)), 0, res - 1);
    const j1 = clamp(Math.ceil(this.toCell(maxZ)), 0, res - 1);

    const segX = x1 - x0;
    const segZ = z1 - z0;
    const segLenSq = segX * segX + segZ * segZ;
    const add = strength * 255;

    for (let j = j0; j <= j1; j++) {
      const wz = -this.half + (j + 0.5) * this.cell;
      const rowOffset = j * res;
      for (let i = i0; i <= i1; i++) {
        const wx = -this.half + (i + 0.5) * this.cell;

        // Noktanın parçaya uzaklığı.
        let t = 0;
        if (segLenSq > 1e-9) {
          t = clamp(((wx - x0) * segX + (wz - z0) * segZ) / segLenSq, 0, 1);
        }
        const dx = wx - (x0 + segX * t);
        const dz = wz - (z0 + segZ * t);
        const u = Math.sqrt(dx * dx + dz * dz) / halfWidth;
        if (u > 1.1) continue;

        const profile = u < 0.55 ? 1 : 1 - (u - 0.55) / 0.55;
        const idx = rowOffset + i;
        const next = this.data[idx] + add * profile;
        this.data[idx] = next > 255 ? 255 : next;
      }
    }
  }

  /**
   * Rüzgâr aşınması. Her karede 1 milyon hücreyi gezmek yerine borç birikip
   * bir 8 bit adımını aştığında tek geçiş yapılıyor — GPU tarafındaki aşınmayla
   * aynı mantık.
   */
  decay(dt, windErosion = 1) {
    this.decayDebt += dt * windErosion * 4.3;
    if (this.decayDebt < 1) return;

    const amount = Math.floor(this.decayDebt);
    this.decayDebt -= amount;

    const d = this.data;
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (v > 0) d[i] = v > amount ? v - amount : 0;
    }
  }

  /** Mini-harita için ızgarayı bir ImageData'ya döker. */
  writeToImageData(imageData, color = [255, 176, 92]) {
    const out = imageData.data;
    const outW = imageData.width;
    const outH = imageData.height;
    const res = this.res;
    const d = this.data;

    for (let y = 0; y < outH; y++) {
      const sj = Math.min(res - 1, ((y / outH) * res) | 0);
      for (let x = 0; x < outW; x++) {
        const si = Math.min(res - 1, ((x / outW) * res) | 0);
        const v = d[sj * res + si];
        const o = (y * outW + x) * 4;
        out[o] = color[0];
        out[o + 1] = color[1];
        out[o + 2] = color[2];
        out[o + 3] = v;
      }
    }
  }
}
