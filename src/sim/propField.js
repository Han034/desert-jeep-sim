import { WORLD } from '../config/settings.js';

/**
 * Sahnedeki katı nesnelerin (kaya, ağaç gövdesi, kaya oluşumu) çarpıştırıcı
 * kaydı.
 *
 * Görsel nesneler `InstancedMesh` olarak çiziliyor; üçgen düzeyinde çarpışma
 * testi hem gereksiz hem pahalı olurdu. Her nesne bunun yerine bir **elipsoid**
 * ile temsil ediliyor: kayalar zaten ölçeklenmiş ikosahedron, ağaç gövdeleri de
 * ince uzun silindir — ikisi de elipsoide iyi oturuyor.
 *
 * İki ayrı bayrak var çünkü iki farklı soru soruluyor:
 *  - `blocksWheel`: tekerlek bunun **üstünden geçer mi**? (küçük kaya: evet)
 *  - `blocksBody`:  gövde bunun **içinden geçemez** mi? (büyük kaya, ağaç)
 *
 * Nesneler düzgün bir ızgaraya kaydediliyor; orman biyomunda binlerce ağaç
 * olacağı için doğrusal tarama yetmez.
 */

const CELL = 8;

export class PropField {
  constructor({ extent = WORLD.playfield * 1.6 } = {}) {
    this.extent = extent;
    this.half = extent * 0.5;
    this.cols = Math.ceil(extent / CELL);
    this.cells = new Map();

    /** Elipsoid merkezleri ve yarıçapları, düz dizilerde. */
    this.cx = [];
    this.cy = [];
    this.cz = [];
    this.rh = [];
    this.rv = [];
    this.wheelFlag = [];
    this.bodyFlag = [];
  }

  get count() {
    return this.cx.length;
  }

  clear() {
    this.cells.clear();
    this.cx.length = 0;
    this.cy.length = 0;
    this.cz.length = 0;
    this.rh.length = 0;
    this.rv.length = 0;
    this.wheelFlag.length = 0;
    this.bodyFlag.length = 0;
  }

  cellIndex(x, z) {
    const i = Math.floor((x + this.half) / CELL);
    const j = Math.floor((z + this.half) / CELL);
    if (i < 0 || j < 0 || i >= this.cols || j >= this.cols) return -1;
    return j * this.cols + i;
  }

  /**
   * @param {number} radiusH yatay yarıçap
   * @param {number} radiusV düşey yarıçap (merkezden tepeye)
   */
  add(x, y, z, radiusH, radiusV, { blocksWheel = true, blocksBody = true } = {}) {
    const index = this.cx.length;
    this.cx.push(x);
    this.cy.push(y);
    this.cz.push(z);
    this.rh.push(radiusH);
    this.rv.push(radiusV);
    this.wheelFlag.push(blocksWheel);
    this.bodyFlag.push(blocksBody);

    // Nesne, yatay sınırlayıcı kutusunun değdiği tüm hücrelere yazılır.
    const i0 = Math.floor((x - radiusH + this.half) / CELL);
    const i1 = Math.floor((x + radiusH + this.half) / CELL);
    const j0 = Math.floor((z - radiusH + this.half) / CELL);
    const j1 = Math.floor((z + radiusH + this.half) / CELL);

    for (let j = j0; j <= j1; j++) {
      if (j < 0 || j >= this.cols) continue;
      for (let i = i0; i <= i1; i++) {
        if (i < 0 || i >= this.cols) continue;
        const key = j * this.cols + i;
        let bucket = this.cells.get(key);
        if (!bucket) {
          bucket = [];
          this.cells.set(key, bucket);
        }
        bucket.push(index);
      }
    }
    return index;
  }

  /** Verilen yatay kutuya değen nesne indekslerini `out` dizisine toplar. */
  query(minX, minZ, maxX, maxZ, out) {
    out.length = 0;
    const i0 = Math.floor((minX + this.half) / CELL);
    const i1 = Math.floor((maxX + this.half) / CELL);
    const j0 = Math.floor((minZ + this.half) / CELL);
    const j1 = Math.floor((maxZ + this.half) / CELL);

    for (let j = j0; j <= j1; j++) {
      if (j < 0 || j >= this.cols) continue;
      for (let i = i0; i <= i1; i++) {
        if (i < 0 || i >= this.cols) continue;
        const bucket = this.cells.get(j * this.cols + i);
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k++) {
          // Aynı nesne birden çok hücrede olabilir.
          if (out.indexOf(bucket[k]) === -1) out.push(bucket[k]);
        }
      }
    }
    return out;
  }

  /**
   * Aşağı bakan ışını nesnelerle keser. Elipsoid, koordinatlar yarıçaplara
   * bölünerek birim küreye dönüştürülüp basit ışın-küre testiyle çözülüyor.
   *
   * @returns en yakın vuruşun mesafesi, yoksa -1. Normal `outNormal`'a yazılır.
   */
  raycast(ox, oy, oz, dx, dy, dz, maxT, outNormal, scratch) {
    const reach = Math.abs(dx * maxT) + Math.abs(dz * maxT) + 1;
    const list = this.query(ox - reach, oz - reach, ox + reach, oz + reach, scratch);
    let best = -1;

    for (let n = 0; n < list.length; n++) {
      const idx = list[n];
      if (!this.wheelFlag[idx]) continue;

      const rh = this.rh[idx];
      const rv = this.rv[idx];
      const ex = (ox - this.cx[idx]) / rh;
      const ey = (oy - this.cy[idx]) / rv;
      const ez = (oz - this.cz[idx]) / rh;
      const fx = dx / rh;
      const fy = dy / rv;
      const fz = dz / rh;

      const a = fx * fx + fy * fy + fz * fz;
      if (a < 1e-9) continue;
      const b = 2 * (ex * fx + ey * fy + ez * fz);
      const c = ex * ex + ey * ey + ez * ez - 1;
      const disc = b * b - 4 * a * c;
      if (disc < 0) continue;

      const sq = Math.sqrt(disc);
      let t = (-b - sq) / (2 * a);
      if (t < 0) t = (-b + sq) / (2 * a);
      if (t < 0 || t > maxT) continue;
      if (best >= 0 && t >= best) continue;

      best = t;
      // Elipsoid yüzey normali: merkeze göre farkın yarıçap karelerine bölümü.
      const px = ox + dx * t - this.cx[idx];
      const py = oy + dy * t - this.cy[idx];
      const pz = oz + dz * t - this.cz[idx];
      outNormal.set(px / (rh * rh), py / (rv * rv), pz / (rh * rh)).normalize();
    }

    return best;
  }

  /**
   * Küre-nesne girişimi. Girişim varsa `outNormal` küreyi dışarı iten yönü,
   * dönüş değeri de girme derinliğini verir.
   */
  resolveSphere(px, py, pz, radius, outNormal, scratch) {
    const list = this.query(px - radius, pz - radius, px + radius, pz + radius, scratch);
    let deepest = 0;

    for (let n = 0; n < list.length; n++) {
      const idx = list[n];
      if (!this.bodyFlag[idx]) continue;

      const rh = this.rh[idx];
      const rv = this.rv[idx];
      const dx = px - this.cx[idx];
      const dy = py - this.cy[idx];
      const dz = pz - this.cz[idx];

      const qx = dx / rh;
      const qy = dy / rv;
      const qz = dz / rh;
      const qlen = Math.sqrt(qx * qx + qy * qy + qz * qz);
      if (qlen > 1 + radius / Math.min(rh, rv)) continue;

      // Yüzeydeki en yakın nokta ve oradaki gerçek normal.
      const inv = qlen > 1e-6 ? 1 / qlen : 0;
      const sx = this.cx[idx] + qx * inv * rh;
      const sy = this.cy[idx] + qy * inv * rv;
      const sz = this.cz[idx] + qz * inv * rh;

      let nx = dx / (rh * rh);
      let ny = dy / (rv * rv);
      let nz = dz / (rh * rh);
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl < 1e-9) continue;
      nx /= nl;
      ny /= nl;
      nz /= nl;

      // Küre merkezinin yüzeye işaretli uzaklığı; içerideyse negatif.
      const signed = (px - sx) * nx + (py - sy) * ny + (pz - sz) * nz;
      const penetration = radius - signed;
      if (penetration > deepest) {
        deepest = penetration;
        outNormal.set(nx, ny, nz);
      }
    }

    return deepest;
  }
}
