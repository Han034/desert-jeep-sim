import * as THREE from 'three';
import { WORLD } from '../config/settings.js';
import { BIOME_IDS, BIOMES } from '../config/biomes.js';
import { mulberry32 } from '../utils/math.js';
import { createKinds, createMaterials, createWindUniforms } from './propKinds.js';

/**
 * Bölgelere serpilen sabit nesneler — ve harita editörünün üzerinde çalıştığı
 * **değiştirilebilir** nesne deposu.
 *
 * İşlevleri süs değil ölçek ve yön duygusu: boş bir arazide ne kadar hızlı
 * gittiğini ya da nerede olduğunu anlamak imkânsızdır.
 *
 * Depo, her nesneyi düz bir kayıt olarak tutuyor (`{kind, x, z, scale, rot}`);
 * `y` saklanmıyor, her yeniden kurulumda araziden okunuyor. Böylece editörde
 * zemini yükseltmek altındaki ağaçları da kaldırıyor — ayrı bir "nesneleri
 * araziye oturt" adımı gerekmiyor.
 *
 * Her tür tek bir `InstancedMesh`; aynı tür birden çok bölgede geçse bile
 * (kaya her yerde var) tek çizim çağrısında toplanıyor. Kapasite paylık
 * bırakılarak ayrılıyor, dolunca mesh yeniden kuruluyor: editörde nesne
 * eklemek yaygın, mesh yeniden kurmak ise nadir olmalı.
 */

/** Yerleştirme aralık kontrolü için ızgara hücresi (m). */
const SPACING_CELL = 4;

export function createProps({ scene, heightfield, quality, propField = null }) {
  const group = new THREE.Group();
  scene.add(group);

  const rand = mulberry32(777001);
  const wind = createWindUniforms();
  const materials = createMaterials(wind);
  const kinds = createKinds(rand);
  const kindNames = Object.keys(kinds);

  /** Tüm nesneler tek düz listede; tür bazlı gruplar `buckets` içinde. */
  const buckets = new Map();
  for (const name of kindNames) buckets.set(name, []);

  const meshes = {};
  let collidersDirty = true;

  // --- yerleştirme yardımcıları -------------------------------------------
  // Aralık kontrolü ızgarayla: 3000 nesnenin her birini diğer hepsiyle
  // karşılaştırmak kareselleşiyor ve açılışı saniyelerce uzatıyordu.
  const spacingCols = Math.ceil(WORLD.playfield / SPACING_CELL);
  let spacingGrid = new Map();
  const biomeWeights = [0, 0, 0, 0];

  function tooClose(x, z, minRadius) {
    const i = Math.floor((x + WORLD.playfield * 0.5) / SPACING_CELL);
    const j = Math.floor((z + WORLD.playfield * 0.5) / SPACING_CELL);
    const reach = Math.ceil(minRadius / SPACING_CELL);
    const minSq = minRadius * minRadius;
    for (let dj = -reach; dj <= reach; dj++) {
      for (let di = -reach; di <= reach; di++) {
        const bucket = spacingGrid.get((j + dj) * spacingCols + (i + di));
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k += 2) {
          const dx = bucket[k] - x;
          const dz = bucket[k + 1] - z;
          if (dx * dx + dz * dz < minSq) return true;
        }
      }
    }
    return false;
  }

  function remember(x, z) {
    const i = Math.floor((x + WORLD.playfield * 0.5) / SPACING_CELL);
    const j = Math.floor((z + WORLD.playfield * 0.5) / SPACING_CELL);
    const key = j * spacingCols + i;
    let bucket = spacingGrid.get(key);
    if (!bucket) {
      bucket = [];
      spacingGrid.set(key, bucket);
    }
    bucket.push(x, z);
  }

  /**
   * Hedef bölgenin içinde, yamacı fazla dik olmayan ve patikanın üstüne
   * düşmeyen bir nokta arar.
   */
  function findSpot(biomeIndex, entry) {
    const limit = WORLD.playfield * 0.5 - 18;
    for (let attempt = 0; attempt < 20; attempt++) {
      const x = (rand() * 2 - 1) * limit;
      const z = (rand() * 2 - 1) * limit;
      if (Math.hypot(x, z) < 22) continue;

      heightfield.sampleBiome(x, z, biomeWeights);
      // Baskın olmayan bölgeye ait nesne serpmek, sınırları bulanıklaştırıp
      // "çölün ortasında çam" gibi sonuçlar veriyordu.
      if (biomeWeights[biomeIndex] < 0.55) continue;
      if (heightfield.sampleSlope(x, z) > entry.maxSlope) continue;
      if (heightfield.samplePath(x, z) > 0.3) continue;
      if (tooClose(x, z, entry.minRadius)) continue;

      remember(x, z);
      return { x, z };
    }
    return null;
  }

  // --- depo işlemleri ------------------------------------------------------

  function add(kindName, x, z, options = {}) {
    const kind = kinds[kindName];
    if (!kind) return null;
    const item = {
      kind: kindName,
      x,
      z,
      scale: options.scale ?? kind.scale(rand),
      rot: options.rot ?? rand() * Math.PI * 2,
      jitter: options.jitter ?? (kind.uniformScale ? 1 : 0.85 + rand() * 0.3),
      sway: options.sway ?? kind.sway * (0.75 + rand() * 0.5),
    };
    buckets.get(kindName).push(item);
    collidersDirty = true;
    return item;
  }

  /** Verilen dairenin içindeki nesneleri siler; silinen sayısını döner. */
  function removeNear(x, z, radius, kindFilter = null) {
    const rSq = radius * radius;
    let total = 0;
    for (const [name, list] of buckets) {
      if (kindFilter && name !== kindFilter) continue;
      let removed = 0;
      for (let i = list.length - 1; i >= 0; i--) {
        const dx = list[i].x - x;
        const dz = list[i].z - z;
        if (dx * dx + dz * dz <= rSq) {
          list.splice(i, 1);
          removed++;
        }
      }
      if (removed) rebuildKind(name);
      total += removed;
    }
    if (total) collidersDirty = true;
    return total;
  }

  function clear() {
    for (const name of kindNames) {
      buckets.get(name).length = 0;
      rebuildKind(name);
    }
    collidersDirty = true;
  }

  /** Bölgelerin `scatter` listelerine göre prosedürel serpme. */
  function seedScatter(density = quality.propDensity) {
    spacingGrid = new Map();
    for (let b = 0; b < BIOME_IDS.length; b++) {
      const biome = BIOMES[BIOME_IDS[b]];
      for (const entry of biome.scatter) {
        if (!kinds[entry.kind]) continue;
        const count = Math.round(entry.density * density);
        for (let i = 0; i < count; i++) {
          const spot = findSpot(b, entry);
          if (spot) add(entry.kind, spot.x, spot.z);
        }
      }
    }
    seedLandmarks();
    rebuildAll();
  }

  /**
   * Çöl çeyreğindeki büyük kaya oluşumları. Ayrı bir mesh değil, iri ölçekli
   * kaya örnekleri: editörde diğer her şey gibi seçilip silinebiliyorlar.
   */
  function seedLandmarks() {
    for (let i = 0; i < 4; i++) {
      const angle = Math.PI * 1.05 + (i / 4) * Math.PI * 0.55;
      const radius = 130 + rand() * 60;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      heightfield.sampleBiome(x, z, biomeWeights);
      if (biomeWeights[0] < 0.6) continue;

      const blocks = 3 + Math.floor(rand() * 3);
      for (let b = 0; b < blocks; b++) {
        add('rock', x + (rand() - 0.5) * 11, z + (rand() - 0.5) * 11, {
          scale: 4.5 + rand() * 5,
        });
      }
    }
  }

  // --- mesh kurulumu -------------------------------------------------------
  const _matrix = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scale = new THREE.Vector3();
  const _normal = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  const _align = new THREE.Quaternion();
  const _yaw = new THREE.Quaternion();
  const _identity = new THREE.Quaternion();

  function ensureMesh(name, needed) {
    let mesh = meshes[name];
    if (mesh && mesh.instanceMatrix.count >= needed) return mesh;

    if (mesh) {
      group.remove(mesh);
      mesh.dispose();
    }
    // Paylık kapasite: editörde tek tek nesne eklerken her seferinde mesh
    // yeniden kurmak, sürükleyerek ağaç dizmeyi tutuklaştırıyordu.
    const capacity = Math.max(64, Math.ceil(needed * 1.5) + 64);
    const kind = kinds[name];
    mesh = new THREE.InstancedMesh(kind.geometry, materials[kind.material], capacity);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.geometry.setAttribute(
      'aSway',
      new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
    );
    group.add(mesh);
    meshes[name] = mesh;
    return mesh;
  }

  function rebuildKind(name) {
    const list = buckets.get(name);
    const kind = kinds[name];
    const mesh = ensureMesh(name, list.length);
    const sway = mesh.geometry.getAttribute('aSway');

    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const y = heightfield.sampleBase(item.x, item.z);

      heightfield.sampleNormal(item.x, item.z, _normal);
      _align.setFromUnitVectors(_up, _normal);
      // Ağaçlar yamaçta da dik büyür; kayalar zemine yaslanır.
      _align.slerp(_identity, 1 - kind.align);
      _yaw.setFromAxisAngle(_up, item.rot);
      _quat.copy(_align).multiply(_yaw);

      _pos.set(item.x, y - kind.sink * item.scale, item.z);
      _scale.set(item.scale * item.jitter, item.scale, item.scale * item.jitter);
      _matrix.compose(_pos, _quat, _scale);
      mesh.setMatrixAt(i, _matrix);
      sway.array[i] = item.sway;
    }

    mesh.count = list.length;
    mesh.instanceMatrix.needsUpdate = true;
    sway.needsUpdate = true;
  }

  function rebuildAll() {
    for (const name of kindNames) rebuildKind(name);
    collidersDirty = true;
  }

  /**
   * Çarpıştırıcıları yeniden kurar. Fırça sürüklenirken her karede yapmak
   * gereksiz: bayrakla işaretlenip kare sonunda bir kez çalışıyor.
   */
  function flushColliders() {
    if (!collidersDirty || !propField) return;
    collidersDirty = false;
    propField.clear();
    for (const [name, list] of buckets) {
      const kind = kinds[name];
      if (!kind.collider) continue;
      for (const item of list) {
        const y = heightfield.sampleBase(item.x, item.z) - kind.sink * item.scale;
        const c = kind.collider(item.scale);
        propField.add(item.x, y + c.offsetY, item.z, c.radiusH, c.radiusV, {
          blocksWheel: c.blocksWheel,
          blocksBody: c.blocksBody,
        });
      }
    }
  }

  function updateWind(dt, weather) {
    wind.uWindTime.value += dt;
    wind.uWindDir.value.set(weather.windDir.x, weather.windDir.y);
    // Fırtınada ağaçlar gerçekten savrulsun: rüzgâr göstergesi sadece kumda
    // değil bitki örtüsünde de okunmalı.
    wind.uWindStrength.value = 0.28 + weather.derived.windSpeed * 0.05;
  }

  function toJSON() {
    const out = [];
    for (const [name, list] of buckets) {
      for (const item of list) {
        out.push([
          name,
          round(item.x, 2),
          round(item.z, 2),
          round(item.scale, 3),
          round(item.rot, 3),
          round(item.jitter, 3),
          round(item.sway, 2),
        ]);
      }
    }
    return out;
  }

  function fromJSON(list) {
    for (const name of kindNames) buckets.get(name).length = 0;
    for (const [name, x, z, scale, rot, jitter, sway] of list) {
      if (!kinds[name]) continue;
      buckets.get(name).push({ kind: name, x, z, scale, rot, jitter, sway });
    }
    rebuildAll();
  }

  function count() {
    let total = 0;
    for (const list of buckets.values()) total += list.length;
    return total;
  }

  function dispose() {
    Object.values(kinds).forEach((k) => k.geometry.dispose());
    Object.values(materials).forEach((m) => m.dispose());
    scene.remove(group);
  }

  seedScatter();

  return {
    group,
    materials,
    meshes,
    kinds,
    kindNames,
    wind,
    add,
    removeNear,
    clear,
    seedScatter,
    rebuildAll,
    rebuildKind,
    flushColliders,
    updateWind,
    toJSON,
    fromJSON,
    dispose,
    get count() {
      return count();
    },
  };
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
