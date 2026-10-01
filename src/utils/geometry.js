import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Birleştirmede korunan öznitelikler; gerisi atılır. */
const KEEP = ['position', 'normal', 'uv', 'color'];

/**
 * Farklı üreticilerden gelen geometrileri güvenle birleştirir.
 *
 * `mergeGeometries` girdilerin öznitelik kümesinin ve indeksli olma durumunun
 * birebir aynı olmasını şart koşuyor; three.js'in üreticileri ise bu konuda
 * tutarlı değil (`ExtrudeGeometry` indekssiz, `BoxGeometry` indeksli, kimi
 * geometriler fazladan öznitelik taşıyor). Bu yardımcı hepsini ortak paydaya
 * indiriyor: indekssiz ve yalnız konum/normal/uv/renk.
 *
 * Vertex renkleri korunuyor çünkü ağaç ve çim modelleri gövde/yaprak/kar
 * ayrımını tek materyalle bunun üzerinden yapıyor. Parçaların bir kısmı renkli
 * bir kısmı renksizse, renksiz olanlara beyaz atanıyor — aksi halde öznitelik
 * kümeleri uyuşmadığı için birleştirme başarısız oluyor.
 *
 * Model parçaları küçük olduğu için indekssize çevirmenin vertex maliyeti
 * önemsiz; karşılığında birleştirme hiçbir zaman patlamıyor.
 */
export function mergeParts(geometries) {
  const normalised = geometries.map((geometry) => {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    // Kaynak geometri ile paylaşılan tamponu bozmamak için gerektiğinde kopya.
    const result = flat === geometry ? flat.clone() : flat;

    for (const name of Object.keys(result.attributes)) {
      if (!KEEP.includes(name)) result.deleteAttribute(name);
    }
    if (!result.attributes.normal) result.computeVertexNormals();
    if (!result.attributes.uv) {
      const count = result.attributes.position.count;
      result.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    return result;
  });

  const anyColored = normalised.some((g) => g.attributes.color);
  if (anyColored) {
    for (const g of normalised) {
      if (g.attributes.color) continue;
      const count = g.attributes.position.count;
      const white = new Float32Array(count * 3).fill(1);
      g.setAttribute('color', new THREE.BufferAttribute(white, 3));
    }
  }

  const merged = mergeGeometries(normalised, false);
  if (!merged) {
    throw new Error('mergeParts: geometriler birleştirilemedi');
  }
  return merged;
}
