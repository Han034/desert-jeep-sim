import { VEHICLE } from '../config/settings.js';
import { clamp, clamp01 } from '../utils/math.js';

/**
 * Prosedürel araç sesi.
 *
 * Ses dosyası yok: her şey WebAudio ile sentezleniyor. Bunun sebebi indirme
 * boyutu değil **sürekli değişkenlik** — kayıttan çalınan bir motor sesi devir
 * aralığında ya hızlandırılıyor (ciyaklama) ya da çapraz karıştırılıyor
 * (nefes nefese geçişler). Sentezde devir doğrudan frekans, yük doğrudan
 * filtre kesim noktası; ikisi de kesintisiz.
 *
 * Sinyal zinciri:
 *
 *  - **motor** — ana harmonik + iki üst harmonik + hafif detune'lu ikizi.
 *    Yükle açılan alçak geçiren filtre, gaz kesikken sesi boğuyor.
 *  - **patinaj** — bant geçiren gürültü, lastik kaymasıyla açılıyor.
 *    Merkez frekansı zemine göre kayıyor: kumda boğuk bir hışırtı, karda ince.
 *  - **yuvarlanma** — alçak geçiren gürültü, hızla ve zemin pürüzüyle.
 *  - **rüzgâr** — yüksek geçiren gürültü, hızın karesiyle.
 *  - **darbe** — tek atımlı gürültü zarfı.
 *
 * Tarayıcılar ses bağlamını kullanıcı etkileşimi olmadan başlatmıyor; bu
 * yüzden ilk tuş ya da tıklamada `resume()` çağrılıyor.
 */

/** Motorun temel frekansı: devir başına ateşleme sayısı (altı silindir, dört zamanlı). */
const FIRING_PER_REV = 3;

export function createAudio({ enabled = true, volume = 0.7 } = {}) {
  let ctx = null;
  let nodes = null;
  let started = false;
  const settings = { enabled, volume };

  /** Sekme arka plana geçince ses de sussun. */
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend();
    else if (settings.enabled) ctx.resume();
  });

  function start() {
    if (started || !settings.enabled) return;
    started = true;

    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return;
    ctx = new AudioCtor();
    nodes = buildGraph(ctx, settings.volume);
    ctx.resume();
  }

  /** İlk kullanıcı etkileşiminde bağlamı aç. */
  function attachUnlock(target = window) {
    const unlock = () => {
      start();
      ctx?.resume();
      target.removeEventListener('pointerdown', unlock);
      target.removeEventListener('keydown', unlock);
    };
    target.addEventListener('pointerdown', unlock);
    target.addEventListener('keydown', unlock);
  }

  const smooth = { skid: 0, roll: 0, wind: 0 };

  function update(dt, { vehicle, weather, surface, muted = false }) {
    if (!ctx || !nodes) return;
    const now = ctx.currentTime;
    const glide = 0.05;

    const drivetrain = vehicle.drivetrain.state;
    const rpm = drivetrain.smoothRpm;
    const speed = vehicle.state.speed;

    // --- motor -------------------------------------------------------------
    const base = (rpm / 60) * FIRING_PER_REV;
    nodes.engineOsc.frequency.setTargetAtTime(base, now, glide);
    nodes.engineOsc2.frequency.setTargetAtTime(base, now, glide);
    nodes.engineOsc3.frequency.setTargetAtTime(base * 2, now, glide);

    const load = clamp01(drivetrain.load);
    const rev = clamp01((rpm - 800) / (VEHICLE.engine.maxRpm - 800));

    // Yük açıldıkça filtre açılıyor: gaz kesikken motor uzakta ve boğuk,
    // tam gazda sert ve harmoniklerle dolu. Taban 320 Hz'den 520'ye çıkarıldı —
    // daha aşağıda rölanti, tonu olmayan bir uğultuya dönüşüyordu.
    nodes.engineFilter.frequency.setTargetAtTime(520 + load * 2400 + rev * 1600, now, 0.08);
    nodes.engineFilter.Q.setTargetAtTime(0.9 + load * 2.2, now, 0.1);

    // Gövde rezonansı devirle birlikte kayıyor: sesin "tok" bileşeni bu.
    nodes.bodyPeak.frequency.setTargetAtTime(clamp(base * 2.6, 90, 320), now, 0.1);

    // Doyum yalnız yükle geliyor — rölantide temiz, gazda hırıltılı.
    nodes.driveGain.gain.setTargetAtTime(1 + load * 2.6 + rev * 0.8, now, 0.08);

    // Üst harmonik yükle açılıyor; rölantide kapalı kalması, sesin ince
    // çıkmasını engelliyor.
    nodes.upperGain.gain.setTargetAtTime(0.08 + load * 0.3, now, 0.1);

    const shifting = drivetrain.shiftTimer > 0 ? 0.45 : 1;
    const engineGain = muted ? 0 : (0.03 + load * 0.075 + rev * 0.03) * shifting;
    nodes.engineGain.gain.setTargetAtTime(engineGain, now, 0.05);

    // --- lastik ------------------------------------------------------------
    let slide = 0;
    let grounded = 0;
    for (const w of vehicle.wheels) {
      if (!w.grounded) continue;
      grounded++;
      slide = Math.max(slide, Math.max(w.slide, w.spin));
    }
    const contact = grounded / 4;

    const ground = surface
      ? surface(vehicle.state.position.x, vehicle.state.position.z)
      : { peakGrip: 1, trackDepth: 1 };

    smooth.skid += (slide * contact - smooth.skid) * Math.min(1, dt * 9);
    // Sert zeminde cıyaklama, kumda hışırtı: merkez frekansı tutuşla yükseliyor.
    nodes.skidFilter.frequency.setTargetAtTime(
      900 + clamp(ground.peakGrip, 0.4, 1.6) * 900,
      now,
      0.15
    );
    nodes.skidGain.gain.setTargetAtTime(
      muted ? 0 : Math.max(0, smooth.skid - 0.12) * 0.28,
      now,
      0.06
    );

    const rollTarget = clamp01(speed / 22) * contact;
    smooth.roll += (rollTarget - smooth.roll) * Math.min(1, dt * 6);
    nodes.rollFilter.frequency.setTargetAtTime(180 + speed * 14, now, 0.12);
    nodes.rollGain.gain.setTargetAtTime(muted ? 0 : smooth.roll * 0.14, now, 0.08);

    // --- rüzgâr ------------------------------------------------------------
    // Fırtına şiddetine bağlı, **taban rüzgâr hızına değil**: `windSpeed` sakin
    // havada bile 3.5 m/s ve buradan gelen sabit tıslama, araç dururken de
    // duyulan bir fon gürültüsü bırakıyordu.
    const stormWind = weather ? weather.state.storm * 0.5 : 0;
    const windTarget = clamp01((speed - 6) / 26) ** 2 + stormWind;
    smooth.wind += (windTarget - smooth.wind) * Math.min(1, dt * 4);
    nodes.windGain.gain.setTargetAtTime(muted ? 0 : smooth.wind * 0.1, now, 0.12);
  }

  /** Kısa gürültü patlaması — çarpma ve sert iniş. */
  function impact(strength) {
    if (!ctx || !nodes) return;
    const now = ctx.currentTime;
    const amount = clamp01(strength / 12);
    nodes.impactGain.gain.cancelScheduledValues(now);
    nodes.impactGain.gain.setValueAtTime(amount * 0.5, now);
    nodes.impactGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18 + amount * 0.3);
    nodes.impactFilter.frequency.setValueAtTime(160 + amount * 500, now);
  }

  /** Vites değişiminin kısa mekanik tıkırtısı. */
  function shift(direction) {
    if (!ctx || !nodes) return;
    const now = ctx.currentTime;
    nodes.impactGain.gain.cancelScheduledValues(now);
    nodes.impactGain.gain.setValueAtTime(0.07, now);
    nodes.impactGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    nodes.impactFilter.frequency.setValueAtTime(direction > 0 ? 1400 : 900, now);
  }

  function setEnabled(value) {
    settings.enabled = value;
    if (!value) {
      ctx?.suspend();
    } else {
      start();
      ctx?.resume();
    }
  }

  function setVolume(value) {
    settings.volume = value;
    if (nodes) nodes.master.gain.setTargetAtTime(value, ctx.currentTime, 0.05);
  }

  function dispose() {
    ctx?.close();
    ctx = null;
    nodes = null;
  }

  return {
    settings,
    start,
    attachUnlock,
    update,
    impact,
    shift,
    setEnabled,
    setVolume,
    dispose,
    get running() {
      return ctx?.state === 'running';
    },
    /** Hata ayıklama: spektrumu ölçmek için ham düğümler. */
    get context() {
      return ctx;
    },
    get nodes() {
      return nodes;
    },
  };
}

function buildGraph(ctx, volume) {
  const master = ctx.createGain();
  master.gain.value = volume;

  /**
   * Duyulamayan altı kes.
   *
   * Motorun temel frekansı rölantide (850 d/dak, altı silindir) 42 Hz'e
   * düşüyor. O bölgede kulak neredeyse hiçbir şey duymuyor ama hoparlör
   * çalışıyor: sonuç, devirden bağımsız gibi duyulan sürekli bir uğultuydu.
   * Temel frekansı susturmak tınıyı bozmuyor — motorun karakterini üst
   * harmonikler taşıyor.
   */
  const rumbleCut = ctx.createBiquadFilter();
  rumbleCut.type = 'highpass';
  rumbleCut.frequency.value = 58;
  rumbleCut.Q.value = 0.7;

  // Yumuşak sınırlayıcı: dört kanal aynı anda tepeye çıkarsa kırpma yerine
  // sıkışsın.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 12;
  limiter.ratio.value = 8;
  limiter.attack.value = 0.004;
  limiter.release.value = 0.16;
  master.connect(rumbleCut).connect(limiter).connect(ctx.destination);

  // --- gürültü kaynağı (paylaşımlı) ----------------------------------------
  const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;
  noise.loop = true;
  noise.start();

  // --- motor ---------------------------------------------------------------
  /**
   * Zincir: iki osilatör → sürüş kazancı → doyum → alçak geçiren → gövde
   * rezonansı → ana kazanç.
   *
   * "Tok" bir motor sesinin üç bileşeni var ve üçü de burada:
   *  - **harmonik yoğunluk** — testere dişi yerine, alt harmonikleri güçlü
   *    tutan özel bir dalga tablosu; testere dişi bütün harmonikleri 1/n ile
   *    zayıflattığı için ince ve vızıltılı çıkıyordu.
   *  - **doyum** — yükle sürülen yumuşak kırpma. Gerçek egzoz gürültüsünün
   *    hırıltısı, doğrusal olmayan bu davranıştan geliyor.
   *  - **gövde rezonansı** — devirle kayan bir tepe filtre. Ses kutusu etkisi;
   *    onsuz motor "açık havada" ve cılız duyuluyor.
   */
  const engineGain = ctx.createGain();
  engineGain.gain.value = 0;

  const bodyPeak = ctx.createBiquadFilter();
  bodyPeak.type = 'peaking';
  bodyPeak.frequency.value = 160;
  bodyPeak.Q.value = 1.1;
  bodyPeak.gain.value = 7.5;

  const engineFilter = ctx.createBiquadFilter();
  engineFilter.type = 'lowpass';
  engineFilter.frequency.value = 600;

  const shaper = ctx.createWaveShaper();
  shaper.curve = makeSaturationCurve();
  shaper.oversample = '2x';

  const driveGain = ctx.createGain();
  driveGain.gain.value = 1;

  driveGain.connect(shaper).connect(engineFilter).connect(bodyPeak).connect(engineGain);
  engineGain.connect(master);

  const wave = makeEngineWave(ctx);
  const engineOsc = ctx.createOscillator();
  engineOsc.setPeriodicWave(wave);
  const engineOsc2 = ctx.createOscillator();
  engineOsc2.setPeriodicWave(wave);
  // Hafif detune: iki ses tam aynı frekansta olduğunda org borusu gibi temiz
  // çıkıyor ve motorun düzensizliği kayboluyor.
  engineOsc2.detune.value = -11;
  const engineOsc3 = ctx.createOscillator();
  engineOsc3.type = 'sawtooth';
  engineOsc3.detune.value = 9;

  const twin = ctx.createGain();
  twin.gain.value = 0.6;
  const upperGain = ctx.createGain();
  upperGain.gain.value = 0.1;

  engineOsc.connect(driveGain);
  engineOsc2.connect(twin).connect(driveGain);
  engineOsc3.connect(upperGain).connect(driveGain);
  engineOsc.start();
  engineOsc2.start();
  engineOsc3.start();

  // --- patinaj -------------------------------------------------------------
  const skidFilter = ctx.createBiquadFilter();
  skidFilter.type = 'bandpass';
  skidFilter.frequency.value = 1600;
  skidFilter.Q.value = 4.5;
  const skidGain = ctx.createGain();
  skidGain.gain.value = 0;
  noise.connect(skidFilter).connect(skidGain).connect(master);

  // --- yuvarlanma ----------------------------------------------------------
  const rollFilter = ctx.createBiquadFilter();
  rollFilter.type = 'lowpass';
  rollFilter.frequency.value = 300;
  const rollGain = ctx.createGain();
  rollGain.gain.value = 0;
  noise.connect(rollFilter).connect(rollGain).connect(master);

  // --- rüzgâr --------------------------------------------------------------
  const windFilter = ctx.createBiquadFilter();
  windFilter.type = 'highpass';
  windFilter.frequency.value = 700;
  const windGain = ctx.createGain();
  windGain.gain.value = 0;
  noise.connect(windFilter).connect(windGain).connect(master);

  // --- darbe ---------------------------------------------------------------
  const impactFilter = ctx.createBiquadFilter();
  impactFilter.type = 'lowpass';
  impactFilter.frequency.value = 300;
  const impactGain = ctx.createGain();
  impactGain.gain.value = 0;
  noise.connect(impactFilter).connect(impactGain).connect(master);

  return {
    master,
    engineOsc,
    engineOsc2,
    engineOsc3,
    engineGain,
    engineFilter,
    bodyPeak,
    driveGain,
    upperGain,
    skidFilter,
    skidGain,
    rollFilter,
    rollGain,
    windGain,
    impactGain,
    impactFilter,
  };
}

/**
 * Motorun dalga tablosu. Alt harmonikler kasten güçlü: testere dişi bütün
 * harmonikleri 1/n ile zayıflatıyor ve sonuç ince, vızıltılı bir ton oluyor.
 * Buradaki seri 2. ve 3. harmoniği öne çıkarıp gövdeyi kalınlaştırıyor,
 * yukarısını hızla söndürüyor.
 */
function makeEngineWave(ctx) {
  const amps = [0, 1, 0.86, 0.72, 0.46, 0.3, 0.22, 0.15, 0.1, 0.07, 0.05, 0.035];
  const real = new Float32Array(amps.length);
  const imag = new Float32Array(amps);
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

/** Yumuşak kırpma eğrisi — egzozun hırıltısı bu doğrusalsızlıktan geliyor. */
function makeSaturationCurve(samples = 1024) {
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 1.6);
  }
  return curve;
}
