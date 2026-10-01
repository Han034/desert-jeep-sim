import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, smoothstep } from '../utils/math.js';

/**
 * Kamera. Üç mod: takip, kaput ve kokpit.
 *
 * Takip kamerası aracın quaternion'unu değil, yalnız **yönünü** (yatay
 * bileşenini) izler. Tam quaternion'u izlemek, araç kum tepesinde yalpalarken
 * ufku da yalpalatır ve birkaç saniyede mide bulandırır. Yalpa yerine küçük,
 * kontrollü bir yatış eklenir — hareket hissi kalır, ufuk yerinde durur.
 */

const MODES = ['takip', 'kaput', 'kokpit'];

export function createCameraRig({ camera, heightfield }) {
  let modeIndex = 0;

  const desired = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();
  const smoothedLook = new THREE.Vector3();
  const flatForward = new THREE.Vector3();
  const flatRight = new THREE.Vector3();
  const _v = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _q = new THREE.Quaternion();

  let initialised = false;
  let shake = 0;
  let bank = 0;
  let fov = camera.fov;
  /** Kısa süreli görüş açısı sıçraması: vites, çarpma, sert iniş. */
  let fovKick = 0;
  /** Savrulurken kameranın yana kayma miktarı — yumuşatılmış. */
  let lateralLead = 0;

  function cycle() {
    modeIndex = (modeIndex + 1) % MODES.length;
    initialised = false;
    return MODES[modeIndex];
  }

  function update(dt, vehicle, weather) {
    const state = vehicle.state;

    flatForward.set(0, 0, -1).applyQuaternion(state.quaternion);
    flatForward.y = 0;
    if (flatForward.lengthSq() < 1e-5) flatForward.set(0, 0, -1);
    flatForward.normalize();
    flatRight.set(flatForward.z, 0, -flatForward.x);

    _up.set(0, 1, 0).applyQuaternion(state.quaternion);

    const speed = state.speed;
    const speedT = clamp01(speed / 32);

    if (MODES[modeIndex] === 'takip') {
      updateChase(dt, state, speed, speedT);
    } else {
      updateAttached(dt, state, speedT);
    }

    // Sarsıntı: hız, zemin sertliği ve süspansiyon hareketiyle birlikte artar.
    const suspensionActivity = vehicle.wheels.reduce(
      (sum, w) => sum + Math.abs(w.compression - w.prevCompression),
      0
    );
    const impactShake = clamp(suspensionActivity * 26, 0, 1.4);
    shake = Math.max(shake * Math.exp(-6 * dt), impactShake * (0.25 + speedT * 0.75));
    if (state.airborne) shake *= 0.35;

    if (shake > 0.002) {
      const t = performance.now() * 0.001;
      const amp = shake * 0.045;
      camera.position.x += Math.sin(t * 47.3) * amp;
      camera.position.y += Math.sin(t * 39.1 + 1.7) * amp;
      camera.position.z += Math.sin(t * 53.7 + 3.1) * amp;
    }

    // Hızla açılan görüş açısı: sürat hissini kameranın kendisi taşır.
    // Üstüne binen `fovKick`, vites ve çarpmalarda tek karelik değil, kısa ama
    // fark edilir bir itiş: sürüşün olayları kamerada da duyulmalı.
    fovKick *= Math.exp(-7 * dt);
    const targetFov =
      (MODES[modeIndex] === 'takip' ? 58 + speedT * 15 : 66 + speedT * 10) + fovKick;
    fov = damp(fov, targetFov, 3, dt);
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }

    // Kamera hiçbir zaman kumun altına girmesin.
    const ground = heightfield.sampleHeight(camera.position.x, camera.position.z);
    if (camera.position.y < ground + 0.9) camera.position.y = ground + 0.9;

    // Fırtınada görüş daralır, kamera araca yaklaşır.
    void weather;
  }

  function updateChase(dt, state, speed, speedT) {
    const distance = lerp(7.2, 9.4, speedT);
    const height = lerp(3.1, 3.9, speedT);

    /**
     * Savrulurken kamera yana kayar. Araç yan gidiyorken kamerayı burnun tam
     * arkasında tutmak, drift'i ekranda bir şeyin *olmadığı* an gibi
     * gösteriyordu: gövde dönüyor ama kadraj kıpırdamıyor. Yanal hıza bağlı
     * küçük bir kayma, aynı anı seyredilebilir hale getiriyor.
     */
    const lateral = state.velocity.dot(flatRight);
    lateralLead = damp(lateralLead, clamp(lateral * 0.16, -2.6, 2.6), 3.5, dt);

    desired
      .copy(state.position)
      .addScaledVector(flatForward, -distance)
      .addScaledVector(flatRight, lateralLead)
      .add(_v.set(0, height, 0));

    // Yüksek hızda kamera daha sıkı takip eder; yavaşta yumuşak süzülür.
    const follow = lerp(3.4, 7.5, speedT);
    if (!initialised) {
      camera.position.copy(desired);
      smoothedLook.copy(state.position);
      initialised = true;
    } else {
      camera.position.x = damp(camera.position.x, desired.x, follow, dt);
      camera.position.y = damp(camera.position.y, desired.y, follow * 0.8, dt);
      camera.position.z = damp(camera.position.z, desired.z, follow, dt);
    }

    // Bakış noktası aracın biraz önünde: virajda yol görünür kalır.
    lookTarget
      .copy(state.position)
      .addScaledVector(flatForward, 3.2 + speedT * 4.5)
      .add(_v.set(0, 1.05, 0));
    smoothedLook.x = damp(smoothedLook.x, lookTarget.x, 6, dt);
    smoothedLook.y = damp(smoothedLook.y, lookTarget.y, 5, dt);
    smoothedLook.z = damp(smoothedLook.z, lookTarget.z, 6, dt);

    camera.lookAt(smoothedLook);

    // Aracın yatışının küçük bir payı kameraya yansır.
    const roll = Math.asin(clamp(_up.dot(flatRight), -1, 1));
    bank = damp(bank, roll * 0.28 - state.velocity.dot(flatRight) * 0.006, 5, dt);
    camera.rotateZ(bank);

    void speed;
  }

  /** Kaput ve kokpit: araca sabit, sadece minik bir gecikmeyle. */
  function updateAttached(dt, state, speedT) {
    const isHood = MODES[modeIndex] === 'kaput';
    const offset = isHood
      ? _v.set(0, 0.42, -1.35)
      : _v.set(-0.36, 0.55, -0.28);

    desired.copy(offset).applyQuaternion(state.quaternion).add(state.position);

    if (!initialised) {
      camera.position.copy(desired);
      initialised = true;
    } else {
      const k = 24;
      camera.position.x = damp(camera.position.x, desired.x, k, dt);
      camera.position.y = damp(camera.position.y, desired.y, k, dt);
      camera.position.z = damp(camera.position.z, desired.z, k, dt);
    }

    _q.copy(state.quaternion);
    camera.quaternion.slerp(_q, 1 - Math.exp(-18 * dt));
    // Hızlanırken burun hafifçe yukarı kalkar.
    camera.rotateX(smoothstep(0, 1, speedT) * -0.03);
  }

  return {
    update,
    cycle,
    /**
     * Dışarıdan gelen olay: vites, çarpma, sert iniş. Sarsıntı ve görüş açısı
     * birlikte itiliyor — ikisi ayrı ayrı fark edilmiyor, birlikte "bir şey
     * oldu" hissi veriyor.
     */
    kick(strength, fovAmount = 0) {
      shake = Math.max(shake, strength);
      fovKick = Math.max(fovKick, fovAmount);
    },
    get mode() {
      return MODES[modeIndex];
    },
    setMode(name) {
      const index = MODES.indexOf(name);
      if (index >= 0) {
        modeIndex = index;
        initialised = false;
      }
    },
    reset() {
      initialised = false;
    },
    modes: MODES,
  };
}
