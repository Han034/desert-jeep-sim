import * as THREE from 'three';
import { WORLD } from '../config/settings.js';

/**
 * Arazi için **ufuk haritası**: her noktada, sekiz azimut yönünde ufkun kaç
 * derece yükseldiği. Açılışta GPU'da bir kez pişirilir.
 *
 * Neden bu, doğrudan ışın izleme değil:
 *
 * Tarayıcıda donanım ışın izleme (RTX/DXR) yok. Ama arazimiz üçgen çorbası
 * değil, bir yükseklik alanı — ışını BVH yerine dokuda yürütebiliyoruz. Yine de
 * her kare, her piksel için güneşe doğru 30 adım yürümek 1080p'de yüz milyonlarca
 * doku okuması demek. Arazi **statik** olduğu için bu iş bir kez yapılıp
 * saklanabilir: çalışma zamanında geriye iki doku okuması kalıyor.
 *
 * Saklanan şey gölgenin kendisi değil (güneş saat kaydırıcısıyla geziyor),
 * **ufuk profili**. Gölge, güneşin o andaki yükseklik tanjantı ile o yöndeki
 * ufuk tanjantının karşılaştırılmasıyla çıkıyor — menzil sınırsız, gölge
 * haritası kademesi yok, gölge sızması ve akne yok.
 *
 * Aynı profilden ortam örtme de bedavaya geliyor: sekiz yöndeki ufuk açısının
 * kapattığı gökyüzü oranı.
 */

/** Azimut yönü sayısı. Sekizi ikişer RGBA dokusuna sığıyor. */
export const HORIZON_DIRECTIONS = 8;
/** Depolanan tanjant bu değere bölünerek 8 bit'e sıkıştırılıyor. */
const TANGENT_SCALE = 2.0;

const QUAD_VERTEX = /* glsl */ `
precision highp float;
attribute vec3 position;
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Yükseklik alanının hızlı (en yakın komşu) okuması. Ufuk, yol boyunca alınan
 * onlarca örneğin **maksimumu** olduğu için bikübik filtre buraya bir şey
 * katmıyor; dört kat pahalıya mal oluyordu.
 */
const MARCH_GLSL = /* glsl */ `
uniform sampler2D uHeightMap;
uniform float uHeightExtent;
uniform float uHeightRes;

float heightAt(vec2 world) {
  vec2 uv = clamp(world / uHeightExtent + 0.5, 0.0, 1.0);
  return texture2D(uHeightMap, uv).r;
}

/**
 * Verilen yönde ufuk tanjantının en büyüğü. Adım boyu geometrik büyüyor:
 * yakında hassas, uzakta ucuz — gölgeyi belirleyen tepe genelde yakındadır,
 * uzaktaki dağ ise zaten kaba bir örneklemeyle yakalanır.
 */
float horizonTangent(vec2 origin, float baseHeight, vec2 dir) {
  float best = 0.0;
  float t = 2.0;
  float stride = 2.0;
  for (int i = 0; i < 24; i++) {
    float h = heightAt(origin + dir * t);
    best = max(best, (h - baseHeight) / t);
    t += stride;
    stride *= 1.24;
  }
  return best;
}
`;

function makeTarget(resolution) {
  const target = new THREE.WebGLRenderTarget(resolution, resolution, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
  });
  target.texture.colorSpace = THREE.NoColorSpace;
  return target;
}

/**
 * Ufuk ve örtme haritalarını üretir. Üç geçişe bölünüyor: her geçiş dört yön,
 * son geçiş de örtmeyi topluyor. Tek geçişte sekiz yön, zayıf bir GPU'da
 * tarayıcının sürücü zaman aşımına takılacak kadar uzun sürebiliyor.
 */
/**
 * @param resolution Ufuk haritasının çözünürlüğü. 512 → 2048 m üzerinde
 *   4 m/texel; gölge kenarı bu ölçekte yumuşuyor ama zaten yarı gölge bandı
 *   uyguluyoruz. Bir kat yükseltmek pişirme maliyetini dörde katlıyor ve zayıf
 *   GPU'larda tarayıcının sürücü zaman aşımına takılıyor.
 */
export async function bakeHorizonMap({ renderer, heightfield, resolution = 512, onProgress }) {
  const targets = [makeTarget(resolution), makeTarget(resolution), makeTarget(resolution)];
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const geometry = new THREE.PlaneGeometry(2, 2);

  const shared = {
    uHeightMap: { value: heightfield.texture },
    uHeightExtent: { value: heightfield.extent },
    uHeightRes: { value: heightfield.res },
  };

  const horizonMaterial = new THREE.RawShaderMaterial({
    vertexShader: QUAD_VERTEX,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform float uDirOffset;
      ${MARCH_GLSL}

      void main() {
        vec2 world = (vUv - 0.5) * uHeightExtent;
        float base = heightAt(world);

        // NOT: "packed" GLSL ES'te ayrılmış bir sözcük; değişken adı olarak
        // kullanılırsa shader derlenmiyor ve hata yalnız konsola düşüyor.
        vec4 result = vec4(0.0);
        for (int k = 0; k < 4; k++) {
          float angle = (uDirOffset + float(k)) * 6.2831853 / ${HORIZON_DIRECTIONS}.0;
          float t = horizonTangent(world, base, vec2(cos(angle), sin(angle)));
          float encoded = clamp(t / ${TANGENT_SCALE.toFixed(1)}, 0.0, 1.0);
          if (k == 0) result.r = encoded;
          else if (k == 1) result.g = encoded;
          else if (k == 2) result.b = encoded;
          else result.a = encoded;
        }
        gl_FragColor = result;
      }
    `,
    uniforms: { ...shared, uDirOffset: { value: 0 } },
    depthTest: false,
    depthWrite: false,
  });

  const aoMaterial = new THREE.RawShaderMaterial({
    vertexShader: QUAD_VERTEX,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uHorizonA;
      uniform sampler2D uHorizonB;

      /** Ufuk açısının kapattığı gök oranı: sin(atan(t)). */
      float blocked(float encoded) {
        float t = encoded * ${TANGENT_SCALE.toFixed(1)};
        return t / sqrt(1.0 + t * t);
      }

      void main() {
        vec4 a = texture2D(uHorizonA, vUv);
        vec4 b = texture2D(uHorizonB, vUv);
        float sum =
          blocked(a.r) + blocked(a.g) + blocked(a.b) + blocked(a.a) +
          blocked(b.r) + blocked(b.g) + blocked(b.b) + blocked(b.a);
        float ao = 1.0 - sum / ${HORIZON_DIRECTIONS}.0;
        gl_FragColor = vec4(ao, ao, ao, 1.0);
      }
    `,
    uniforms: {
      uHorizonA: { value: targets[0].texture },
      uHorizonB: { value: targets[1].texture },
    },
    depthTest: false,
    depthWrite: false,
  });

  const quad = new THREE.Mesh(geometry, horizonMaterial);
  quad.frustumCulled = false;
  scene.add(quad);

  const previousTarget = renderer.getRenderTarget();

  for (let pass = 0; pass < 2; pass++) {
    horizonMaterial.uniforms.uDirOffset.value = pass * 4;
    quad.material = horizonMaterial;
    renderer.setRenderTarget(targets[pass]);
    renderer.render(scene, camera);
    if (onProgress) onProgress((pass + 1) / 3);
    // Sürücüye nefes aldır: iki geçiş arka arkaya sürülünce zayıf GPU'larda
    // kare bütçesi tek seferde tükeniyor.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  quad.material = aoMaterial;
  renderer.setRenderTarget(targets[2]);
  renderer.render(scene, camera);
  renderer.setRenderTarget(previousTarget);
  if (onProgress) onProgress(1);

  geometry.dispose();
  horizonMaterial.dispose();
  aoMaterial.dispose();

  return {
    horizonA: targets[0].texture,
    horizonB: targets[1].texture,
    occlusion: targets[2].texture,
    /** Hata ayıklama: pişmiş değerleri geri okuyabilmek için hedeflerin kendisi. */
    targets,
    resolution,
    dispose() {
      targets.forEach((t) => t.dispose());
    },
  };
}

/**
 * Güneşin o anki yönünü ufuk haritası aramasına çevirir.
 *
 * GLSL ES 1.00'da dizi elemanına değişken indeksle erişmek serbest değil; bu
 * yüzden hangi iki kanalın okunacağı CPU'da maskelere çevriliyor ve shader
 * `dot()` ile seçiyor.
 */
export function createSunHorizonUniforms() {
  return {
    uSunSel0A: { value: new THREE.Vector4() },
    uSunSel0B: { value: new THREE.Vector4() },
    uSunSel1A: { value: new THREE.Vector4() },
    uSunSel1B: { value: new THREE.Vector4() },
    uSunSlotBlend: { value: 0 },
    uSunTangent: { value: 1 },
    uSunShadowStrength: { value: 1 },
    // Örtme ölçülü uygulanıyor: gölgeyle çarpıldığında tam güç, çukurları
    // okunamayacak kadar karartıyor.
    uTerrainAOStrength: { value: 0.55 },
  };
}

const _selA = [new THREE.Vector4(), new THREE.Vector4()];
const _selB = [new THREE.Vector4(), new THREE.Vector4()];

export function updateSunHorizonUniforms(uniforms, sunDirection) {
  const horizontal = Math.hypot(sunDirection.x, sunDirection.z);
  // Güneş ufka çok yaklaşınca tanjant patlıyor; kelepçeleniyor.
  uniforms.uSunTangent.value =
    horizontal < 1e-4 ? 99 : Math.min(sunDirection.y / horizontal, 8);

  const azimuth = Math.atan2(sunDirection.z, sunDirection.x);
  let slot = (azimuth / (Math.PI * 2)) * HORIZON_DIRECTIONS;
  slot = ((slot % HORIZON_DIRECTIONS) + HORIZON_DIRECTIONS) % HORIZON_DIRECTIONS;

  const i0 = Math.floor(slot);
  const i1 = (i0 + 1) % HORIZON_DIRECTIONS;
  uniforms.uSunSlotBlend.value = slot - i0;

  for (let k = 0; k < 2; k++) {
    _selA[k].set(0, 0, 0, 0);
    _selB[k].set(0, 0, 0, 0);
  }
  writeMask(_selA[0], _selB[0], i0);
  writeMask(_selA[1], _selB[1], i1);

  uniforms.uSunSel0A.value.copy(_selA[0]);
  uniforms.uSunSel0B.value.copy(_selB[0]);
  uniforms.uSunSel1A.value.copy(_selA[1]);
  uniforms.uSunSel1B.value.copy(_selB[1]);
}

function writeMask(maskA, maskB, index) {
  const target = index < 4 ? maskA : maskB;
  const channel = index % 4;
  if (channel === 0) target.x = 1;
  else if (channel === 1) target.y = 1;
  else if (channel === 2) target.z = 1;
  else target.w = 1;
}
