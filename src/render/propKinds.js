import * as THREE from 'three';
import { mergeParts } from '../utils/geometry.js';

/**
 * Serpilen nesnelerin geometri ve materyalleri.
 *
 * `props.js` yerleştirmeyi ve düzenlemeyi yönetiyor; burada yalnız "bir çam
 * neye benzer" sorusunun cevabı var. Ayrılmalarının sebebi harita editörü:
 * editör tür listesini paletine dizmek için okuyor, sahneyi kurmadan.
 */

/**
 * `align` 1 = zemin normaline tam hizalı (kaya), 0 = her zaman dik (ağaç).
 * `sink` nesnenin ne kadar gömüleceği (ölçekle çarpılır).
 * `sway` rüzgârda ne kadar salınacağı (0 = kaya gibi sabit).
 */
export function createKinds(rand) {
  return {
    rock: {
      label: 'Kaya',
      geometry: createRockGeometry(),
      material: 'rock',
      align: 0.55,
      sink: 0.28,
      sway: 0,
      scale: (r) => 0.35 + r() * r() * 2.6,
      collider: (s) => ({
        radiusH: s * 0.95,
        radiusV: s * 0.72,
        offsetY: -s * 0.28,
        blocksWheel: true,
        blocksBody: s * 0.95 > 0.55,
      }),
    },

    deadBush: {
      label: 'Kuru çalı',
      geometry: createBushGeometry(rand, 0.006, 0.022),
      material: 'deadBush',
      align: 0.85,
      sink: 0.12,
      sway: 0.5,
      scale: (r) => 0.55 + r() * 0.75,
      collider: null,
    },

    bones: {
      label: 'Kemik',
      geometry: createBoneGeometry(),
      material: 'bone',
      align: 1.0,
      sink: 0.05,
      sway: 0,
      scale: (r) => 0.8 + r() * 0.6,
      collider: null,
    },

    pine: {
      label: 'Çam',
      geometry: createPineGeometry(false),
      material: 'pine',
      align: 0.12,
      sink: 0.15,
      sway: 0.55,
      uniformScale: true,
      scale: (r) => 0.75 + r() * r() * 0.9,
      // Gövde ince ve uzun: araç dalların arasından değil, gövdeden çarpar.
      collider: (s) => ({
        radiusH: 0.34 * s,
        radiusV: 2.4 * s,
        offsetY: 2.0 * s,
        blocksWheel: false,
        blocksBody: true,
      }),
    },

    snowPine: {
      label: 'Karlı çam',
      geometry: createPineGeometry(true),
      material: 'snowPine',
      align: 0.12,
      sink: 0.2,
      sway: 0.42,
      uniformScale: true,
      scale: (r) => 0.8 + r() * r() * 0.85,
      collider: (s) => ({
        radiusH: 0.34 * s,
        radiusV: 2.4 * s,
        offsetY: 2.0 * s,
        blocksWheel: false,
        blocksBody: true,
      }),
    },

    broadleaf: {
      label: 'Yapraklı ağaç',
      geometry: createBroadleafGeometry(rand),
      material: 'broadleaf',
      align: 0.1,
      sink: 0.15,
      sway: 0.75,
      uniformScale: true,
      scale: (r) => 0.9 + r() * 0.8,
      collider: (s) => ({
        radiusH: 0.4 * s,
        radiusV: 2.0 * s,
        offsetY: 1.8 * s,
        blocksWheel: false,
        blocksBody: true,
      }),
    },

    fern: {
      label: 'Eğreltiotu',
      geometry: createBushGeometry(rand, 0.008, 0.016),
      material: 'fern',
      align: 0.9,
      sink: 0.08,
      sway: 0.9,
      scale: (r) => 0.45 + r() * 0.4,
      collider: null,
    },

    grassTuft: {
      label: 'Çim',
      geometry: createGrassGeometry(rand),
      material: 'grass',
      align: 0.75,
      sink: 0.04,
      sway: 1.3,
      scale: (r) => 0.7 + r() * 0.7,
      collider: null,
    },

    log: {
      label: 'Kütük',
      geometry: createLogGeometry(),
      material: 'pine',
      align: 0.9,
      sink: 0.18,
      sway: 0,
      scale: (r) => 0.8 + r() * 0.7,
      collider: (s) => ({
        radiusH: 1.5 * s,
        radiusV: 0.34 * s,
        offsetY: 0.1 * s,
        blocksWheel: true,
        blocksBody: false,
      }),
    },
  };
}

/**
 * Rüzgâr salınımı. Materyal başına tek bir uniform seti; salınımın gücü
 * `aSway` örnek niteliğinden geliyor, böylece aynı materyali paylaşan kaya ve
 * kütük hiç kıpırdamıyor.
 *
 * Yerel `position.y` doğrudan kaldıraç kolu olarak kullanılıyor: bu
 * geometrilerin hepsi tabandan (y=0) yukarı doğru kuruluyor, dolayısıyla dip
 * çakılı kalırken tepe savruluyor. Kare oranı, esnemeyi gövde boyunca değil
 * uçlarda topluyor.
 */
export function applyWindSway(material, wind) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindDir = wind.uWindDir;
    shader.uniforms.uWindStrength = wind.uWindStrength;
    shader.uniforms.uWindTime = wind.uWindTime;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        attribute float aSway;
        uniform vec2 uWindDir;
        uniform float uWindStrength;
        uniform float uWindTime;
        `
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        #ifdef USE_INSTANCING
        {
          float lever = max(transformed.y, 0.0);
          float amp = aSway * uWindStrength * lever * lever * 0.06;
          if (amp > 0.0001) {
            // Faz, örneğin dünya konumundan geliyor: yan yana iki çalı aynı
            // anda aynı yöne yatarsa çayır tek parça bir örtü gibi dalgalanıyor.
            float phase = instanceMatrix[3].x * 0.35 + instanceMatrix[3].z * 0.27;
            float gust = sin(uWindTime * 1.9 + phase) * 0.65
                       + sin(uWindTime * 4.7 + phase * 2.3) * 0.35;
            transformed.xz += uWindDir * amp * gust;
          }
        }
        #endif
        `
      );
  };
  material.customProgramCacheKey = () => 'sway';
}

export function createWindUniforms() {
  return {
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uWindStrength: { value: 0.4 },
    uWindTime: { value: 0 },
  };
}

export function createMaterials(wind) {
  const materials = {
    rock: new THREE.MeshStandardMaterial({ color: 0x8a7256, roughness: 0.94, metalness: 0.02 }),
    darkRock: new THREE.MeshStandardMaterial({ color: 0x6b5943, roughness: 0.96, metalness: 0.02 }),
    deadBush: new THREE.MeshStandardMaterial({ color: 0x6d5c3c, roughness: 0.95, metalness: 0 }),
    bone: new THREE.MeshStandardMaterial({ color: 0xd8cfb8, roughness: 0.8, metalness: 0 }),
    // Vertex renkleri gövde/iğne ayrımını ve kar birikintisini taşıyor:
    // tek materyalle iki farklı yüzey.
    pine: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.92,
      metalness: 0,
      vertexColors: true,
    }),
    snowPine: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.78,
      metalness: 0,
      vertexColors: true,
    }),
    broadleaf: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0,
      vertexColors: true,
    }),
    fern: new THREE.MeshStandardMaterial({ color: 0x4a6b2c, roughness: 0.93, metalness: 0 }),
    grass: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.94,
      metalness: 0,
      vertexColors: true,
      side: THREE.DoubleSide,
    }),
  };

  if (wind) for (const material of Object.values(materials)) applyWindSway(material, wind);
  return materials;
}

/** Geometriye tek renk vertex rengi basar (birleştirmede karışabilsin diye). */
function paint(geometry, hex) {
  const color = new THREE.Color(hex);
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Gürültüyle bozulmuş ikosahedron — hiçbir kaya diğerine benzemesin diye. */
function createRockGeometry() {
  const geometry = new THREE.IcosahedronGeometry(1, 2);
  const position = geometry.attributes.position;
  const v = new THREE.Vector3();

  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    // Yön bazlı deterministik bozulma: aynı vertex her seferinde aynı kayar,
    // böylece paylaşılan kenarlar ayrılmaz.
    const n =
      Math.sin(v.x * 3.1 + 1.7) * 0.5 +
      Math.sin(v.y * 4.3 + 0.4) * 0.3 +
      Math.sin(v.z * 2.7 + 2.9) * 0.4;
    v.multiplyScalar(1 + n * 0.22);
    // Kayalar tabanda yayvan, üstte sivri.
    v.y *= 0.72;
    position.setXYZ(i, v.x, v.y, v.z);
  }

  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/** Merkezden dışa açılan ince dallar — kuru çalı ve eğreltiotu için. */
function createBushGeometry(rand, tipRadius, baseRadius) {
  const parts = [];
  const branches = 16;
  for (let i = 0; i < branches; i++) {
    const angle = (i / branches) * Math.PI * 2 + rand() * 0.5;
    const tilt = 0.5 + rand() * 0.7;
    const length = 0.55 + rand() * 0.55;

    const branch = new THREE.CylinderGeometry(tipRadius, baseRadius, length, 4);
    branch.translate(0, length / 2, 0);
    branch.rotateZ(tilt);
    branch.rotateY(angle);
    parts.push(branch);

    if (rand() > 0.45) {
      const twig = new THREE.CylinderGeometry(tipRadius * 0.7, baseRadius * 0.5, length * 0.5, 4);
      twig.translate(0, length * 0.25, 0);
      twig.rotateZ(tilt + 0.5);
      twig.rotateY(angle + 0.4);
      twig.translate(
        Math.sin(tilt) * Math.cos(angle) * length * 0.8,
        Math.cos(tilt) * length * 0.8,
        -Math.sin(tilt) * Math.sin(angle) * length * 0.8
      );
      parts.push(twig);
    }
  }
  return mergeParts(parts);
}

/** Kumdan çıkmış birkaç kaburga ve bir omurga parçası. */
function createBoneGeometry() {
  const parts = [];
  const spine = new THREE.CylinderGeometry(0.05, 0.05, 1.5, 6);
  spine.rotateZ(Math.PI / 2);
  parts.push(spine);

  for (let i = 0; i < 6; i++) {
    const t = (i / 5 - 0.5) * 1.3;
    for (const side of [-1, 1]) {
      const rib = new THREE.TorusGeometry(0.32, 0.028, 5, 10, Math.PI * 0.75);
      rib.rotateY(Math.PI / 2);
      rib.rotateZ(side > 0 ? 0.4 : Math.PI - 0.4);
      rib.translate(t, 0.06, side * 0.05);
      parts.push(rib);
    }
  }
  const merged = mergeParts(parts);
  merged.computeVertexNormals();
  return merged;
}

/**
 * İğne yapraklı ağaç: gövde + üst üste binen üç koni.
 * Karlı sürümde koni yüzeyleri beyaza boyanıyor ve tepelere kar tabakası
 * ekleniyor — ayrı model yerine aynı iskeletin iki boyaması.
 */
function createPineGeometry(snowy) {
  const parts = [];

  const trunk = new THREE.CylinderGeometry(0.14, 0.24, 2.4, 7);
  trunk.translate(0, 1.2, 0);
  parts.push(paint(trunk, 0x4a3826));

  const tiers = [
    { y: 1.9, radius: 1.5, height: 2.2 },
    { y: 3.2, radius: 1.15, height: 2.0 },
    { y: 4.4, radius: 0.78, height: 1.8 },
  ];

  const needle = snowy ? 0x35563f : 0x2f5133;
  for (const tier of tiers) {
    const cone = new THREE.ConeGeometry(tier.radius, tier.height, 9);
    cone.translate(0, tier.y + tier.height * 0.5, 0);
    parts.push(paint(cone, needle));

    if (snowy) {
      // Dalların üstünde biriken kar: aynı koninin biraz basık kopyası.
      const cap = new THREE.ConeGeometry(tier.radius * 0.93, tier.height * 0.62, 9);
      cap.translate(0, tier.y + tier.height * 0.5 + tier.height * 0.28, 0);
      parts.push(paint(cap, 0xeef4fb));
    }
  }

  const merged = mergeParts(parts);
  merged.computeVertexNormals();
  return merged;
}

/** Geniş yapraklı ağaç: gövde + üç örtüşen yaprak kütlesi. */
function createBroadleafGeometry(rand) {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.16, 0.28, 2.6, 7);
  trunk.translate(0, 1.3, 0);
  parts.push(paint(trunk, 0x53412c));

  for (let i = 0; i < 3; i++) {
    const blob = new THREE.IcosahedronGeometry(1.05 + rand() * 0.45, 1);
    blob.scale(1, 0.82, 1);
    blob.translate((rand() - 0.5) * 1.1, 3.0 + rand() * 0.9, (rand() - 0.5) * 1.1);
    parts.push(paint(blob, i === 0 ? 0x4c6f2e : 0x577c33));
  }

  const merged = mergeParts(parts);
  merged.computeVertexNormals();
  return merged;
}

/** Çim tutamı: tabandan çıkıp uçları kıvrılan ince bıçaklar. */
function createGrassGeometry(rand) {
  const parts = [];
  const blades = 7;
  for (let i = 0; i < blades; i++) {
    const angle = (i / blades) * Math.PI * 2 + rand() * 0.7;
    const lean = 0.2 + rand() * 0.5;
    const height = 0.3 + rand() * 0.28;

    const blade = new THREE.ConeGeometry(0.026, height, 3);
    blade.translate(0, height * 0.5, 0);
    blade.rotateZ(lean);
    blade.rotateY(angle);
    // Uçlar dipten daha açık: ışıkta canlı görünüyor.
    parts.push(paint(blade, rand() > 0.5 ? 0x6f9440 : 0x5c8036));
  }
  const merged = mergeParts(parts);
  merged.computeVertexNormals();
  return merged;
}

/** Devrilmiş gövde: yatay kütük ve birkaç kırık dal. */
function createLogGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.3, 0.34, 3.4, 9);
  trunk.rotateZ(Math.PI / 2);
  trunk.translate(0, 0.3, 0);
  parts.push(paint(trunk, 0x4a3826));

  for (const [x, angle] of [
    [-0.9, 0.7],
    [0.6, -0.5],
  ]) {
    const branch = new THREE.CylinderGeometry(0.07, 0.11, 0.9, 5);
    branch.translate(0, 0.45, 0);
    branch.rotateZ(angle);
    branch.translate(x, 0.4, 0.1);
    parts.push(paint(branch, 0x51402c));
  }

  const merged = mergeParts(parts);
  merged.computeVertexNormals();
  return merged;
}
