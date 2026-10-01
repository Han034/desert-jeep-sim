import * as THREE from 'three';
import { WORLD } from '../config/settings.js';
import {
  createSandUniforms,
  createSandMaterial,
  createSandNormalMaterial,
} from './sandMaterial.js';

/**
 * Arazi, iç içe geçmiş üç kabuktan oluşur:
 *
 *   near — 64 m, kameraya kilitli, 0.125 m/vertex → lastik izleri burada
 *          gerçek geometri olarak çukurlaşır
 *   mid  — 768 m, sabit, 2 m/vertex → oynanabilir alan ve çanak kenarı
 *   far  — 3072 m, sabit, 16 m/vertex → ufuk siluetleri
 *
 * Kabuklar üst üste çizilmez: dıştaki kabuk, içtekinin ayak izinde `discard`
 * eder. Bindirme payı bırakılır ve içteki kabuğun dış halkası aşağı sarkan bir
 * "etek"e dönüşür, böylece iki farklı yoğunluktaki ızgaranın arasında ışık
 * sızdıran dikiş kalmaz.
 *
 * Yakın kabuk her karede kendi hücre boyutuna yuvarlanarak konumlanır; aksi
 * halde araç ilerlerken vertex'ler arazinin üstünde kayar ve zemin "yüzer".
 */
export function createTerrain({ scene, heightfield, trackMap, quality, terrainShadow }) {
  const uniforms = createSandUniforms({
    heightfield,
    trackMap,
    trackResolution: quality.trackRes,
    terrainShadow,
  });

  const holeCenter = new THREE.Vector2(0, 0);

  const nearHalf = WORLD.nearPatch * 0.5;
  const midHalf = WORLD.midSize * 0.5;
  const midCell = WORLD.midSize / WORLD.midSegments;

  const shells = {};

  // --- yakın kabuk ---------------------------------------------------------
  const nearMaterial = createSandMaterial({
    uniforms,
    trackDisplace: true,
    skirtDepth: 1.2,
    side: THREE.DoubleSide,
  });
  /**
   * Arazi artık gölge haritasına **yazmıyor**. Kendi gölgesini ufuk
   * haritasından analitik olarak alıyor (menzil sınırsız, kademe yok); ikisi
   * birlikte çalışsaydı yakın plandaki tepe gölgeleri iki kez uygulanıp
   * fazladan koyulaşırdı. Yan fayda: her karede 400 bin vertex'lik bir
   * derinlik geçişi tamamen kalktı.
   *
   * Derinlik materyali yine de kuruluyor — GTAO'nun G-tamponu ve olası bir
   * geri dönüş için aynı yer değiştirmeye ihtiyaç var.
   */
  shells.near = new THREE.Mesh(makeShellGeometry(WORLD.nearPatch, quality.nearSegments), nearMaterial);
  // GTAO'nun G-tamponu için: aynı yer değiştirmeyi taşıyan normal materyali.
  shells.near.userData.normalMaterial = createSandNormalMaterial({
    uniforms,
    trackDisplace: true,
    skirtDepth: 1.2,
  });
  shells.near.castShadow = false;
  shells.near.receiveShadow = true;
  shells.near.frustumCulled = false;
  shells.near.renderOrder = 0;
  // Bindirme bandında derinlik eşitliğini yakın kabuk kazansın.
  nearMaterial.polygonOffset = true;
  nearMaterial.polygonOffsetFactor = -2;
  nearMaterial.polygonOffsetUnits = -2;

  // --- orta kabuk ----------------------------------------------------------
  const midMaterial = createSandMaterial({
    uniforms,
    trackDisplace: true,
    skirtDepth: 6,
    side: THREE.DoubleSide,
    hole: { center: holeCenter, half: 0 },
  });
  shells.mid = new THREE.Mesh(makeShellGeometry(WORLD.midSize, WORLD.midSegments), midMaterial);
  shells.mid.userData.normalMaterial = createSandNormalMaterial({
    uniforms,
    trackDisplace: true,
    skirtDepth: 6,
  });
  shells.mid.castShadow = false;
  shells.mid.receiveShadow = true;
  shells.mid.frustumCulled = false;
  shells.mid.renderOrder = 1;

  // --- uzak kabuk ----------------------------------------------------------
  const farMaterial = createSandMaterial({
    uniforms,
    trackDisplace: false,
    skirtDepth: 0,
    hole: { center: new THREE.Vector2(0, 0), half: midHalf - 3 * midCell },
  });

  shells.far = new THREE.Mesh(makeShellGeometry(WORLD.farSize, WORLD.farSegments), farMaterial);
  shells.far.castShadow = false;
  shells.far.receiveShadow = true;
  shells.far.frustumCulled = false;
  shells.far.renderOrder = 2;

  scene.add(shells.near, shells.mid, shells.far);

  let nearSegments = quality.nearSegments;
  let snap = WORLD.nearPatch / nearSegments;
  refreshHole();

  function refreshHole() {
    // Delik, yakın kabuğun son gerçek vertex halkasından (etek hariç) 0.75 m
    // içeride kalır — kalan bant iki kabuğun bindirme payıdır.
    midMaterial.userData.hole.uHoleHalf.value = nearHalf - snap - 0.75;
  }

  /** Yakın kabuğu odak noktasına taşır ve orta kabuğun deliğini eşitler. */
  function update(focusX, focusZ) {
    const cx = Math.round(focusX / snap) * snap;
    const cz = Math.round(focusZ / snap) * snap;
    shells.near.position.set(cx, 0, cz);
    holeCenter.set(cx, cz);
  }

  function setNearSegments(segments) {
    if (segments === nearSegments) return;
    nearSegments = segments;
    const old = shells.near.geometry;
    shells.near.geometry = makeShellGeometry(WORLD.nearPatch, segments);
    old.dispose();
    snap = WORLD.nearPatch / nearSegments;
    refreshHole();
  }

  function setTrackResolution(res) {
    uniforms.uTrackTexelWorld.value = WORLD.playfield / res;
  }

  function dispose() {
    Object.values(shells).forEach((mesh) => {
      mesh.geometry.dispose();
      mesh.material.dispose();
      if (mesh.customDepthMaterial) mesh.customDepthMaterial.dispose();
      scene.remove(mesh);
    });
  }

  return {
    uniforms,
    shells,
    update,
    setNearSegments,
    setTrackResolution,
    dispose,
    get triangleCount() {
      return Object.values(shells).reduce((sum, m) => sum + m.geometry.index.count / 3, 0);
    },
  };
}

/**
 * XZ düzleminde yatan bir ızgara. Dış halkadaki vertex'ler `aSkirt = 1` ile
 * işaretlenir; vertex shader onları aşağı sarkıtarak eteği oluşturur — ayrı
 * geometri eklemeye gerek kalmadan komşu kabukla arasındaki çatlak kapanır.
 */
function makeShellGeometry(size, segments) {
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  geometry.rotateX(-Math.PI / 2);

  const side = segments + 1;
  const skirt = new Float32Array(side * side);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      if (i === 0 || j === 0 || i === segments || j === segments) {
        skirt[j * side + i] = 1;
      }
    }
  }
  geometry.setAttribute('aSkirt', new THREE.BufferAttribute(skirt, 1));

  // Yükseklik vertex shader'da üretildiği için CPU'daki sınırlayıcı hacim
  // yanlış olur; kabuklar zaten `frustumCulled = false`.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), size);
  return geometry;
}
