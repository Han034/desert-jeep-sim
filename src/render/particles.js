import * as THREE from 'three';
import { BIOME_LIST } from '../config/biomes.js';
import { mulberry32, clamp01, lerp } from '../utils/math.js';

/**
 * Tek havuzlu parçacık sistemi: tekerlek püskürtmesi, toz bulutu ve havada
 * savrulan kum aynı `Points` nesnesinde yaşıyor. Üç ayrı sistem yerine tek
 * çizim çağrısı ve tek buffer güncellemesi.
 *
 * Parçacıklar CPU'da entegre ediliyor. GPU'da yapmak daha hızlı olurdu ama
 * püskürtmenin doğduğu yer (tekerlek temas noktası, kayma miktarı, süspansiyon
 * yükü) zaten CPU'da; veriyi GPU'ya taşımanın maliyeti kazancı yiyor.
 */

const TYPE_SPRAY = 0;
const TYPE_DUST = 1;
const TYPE_WIND = 2;

const _sandMix = new THREE.Color();
const _dustMix = new THREE.Color();
const _tmpColor = new THREE.Color();

export function createParticles({ scene, quality, weather }) {
  // Havuz geniş: ince toz, az sayıda iri kabarcık yerine çok sayıda küçük ve
  // neredeyse şeffaf zerreyle elde ediliyor.
  const capacity = Math.max(1600, Math.round(7000 * quality.particleScale));

  const positions = new Float32Array(capacity * 3);
  const velocities = new Float32Array(capacity * 3);
  const params = new Float32Array(capacity * 4); // boyut, alfa, ton, dönüş
  const life = new Float32Array(capacity);
  const maxLife = new Float32Array(capacity);
  const kind = new Uint8Array(capacity);
  const growth = new Float32Array(capacity);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aParams', new THREE.BufferAttribute(params, 4).setUsage(THREE.DynamicDrawUsage));
  geometry.setDrawRange(0, capacity);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSprite: { value: createSoftSprite() },
      uSandColor: { value: new THREE.Color(0xd8b483) },
      uDustColor: { value: new THREE.Color(0xc4a887) },
      uLight: { value: new THREE.Color(0xffffff) },
      uLightAmount: { value: 1 },
      uExposure: { value: 1 },
      uPixelScale: { value: 700 },
      uFogColor: { value: new THREE.Color(0xd8b98a) },
      uFogDensity: { value: 0.0011 },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aParams;
      varying float vAlpha;
      varying float vTint;
      varying float vFog;
      varying float vRot;

      uniform float uPixelScale;
      uniform float uFogDensity;

      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        // Mesafeye göre küçülme; sıfıra bölünmeyi engellemek için taban değer.
        gl_PointSize = aParams.x * uPixelScale / max(-mv.z, 1.0);
        vAlpha = aParams.y;
        vTint = aParams.z;
        vRot = aParams.w;
        float d = uFogDensity * length(mv.xyz);
        vFog = 1.0 - exp(-d * d);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uSprite;
      uniform vec3 uSandColor;
      uniform vec3 uDustColor;
      uniform vec3 uLight;
      uniform float uLightAmount;
      uniform float uExposure;
      uniform vec3 uFogColor;

      varying float vAlpha;
      varying float vTint;
      varying float vFog;
      varying float vRot;

      void main() {
        // Her zerre kendi açısıyla örnekleniyor: aynı doku üst üste binerken
        // tekrar eden bir desen olarak okunmuyor.
        vec2 c = gl_PointCoord - 0.5;
        float s = sin(vRot), co = cos(vRot);
        vec2 uv = vec2(c.x * co - c.y * s, c.x * s + c.y * co) + 0.5;

        float mask = texture2D(uSprite, uv).a;
        if (mask < 0.004 || vAlpha <= 0.0) discard;
        vec3 base = mix(uSandColor, uDustColor, vTint);
        // Kum taneleri ışığı saçar; güneşin rengi tona karışır ama tamamen
        // ele geçirmez — alçak güneşte toz bulutu turuncu bir lekeye dönüyordu.
        vec3 lit = base * mix(vec3(0.82), uLight, uLightAmount * 0.6);
        // Parçacıklar sahne ışığından geçmiyor; genel aydınlık seviyesi
        // buradan uygulanıyor, yoksa gece zifiri karanlıkta bembeyaz toz
        // bulutları uçuşuyor.
        lit *= uExposure;
        vec3 color = mix(lit, uFogColor, vFog);
        gl_FragColor = vec4(color, mask * vAlpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 5;
  scene.add(points);

  const rand = mulberry32(4242);
  let cursor = 0;
  let alive = 0;
  /**
   * Kalite değişince havuzu yeniden kurmak yerine sadece doğum hızı
   * ölçekleniyor: bellek sabit kalıyor, geçiş anında hiçbir şey kaybolmuyor.
   */
  let emission = 1;

  function spawn(x, y, z, vx, vy, vz, size, lifespan, type, tint, grow) {
    // Halka tampon: en eski parçacığın üstüne yazılır. Havuz dolduğunda en
    // eski toz kaybolur, bu da görsel olarak zaten beklenen davranış.
    const i = cursor;
    cursor = (cursor + 1) % capacity;

    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    velocities[i * 3] = vx;
    velocities[i * 3 + 1] = vy;
    velocities[i * 3 + 2] = vz;
    params[i * 4] = size;
    params[i * 4 + 1] = 0;
    params[i * 4 + 2] = tint;
    params[i * 4 + 3] = rand() * Math.PI * 2;
    life[i] = lifespan;
    maxLife[i] = lifespan;
    kind[i] = type;
    growth[i] = grow;
    alive++;
  }

  /** Tekerlekten fırlayan kum taneleri: küçük, çok sayıda, kısa ömürlü. */
  function emitSpray(wheel, amount, forward, dt) {
    const count = Math.min(22, Math.floor(amount * 68 * emission * dt * 60));
    for (let i = 0; i < count; i++) {
      const spreadX = (rand() - 0.5) * 2.6;
      const spreadZ = (rand() - 0.5) * 2.6;
      const speed = 2.5 + amount * 9 * rand();
      spawn(
        wheel.contact.x + (rand() - 0.5) * 0.34,
        wheel.contact.y + 0.05,
        wheel.contact.z + (rand() - 0.5) * 0.34,
        -forward.x * speed + spreadX,
        1.6 + rand() * 3.4 * amount,
        -forward.z * speed + spreadZ,
        0.022 + rand() * rand() * 0.055,
        0.4 + rand() * 0.45,
        TYPE_SPRAY,
        rand() * 0.25,
        0
      );
    }
  }

  /** Arkada büyüyerek asılı kalan toz bulutu. */
  function emitDust(x, y, z, amount, windX, windZ, dt) {
    const count = Math.min(18, Math.floor(amount * 46 * emission * dt * 60));
    for (let i = 0; i < count; i++) {
      spawn(
        x + (rand() - 0.5) * 1.3,
        y + 0.12 + rand() * 0.5,
        z + (rand() - 0.5) * 1.3,
        windX * 0.4 + (rand() - 0.5) * 1.1,
        0.3 + rand() * 0.8,
        windZ * 0.4 + (rand() - 0.5) * 1.1,
        0.14 + rand() * 0.22,
        1.5 + rand() * 1.9,
        TYPE_DUST,
        0.75 + rand() * 0.25,
        0.75 + rand() * 0.7
      );
    }
  }

  /** İniş veya çarpışma darbesinde tek seferlik toz patlaması. */
  function emitImpact(x, y, z, strength) {
    const count = Math.min(110, Math.floor(strength * 26 * emission));
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const r = 1.4 + rand() * 3.5;
      spawn(
        x + Math.cos(a) * 0.5,
        y + 0.1,
        z + Math.sin(a) * 0.5,
        Math.cos(a) * r,
        0.8 + rand() * 1.6,
        Math.sin(a) * r,
        0.14 + rand() * 0.26,
        1.1 + rand() * 1.3,
        TYPE_DUST,
        0.6 + rand() * 0.4,
        1.1
      );
    }
  }

  /** Fırtınada kameranın çevresinde savrulan kum. */
  function emitWindSand(camera, intensity, windX, windZ, dt) {
    const count = Math.min(60, Math.floor(intensity * 190 * emission * dt * 60));
    for (let i = 0; i < count; i++) {
      // Rüzgârın geldiği tarafta, kameranın önünde doğuyorlar.
      const side = 26;
      spawn(
        camera.position.x - windX * 1.4 + (rand() - 0.5) * side,
        camera.position.y - 5 + rand() * 13,
        camera.position.z - windZ * 1.4 + (rand() - 0.5) * side,
        windX * (0.85 + rand() * 0.4),
        (rand() - 0.4) * 1.6,
        windZ * (0.85 + rand() * 0.4),
        0.06 + rand() * 0.16,
        0.9 + rand() * 0.9,
        TYPE_WIND,
        0.5 + rand() * 0.5,
        0.5
      );
    }
  }

  const windVec = new THREE.Vector2();

  function update(dt, { heightfield }) {
    const d = weather.derived;
    windVec.set(weather.windDir.x, weather.windDir.y).multiplyScalar(d.windSpeed);

    material.uniforms.uLight.value.copy(weather.sunColor);
    material.uniforms.uLightAmount.value = clamp01(d.sunIntensity / 3);
    material.uniforms.uExposure.value = clamp01(0.1 + d.sunIntensity / 3.2);
    material.uniforms.uFogColor.value.copy(weather.hazeColor);
    material.uniforms.uFogDensity.value = d.fogDensity;

    alive = 0;
    for (let i = 0; i < capacity; i++) {
      // Konum/hız vec3, görünüm parametreleri vec4 — indeksler ayrı.
      const p3 = i * 3;
      const p4 = i * 4;

      if (life[i] <= 0) {
        params[p4 + 1] = 0;
        continue;
      }

      life[i] -= dt;
      if (life[i] <= 0) {
        params[p4 + 1] = 0;
        continue;
      }
      alive++;

      const t = 1 - life[i] / maxLife[i];
      const type = kind[i];

      if (type === TYPE_SPRAY) {
        velocities[p3 + 1] -= 9.81 * dt;
        // Hava direnci: taneler hızla yavaşlar, uzağa gitmez.
        const drag = Math.exp(-2.4 * dt);
        velocities[p3] *= drag;
        velocities[p3 + 2] *= drag;
      } else if (type === TYPE_DUST) {
        velocities[p3 + 1] += (0.55 - velocities[p3 + 1]) * dt * 1.4;
        velocities[p3] = lerp(velocities[p3], windVec.x * 0.35, dt * 0.8);
        velocities[p3 + 2] = lerp(velocities[p3 + 2], windVec.y * 0.35, dt * 0.8);
        params[p4] += growth[i] * dt;
      } else {
        velocities[p3 + 1] += Math.sin(life[i] * 6.1 + i) * dt * 0.9;
      }

      positions[p3] += velocities[p3] * dt;
      positions[p3 + 1] += velocities[p3 + 1] * dt;
      positions[p3 + 2] += velocities[p3 + 2] * dt;

      // Kum taneleri zemine çarpınca ölür; toz süzülmeye devam eder.
      if (type === TYPE_SPRAY) {
        const ground = heightfield.sampleHeight(positions[p3], positions[p3 + 2]);
        if (positions[p3 + 1] < ground) {
          life[i] = 0;
          params[p4 + 1] = 0;
          continue;
        }
      }

      let alpha;
      if (type === TYPE_SPRAY) {
        alpha = (1 - t * t) * 0.55;
      } else if (type === TYPE_DUST) {
        // Toz önce hızla belirir, sonra yavaşça dağılır. Tek tek çok şeffaf
        // olmalı: onlarcası üst üste bindiğinde bulut zaten yoğunlaşıyor,
        // yüksek alfa ile ortaya opak bir leke çıkıyordu.
        alpha = Math.min(t * 5, 1) * (1 - t) * (1 - t) * 0.105;
      } else {
        alpha = Math.sin(t * Math.PI) * 0.3 * d.airborneSand;
      }
      params[p4 + 1] = alpha;
    }

    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aParams.needsUpdate = true;
  }

  /**
   * Püskürtme ve tozun rengini, aracın o an bastığı zeminden alır.
   *
   * Renk parçacık başına değil tek bir uniform olarak taşınıyor; bütün
   * püskürtme zaten tekerlek temas noktalarından doğduğu için araç konumundan
   * alınan tek örnek yeterli. Olmadığında kar üstünde kahverengi bir leke
   * savruluyordu — beyaz zeminde en çok göze batan hata.
   */
  function setGroundBiome(weights) {
    _sandMix.setRGB(0, 0, 0);
    _dustMix.setRGB(0, 0, 0);
    for (let i = 0; i < 4; i++) {
      const w = weights[i];
      if (w <= 0) continue;
      const ground = BIOME_LIST[i].ground;
      _sandMix.add(_tmpColor.setHex(ground.colorA).multiplyScalar(w));
      _dustMix.add(_tmpColor.setHex(ground.colorB).multiplyScalar(w));
    }
    material.uniforms.uSandColor.value.copy(_sandMix);
    // Havada asılı toz, yerdeki koyu tondan daha açık: zerreler ışığı saçıyor.
    material.uniforms.uDustColor.value.copy(_dustMix).lerp(_sandMix, 0.6);
  }

  return {
    points,
    material,
    update,
    emitSpray,
    emitDust,
    emitImpact,
    emitWindSand,
    setGroundBiome,
    setEmissionScale(value) {
      emission = value;
    },
    get aliveCount() {
      return alive;
    },
    get capacity() {
      return capacity;
    },
    dispose() {
      geometry.dispose();
      material.uniforms.uSprite.value.dispose();
      material.dispose();
      scene.remove(points);
    },
  };
}

/**
 * Toz zerresi dokusu — canvas'ta üretiliyor, dosya bağımlılığı yok.
 *
 * Düz bir radyal gradyan, üst üste bindiğinde kusursuz daireler olarak
 * okunuyor ve toz bulutu "kabarcık yığını" gibi görünüyordu. Gradyanın üstüne
 * yumuşak bir gürültü çarpılıyor: kenarlar düzensizleşiyor, örtüşen zerreler
 * birbirine karışıyor ve sonuç ince bir pus oluyor.
 */
function createSoftSprite() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  const rand = mulberry32(20260812);

  // Düşük çözünürlüklü rastgele ızgara, iki kez yumuşatılarak bulanıklaştırılıyor.
  const gridSize = 16;
  const grid = new Float32Array(gridSize * gridSize);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();

  const noiseAt = (u, v) => {
    const gx = u * gridSize;
    const gy = v * gridSize;
    const i0 = Math.floor(gx) % gridSize;
    const j0 = Math.floor(gy) % gridSize;
    const i1 = (i0 + 1) % gridSize;
    const j1 = (j0 + 1) % gridSize;
    const tx = gx - Math.floor(gx);
    const ty = gy - Math.floor(gy);
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const a = grid[j0 * gridSize + i0];
    const b = grid[j0 * gridSize + i1];
    const c = grid[j1 * gridSize + i0];
    const dd = grid[j1 * gridSize + i1];
    return (a + (b - a) * sx) * (1 - sy) + (c + (dd - c) * sx) * sy;
  };

  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const r = Math.sqrt(dx * dx + dy * dy);

      // Geniş ve yumuşak düşüş; keskin bir kenar bırakmıyor.
      let alpha = Math.max(0, 1 - r);
      alpha = alpha * alpha * (3 - 2 * alpha);

      const u = x / size;
      const v = y / size;
      const n = noiseAt(u, v) * 0.55 + noiseAt(u * 2.7 + 0.3, v * 2.7 + 0.7) * 0.45;
      alpha *= 0.45 + n * 0.75;

      const o = (y * size + x) * 4;
      image.data[o] = 255;
      image.data[o + 1] = 255;
      image.data[o + 2] = 255;
      image.data[o + 3] = Math.max(0, Math.min(255, Math.round(alpha * 255)));
    }
  }

  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  return texture;
}
