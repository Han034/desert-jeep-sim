import * as THREE from 'three';
import { HEIGHT_SAMPLER_GLSL, TERRAIN_SHADOW_GLSL } from './glsl.js';
import { createSunHorizonUniforms, updateSunHorizonUniforms } from './horizonMap.js';

/**
 * Ufuk haritasından gelen güneş gölgesini ve arazi örtmesini herhangi bir
 * `MeshStandardMaterial`'e ekler.
 *
 * Arazi artık gölge haritasına yazmıyor (bkz. `terrain.js`), dolayısıyla bir
 * kum tepesinin gölgesine giren ağaç ya da araç, gölge haritasından bunu
 * öğrenemez. Aynı ufuk araması onlara da uygulanınca sahne tutarlı kalıyor —
 * üstelik gölge haritasının menzil sınırı olmadan.
 */

const VERTEX_HEADER = /* glsl */ `
varying vec3 vTerrainShadowWorld;
`;

const FRAGMENT_HEADER = /* glsl */ `
varying vec3 vTerrainShadowWorld;
${HEIGHT_SAMPLER_GLSL}
${TERRAIN_SHADOW_GLSL}
`;

/**
 * Ortak uniform kümesi. Tek nesne tüm materyaller arasında paylaşılıyor:
 * güneş hareket ettiğinde tek yerden güncellemek yetiyor.
 */
export function createTerrainShadowUniforms({ heightfield, horizon }) {
  return {
    uHeightMap: { value: heightfield.texture },
    uHeightExtent: { value: heightfield.extent },
    uHeightRes: { value: heightfield.res },
    uHorizonA: { value: horizon.horizonA },
    uHorizonB: { value: horizon.horizonB },
    uTerrainAO: { value: horizon.occlusion },
    ...createSunHorizonUniforms(),
  };
}

export function updateTerrainShadowUniforms(uniforms, weather) {
  updateSunHorizonUniforms(uniforms, weather.sunDirection);
  // Güneş ufkun altındayken gölge terimi kapatılıyor: aksi halde gece
  // farlarının aydınlattığı yüzeyler de arazi gölgesiyle karartılırdı.
  const elevation = weather.derived.elevation;
  uniforms.uSunShadowStrength.value = THREE.MathUtils.clamp((elevation - 0.5) / 4, 0, 1);
}

/**
 * Materyale enjeksiyonu ekler. `applyOcclusion` kapalıysa yalnız gölge
 * uygulanır — küçük nesnelerde arazi örtmesi çifte karartma yaratabiliyor.
 */
export function applyTerrainShadow(material, uniforms, { applyOcclusion = true, key = 'obj' } = {}) {
  const previous = material.onBeforeCompile;

  material.onBeforeCompile = (shader, renderer) => {
    if (previous) previous(shader, renderer);
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_HEADER}`)
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>\n  vTerrainShadowWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_HEADER}`)
      .replace(
        '#include <aomap_fragment>',
        /* glsl */ `
        #include <aomap_fragment>
        {
          float sunShadow = terrainSunShadow(vTerrainShadowWorld.xz);
          reflectedLight.directDiffuse *= sunShadow;
          reflectedLight.directSpecular *= sunShadow;
          ${
            applyOcclusion
              ? `float terrainAo = terrainOcclusion(vTerrainShadowWorld.xz);
          reflectedLight.indirectDiffuse *= terrainAo;
          reflectedLight.indirectSpecular *= terrainAo;`
              : ''
          }
        }
        `
      );
  };

  const previousKey = material.customProgramCacheKey;
  material.customProgramCacheKey = () =>
    `${previousKey ? previousKey.call(material) : ''}|terrainShadow:${key}:${applyOcclusion}`;

  material.needsUpdate = true;
  return material;
}
