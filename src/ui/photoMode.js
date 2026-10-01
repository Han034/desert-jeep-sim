import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * Fotoğraf modu: simülasyon durur, kamera serbest kalır, arayüz gizlenir.
 *
 * Kayıt, ekran görüntüsü almak yerine sahneyi geçici olarak 2× çözünürlükte
 * yeniden çizip alıyor: bıraktığın izlerin diş desenine kadar okunduğu bir
 * kare çıkıyor, ekranda gördüğünden daha keskin.
 */
export function createPhotoMode(root, { context, camera, vehicle, hud, panel, weather, onWeatherChange }) {
  const element = document.createElement('div');
  element.className = 'photo hidden';
  element.innerHTML = `
    <div class="photo-bar">
      <div class="photo-title">Fotoğraf modu</div>

      <label class="photo-row">
        <span>Görüş açısı <b class="v-fov">45°</b></span>
        <input class="photo-slider s-fov" type="range" min="14" max="95" step="1" value="45">
      </label>

      <label class="photo-row">
        <span>Saat <b class="v-time">17:20</b></span>
        <input class="photo-slider s-time" type="range" min="0" max="24" step="0.05" value="17.35">
      </label>

      <label class="photo-row">
        <span>Kum fırtınası <b class="v-storm">%0</b></span>
        <input class="photo-slider s-storm" type="range" min="0" max="1" step="0.01" value="0">
      </label>

      <label class="photo-row photo-row-inline">
        <input class="s-grid" type="checkbox"> <span>Üçler kuralı ızgarası</span>
      </label>

      <div class="photo-actions">
        <button class="photo-button b-shot">PNG kaydet (2×)</button>
        <button class="photo-button b-exit">Çık (P)</button>
      </div>

      <div class="photo-hint">Sürükle: döndür · Tekerlek: yakınlaş · Sağ tık: kaydır</div>
    </div>
    <div class="photo-grid hidden"></div>
  `;
  root.appendChild(element);

  const controls = new OrbitControls(camera, context.renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 1.5;
  controls.maxDistance = 260;
  controls.enabled = false;

  const fovSlider = element.querySelector('.s-fov');
  const timeSlider = element.querySelector('.s-time');
  const stormSlider = element.querySelector('.s-storm');
  const gridToggle = element.querySelector('.s-grid');
  const gridOverlay = element.querySelector('.photo-grid');
  const fovValue = element.querySelector('.v-fov');
  const timeValue = element.querySelector('.v-time');
  const stormValue = element.querySelector('.v-storm');

  let active = false;
  let savedFov = camera.fov;
  const savedPosition = new THREE.Vector3();
  const savedQuaternion = new THREE.Quaternion();

  fovSlider.addEventListener('input', () => {
    camera.fov = parseFloat(fovSlider.value);
    camera.updateProjectionMatrix();
    fovValue.textContent = `${fovSlider.value}°`;
  });

  timeSlider.addEventListener('input', () => {
    weather.setTimeOfDay(parseFloat(timeSlider.value));
    timeValue.textContent = formatTime(weather.state.timeOfDay);
    onWeatherChange();
  });

  stormSlider.addEventListener('input', () => {
    weather.setStorm(parseFloat(stormSlider.value));
    stormValue.textContent = `%${Math.round(weather.state.storm * 100)}`;
    onWeatherChange();
  });

  gridToggle.addEventListener('change', () => {
    gridOverlay.classList.toggle('hidden', !gridToggle.checked);
  });

  element.querySelector('.b-exit').addEventListener('click', () => toggle(false));
  element.querySelector('.b-shot').addEventListener('click', capture);

  function capture() {
    // Arayüz canvas'ın üstünde ayrı bir DOM katmanı olduğu için karede
    // görünmüyor; gizlemeye gerek yok.
    const dataUrl = context.captureFrame(2);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    link.download = `col-jip-${stamp}.png`;
    link.href = dataUrl;
    link.click();
  }

  function toggle(force) {
    const next = force === undefined ? !active : force;
    if (next === active) return;
    active = next;

    element.classList.toggle('hidden', !active);
    hud.setVisible(!active);
    panel.setVisible(!active);
    controls.enabled = active;

    if (active) {
      savedFov = camera.fov;
      savedPosition.copy(camera.position);
      savedQuaternion.copy(camera.quaternion);

      // Yörünge merkezi araç: fotoğraf modu neredeyse her zaman aracın ve
      // izlerinin etrafında dönmek için açılıyor.
      controls.target.copy(vehicle.state.position);
      controls.update();

      fovSlider.value = String(Math.round(camera.fov));
      fovValue.textContent = `${Math.round(camera.fov)}°`;
      timeSlider.value = String(weather.state.timeOfDay);
      timeValue.textContent = formatTime(weather.state.timeOfDay);
      stormSlider.value = String(weather.state.storm);
      stormValue.textContent = `%${Math.round(weather.state.storm * 100)}`;
    } else {
      camera.fov = savedFov;
      camera.position.copy(savedPosition);
      camera.quaternion.copy(savedQuaternion);
      camera.updateProjectionMatrix();
      gridOverlay.classList.add('hidden');
      gridToggle.checked = false;
    }
  }

  function update() {
    if (active) controls.update();
  }

  function formatTime(hours) {
    const h = Math.floor(hours) % 24;
    const m = Math.floor((hours - Math.floor(hours)) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  return {
    element,
    toggle,
    update,
    capture,
    get active() {
      return active;
    },
  };
}
