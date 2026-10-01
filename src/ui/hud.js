import * as THREE from 'three';
import { WORLD } from '../config/settings.js';
import { BIOMES } from '../config/biomes.js';
import { clamp, clamp01 } from '../utils/math.js';

/**
 * Sürüş göstergeleri ve mini-harita.
 *
 * Mini-harita, iz sisteminin CPU ikizinden (rut ızgarası) çiziliyor: ayrıca
 * bir yol kaydı tutmaya gerek yok, bıraktığın izler zaten orada duruyor.
 * Izgara 1 MB'lık bir `Uint8Array`; her karede değil saniyede ~12 kez
 * taranıyor, çünkü izler o hızda görünür biçimde değişmiyor.
 */

const MINIMAP_SIZE = 152;
const MINIMAP_INTERVAL = 1 / 12;

export function createHud(root, { rutfield, vehicle, heightfield }) {
  const element = document.createElement('div');
  element.className = 'hud';
  element.innerHTML = `
    <div class="hud-gauge">
      <div class="hud-speed">
        <span class="hud-speed-value">0</span>
        <span class="hud-speed-unit">km/s</span>
      </div>
      <div class="hud-rpm">
        <div class="hud-rpm-track"><div class="hud-rpm-fill"></div></div>
        <div class="hud-rpm-meta">
          <span class="hud-gear">1</span>
          <span class="hud-range"></span>
        </div>
      </div>
      <div class="hud-tilt">
        <div class="hud-tilt-bar"><div class="hud-tilt-needle"></div></div>
        <span class="hud-tilt-label">eğim</span>
      </div>
    </div>

    <div class="hud-map">
      <canvas class="hud-map-canvas" width="${MINIMAP_SIZE}" height="${MINIMAP_SIZE}"></canvas>
      <div class="hud-map-label">izler</div>
    </div>

    <div class="hud-status">
      <span class="hud-chip hud-biome">Çöl</span>
      <span class="hud-chip hud-cam">kamera: takip</span>
      <span class="hud-chip hud-fps">60 fps</span>
    </div>

    <div class="hud-keys">
      <div class="hud-keys-title">kontroller</div>
      <ul>
        <li><kbd>W</kbd><kbd>S</kbd> gaz / fren</li>
        <li><kbd>A</kbd><kbd>D</kbd> direksiyon</li>
        <li><kbd>Boşluk</kbd> el freni — drift / park</li>
        <li><kbd>Shift</kbd> düşük vites (4L)</li>
        <li><kbd>C</kbd> kamera · <kbd>F</kbd> farlar</li>
        <li><kbd>T</kbd> hava paneli · <kbd>P</kbd> foto</li>
        <li><kbd>M</kbd> harita editörü</li>
        <li><kbd>N</kbd> çok oyunculu · <kbd>R</kbd> sıfırla</li>
      </ul>
    </div>
  `;
  root.appendChild(element);

  const speedValue = element.querySelector('.hud-speed-value');
  const rpmFill = element.querySelector('.hud-rpm-fill');
  const gearLabel = element.querySelector('.hud-gear');
  const rangeLabel = element.querySelector('.hud-range');
  const tiltNeedle = element.querySelector('.hud-tilt-needle');
  const camChip = element.querySelector('.hud-cam');
  const biomeChip = element.querySelector('.hud-biome');
  const fpsChip = element.querySelector('.hud-fps');
  const mapCanvas = element.querySelector('.hud-map-canvas');
  const mapCtx = mapCanvas.getContext('2d');

  // İzler doğrudan ekrana değil, ara bir tampona çiziliyor; her karede yeniden
  // taramak yerine tampon yeniden kullanılıyor.
  const trackImage = mapCtx.createImageData(MINIMAP_SIZE, MINIMAP_SIZE);
  const trackCanvas = document.createElement('canvas');
  trackCanvas.width = MINIMAP_SIZE;
  trackCanvas.height = MINIMAP_SIZE;
  const trackCtx = trackCanvas.getContext('2d');

  let mapTimer = MINIMAP_INTERVAL;
  let biomeTimer = 0;
  let displayedSpeed = 0;

  function redrawTracks() {
    rutfield.writeToImageData(trackImage, [255, 168, 84]);
    trackCtx.putImageData(trackImage, 0, 0);
  }
  redrawTracks();

  function drawMinimap() {
    const size = MINIMAP_SIZE;
    mapCtx.clearRect(0, 0, size, size);

    mapCtx.fillStyle = '#3a2c1c';
    mapCtx.fillRect(0, 0, size, size);
    mapCtx.drawImage(trackCanvas, 0, 0);

    // Araç konumu ve yönü.
    const half = WORLD.playfield * 0.5;
    const px = ((vehicle.state.position.x + half) / WORLD.playfield) * size;
    const py = ((vehicle.state.position.z + half) / WORLD.playfield) * size;

    const forward = vehicle.forwardVector;
    const heading = Math.atan2(forward.x, forward.z);

    mapCtx.save();
    mapCtx.translate(px, py);
    mapCtx.rotate(-heading);
    mapCtx.beginPath();
    mapCtx.moveTo(0, -6);
    mapCtx.lineTo(4, 5);
    mapCtx.lineTo(0, 2.5);
    mapCtx.lineTo(-4, 5);
    mapCtx.closePath();
    mapCtx.fillStyle = '#8ce0ff';
    mapCtx.fill();
    mapCtx.restore();
  }

  function update(dt, { vehicle: v, cameraMode, fps }) {
    // Gösterge iğnesi gerçek hızın biraz gerisinden gelir: ham değer ekranda
    // titrer, yumuşatılmış değer analog bir gösterge gibi okunur.
    const target = v.speedKmh;
    displayedSpeed += (target - displayedSpeed) * Math.min(1, dt * 9);
    speedValue.textContent = Math.round(displayedSpeed);

    const drive = v.drivetrain.state;
    const rpmRatio = clamp01((drive.rpm - 700) / (v.config.engine.maxRpm - 700));
    rpmFill.style.width = `${rpmRatio * 100}%`;
    rpmFill.classList.toggle('redline', rpmRatio > 0.86);
    gearLabel.textContent = v.drivetrain.gearLabel;
    rangeLabel.textContent = drive.lowRange ? '4L' : '';

    // Eğim göstergesi: sağ eksenin ufka göre açısı = aracın yatışı.
    _right.set(1, 0, 0).applyQuaternion(v.state.quaternion);
    const roll = Math.asin(clamp(_right.y, -1, 1));
    tiltNeedle.style.transform = `translateX(-50%) rotate(${(roll * 180) / Math.PI}deg)`;

    camChip.textContent = `kamera: ${cameraMode}`;
    fpsChip.textContent = `${Math.round(fps)} fps`;

    // Bölge her karede sorgulanmıyor; sınırdan geçerken bile saniyede birkaç
    // kez yeterli ve etiket titremiyor.
    biomeTimer -= dt;
    if (biomeTimer <= 0) {
      biomeTimer = 0.25;
      const id = heightfield.dominantBiome(v.state.position.x, v.state.position.z);
      const onPath = heightfield.samplePath(v.state.position.x, v.state.position.z) > 0.5;
      biomeChip.textContent = onPath ? `${BIOMES[id].label} · patika` : BIOMES[id].label;
    }

    mapTimer -= dt;
    if (mapTimer <= 0) {
      mapTimer = MINIMAP_INTERVAL;
      redrawTracks();
    }
    drawMinimap();
  }

  function setVisible(visible) {
    element.classList.toggle('hidden', !visible);
  }

  return { element, update, setVisible };
}

// Kare başına tahsis olmasın diye modül düzeyinde.
const _right = new THREE.Vector3();
