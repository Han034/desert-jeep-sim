import { VEHICLE } from '../config/settings.js';
import { clamp, lerp } from '../utils/math.js';

/**
 * Motor ve şanzıman.
 *
 * Kavrama kilitli varsayılıyor: motor devri, çeken tekerleklerin hızından ve
 * vites oranından türetiliyor. Bu, gerçek bir kavrama/tork konvertörü
 * modellemekten çok daha stabil ve arazi aracının istediği hissi zaten veriyor
 * — asıl mesele tepe tırmanırken devrin düşmesi, vitesin inmesi ve torkun
 * geri gelmesi.
 *
 * Rölanti altında devir kelepçelendiği için araç duruştan da hareket edebilir;
 * gerçekte bunu tork konvertörü yapar.
 */
export function createDrivetrain() {
  const cfg = VEHICLE.engine;

  const state = {
    rpm: cfg.idleRpm,
    /**
     * Sesin ve göstergenin okuduğu, yumuşatılmış devir. Ham devir doğrudan
     * tekerlek hızından türediği için vites değişiminde tek karede yüzlerce
     * devir sıçrıyor; volanın ataleti bunu gerçekte yapamaz ve motor sesi
     * çatlak bir sıçrama olarak duyuluyordu.
     */
    smoothRpm: cfg.idleRpm,
    /** 0 tabanlı ileri vites indeksi. */
    gear: 0,
    reverse: false,
    /** Vites değişimi sırasında tork kesilen süre. */
    shiftTimer: 0,
    /** Bu adımda vites değişti mi: +1 yukarı, -1 aşağı, 0 yok. Okunduğunda tüketilir. */
    shiftEvent: 0,
    lowRange: false,
    driveTorque: 0,
    load: 0,
  };

  function torqueAt(rpm) {
    const curve = cfg.torqueCurve;
    if (rpm <= curve[0][0]) return curve[0][1];
    for (let i = 0; i < curve.length - 1; i++) {
      const [r0, t0] = curve[i];
      const [r1, t1] = curve[i + 1];
      if (rpm <= r1) return lerp(t0, t1, (rpm - r0) / (r1 - r0));
    }
    // Kesme bölgesi: devir sınırında tork hızla düşer.
    const last = curve[curve.length - 1];
    return Math.max(0, last[1] - (rpm - last[0]) * 0.5);
  }

  /** Aktif toplam çevrim oranı (tekerlek → motor). */
  function totalRatio() {
    const gearRatio = state.reverse ? -cfg.reverseRatio : cfg.gearRatios[state.gear];
    const range = state.lowRange ? cfg.lowRangeMultiplier : 1;
    return gearRatio * cfg.finalDrive * range;
  }

  /**
   * @param {number} wheelOmega çeken tekerleklerin ortalama açısal hızı (rad/s)
   * @param {number} throttle 0-1
   * @param {number} forwardSpeed aracın ileri hızı (m/s), vites yönü için
   */
  function update(dt, { wheelOmega, throttle, brake, forwardSpeed, lowRange }) {
    state.lowRange = lowRange;

    // Geri vites: neredeyse duruyorken frene basmak geri viteste sürüşe geçirir.
    if (!state.reverse && brake > 0.5 && forwardSpeed < 0.6) {
      state.reverse = true;
      state.gear = 0;
    } else if (state.reverse && throttle > 0.5 && forwardSpeed > -0.6) {
      state.reverse = false;
    }

    const ratio = totalRatio();
    const engineOmega = Math.abs(wheelOmega * ratio);
    const rawRpm = (engineOmega * 60) / (Math.PI * 2);
    state.rpm = clamp(rawRpm, cfg.idleRpm, cfg.maxRpm + 250);

    // Volan ataleti. Vites boştayken (tork kesikken) motor serbest kalır ve
    // gaz bırakılmışsa devir hızla düşer — vites değişiminin duyulan imzası bu.
    const follow = state.shiftTimer > 0 ? 3.2 : 14;
    state.smoothRpm += (state.rpm - state.smoothRpm) * Math.min(1, follow * dt);

    if (state.shiftTimer > 0) {
      state.shiftTimer -= dt;
      state.driveTorque = 0;
      return state;
    }

    if (!state.reverse) {
      if (state.rpm > cfg.shiftUpRpm && state.gear < cfg.gearRatios.length - 1 && throttle > 0.1) {
        state.gear++;
        state.shiftTimer = 0.28;
        state.shiftEvent = 1;
      } else if (state.rpm < cfg.shiftDownRpm && state.gear > 0) {
        state.gear--;
        state.shiftTimer = 0.18;
        state.shiftEvent = -1;
      }
    }

    // Devir kesici: sınırın üstünde tork tamamen kesilir. Olmadığında, havada
    // boşta dönen tekerlekler motoru sonsuza kadar hızlandırıyordu.
    const limiter = rawRpm > cfg.maxRpm ? 0 : 1;
    const engineTorque = torqueAt(state.rpm) * throttle * limiter;
    // Gaz kesikken motor freni: yokuş aşağı serbest bırakınca araç hızlanmasın.
    const braking = (1 - throttle) * cfg.engineBraking * (state.rpm / 1000);

    state.load = throttle;
    // Aktarma verimi ve `ratio`nun işareti (geri viteste negatif) korunuyor.
    state.driveTorque = (engineTorque - braking) * ratio * 0.92;
    return state;
  }

  function reset() {
    state.rpm = cfg.idleRpm;
    state.smoothRpm = cfg.idleRpm;
    state.gear = 0;
    state.reverse = false;
    state.shiftTimer = 0;
    state.shiftEvent = 0;
    state.driveTorque = 0;
  }

  return {
    state,
    update,
    reset,
    torqueAt,
    /** Vites değişimi olayını okur ve sıfırlar (ses ve kamera tepkisi için). */
    consumeShift() {
      const event = state.shiftEvent;
      state.shiftEvent = 0;
      return event;
    },
    get gearLabel() {
      if (state.reverse) return 'R';
      return String(state.gear + 1);
    },
  };
}
