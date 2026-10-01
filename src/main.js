import * as THREE from 'three';
import {
  QUALITY_PRESETS,
  DEFAULT_QUALITY,
  FIXED_DT,
  MAX_SUBSTEPS,
  VEHICLE,
  WORLD,
} from './config/settings.js';
import { createHeightfield } from './sim/heightfield.js';
import { Rutfield } from './sim/rutfield.js';
import { PropField } from './sim/propField.js';
import { createSurfaceSampler } from './sim/surface.js';
import { createWeather } from './sim/weather.js';
import { createInput } from './sim/input.js';
import { createVehicle } from './sim/vehicle.js';
import { createSceneContext } from './render/scene.js';
import { createTrackMap } from './render/trackMap.js';
import { createTerrain } from './render/terrain.js';
import { createJeep } from './render/jeepModel.js';
import { createParticles } from './render/particles.js';
import { createProps } from './render/props.js';
import { createCameraRig } from './render/cameraRig.js';
import { bakeHorizonMap } from './render/horizonMap.js';
import {
  createTerrainShadowUniforms,
  updateTerrainShadowUniforms,
  applyTerrainShadow,
} from './render/terrainShadow.js';
import { createAudio } from './sim/audio.js';
import { createEditor } from './map/editor.js';
import { applyDoc, createEmptyDoc } from './map/mapDoc.js';
import { createNetSession } from './net/session.js';
import { createRemotePlayers } from './net/remotePlayers.js';
import { createHud } from './ui/hud.js';
import { createControlsPanel } from './ui/controlsPanel.js';
import { createEditorPanel } from './ui/editorPanel.js';
import { createNetPanel } from './ui/netPanel.js';
import { createPhotoMode } from './ui/photoMode.js';
import { clamp, clamp01 } from './utils/math.js';

const canvas = document.getElementById('scene-canvas');
const uiRoot = document.getElementById('ui-root');
const bootScreen = document.getElementById('boot-screen');
const bootFill = bootScreen.querySelector('.boot-bar-fill');
const bootSub = bootScreen.querySelector('.boot-sub');

boot().catch((error) => {
  console.error(error);
  bootSub.textContent = 'Başlatılamadı — konsolu kontrol edin.';
});

async function boot() {
  let quality = QUALITY_PRESETS[DEFAULT_QUALITY];
  let qualityKey = DEFAULT_QUALITY;

  bootSub.textContent = 'kum tepeleri üretiliyor…';
  const heightfield = await createHeightfield({
    onProgress: (t) => {
      bootFill.style.width = `${Math.round(t * 88)}%`;
    },
  });

  // Fiziğin gördüğü oyuklar: iz haritasının CPU ikizi. Yükseklik alanına
  // takılınca süspansiyon ray-cast'i kendi bıraktığın izi de görür.
  const rutfield = new Rutfield({ resolution: 1024, maxDepth: 0.07 });
  heightfield.rutfield = rutfield;

  bootSub.textContent = 'sahne kuruluyor…';
  bootFill.style.width = '92%';
  await nextFrame();

  const weather = createWeather();
  const context = createSceneContext({ canvas, quality, weather });
  const { scene, camera, renderer } = context;

  bootSub.textContent = 'gölgeler pişiriliyor…';
  /**
   * Ufuk haritası: arazinin kendi gölgesi ve ortam örtmesi, çalışma zamanında
   * ışın yürütmek yerine açılışta bir kez GPU'da pişiriliyor.
   */
  let horizon = await bakeHorizonMap({
    renderer,
    heightfield,
    onProgress: (t) => {
      bootFill.style.width = `${92 + t * 6}%`;
    },
  });
  const terrainShadow = createTerrainShadowUniforms({ heightfield, horizon });

  /**
   * Arazi düzenlendikten sonra ufuk haritası yeniden pişirilmeli: haritanın
   * tamamı "arazi değişmez" varsayımı üzerine kurulu ve fırçayla açılan bir
   * vadi, eski gölgeleri olduğu yerde bırakır.
   *
   * Uniform nesneleri materyaller arasında **referansla** paylaşıldığı için
   * yeni dokuları tek yerden takmak yetiyor.
   */
  let rebaking = false;
  async function rebakeHorizon() {
    if (rebaking) return;
    rebaking = true;
    try {
      const next = await bakeHorizonMap({ renderer, heightfield, resolution: horizon.resolution });
      horizon.dispose();
      horizon = next;
      terrainShadow.uHorizonA.value = next.horizonA;
      terrainShadow.uHorizonB.value = next.horizonB;
      terrainShadow.uTerrainAO.value = next.occlusion;
    } finally {
      rebaking = false;
    }
  }

  const trackMap = createTrackMap({ renderer, resolution: quality.trackRes });
  const terrain = createTerrain({ scene, heightfield, trackMap, quality, terrainShadow });

  // Nesnelerin çarpıştırıcı kaydı: `createProps` yerleştirirken doldurur,
  // araç fiziği tekerlek ışınları ve gövde küreleri için okur.
  const propField = new PropField();
  const props = createProps({ scene, heightfield, quality, propField });
  // Çarpıştırıcılar ilk kareden önce hazır olsun: `flushColliders` normalde
  // kare döngüsünde çağrılıyor ve ilk fizik adımı ondan önce koşuyor.
  props.flushColliders();
  const particles = createParticles({ scene, quality, weather });
  // Toz katı yüzey değil; örtme tamponuna girerse ardındaki her şeyi karartır.
  particles.points.userData.skipGBuffer = true;

  // Zemin örnekleyicisi: bölge ve patika bilgisini lastik parametrelerine çevirir.
  const surface = createSurfaceSampler(heightfield);
  const vehicle = createVehicle({ heightfield, propField, surface });
  const jeep = createJeep({ scene, weather });

  /**
   * Arazi gölgesini sahnedeki diğer yüzeylere de uygula. Arazi gölge
   * haritasına yazmadığı için, kum tepesinin gölgesine giren ağaç ya da araç
   * bunu başka türlü öğrenemez.
   *
   * Araçta örtme kapalı: arazi örtmesi zeminde duran nesneler için anlamlı,
   * gövdesi yerden yüksek bir araçta ise çifte karartma yapıyor.
   */
  for (const material of Object.values(props.materials)) {
    applyTerrainShadow(material, terrainShadow, { key: 'prop' });
  }
  for (const material of Object.values(jeep.materials)) {
    applyTerrainShadow(material, terrainShadow, { applyOcclusion: false, key: 'jeep' });
  }
  applyTerrainShadow(jeep.wheelRig.materials.tire, terrainShadow, {
    applyOcclusion: false,
    key: 'jeep',
  });
  applyTerrainShadow(jeep.wheelRig.materials.rim, terrainShadow, {
    applyOcclusion: false,
    key: 'jeep',
  });
  const cameraRig = createCameraRig({ camera, heightfield });
  const input = createInput();

  const audio = createAudio();
  audio.attachUnlock();

  const spawn = findSpawn(heightfield);
  vehicle.resetTo(spawn.x, spawn.z, spawn.heading);

  // --- harita belgesi, editör ve ağ ----------------------------------------
  // Prosedürel arazinin el değmemiş kopyası: editörün fırça darbelerini
  // üstüne yeniden oynattığı taban.
  heightfield.snapshotBase();

  // Belge nesnesinin kimliği sabit kalıyor: editör ve ağ oturumu ona referansla
  // bağlı, yerine yenisi konsa ikisi de eski belgeyi tutmaya devam ederdi.
  const doc = createEmptyDoc('Prosedürel harita');
  doc.props = props.toJSON();

  const remotePlayers = createRemotePlayers({
    scene,
    weather,
    heightfield,
    trackMap,
    rutfield,
    particles,
    surface,
  });

  const editor = createEditor({
    canvas,
    camera,
    scene,
    renderer,
    heightfield,
    props,
    doc,
    vehicle,
    onDocChange: () => {},
    onStroke: (stroke) => net.broadcastStroke(stroke),
  });
  editor.setRebakeHandler(rebakeHorizon);

  const net = createNetSession({
    vehicle,
    remotePlayers,
    weather,
    doc,
    onStroke: (stroke) => {
      doc.strokes.push(stroke);
      editor.applyRemoteStroke(stroke);
      editor.requestRebake();
    },
    onMapReceived: (received) => loadDoc(received, { broadcast: false }),
    onPeersChanged: () => netPanel.refresh(),
    onStatus: () => netPanel.refresh(),
  });

  const hud = createHud(uiRoot, { rutfield, vehicle, heightfield });
  const panel = createControlsPanel(uiRoot, {
    weather,
    qualityKey,
    audio,
    onQualityChange: applyQuality,
    onClearTracks: () => {
      trackMap.clear();
      rutfield.clear();
    },
    onReset: resetVehicle,
    onWeatherChange: refreshEnvironment,
  });
  const photoMode = createPhotoMode(uiRoot, {
    context,
    camera,
    vehicle,
    hud,
    panel,
    weather,
    onWeatherChange: refreshEnvironment,
  });

  const editorPanel = createEditorPanel(uiRoot, {
    editor,
    props,
    doc,
    onLoadDoc: (next) => loadDoc(next),
    onNewDoc: (next) => loadDoc(next),
    onPlay: () => setEditorMode(false),
  });
  editorPanel.setVisible(false);

  const netPanel = createNetPanel(uiRoot, { session: net, remotePlayers });

  /**
   * Belgeyi sahneye uygular. Belgenin kimliği korunuyor (bkz. yukarısı), yalnız
   * alanları değişiyor.
   */
  function loadDoc(next, { broadcast = true } = {}) {
    doc.name = next.name;
    doc.strokes = next.strokes ?? [];
    doc.props = next.props ?? [];
    doc.spawn = next.spawn ?? null;
    doc.weather = next.weather ?? null;

    applyDoc(doc, { heightfield, props, renderer });
    props.flushColliders();
    editorPanel.setDoc(doc);
    editorPanel.refreshList();

    if (doc.weather) {
      weather.setTimeOfDay(doc.weather.timeOfDay);
      weather.setStorm(doc.weather.storm ?? 0);
      panel.refreshLabels();
    }
    refreshEnvironment();
    rebakeHorizon();
    resetVehicle();
    if (broadcast) net.broadcastMap();
  }

  bootFill.style.width = '100%';
  await nextFrame();
  bootScreen.classList.add('hidden');
  setTimeout(() => bootScreen.remove(), 700);

  window.addEventListener('resize', () => context.resize());

  // Geri alma yalnız editörde ve yalnız metin alanı dışındayken.
  window.addEventListener('keydown', (event) => {
    if (!editor.state.active || !(event.ctrlKey || event.metaKey) || event.code !== 'KeyZ') return;
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    event.preventDefault();
    editor.undo();
  });

  function applyQuality(key) {
    qualityKey = key;
    quality = QUALITY_PRESETS[key];
    context.setQuality(quality);
    trackMap.setResolution(quality.trackRes);
    terrain.setNearSegments(quality.nearSegments);
    terrain.setTrackResolution(quality.trackRes);
    particles.setEmissionScale(quality.particleScale / QUALITY_PRESETS[DEFAULT_QUALITY].particleScale);
    // Çözünürlük değişince harita sıfırlandığı için CPU ikizi de sıfırlanmalı,
    // yoksa fizik olmayan izleri hissetmeye devam eder.
    rutfield.clear();
  }

  function resetVehicle() {
    // Haritanın kendi doğuş noktası varsa oraya; yoksa bulunulan yerin
    // çevresindeki en düz noktaya.
    if (doc.spawn) {
      vehicle.resetTo(doc.spawn.x, doc.spawn.z, doc.spawn.heading ?? 0);
    } else {
      const spot = findSpawn(heightfield, vehicle.state.position);
      vehicle.resetTo(spot.x, spot.z, spot.heading);
    }
    cameraRig.reset();
  }

  /**
   * Editör ↔ sürüş geçişi. Editörde simülasyon duruyor ve sürüş arayüzü
   * gizleniyor; çıkarken çarpıştırıcılar tazeleniyor ve araç, altından zemin
   * kaydırılmışsa yeniden doğuyor.
   */
  function setEditorMode(on) {
    if (on === editor.state.active) return;
    if (on && photoMode.active) photoMode.toggle();

    if (on) {
      editor.enter();
    } else {
      editor.exit();
      // Zemin aracın altında yükseltilmişse araç kayanın içinde kalır.
      const ground = heightfield.sampleBase(vehicle.state.position.x, vehicle.state.position.z);
      if (vehicle.state.position.y < ground + 0.2) resetVehicle();
      cameraRig.reset();
    }

    editorPanel.setVisible(on);
    hud.setVisible(!on);
    panel.setVisible(!on);
    netPanel.setVisible(!on);
    if (on) panel.toggle(false);
  }

  /**
   * Hava/saat değiştiğinde ışıklar, gökyüzü ve ufuk haritası aramasının güneş
   * parametreleri birlikte tazelenir — biri güncellenip diğeri unutulursa
   * gölgeler güneşin gerisinde kalır.
   */
  function refreshEnvironment() {
    context.applyWeather();
    updateTerrainShadowUniforms(terrainShadow, weather);
  }
  refreshEnvironment();

  // --- ana döngü -----------------------------------------------------------
  const clock = new THREE.Clock();
  let accumulator = 0;
  let fpsTimer = 0;
  let fpsFrames = 0;
  let fps = 60;

  const _forward = new THREE.Vector3();
  const _dustPos = new THREE.Vector3();
  const focus = new THREE.Vector3();

  renderer.setAnimationLoop(() => tick(Math.min(clock.getDelta(), 0.1)));

  function tick(dt) {
    fpsTimer += dt;
    fpsFrames++;
    if (fpsTimer >= 0.5) {
      fps = fpsFrames / fpsTimer;
      fpsTimer = 0;
      fpsFrames = 0;
    }

    handleHotkeys();

    const axes = input.update(dt);
    weather.update(dt);
    if (weather.state.timeSpeed !== 0) refreshEnvironment();

    trackMap.beginFrame();

    if (editor.state.active) {
      // Editörde simülasyon duruyor: fırçayla zemini oyarken aracın kayması,
      // düzenlemeyi kovalamacaya çevirirdi.
      editor.update(dt);
      editorPanel.update(dt);
    } else if (!photoMode.active) {
      // Sabit adımlı simülasyon: yay kuvvetleri kare hızından bağımsız kalır.
      accumulator += dt;
      let steps = 0;
      while (accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
        vehicle.step(FIXED_DT, axes);
        stampTracks(FIXED_DT);
        accumulator -= FIXED_DT;
        steps++;
      }
      // Sekme arkaplandan dönerse biriken zamanı atıyoruz; yoksa araç
      // yakalamaya çalışırken sahnede ışınlanır.
      if (steps >= MAX_SUBSTEPS) accumulator = 0;

      // Ters dönen araç kendini toplasın: `R` ile başa dönmek, sürüşün
      // ortasında haritanın öbür ucuna ışınlanmak demek.
      if (vehicle.state.upsideDownTime > VEHICLE.stability.autoRightDelay) {
        vehicle.selfRight();
        cameraRig.reset();
      }

      jeep.sync(vehicle, axes);
      cameraRig.update(dt, vehicle, weather);
      emitEffects(dt, axes);

      // Vites değişimi: hem duyuluyor hem kamerada hissediliyor.
      const shift = vehicle.drivetrain.consumeShift();
      if (shift !== 0) {
        audio.shift(shift);
        cameraRig.kick(0.28, shift > 0 ? 1.6 : 0.9);
      }
    } else {
      photoMode.update(dt);
    }

    // Uzak oyuncular editörde ve fotoğraf modunda da hareket etmeye devam
    // ediyor: onların simülasyonu bizde durmuyor.
    net.update(dt, axes, heightfield);
    remotePlayers.update(dt);

    audio.update(dt, {
      vehicle,
      weather,
      surface,
      muted: editor.state.active || photoMode.active,
    });

    props.updateWind(dt, weather);
    props.flushColliders();
    netPanel.update(dt);

    trackMap.flush(dt, weather.derived.erosion);
    rutfield.decay(dt, weather.derived.erosion);

    focus.copy(
      editor.state.active || photoMode.active ? camera.position : vehicle.state.position
    );
    terrain.update(focus.x, focus.z);
    particles.update(dt, { heightfield });

    hud.update(dt, {
      vehicle,
      camera,
      cameraMode: cameraRig.mode,
      weather,
      fps,
      quality: qualityKey,
    });

    context.render(dt, focus);
    input.endFrame();
  }

  function handleHotkeys() {
    if (input.consume('editor')) setEditorMode(!editor.state.active);
    if (editor.state.active) return;

    if (input.consume('camera') && !photoMode.active) cameraRig.cycle();
    if (input.consume('reset')) resetVehicle();
    if (input.consume('headlights')) {
      weather.toggleHeadlights();
      refreshEnvironment();
    }
    if (input.consume('panel')) panel.toggle();
    if (input.consume('photo')) photoMode.toggle();
    if (input.consume('network')) netPanel.toggle();
  }

  /**
   * Tekerlek temaslarını hem GPU iz haritasına hem CPU rut ızgarasına işler.
   * Fizik alt adımı başına bir kez çağrıldığı için segmentler kısa ve
   * kavisleri doğru takip ediyor.
   */
  function stampTracks(dt) {
    const halfWidth = VEHICLE.wheelWidth * 0.5;

    for (const w of vehicle.wheels) {
      if (!w.grounded) continue;
      if (!heightfield.isInsidePlayfield(w.contact.x, w.contact.z, 1)) continue;

      // Tekerlek havadan yeni indiyse önceki temas noktası çok uzakta olabilir;
      // aradaki boşluğa iz çizmek yerine tek noktalık damga bırakılır.
      let px = w.prevContact.x;
      let pz = w.prevContact.z;
      if (!w.hadContact || Math.hypot(w.contact.x - px, w.contact.z - pz) > 2.5) {
        px = w.contact.x;
        pz = w.contact.z;
      }

      // İz derinliği bölgeye göre: kar en derin izi tutar, çayır neredeyse
      // hiç iz almaz, orman toprağı ikisinin arasında.
      const ground = surface(w.contact.x, w.contact.z);
      const load = clamp(w.load / vehicle.nominalLoad, 0, 2.2) * ground.trackDepth;
      trackMap.stampWheel(px, pz, w.contact.x, w.contact.z, {
        halfWidth,
        load,
        slide: w.slide,
        spin: w.spin,
        dt,
      });

      // CPU ikizi daha sığ ve daha geniş: fizikte istenen his "kendi hendeğine
      // oturmak", tek tek diş izlerini hissetmek değil.
      const dig = Math.min(1, w.slide * 0.55 + w.spin * 0.45);
      const advance = Math.min(1, Math.hypot(w.contact.x - px, w.contact.z - pz) / 0.5);
      const strength = load * (advance * 0.16 + dig * dt * 1.1);
      rutfield.stampSegment(px, pz, w.contact.x, w.contact.z, halfWidth * 1.5, strength);
    }
  }

  function emitEffects(dt, axes) {
    const state = vehicle.state;
    _forward.set(0, 0, -1).applyQuaternion(state.quaternion);

    for (const w of vehicle.wheels) {
      if (!w.grounded) continue;
      // Püskürtme miktarı yükle ölçeklenir: hafiflemiş tekerlek kum atmaz.
      const loadScale = clamp01(w.load / vehicle.nominalLoad);
      const amount = clamp01(w.slide * 0.85 + w.spin * 0.75) * loadScale;
      if (amount > 0.08) particles.emitSpray(w, amount, _forward, dt);
    }

    const speed = state.speed;
    if (speed > 3.5 && vehicle.state.groundedCount > 0) {
      _dustPos
        .copy(state.position)
        .addScaledVector(_forward, -2.4)
        .setY(heightfield.sampleHeight(state.position.x, state.position.z) + 0.1);
      const drift = clamp01(
        vehicle.wheels.reduce((sum, w) => sum + w.slide, 0) / 4
      );
      const amount = clamp01((speed - 3.5) / 16) * (0.45 + drift * 0.9);
      particles.emitDust(
        _dustPos.x,
        _dustPos.y,
        _dustPos.z,
        amount,
        weather.windDir.x * weather.derived.windSpeed,
        weather.windDir.y * weather.derived.windSpeed,
        dt
      );
    }

    // Kayaya çarpınca da toz kalksın — çarpma sadece hızı kesmesin, görünsün.
    const crash = vehicle.consumeImpact();
    if (crash > 2.5) {
      particles.emitImpact(
        state.position.x,
        heightfield.sampleHeight(state.position.x, state.position.z) + 0.3,
        state.position.z,
        Math.min(crash, 12)
      );
      audio.impact(crash);
      cameraRig.kick(clamp01(crash / 9) * 1.2, clamp01(crash / 9) * 3);
    }

    const impact = vehicle.consumeLandingImpact();
    if (impact > 2.4) {
      particles.emitImpact(
        state.position.x,
        heightfield.sampleHeight(state.position.x, state.position.z),
        state.position.z,
        Math.min(impact, 14)
      );
      audio.impact(impact * 0.8);
      cameraRig.kick(clamp01(impact / 11) * 0.9, clamp01(impact / 11) * 2);
    }

    if (weather.derived.airborneSand > 0.04) {
      particles.emitWindSand(
        camera,
        weather.derived.airborneSand,
        weather.windDir.x * weather.derived.windSpeed,
        weather.windDir.y * weather.derived.windSpeed,
        dt
      );
    }

    void axes;
  }

  // Konsoldan kurcalamak için. `tick` sayesinde simülasyon sabit adımlarla
  // elle de sürülebiliyor — hata ayıklarken ve kare yakalarken işe yarıyor.
  window.desert = {
    vehicle,
    weather,
    terrain,
    trackMap,
    rutfield,
    heightfield,
    context,
    particles,
    propField,
    props,
    input,
    cameraRig,
    audio,
    editor,
    doc,
    net,
    remotePlayers,
    loadDoc,
    setEditorMode,
    rebakeHorizon,
    get horizon() {
      return horizon;
    },
    tick,
    // Saati elle değiştirdikten sonra ışıkların ve gölge aramasının birlikte
    // tazelenmesi için: ikisi ayrı kalırsa gölgeler güneşin gerisinde kalır.
    refreshEnvironment,
  };
}

/**
 * Aracın başlayacağı düz noktayı arar. Verilen noktanın çevresinde en az eğimli
 * yeri seçer — dik bir kayma yüzünde doğmak, araç daha kontrol alınamadan
 * aşağı kaymasıyla sonuçlanır.
 */
function findSpawn(heightfield, near = null) {
  let best = null;
  let bestSlope = Infinity;
  const cx = near ? near.x : 0;
  const cz = near ? near.z : 0;

  for (let i = 0; i < 220; i++) {
    const angle = (i / 220) * Math.PI * 2 * 7;
    const radius = near ? (i / 220) * 40 : (i / 220) * 60;
    const x = clamp(cx + Math.cos(angle) * radius, -180, 180);
    const z = clamp(cz + Math.sin(angle) * radius, -180, 180);
    const slope = heightfield.sampleSlope(x, z);
    if (slope < bestSlope) {
      bestSlope = slope;
      best = { x, z };
      if (slope < 0.045) break;
    }
  }

  const heading = Math.atan2(-best.x, -best.z) + Math.PI;
  return { ...best, heading };
}

/**
 * Açılış ekranının ilerlemesini gösterebilmesi için kontrolü tarayıcıya bırakır.
 * `requestAnimationFrame` yerine `setTimeout`: sekme arka plandayken rAF hiç
 * tetiklenmiyor ve açılış orada takılıp kalıyordu.
 */
function nextFrame() {
  return new Promise((resolve) => setTimeout(resolve, 16));
}

void WORLD;
