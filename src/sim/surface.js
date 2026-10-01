import { BIOME_LIST, PATH } from '../config/biomes.js';
import { VEHICLE } from '../config/settings.js';
import { lerp } from '../utils/math.js';

/**
 * Zemin özellikleri: aracın o an bastığı yerin tutuşu, yuvarlanma direnci ve
 * batma eğilimi.
 *
 * Bölge ağırlıkları zaten CPU'da olduğu için lastik parametreleri de aynı
 * karışımdan çıkıyor — kar belirgin şekilde kaygan, çayır ve orman toprağı
 * kumdan tutuşlu, sıkışmış patika hepsinden iyi. Sürücü bölge değiştirdiğini
 * renkten önce direksiyondan anlıyor.
 */
export function createSurfaceSampler(heightfield) {
  const weights = [0, 0, 0, 0];
  const result = {
    peakGrip: 0,
    slideGrip: 0,
    rollingResistance: 0,
    bogDrag: 0,
    trackDepth: 0,
    erosion: 0,
  };

  return function sampleSurface(x, z) {
    heightfield.sampleBiome(x, z, weights);

    let grip = 0;
    let rolling = 0;
    let bog = 0;
    let trackDepth = 0;
    let erosion = 0;

    for (let i = 0; i < 4; i++) {
      const w = weights[i];
      if (w <= 0) continue;
      const b = BIOME_LIST[i];
      grip += b.tyre.grip * w;
      rolling += b.tyre.rolling * w;
      bog += b.tyre.bog * w;
      trackDepth += b.track.depth * w;
      erosion += b.track.erosion * w;
    }

    // Patika yalnız çayır bölgesinde var; ağırlıkla çarpmak, sınırda maskenin
    // taşmasını engelliyor.
    const path = heightfield.samplePath(x, z) * weights[3];
    if (path > 0) {
      grip = lerp(grip, PATH.tyre.grip, path);
      rolling = lerp(rolling, PATH.tyre.rolling, path);
      bog = lerp(bog, PATH.tyre.bog, path);
      trackDepth = lerp(trackDepth, 0.35, path);
    }

    const sand = VEHICLE.sand;
    result.peakGrip = sand.peakGrip * grip;
    result.slideGrip = sand.slideGrip * grip;
    result.rollingResistance = sand.rollingResistance * rolling;
    result.bogDrag = sand.bogDrag * bog;
    result.trackDepth = trackDepth;
    result.erosion = erosion;
    return result;
  };
}
