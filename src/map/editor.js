import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { WORLD } from '../config/settings.js';
import { BIOME_IDS, BIOMES } from '../config/biomes.js';
import { applyStroke } from './terrainBrush.js';
import { clamp } from '../utils/math.js';

/**
 * Harita editörü.
 *
 * Sürüşten ayrı bir mod: simülasyon durur, kamera serbest kalır, sol tık
 * fırçaya bağlanır. Fare düğmeleri modelleme yazılımlarındaki alışkanlığı
 * izliyor — **sol** boyar, **sağ** döndürür, **orta** kaydırır, tekerlek
 * yakınlaştırır — çünkü sol tıkın döndürmeye ayrılması, boyamayı imkânsız
 * kılardı.
 *
 * Fırça sürüklenirken her karede bir darbe üretmiyor: darbeler hem zamanda hem
 * mesafede seyreltiliyor. Yoksa on saniyelik bir sürükleme belgeye altı yüz
 * darbe yazar, dosyayı şişirir ve geri almayı yavaşlatırdı.
 */

/** İki darbe arasındaki en kısa süre (s) ve mesafe (fırça yarıçapının oranı). */
const STROKE_INTERVAL = 0.045;
const STROKE_SPACING = 0.22;
/** Arazi düzenlendikten sonra ufuk haritasının yeniden pişirilme gecikmesi (s). */
const REBAKE_DELAY = 0.6;

export const TOOL_GROUPS = [
  {
    id: 'arazi',
    label: 'Arazi',
    tools: [
      { id: 'yukselt', label: 'Yükselt', hint: 'Zemini kaldırır' },
      { id: 'alcalt', label: 'Alçalt', hint: 'Zemini oyar' },
      { id: 'duzle', label: 'Düzle', hint: 'İlk tıklanan yüksekliğe çeker' },
      { id: 'yumusat', label: 'Yumuşat', hint: 'Keskin kenarları eritir' },
      { id: 'puruzlendir', label: 'Pürüzlendir', hint: 'İnce gürültü ekler' },
    ],
  },
  {
    id: 'biyom',
    label: 'Bölge',
    tools: BIOME_IDS.map((id, index) => ({
      id: `biyom:${index}`,
      label: BIOMES[id].label,
      hint: 'Zemini bu bölgeye boyar',
    })),
  },
  {
    id: 'nesne',
    label: 'Nesne',
    tools: [
      { id: 'nesne:ekle', label: 'Yerleştir', hint: 'Seçili türü dizer' },
      { id: 'nesne:sil', label: 'Sil', hint: 'Fırçanın içindekileri kaldırır' },
      { id: 'nesne:dogus', label: 'Doğuş noktası', hint: 'Aracın başlayacağı yer' },
    ],
  },
];

export function createEditor({
  canvas,
  camera,
  scene,
  renderer,
  heightfield,
  props,
  doc,
  vehicle,
  onDocChange,
  onStroke = null,
}) {
  const controls = new OrbitControls(camera, canvas);
  controls.enabled = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 6;
  controls.maxDistance = 900;
  controls.mouseButtons = {
    LEFT: null,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.ROTATE,
  };
  controls.screenSpacePanning = false;

  const state = {
    active: false,
    tool: 'yukselt',
    /** Nesne paletinde seçili tür. */
    propKind: 'pine',
    radius: 18,
    strength: 0.55,
    /** Nesne yerleştirmede ölçek çarpanı. */
    propScale: 1,
    hover: null,
    painting: false,
    dirtyTerrain: false,
    dirtyProps: false,
    message: '',
  };

  const undoStack = [];
  const _hit = new THREE.Vector3();
  const _rayOrigin = new THREE.Vector3();
  const _rayDir = new THREE.Vector3();
  const _ndc = new THREE.Vector2();
  const _lastStroke = new THREE.Vector2();
  let strokeTimer = 0;
  let lastStrokeValid = false;
  let flattenHeight = 0;
  let rebakeTimer = 0;
  let onRebake = null;

  // --- fırça imleci --------------------------------------------------------
  // Araziye oturan bir halka: düz bir daire, tepenin yamacında havada asılı
  // kalıp fırçanın nereye değdiğini yanlış gösteriyordu.
  const RING_SEGMENTS = 72;
  const ringGeometry = new THREE.BufferGeometry();
  ringGeometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(RING_SEGMENTS * 3), 3)
  );
  const ring = new THREE.LineLoop(
    ringGeometry,
    new THREE.LineBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.9, depthTest: false })
  );
  ring.frustumCulled = false;
  ring.renderOrder = 999;
  ring.visible = false;
  ring.userData.skipGBuffer = true;
  scene.add(ring);

  const spawnMarker = createSpawnMarker();
  spawnMarker.visible = false;
  spawnMarker.userData.skipGBuffer = true;
  scene.add(spawnMarker);

  // --- fare ----------------------------------------------------------------

  function toRay(event) {
    const rect = canvas.getBoundingClientRect();
    _ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    _ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    _rayOrigin.setFromMatrixPosition(camera.matrixWorld);
    _rayDir.set(_ndc.x, _ndc.y, 0.5).unproject(camera).sub(_rayOrigin).normalize();
    return heightfield.raycast(_rayOrigin, _rayDir, _hit);
  }

  function onPointerMove(event) {
    if (!state.active) return;
    state.hover = toRay(event) ? _hit.clone() : null;
  }

  function onPointerDown(event) {
    if (!state.active || event.button !== 0) return;
    if (!toRay(event)) return;
    // Yakalama, imleç tuvalin dışına çıksa da darbelerin gelmesini sağlıyor.
    // Sentetik olaylarda (test) etkin bir işaretçi olmayabilir.
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // yakalama olmadan da çalışır, sadece tuvalin dışında iz bırakmaz
    }

    pushUndo();
    state.painting = true;
    strokeTimer = STROKE_INTERVAL;
    lastStrokeValid = false;
    flattenHeight = heightfield.sampleBase(_hit.x, _hit.z);

    if (state.tool === 'nesne:dogus') {
      doc.spawn = { x: round(_hit.x), z: round(_hit.z), heading: 0 };
      state.message = 'Doğuş noktası taşındı.';
      onDocChange?.();
      state.painting = false;
      return;
    }
    paintAt(0);
  }

  function onPointerUp(event) {
    if (!state.painting) return;
    state.painting = false;
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    settle();
  }

  function onWheel(event) {
    if (!state.active) return;
    // Ctrl + tekerlek fırça boyunu değiştirir; çıplak tekerlek kamerayı
    // yakınlaştırır (OrbitControls'a bırakılıyor).
    if (!event.ctrlKey && !event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) {
      state.strength = clamp(state.strength * (event.deltaY > 0 ? 0.9 : 1.11), 0.02, 3);
    } else {
      state.radius = clamp(state.radius * (event.deltaY > 0 ? 0.9 : 1.11), 3, 120);
    }
  }

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false, capture: true });
  canvas.addEventListener('contextmenu', (e) => {
    if (state.active) e.preventDefault();
  });

  // --- fırça ---------------------------------------------------------------

  function paintAt(dt) {
    if (!state.hover && !_hit) return;
    const x = _hit.x;
    const z = _hit.z;

    strokeTimer += dt;
    if (strokeTimer < STROKE_INTERVAL) return;
    if (lastStrokeValid) {
      const moved = Math.hypot(x - _lastStroke.x, z - _lastStroke.y);
      // Fırça yerinde duruyorsa da darbe düşsün (yığmak için), ama seyrek.
      if (moved < state.radius * STROKE_SPACING && strokeTimer < STROKE_INTERVAL * 4) return;
    }
    strokeTimer = 0;
    _lastStroke.set(x, z);
    lastStrokeValid = true;

    if (state.tool.startsWith('nesne:')) {
      paintProps(x, z);
      return;
    }

    const stroke = buildStroke(x, z);
    if (!stroke) return;
    doc.strokes.push(stroke);
    applyStroke(heightfield, stroke);
    state.dirtyTerrain = true;
    onStroke?.(stroke);
    onDocChange?.();
  }

  function buildStroke(x, z) {
    if (state.tool.startsWith('biyom:')) {
      return {
        t: 'biyom',
        x: round(x),
        z: round(z),
        r: round(state.radius),
        s: round(state.strength * 0.5),
        b: Number(state.tool.split(':')[1]),
      };
    }
    const stroke = {
      t: state.tool,
      x: round(x),
      z: round(z),
      r: round(state.radius),
      s: round(strokeAmount()),
    };
    if (state.tool === 'duzle') stroke.h = round(flattenHeight);
    return stroke;
  }

  /** Aracın işaretine göre yükseklik değişimi (m) ya da karışım oranı. */
  function strokeAmount() {
    if (state.tool === 'yukselt') return state.strength * 1.4;
    if (state.tool === 'alcalt') return -state.strength * 1.4;
    if (state.tool === 'puruzlendir') return state.strength * 0.35;
    return state.strength * 0.5;
  }

  function paintProps(x, z) {
    if (state.tool === 'nesne:sil') {
      if (props.removeNear(x, z, state.radius)) {
        state.dirtyProps = true;
        onDocChange?.();
      }
      return;
    }
    // Yerleştirmede fırça yarıçapı bir dağılım alanı: tek tık bir ağaç değil
    // küçük bir küme bırakıyor, elle orman dikmek dakikalar sürmesin.
    const kind = props.kinds[state.propKind];
    if (!kind) return;
    const count = state.radius < 8 ? 1 : Math.max(1, Math.round(state.radius * 0.18));
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * state.radius;
      const px = clamp(x + Math.cos(angle) * r, -WORLD.playfield * 0.5, WORLD.playfield * 0.5);
      const pz = clamp(z + Math.sin(angle) * r, -WORLD.playfield * 0.5, WORLD.playfield * 0.5);
      const item = props.add(state.propKind, px, pz);
      if (item) item.scale *= state.propScale;
    }
    props.rebuildKind(state.propKind);
    state.dirtyProps = true;
    onDocChange?.();
  }

  /** Sürükleme bitince: pahalı işler burada toplanıyor. */
  function settle() {
    if (state.dirtyTerrain) {
      // Nesneler araziden yükseklik okuyor; zemin değiştiyse yeniden otursunlar.
      props.rebuildAll();
      rebakeTimer = REBAKE_DELAY;
    }
    if (state.dirtyTerrain || state.dirtyProps) {
      doc.props = props.toJSON();
      props.flushColliders();
      onDocChange?.();
    }
    state.dirtyProps = false;
  }

  // --- geri alma -----------------------------------------------------------

  function pushUndo() {
    undoStack.push({ strokes: doc.strokes.length, props: doc.props, spawn: doc.spawn });
    if (undoStack.length > 40) undoStack.shift();
  }

  function undo() {
    const snapshot = undoStack.pop();
    if (!snapshot) {
      state.message = 'Geri alınacak bir şey yok.';
      return;
    }
    doc.spawn = snapshot.spawn;
    if (doc.strokes.length !== snapshot.strokes) {
      doc.strokes.length = snapshot.strokes;
      // Araziyi baştan kur: darbeler sıraya bağlı olduğu için tek tek geri
      // almak mümkün değil (yumuşat ve düzle o anki yüzeyi okuyor).
      heightfield.restoreBase();
      for (const stroke of doc.strokes) applyStroke(heightfield, stroke);
      heightfield.flushTexture(renderer);
      rebakeTimer = REBAKE_DELAY;
    }
    doc.props = snapshot.props;
    props.fromJSON(doc.props);
    props.flushColliders();
    state.message = 'Geri alındı.';
    onDocChange?.();
  }

  // --- kare döngüsü --------------------------------------------------------

  function update(dt) {
    if (!state.active) return;
    controls.update();

    if (state.painting && state.hover) paintAt(dt);

    if (state.dirtyTerrain) {
      heightfield.flushTexture(renderer);
      state.dirtyTerrain = state.painting;
      if (!state.painting) rebakeTimer = REBAKE_DELAY;
    }

    if (rebakeTimer > 0) {
      rebakeTimer -= dt;
      if (rebakeTimer <= 0 && onRebake) {
        // Ufuk haritası statik araziyi varsayıyor; zemin değişince gölgeler ve
        // örtme haritası eski araziye ait kalır.
        onRebake();
      }
    }

    updateRing();
    updateSpawnMarker();
  }

  function updateRing() {
    if (!state.hover) {
      ring.visible = false;
      return;
    }
    ring.visible = true;
    const array = ringGeometry.attributes.position.array;
    for (let i = 0; i < RING_SEGMENTS; i++) {
      const a = (i / RING_SEGMENTS) * Math.PI * 2;
      const x = state.hover.x + Math.cos(a) * state.radius;
      const z = state.hover.z + Math.sin(a) * state.radius;
      array[i * 3] = x;
      array[i * 3 + 1] = heightfield.sampleBase(x, z) + 0.25;
      array[i * 3 + 2] = z;
    }
    ringGeometry.attributes.position.needsUpdate = true;
    ring.material.color.set(state.tool === 'nesne:sil' ? 0xff9a76 : 0x9fe8ff);
  }

  function updateSpawnMarker() {
    if (!doc.spawn) {
      spawnMarker.visible = false;
      return;
    }
    spawnMarker.visible = true;
    spawnMarker.position.set(
      doc.spawn.x,
      heightfield.sampleBase(doc.spawn.x, doc.spawn.z) + 1.2,
      doc.spawn.z
    );
    spawnMarker.rotation.y += 0.6 * (1 / 60);
  }

  // --- mod geçişi ----------------------------------------------------------

  function enter() {
    if (state.active) return;
    state.active = true;
    controls.enabled = true;
    heightfield.snapshotBase();

    // Kamera aracın üstünde, harita geneli görünecek bir yükseklikte açılır.
    const p = vehicle.state.position;
    controls.target.set(p.x, heightfield.sampleBase(p.x, p.z), p.z);
    camera.position.set(p.x + 40, controls.target.y + 46, p.z + 40);
    camera.fov = 55;
    camera.updateProjectionMatrix();
    controls.update();
    state.message = 'Editör açık — sol tık boyar, sağ tık döndürür.';
  }

  function exit() {
    if (!state.active) return;
    state.active = false;
    state.painting = false;
    controls.enabled = false;
    ring.visible = false;
    spawnMarker.visible = false;
    props.flushColliders();
    doc.props = props.toJSON();
  }

  function dispose() {
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('wheel', onWheel, { capture: true });
    controls.dispose();
    scene.remove(ring);
    scene.remove(spawnMarker);
    ringGeometry.dispose();
  }

  return {
    state,
    controls,
    enter,
    exit,
    update,
    undo,
    dispose,
    setTool(tool) {
      state.tool = tool;
    },
    setRebakeHandler(fn) {
      onRebake = fn;
    },
    /** Ağdan gelen darbeyi uygular (belgeye yazmak çağıranın işi). */
    applyRemoteStroke(stroke) {
      applyStroke(heightfield, stroke);
      state.dirtyTerrain = true;
      if (!state.active) heightfield.flushTexture(renderer);
    },
    requestRebake() {
      rebakeTimer = REBAKE_DELAY;
    },
    get toolGroups() {
      return TOOL_GROUPS;
    },
  };
}

/** Doğuş noktasını gösteren, dönen bir ok. */
function createSpawnMarker() {
  const group = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({ color: 0x7cf7a0, transparent: true, opacity: 0.85 });
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2.2, 5), material);
  cone.rotation.x = Math.PI;
  group.add(cone);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.09, 6, 28), material);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -1.2;
  group.add(ring);
  return group;
}

function round(v) {
  return Math.round(v * 100) / 100;
}
