import * as THREE from 'three';
import {
  HEIGHT_SAMPLER_GLSL,
  TERRAIN_SHADOW_GLSL,
  BIOME_SAMPLER_GLSL,
  TRACK_SAMPLER_GLSL,
  TRACK_DETAIL_GLSL,
  NOISE_GLSL,
  RIPPLE_GLSL,
} from './glsl.js';
import { WORLD } from '../config/settings.js';
import { BIOME_LIST, PATH } from '../config/biomes.js';

/**
 * Zemin materyali: `MeshStandardMaterial` üzerine shader enjeksiyonu.
 *
 * Sıfırdan bir ShaderMaterial yazmak yerine standart materyali yamamak, PBR
 * aydınlatmayı, gölge haritalarını, sisi ve ton eşlemeyi hazır getiriyor;
 * bize sadece yükseklik, normal ve renk üretmek kalıyor.
 *
 * Normal üretiminin tamamı **yüzey gradyanı** üzerinden yapılıyor. Sahnedeki
 * her katman bir yükseklik alanı olduğu için (arazi, iz oyuğu, lastik dişi,
 * rüzgâr dalgacığı) gradyanları doğrudan toplanabilir; normal en sonda bir kez
 * kuruluyor. Katman başına normal üretip harmanlamaktan hem ucuz hem doğru.
 *
 * Zemin görünümü dört bölge paletinin ağırlıklı karışımı. Tek bir materyal ve
 * tek bir program: bölge başına ayrı mesh ya da ayrı geçiş yok.
 */

function colorArray(hexes) {
  return hexes.map((hex) => new THREE.Color(hex));
}

export function createSandUniforms({ heightfield, trackMap, trackResolution, terrainShadow }) {
  return {
    ...heightfield.uniforms,
    ...trackMap.uniforms,
    // Ufuk haritası uniform'ları nesne ve jip materyalleriyle paylaşılıyor:
    // güneş hareket ettiğinde tek yerden güncelleniyorlar.
    ...terrainShadow,
    uTrackTexelWorld: { value: WORLD.playfield / trackResolution },
    uTrackNormalStrength: { value: 1.4 },
    uRippleStrength: { value: 1.0 },
    uWindDir: { value: new THREE.Vector2(Math.cos(WORLD.windAngle), Math.sin(WORLD.windAngle)) },
    uSkirtDepth: { value: 0 },

    // --- bölge paletleri (sıra: çöl, orman, kar, çayır) --------------------
    uBiomeColorA: { value: colorArray(BIOME_LIST.map((b) => b.ground.colorA)) },
    uBiomeColorB: { value: colorArray(BIOME_LIST.map((b) => b.ground.colorB)) },
    uBiomeColorSteep: { value: colorArray(BIOME_LIST.map((b) => b.ground.colorSteep)) },
    uBiomePacked: { value: colorArray(BIOME_LIST.map((b) => b.ground.packedTint)) },
    uBiomeRoughness: { value: BIOME_LIST.map((b) => b.ground.roughness) },
    uBiomeRipple: { value: BIOME_LIST.map((b) => b.ground.ripple) },
    uBiomeSparkle: { value: BIOME_LIST.map((b) => b.ground.sparkle) },
    uBiomeGrain: { value: BIOME_LIST.map((b) => b.ground.grain) },

    uPathColor: { value: new THREE.Color(PATH.ground.color) },
    uPathRoughness: { value: PATH.ground.roughness },
  };
}

const VERTEX_HEADER = /* glsl */ `
attribute float aSkirt;

uniform float uSkirtDepth;

varying vec2 vTerrainGrad;
varying vec2 vWorldXZ;

${HEIGHT_SAMPLER_GLSL}
${TRACK_SAMPLER_GLSL}

// Yükseklik ve gradyan bir kez hesaplanıp iki enjeksiyon noktası arasında
// paylaşılıyor: normal bloğu vertex konumundan önce çalıştığı için değer
// oradan buraya global üzerinden taşınıyor.
vec2 gWorldXZ;
vec2 gTerrainGrad;
float gTerrainH;
`;

const FRAGMENT_HEADER = /* glsl */ `
varying vec2 vTerrainGrad;
varying vec2 vWorldXZ;

uniform float uTrackTexelWorld;
uniform float uTrackNormalStrength;
#ifdef TERRAIN_HOLE
  uniform vec2 uHoleCenter;
  uniform float uHoleHalf;
#endif

uniform vec3 uBiomeColorA[4];
uniform vec3 uBiomeColorB[4];
uniform vec3 uBiomeColorSteep[4];
uniform vec3 uBiomePacked[4];
uniform float uBiomeRoughness[4];
uniform float uBiomeRipple[4];
uniform float uBiomeSparkle[4];
uniform float uBiomeGrain[4];
uniform vec3 uPathColor;
uniform float uPathRoughness;

${HEIGHT_SAMPLER_GLSL}
${TERRAIN_SHADOW_GLSL}
${BIOME_SAMPLER_GLSL}
${TRACK_SAMPLER_GLSL}
${NOISE_GLSL}
${TRACK_DETAIL_GLSL}
${RIPPLE_GLSL}

vec4 gTrk;
vec2 gTrkGrad;
float gPacked;
float gDetailFade;
float gRipple;
float gSparkle;
`;

export function createSandMaterial({
  uniforms,
  trackDisplace = true,
  skirtDepth = 0,
  /**
   * Bu kabuğun ortasında açılacak delik. Dıştaki kaba kabuk, içteki ince
   * kabuğun kapladığı alanda `discard` eder — iki kabuk üst üste çizilmez,
   * dolayısıyla z-fighting da olmaz. Delik, içteki kabuğun gerçek yüzeyinden
   * biraz küçük tutulur ki aralarında bindirme payı kalsın.
   */
  hole = null,
  side = THREE.FrontSide,
  wireframe = false,
} = {}) {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0.0,
    dithering: true,
    side,
    wireframe,
  });

  material.defines = material.defines || {};
  if (trackDisplace) material.defines.TERRAIN_TRACK_DISPLACE = '';
  if (hole) material.defines.TERRAIN_HOLE = '';

  const skirtUniform = { value: skirtDepth };
  const holeUniforms = hole
    ? {
        uHoleCenter: hole.center ? { value: hole.center } : { value: new THREE.Vector2() },
        uHoleHalf: { value: hole.half ?? 0 },
      }
    : null;

  material.userData.uniforms = uniforms;
  material.userData.skirt = skirtUniform;
  material.userData.hole = holeUniforms;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    // Kabuk başına farklı değerler: ortak uniform nesnesini bozmadan yalnız bu
    // materyale ait kopyalar bağlanıyor.
    shader.uniforms.uSkirtDepth = skirtUniform;
    if (holeUniforms) Object.assign(shader.uniforms, holeUniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_HEADER}`)
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `
        gWorldXZ = (modelMatrix * vec4(position, 1.0)).xz;
        gTerrainH = sampleTerrain(gWorldXZ, gTerrainGrad);
        // modelMatrix saf ötelemedir (arazi kabukları hiç dönmez), bu yüzden
        // nesne uzayı ile dünya uzayı yönleri çakışır.
        vec3 objectNormal = normalize(vec3(-gTerrainGrad.x, 1.0, -gTerrainGrad.y));
        `
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        float trackY = 0.0;
        #ifdef TERRAIN_TRACK_DISPLACE
          trackY = trackHeightAt(gWorldXZ);
        #endif

        vec3 transformed = vec3(position);
        transformed.y = gTerrainH + trackY - aSkirt * uSkirtDepth;

        vTerrainGrad = gTerrainGrad;
        vWorldXZ = gWorldXZ;
        `
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_HEADER}`)
      .replace(
        '#include <clipping_planes_fragment>',
        /* glsl */ `
        #include <clipping_planes_fragment>
        #ifdef TERRAIN_HOLE
          vec2 holeDist = abs(vWorldXZ - uHoleCenter);
          if (max(holeDist.x, holeDist.y) < uHoleHalf) discard;
        #endif
        `
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        #include <map_fragment>
        {
          float viewDist = length(vViewPosition);
          gDetailFade = 1.0 - smoothstep(60.0, 230.0, viewDist);
          gTrk = sampleTrack(vWorldXZ);
          gPacked = clamp(gTrk.b * 1.25, 0.0, 1.0);

          vec4 bw = sampleBiome(vWorldXZ);
          float path = samplePath(vWorldXZ) * bw.a;

          gRipple = blendBiome(uBiomeRipple[0], uBiomeRipple[1], uBiomeRipple[2], uBiomeRipple[3], bw);
          gSparkle = blendBiome(uBiomeSparkle[0], uBiomeSparkle[1], uBiomeSparkle[2], uBiomeSparkle[3], bw);
          float grain = blendBiome(uBiomeGrain[0], uBiomeGrain[1], uBiomeGrain[2], uBiomeGrain[3], bw);

          // Geniş doku damarları: zeminin tek renk bir hamur gibi görünmesini
          // engelleyen en etkili tek katman.
          float macro = fbm2(vWorldXZ * 0.011) * 0.5 + 0.5;
          float meso = fbm2(vWorldXZ * 0.075 + 19.0) * 0.5 + 0.5;
          float mixT = macro * 0.75 + meso * 0.25;

          vec3 colA = blendBiomeColor(uBiomeColorA[0], uBiomeColorA[1], uBiomeColorA[2], uBiomeColorA[3], bw);
          vec3 colB = blendBiomeColor(uBiomeColorB[0], uBiomeColorB[1], uBiomeColorB[2], uBiomeColorB[3], bw);
          vec3 colS = blendBiomeColor(uBiomeColorSteep[0], uBiomeColorSteep[1], uBiomeColorSteep[2], uBiomeColorSteep[3], bw);
          vec3 packedTint = blendBiomeColor(uBiomePacked[0], uBiomePacked[1], uBiomePacked[2], uBiomePacked[3], bw);

          vec3 col = mix(colA, colB, mixT);

          // Dik yamaçlar (kayma yüzleri, kaya çıkıntıları) farklı renktedir.
          float slope = clamp(length(vTerrainGrad), 0.0, 1.4);
          col = mix(col, colS, smoothstep(0.30, 1.05, slope));

          // Toprak patika çimin üstüne biniyor. Rengi boyunca dalgalanıyor:
          // düz bir şerit, araziye çizilmiş bant gibi duruyordu.
          vec3 pathCol = uPathColor * (0.82 + fbm2(vWorldXZ * 0.35) * 0.32);
          col = mix(col, pathCol, path);

          // Ezilmiş zemin sıkışıp koyulaşır; kenara savrulan malzeme açılır.
          col = mix(col, col * packedTint * 1.35, gPacked * 0.34);
          col = mix(col, col * 1.07 + 0.02, clamp(gTrk.g, 0.0, 1.0) * 0.5);

          // Yakın planda ince gren — çimde ve orman zemininde belirgin,
          // kumda ve karda neredeyse yok.
          col *= 1.0 + valueNoise(vWorldXZ * 31.0) * grain * gDetailFade;
          col *= 1.0 + fbm2(vWorldXZ * 3.4) * grain * 0.6 * gDetailFade;

          diffuseColor.rgb *= col;
        }
        `
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        #include <roughnessmap_fragment>
        {
          vec4 bw = sampleBiome(vWorldXZ);
          float base = blendBiome(uBiomeRoughness[0], uBiomeRoughness[1], uBiomeRoughness[2], uBiomeRoughness[3], bw);
          roughnessFactor = mix(base, base - 0.2, gPacked);
          roughnessFactor = mix(roughnessFactor, uPathRoughness, samplePath(vWorldXZ) * bw.a);
          roughnessFactor -= clamp(gTrk.g, 0.0, 1.0) * 0.02;
          // Mika/kar kristali pırıltısı: yüksek frekanslı tekil parlamalar.
          float glint = step(0.9955, hash21(floor(vWorldXZ * 420.0)));
          roughnessFactor -= glint * 0.5 * gDetailFade * gSparkle;
          roughnessFactor = clamp(roughnessFactor, 0.05, 1.0);
        }
        `
      )
      .replace(
        '#include <normal_fragment_begin>',
        /* glsl */ `
        #include <normal_fragment_begin>
        {
          // Tüm yükseklik katmanlarının gradyanları toplanır, normal en sonda
          // bir kez kurulur.
          vec2 grad = vTerrainGrad;

          float trackFade = 1.0 - smoothstep(120.0, 420.0, length(vViewPosition));
          gTrkGrad = trackGradient(vWorldXZ, uTrackTexelWorld * 0.8)
                   * uTrackNormalStrength * trackFade;
          grad += gTrkGrad;
          grad += treadGradient(vWorldXZ, gTrkGrad, gTrk.r) * gDetailFade;
          grad += rippleGradient(vWorldXZ, gDetailFade * gRipple);

          vec3 worldN = normalize(vec3(-grad.x, 1.0, -grad.y));
          normal = normalize((viewMatrix * vec4(worldN, 0.0)).xyz);
        }
        `
      )
      .replace(
        '#include <aomap_fragment>',
        /* glsl */ `
        #include <aomap_fragment>
        {
          // Ufuk haritasından gelen uzun menzilli güneş gölgesi ve arazi
          // örtmesi. Doğrudan ışık gölgeyle, dolaylı ışık örtmeyle çarpılıyor —
          // ikisini karıştırmak, gölgedeki kum tepesini simsiyah yapardı.
          float sunShadow = terrainSunShadow(vWorldXZ);
          float terrainAo = terrainOcclusion(vWorldXZ);
          reflectedLight.directDiffuse *= sunShadow;
          reflectedLight.directSpecular *= sunShadow;
          reflectedLight.indirectDiffuse *= terrainAo;
          reflectedLight.indirectSpecular *= terrainAo;
        }
        `
      );

    material.userData.shader = shader;
  };

  // Enjeksiyon materyalin program anahtarını değiştirdiği için özel bir anahtar
  // gerekiyor; aksi halde three.js farklı kabukları aynı programda birleştirir.
  material.customProgramCacheKey = () => `ground|${trackDisplace}|${!!hole}|${side}`;

  return material;
}

/**
 * Gölge geçişi için derinlik materyali. Arazi yüksekliği vertex shader'da
 * üretildiği için varsayılan `MeshDepthMaterial` düz bir zemin görür ve
 * gölgeler tamamen yanlış çıkar; bu yüzden aynı yer değiştirme burada da
 * uygulanmak zorunda.
 */
export function createSandDepthMaterial({ uniforms, trackDisplace = true, skirtDepth = 0 }) {
  const material = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
  });

  material.defines = material.defines || {};
  if (trackDisplace) material.defines.TERRAIN_TRACK_DISPLACE = '';

  const skirtUniform = { value: skirtDepth };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.uniforms.uSkirtDepth = skirtUniform;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        attribute float aSkirt;
        uniform float uSkirtDepth;
        ${HEIGHT_SAMPLER_GLSL}
        ${TRACK_SAMPLER_GLSL}
        `
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        vec2 dWorldXZ = (modelMatrix * vec4(position, 1.0)).xz;
        vec2 dGrad;
        float dHeight = sampleTerrain(dWorldXZ, dGrad);
        float dTrack = 0.0;
        #ifdef TERRAIN_TRACK_DISPLACE
          dTrack = trackHeightAt(dWorldXZ);
        #endif
        vec3 transformed = vec3(position);
        transformed.y = dHeight + dTrack - aSkirt * uSkirtDepth;
        `
      );
  };

  material.customProgramCacheKey = () => `groundDepth|${trackDisplace}`;

  return material;
}

/**
 * GTAO'nun normal/derinlik ön geçişi için arazi materyali.
 *
 * `GTAOPass` kendi G-tamponunu `scene.overrideMaterial` ile çiziyor; bu da
 * bizim vertex shader'ımızı devre dışı bırakıp araziyi **düz bir tabla**
 * olarak görmesi demek — üretilen örtme tamamen yanlış olurdu. Bu yüzden
 * G-tamponu kendimiz çiziyoruz ve araziye aynı yer değiştirmeyi taşıyan bu
 * materyali veriyoruz. Normal, yüzey gradyanından kuruluyor: `MeshNormalMaterial`
 * geometrinin düz normalini yazardı, oysa bizim yüzeyimizin asıl detayı
 * fragment'ta doğuyor.
 */
export function createSandNormalMaterial({ uniforms, trackDisplace = true, skirtDepth = 0 }) {
  const skirtUniform = { value: skirtDepth };

  return new THREE.ShaderMaterial({
    defines: trackDisplace ? { TERRAIN_TRACK_DISPLACE: '' } : {},
    uniforms: { ...uniforms, uSkirtDepth: skirtUniform },
    vertexShader: /* glsl */ `
      attribute float aSkirt;
      uniform float uSkirtDepth;
      varying vec2 vWorldXZ;
      varying vec2 vGrad;

      ${HEIGHT_SAMPLER_GLSL}
      ${TRACK_SAMPLER_GLSL}

      void main() {
        vec2 worldXZ = (modelMatrix * vec4(position, 1.0)).xz;
        vec2 grad;
        float h = sampleTerrain(worldXZ, grad);
        float trackY = 0.0;
        #ifdef TERRAIN_TRACK_DISPLACE
          trackY = trackHeightAt(worldXZ);
        #endif
        vec3 transformed = vec3(position);
        transformed.y = h + trackY - aSkirt * uSkirtDepth;

        vWorldXZ = worldXZ;
        vGrad = grad;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vWorldXZ;
      varying vec2 vGrad;

      ${HEIGHT_SAMPLER_GLSL}
      ${TRACK_SAMPLER_GLSL}
      ${TRACK_DETAIL_GLSL}

      void main() {
        vec2 grad = vGrad + trackGradient(vWorldXZ, 0.2);
        vec3 worldN = normalize(vec3(-grad.x, 1.0, -grad.y));
        vec3 viewN = normalize((viewMatrix * vec4(worldN, 0.0)).xyz);
        gl_FragColor = vec4(viewN * 0.5 + 0.5, 1.0);
      }
    `,
    blending: THREE.NoBlending,
  });
}
