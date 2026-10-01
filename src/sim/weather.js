import * as THREE from 'three';
import { WORLD } from '../config/settings.js';
import { clamp, clamp01, lerp, smoothstep } from '../utils/math.js';

/**
 * Günün saati ve hava durumu. Sahnedeki ışık, gökyüzü, sis, kum fırtınası ve
 * izlerin rüzgârla silinme hızı tek bir yerden sürülüyor: saati değiştirmek
 * hepsini birden tutarlı biçimde kaydırır.
 *
 * Güneşin konumu için tam bir astronomi modeli yerine, gün doğumu/batımı ve
 * en yüksek açı üzerinden ayarlanabilen bir yaklaşım kullanılıyor — amaç
 * doğruluk değil, saat kaydırıcısının her noktasında güzel bir ışık.
 */

const SUNRISE = 5.7;
const SUNSET = 18.7;
const MAX_ELEVATION = 76;

/** Güneş yüksekliğine (derece) göre renk/şiddet rampaları. */
const SUN_RAMP = [
  { e: -14, color: 0x000000, intensity: 0.0 },
  { e: -6, color: 0x2b3358, intensity: 0.05 },
  { e: -1.5, color: 0xff5a24, intensity: 0.35 },
  { e: 3, color: 0xff8a3d, intensity: 1.7 },
  { e: 9, color: 0xffa858, intensity: 3.0 },
  { e: 20, color: 0xffcd92, intensity: 4.1 },
  { e: 42, color: 0xffeccb, intensity: 4.9 },
  { e: 80, color: 0xfffaf0, intensity: 5.4 },
];

/** Ufuk / sis rengi. */
const HAZE_RAMP = [
  { e: -14, color: 0x070a14 },
  { e: -6, color: 0x1b2136 },
  { e: -1.5, color: 0x6d4a4a },
  { e: 3, color: 0xd08a5c },
  { e: 9, color: 0xe0a878 },
  { e: 20, color: 0xdcb894 },
  { e: 42, color: 0xd6c4a8 },
  { e: 80, color: 0xd8cdb6 },
];

/**
 * Gökten gelen dolaylı ışık.
 *
 * Güneş/gök oranı yaklaşık 4:1 tutuluyor. Bu oran, arazi kendi gölgesini
 * düşürmeye başlayınca kritik hale geldi: gölgeye giren yüzeyin aldığı tek
 * ışık bu. Daha düşük bir gök ışığıyla gölgeler simsiyah lekelere dönüşüyor,
 * daha yükseğiyle de tepelerin hacmi siliniyor.
 *
 * Renk soğuk: sıcak güneş + soğuk gölge, altın saatin en tanınabilir imzası.
 */
const SKY_RAMP = [
  // Gecede sıfıra inmiyor: ay ve yıldız ışığı, tepelerin hatlarını
  // seçebilecek kadar aydınlatır. Tam karanlık, farların dışında hiçbir şeyin
  // görünmediği kullanılamaz bir sahne demek.
  { e: -14, color: 0x6d86c4, intensity: 0.2 },
  { e: -6, color: 0x7189c4, intensity: 0.28 },
  { e: -1.5, color: 0x8a86a8, intensity: 0.5 },
  { e: 3, color: 0x8b90bd, intensity: 0.78 },
  { e: 9, color: 0x9fb0d4, intensity: 0.98 },
  { e: 20, color: 0xa8c0e4, intensity: 1.15 },
  { e: 80, color: 0xb6cdf0, intensity: 1.3 },
];

function sampleRamp(ramp, elevation, outColor) {
  let i = 0;
  while (i < ramp.length - 2 && elevation > ramp[i + 1].e) i++;
  const a = ramp[i];
  const b = ramp[i + 1];
  const t = clamp01((elevation - a.e) / (b.e - a.e));
  outColor.setHex(a.color).lerp(_tmpColor.setHex(b.color), t);
  const intensity =
    a.intensity !== undefined ? lerp(a.intensity, b.intensity, t) : undefined;
  return intensity;
}

const _tmpColor = new THREE.Color();

export function createWeather() {
  const state = {
    /** Saat (0-24). Varsayılan: güneşin ~15°'de olduğu altın saat. */
    timeOfDay: 17.9,
    /** Saatin kendi kendine akma hızı (gerçek saniye başına oyun saati). */
    timeSpeed: 0,
    /** Kum fırtınası şiddeti 0-1. */
    storm: 0,
    /** Farlar açık mı (gece otomatik açılır). */
    headlights: false,
    headlightsAuto: true,
  };

  const sunDirection = new THREE.Vector3();
  const sunColor = new THREE.Color();
  const skyColor = new THREE.Color();
  const hazeColor = new THREE.Color();
  const groundColor = new THREE.Color(0x6b4d2c);
  const windDir = new THREE.Vector2(Math.cos(WORLD.windAngle), Math.sin(WORLD.windAngle));

  const derived = {
    elevation: 0,
    sunIntensity: 0,
    skyIntensity: 0,
    fogDensity: 0,
    /** İzlerin rüzgârla silinme hızı çarpanı. */
    erosion: 1,
    /** Havada asılı kum yoğunluğu (parçacık sistemleri okur). */
    airborneSand: 0,
    /** Ekrana inen kum perdesinin gücü (post-process okur). */
    stormVeil: 0,
    /** Rüzgâr hızı (m/s) — kum püskürtmesini ve savrulan kumu sürükler. */
    windSpeed: 3.5,
    isNight: false,
  };

  function recompute() {
    const t = state.timeOfDay;
    const phase = (t - SUNRISE) / (SUNSET - SUNRISE);
    const elevationDeg = Math.sin(Math.PI * phase) * MAX_ELEVATION;
    const azimuthDeg = 96 + ((t - 12) / 12) * 158;

    derived.elevation = elevationDeg;
    derived.isNight = elevationDeg < -2;

    const el = THREE.MathUtils.degToRad(elevationDeg);
    const az = THREE.MathUtils.degToRad(azimuthDeg);
    sunDirection.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));

    derived.sunIntensity = sampleRamp(SUN_RAMP, elevationDeg, sunColor);
    derived.skyIntensity = sampleRamp(SKY_RAMP, elevationDeg, skyColor);
    sampleRamp(HAZE_RAMP, elevationDeg, hazeColor);

    const storm = clamp01(state.storm);

    // Fırtına güneşi boğar, gökyüzünü kum rengine boyar.
    derived.sunIntensity *= lerp(1, 0.22, storm);
    derived.skyIntensity *= lerp(1, 0.75, storm);
    sunColor.lerp(_tmpColor.setHex(0xc98b4a), storm * 0.7);
    hazeColor.lerp(_tmpColor.setHex(0xb07a44), storm * 0.85);
    skyColor.lerp(_tmpColor.setHex(0xa87c50), storm * 0.6);

    // Berrak çölde bile ufuk ısı buğusuyla dolar; tam fırtınada görüş ~60 m.
    const clearDensity = lerp(0.00125, 0.00092, smoothstep(0, 30, elevationDeg));
    derived.fogDensity = lerp(clearDensity, 0.042, storm * storm);

    derived.windSpeed = lerp(3.5, 28, storm);
    derived.erosion = lerp(1, 14, storm * storm);
    derived.airborneSand = storm;
    /** Ekran boyu kum perdesinin yoğunluğu. */
    derived.stormVeil = storm * storm * 0.62;

    if (state.headlightsAuto) {
      state.headlights = elevationDeg < 4;
    }
  }

  function update(dt) {
    if (state.timeSpeed !== 0) {
      state.timeOfDay = (state.timeOfDay + state.timeSpeed * dt) % 24;
      if (state.timeOfDay < 0) state.timeOfDay += 24;
    }
    recompute();
  }

  recompute();

  return {
    state,
    derived,
    sunDirection,
    sunColor,
    skyColor,
    hazeColor,
    groundColor,
    windDir,
    update,
    recompute,
    setTimeOfDay(hours) {
      state.timeOfDay = clamp(hours, 0, 24);
      recompute();
    },
    setStorm(value) {
      state.storm = clamp01(value);
      recompute();
    },
    toggleHeadlights() {
      state.headlightsAuto = false;
      state.headlights = !state.headlights;
    },
  };
}
