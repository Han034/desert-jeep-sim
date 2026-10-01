import * as THREE from 'three';
import { WORLD } from '../config/settings.js';

/**
 * Kum izlerinin kalıcı olarak biriktiği dünya-sabit harita.
 *
 * Tek bir render target'a `autoClear = false` ile damga vuruluyor; ping-pong
 * yok, kopyalama yok. Harita 512 m'lik oynanabilir alanı kaplar ve araç nereye
 * giderse gitsin izler yerinde kalır.
 *
 * Kanallar:  R = oyuk derinliği · G = kenara savrulan kum · B = sıkışma · A = tazelik
 *
 * 8 bit hassasiyet, aşınmayı doğrudan her karede çıkarmayı imkânsız kılıyor
 * (1/255 = 0.0039, bir karelik aşınma bunun onda biri → sıfıra yuvarlanır).
 * Bu yüzden aşınma bir "borç" olarak CPU'da birikiyor ve eşiği aştığında tek
 * seferde uygulanıyor; kalan yuvarlama hatası da dither ile dağıtılıyor.
 */

const MAX_STAMPS = 96;

/** Saniyedeki aşınma hızı (kanal başına, rüzgâr çarpanı 1 iken). */
const EROSION_RATE = new THREE.Vector4(0.017, 0.034, 0.026, 0.11);
/** Aşınma paketinin uygulanma eşiği — 8 bit adımının iki katı. */
const EROSION_THRESHOLD = 2.2 / 255;

const brushVertex = /* glsl */ `
attribute vec2 aCenter;
attribute vec2 aDir;
attribute vec2 aHalf;
attribute vec4 aParams;
attribute vec2 aMix;

uniform float uExtent;

varying vec2 vLocal;
varying vec4 vParams;
varying vec2 vMix;

void main() {
  // Yerel çerçeve: x = ize dik, y = gidiş yönü. Metre cinsinden taşınıyor ki
  // fragment shader kapsül profilini gerçek ölçülerle çizebilsin.
  vec2 local = position.xy * aHalf * 2.0;
  vLocal = local;
  vParams = aParams;
  vMix = aMix;

  vec2 perp = vec2(aDir.y, -aDir.x);
  vec2 world = aCenter + perp * local.x + aDir * local.y;

  // Ortografik projeksiyon elle yapılıyor: kamera matrisine gerek yok.
  gl_Position = vec4(world / (uExtent * 0.5), 0.0, 1.0);
}
`;

const brushFragment = /* glsl */ `
precision highp float;

varying vec2 vLocal;
varying vec4 vParams;
varying vec2 vMix;

void main() {
  float halfWidth = vParams.z;
  float halfLength = vParams.w;

  // Kapsül: karenin iki ucu yuvarlatılıyor, böylece hızlı giderken kareler
  // arasında boşluk kalmıyor, yavaşken de köşeler iz bırakmıyor.
  vec2 p = vLocal;
  float d = length(vec2(p.x, max(abs(p.y) - halfLength, 0.0)));
  float u = d / halfWidth;
  if (u > 2.4) discard;

  // Oyuk profili: lastik tabanı altında düz, kenarda hızla yükselen çukur.
  float core = 1.0 - smoothstep(0.52, 1.04, u);
  // Berm: kumun ittirilip yığıldığı, oyuğun hemen dışındaki sırt.
  float ridge = smoothstep(0.80, 1.08, u) * (1.0 - smoothstep(1.08, 2.15, u));

  gl_FragColor = vec4(
    vParams.x * core,
    vParams.y * ridge,
    vMix.x * core,
    vMix.y * core
  );
}
`;

const erodeVertex = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const erodeFragment = /* glsl */ `
precision highp float;
uniform vec4 uAmount;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  // Dither: 8 bit yuvarlama hatasını piksellere dağıtır, aksi halde aşınma
  // haritada basamaklı halkalar bırakır.
  float d = (hash21(gl_FragCoord.xy) - 0.5) * (1.0 / 255.0);
  gl_FragColor = max(uAmount + d, vec4(0.0));
}
`;

export function createTrackMap({ renderer, resolution = 2048 }) {
  const extent = WORLD.playfield;

  let renderTarget = makeTarget(resolution);

  const geometry = new THREE.PlaneGeometry(1, 1);
  const aCenter = new THREE.InstancedBufferAttribute(new Float32Array(MAX_STAMPS * 2), 2);
  const aDir = new THREE.InstancedBufferAttribute(new Float32Array(MAX_STAMPS * 2), 2);
  const aHalf = new THREE.InstancedBufferAttribute(new Float32Array(MAX_STAMPS * 2), 2);
  const aParams = new THREE.InstancedBufferAttribute(new Float32Array(MAX_STAMPS * 4), 4);
  const aMix = new THREE.InstancedBufferAttribute(new Float32Array(MAX_STAMPS * 2), 2);

  const brushGeometry = new THREE.InstancedBufferGeometry();
  brushGeometry.index = geometry.index;
  brushGeometry.attributes.position = geometry.attributes.position;
  brushGeometry.setAttribute('aCenter', aCenter);
  brushGeometry.setAttribute('aDir', aDir);
  brushGeometry.setAttribute('aHalf', aHalf);
  brushGeometry.setAttribute('aParams', aParams);
  brushGeometry.setAttribute('aMix', aMix);
  brushGeometry.instanceCount = 0;

  const brushMaterial = new THREE.RawShaderMaterial({
    vertexShader: `precision highp float;
      attribute vec3 position;
      ${brushVertex}`,
    fragmentShader: brushFragment,
    uniforms: { uExtent: { value: extent } },
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    depthTest: false,
    depthWrite: false,
  });

  const brushMesh = new THREE.Mesh(brushGeometry, brushMaterial);
  brushMesh.frustumCulled = false;

  const erodeMaterial = new THREE.RawShaderMaterial({
    vertexShader: `precision highp float;
      attribute vec3 position;
      ${erodeVertex}`,
    fragmentShader: erodeFragment,
    uniforms: { uAmount: { value: new THREE.Vector4() } },
    blending: THREE.CustomBlending,
    // dst - src: haritadan sabit bir miktar düşer.
    blendEquation: THREE.ReverseSubtractEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    depthTest: false,
    depthWrite: false,
  });

  const erodeMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), erodeMaterial);
  erodeMesh.frustumCulled = false;

  const scene = new THREE.Scene();
  scene.add(brushMesh);
  scene.add(erodeMesh);
  const camera = new THREE.Camera();

  const uniforms = {
    uTrackMap: { value: renderTarget.texture },
    uTrackExtent: { value: extent },
    uRutDepth: { value: 0.16 },
    uBermHeight: { value: 0.055 },
    uTreadStrength: { value: 1.0 },
  };

  const erosionDebt = new THREE.Vector4();
  let stampCount = 0;
  let totalStamped = 0;

  clear();

  function makeTarget(res) {
    const target = new THREE.WebGLRenderTarget(res, res, {
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

  function clear() {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(renderTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(prev);
    erosionDebt.set(0, 0, 0, 0);
    totalStamped = 0;
  }

  function beginFrame() {
    stampCount = 0;
  }

  /**
   * Bir tekerleğin bu karede taradığı zemin parçasını haritaya işler.
   *
   * Güç ayarı, yeni zemin miktarına göre ölçekleniyor: hızlı giderken her kare
   * bakir kuma basar ve tam güçle iz bırakır, dururken üst üste basar ve iz
   * derinleşmez. Buna karşılık patinaj/kayma, araç yerinde dursa bile zamanla
   * kazar — `digRate` terimi doğrudan `dt` ile ölçekli.
   */
  function stampWheel(prevX, prevZ, curX, curZ, options) {
    if (stampCount >= MAX_STAMPS) return;

    const {
      halfWidth = 0.165,
      load = 1,
      slide = 0,
      spin = 0,
      dt = 1 / 60,
    } = options;

    let dx = curX - prevX;
    let dz = curZ - prevZ;
    let segLen = Math.hypot(dx, dz);

    // Duruyorsa yön bilinmiyor; son bilinen yön verilmediyse damga atlanır.
    if (segLen < 1e-5) {
      if (!options.fallbackDir) return;
      dx = options.fallbackDir.x;
      dz = options.fallbackDir.y;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      segLen = 0;
    } else {
      dx /= segLen;
      dz /= segLen;
    }

    const dig = Math.min(1, slide * 0.55 + spin * 0.45);
    // Yeni zemin oranı: temas yaması ~0.5 m uzunluğunda kabul ediliyor.
    const advance = Math.min(1, segLen / 0.5);

    const rut = Math.min(1, load * (advance * 0.5 + dig * dt * 2.4));
    if (rut < 0.002) return;

    // Kayan tekerlek kumu yana savurur: iz genişler, berm güçlenir, sıkışma azalır.
    const widen = 1 + dig * 1.35;
    const berm = rut * (0.3 + dig * 0.55);
    const compaction = rut * (0.85 - dig * 0.6);

    const tireHalf = halfWidth * widen;
    const segHalf = segLen * 0.5;
    // Kapsül yarıçapı berm halkasını da kapsamalı (2.2 × lastik yarı genişliği).
    const padX = tireHalf * 2.3;
    const padY = segHalf + padX;

    const i = stampCount++;
    aCenter.array[i * 2] = (prevX + curX) * 0.5;
    aCenter.array[i * 2 + 1] = (prevZ + curZ) * 0.5;
    aDir.array[i * 2] = dx;
    aDir.array[i * 2 + 1] = dz;
    aHalf.array[i * 2] = padX;
    aHalf.array[i * 2 + 1] = padY;
    aParams.array[i * 4] = rut;
    aParams.array[i * 4 + 1] = berm;
    aParams.array[i * 4 + 2] = tireHalf;
    aParams.array[i * 4 + 3] = segHalf;
    aMix.array[i * 2] = compaction;
    aMix.array[i * 2 + 1] = rut;

    totalStamped++;
  }

  /** Biriken damgaları ve aşınmayı haritaya uygular. */
  function flush(dt, windErosion = 1) {
    erosionDebt.addScaledVector(EROSION_RATE, dt * windErosion);
    const applyErosion = erosionDebt.x >= EROSION_THRESHOLD;
    if (!applyErosion && stampCount === 0) return;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(renderTarget);

    if (applyErosion) {
      erodeMaterial.uniforms.uAmount.value.copy(erosionDebt);
      erodeMesh.visible = true;
      brushMesh.visible = false;
      renderer.render(scene, camera);
      erosionDebt.set(0, 0, 0, 0);
    }

    if (stampCount > 0) {
      erodeMesh.visible = false;
      brushMesh.visible = true;
      brushGeometry.instanceCount = stampCount;
      aCenter.needsUpdate = true;
      aDir.needsUpdate = true;
      aHalf.needsUpdate = true;
      aParams.needsUpdate = true;
      aMix.needsUpdate = true;
      renderer.render(scene, camera);
    }

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  function setResolution(res) {
    if (res === renderTarget.width) return;
    renderTarget.dispose();
    renderTarget = makeTarget(res);
    uniforms.uTrackMap.value = renderTarget.texture;
    clear();
  }

  function dispose() {
    renderTarget.dispose();
    brushGeometry.dispose();
    brushMaterial.dispose();
    erodeMaterial.dispose();
    erodeMesh.geometry.dispose();
    geometry.dispose();
  }

  return {
    uniforms,
    beginFrame,
    stampWheel,
    flush,
    clear,
    setResolution,
    dispose,
    get texture() {
      return renderTarget.texture;
    },
    get renderTarget() {
      return renderTarget;
    },
    get resolution() {
      return renderTarget.width;
    },
    get stampsThisFrame() {
      return stampCount;
    },
    get totalStamped() {
      return totalStamped;
    },
  };
}
