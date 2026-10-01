import { clamp } from '../utils/math.js';

/**
 * Sadeleştirilmiş lastik modeli.
 *
 * Kayma oranı (boyuna) ve kayma açısı (yanal) normalize edilip tek bir
 * "bileşik kayma" vektörüne toplanıyor; sürtünme katsayısı bu vektörün
 * büyüklüğünden okunuyor ve kuvvet kaymanın tersi yönde dağıtılıyor. Bu
 * yaklaşım sürtünme dairesini kendiliğinden korur: gaz verirken direksiyon
 * kırmak boyuna tutuşu yer, tam frende dönüş imkânsızlaşır.
 *
 * Eğri, kumun karakterini taşıyacak şekilde ayarlandı: tepe düşük ve erken,
 * tepeden sonraki düşüş çok yumuşak. Asfaltta savrulma ani ve cezalandırıcıdır;
 * kumda araç yumuşakça açılır ve gazla toplanabilir — yarı-gerçekçi hedefin
 * tam olarak istediği his.
 */

/** Tepe sürtünmenin göründüğü kayma oranı. */
export const PEAK_SLIP_RATIO = 0.19;
/**
 * Tepe sürtünmenin göründüğü kayma açısı (radyan, ~16°). Geniş tutuluyor:
 * lastik tutuşunu daha geç bırakıyor, savrulma ani değil kademeli başlıyor.
 */
export const PEAK_SLIP_ANGLE = 0.28;

/**
 * Bileşik kayma büyüklüğünden sürtünme katsayısı.
 * @param {number} s normalize kayma (1.0 = tepe noktası)
 */
export function frictionCurve(s, peak, slide) {
  if (s <= 0) return 0;
  if (s <= 1) {
    // Tepede türev sıfır: tutuşun sınırında araç titremez.
    return peak * Math.sin((Math.PI / 2) * s);
  }
  // Tepeden sonraki düşüş yumuşak: savrulan araç gaz ve direksiyonla
  // toparlanabilsin diye tutuş bir uçurumdan değil, yokuştan iniyor.
  return slide + (peak - slide) * Math.exp(-(s - 1) * 0.7);
}

/**
 * Bir tekerleğin temas kuvvetlerini hesaplar.
 *
 * @returns {{ forward: number, lateral: number, combined: number, saturation: number }}
 *          `forward` aracı iten kuvvet (N), `lateral` yanal kuvvet (N),
 *          `saturation` tutuşun ne kadar tükendiği (0-1, parçacık ve iz
 *          sistemleri bunu okur).
 */
export function solveTire({ slipRatio, slipAngle, load, peak, slide, out }) {
  const result = out || { forward: 0, lateral: 0, combined: 0, saturation: 0 };

  if (load <= 1) {
    result.forward = 0;
    result.lateral = 0;
    result.combined = 0;
    result.saturation = 0;
    return result;
  }

  const sx = slipRatio / PEAK_SLIP_RATIO;
  const sy = Math.tan(clamp(slipAngle, -1.45, 1.45)) / Math.tan(PEAK_SLIP_ANGLE);
  const s = Math.hypot(sx, sy);

  if (s < 1e-5) {
    result.forward = 0;
    result.lateral = 0;
    result.combined = 0;
    result.saturation = 0;
    return result;
  }

  const mu = frictionCurve(s, peak, slide);
  const magnitude = mu * load;

  // Tekerlek araçtan hızlı dönüyorsa (sx > 0) lastik zemini geriye iter, zemin
  // de aracı ileri; yanal kayma ise her zaman kaymanın tersine kuvvet doğurur.
  result.forward = (sx / s) * magnitude;
  result.lateral = (-sy / s) * magnitude;
  result.combined = magnitude;
  result.saturation = clamp(s, 0, 3) / 3;
  return result;
}
