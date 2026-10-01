import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { createNormalPrepass } from './gbuffer.js';
import { mulberry32, lerp, clamp01, smoothstep } from '../utils/math.js';

/**
 * Renderer, gökyüzü, ışıklar ve post-process zinciri.
 *
 * Gölge kamerası aracı takip eder ve dar tutulur (140 m'lik kutu, 2048 harita
 * → ~7 cm/texel): geniş bir gölge frustumu tüm çölü kapsayabilirdi ama kum
 * tepelerinin altın saatteki uzun, keskin gölgeleri bulanık bir lekeye dönerdi.
 */

/** Isı buğusu, vinyet, gren ve fırtına tozu — tek geçişte. */
const DesertGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uHorizon: { value: 0.5 },
    uHeat: { value: 0.5 },
    uStorm: { value: 0 },
    uStormColor: { value: new THREE.Color(0xb07a44) },
    uVignette: { value: 0.5 },
    uAspect: { value: 1.777 },
    uSharpen: { value: 0.34 },
    uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    uSaturation: { value: 1.16 },
    uContrast: { value: 1.14 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uHorizon;
    uniform float uHeat;
    uniform float uStorm;
    uniform float uVignette;
    uniform float uAspect;
    uniform float uSharpen;
    uniform vec2 uTexel;
    uniform float uSaturation;
    uniform float uContrast;
    uniform vec3 uStormColor;
    varying vec2 vUv;

    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    void main() {
      vec2 uv = vUv;

      // Isı buğusu: sadece ufuk bandında, dikey kaymayla. Çölde havanın
      // titremesi görüntünün tamamını değil, sıcak zeminin hemen üstündeki
      // ince şeridi bozar.
      float band = exp(-pow((uv.y - uHorizon) / 0.075, 2.0));
      float shimmer = sin(uv.x * 90.0 + uTime * 2.6) * sin(uv.y * 220.0 - uTime * 3.9);
      uv.y += shimmer * band * uHeat * 0.0022;
      uv.x += shimmer * band * uHeat * 0.0009;

      vec3 color = texture2D(tDiffuse, uv).rgb;

      /**
       * Keskinleştirme. Çizim tamponu ekrandan büyük olduğunda (pixelRatio 1.5)
       * küçültme adımı ayrıntıyı yumuşatıyor; kumun dalgacıkları ve lastik izinin
       * kenarı belirgin şekilde bulanıklaşıyordu. Çapraz dört komşuyla kurulan
       * ters keskinlik maskesi bunu geri veriyor — bloom'dan sonra uygulanıyor ki
       * parlama halkalarının kenarını çizmesin.
       */
      if (uSharpen > 0.001) {
        vec3 blur =
          texture2D(tDiffuse, uv + vec2(uTexel.x, 0.0)).rgb +
          texture2D(tDiffuse, uv - vec2(uTexel.x, 0.0)).rgb +
          texture2D(tDiffuse, uv + vec2(0.0, uTexel.y)).rgb +
          texture2D(tDiffuse, uv - vec2(0.0, uTexel.y)).rgb;
        color = max(vec3(0.0), color + (color * 4.0 - blur) * uSharpen * 0.25);
      }

      // Fırtınada ekranın tamamına kum perdesi iner: sadece sisle görüşü
      // kısmak yetmiyor, çünkü sis rengi kumun rengine çok yakın ve fark
      // edilmiyor. Perde, gökyüzünü de kum rengine boğarak farkı yaratıyor.
      if (uStorm > 0.001) {
        float grain = hash21(floor(gl_FragCoord.xy * 0.7) + floor(uTime * 24.0));
        float veil = clamp(uStorm * (0.82 + grain * 0.28), 0.0, 0.94);
        color = mix(color, uStormColor, veil);
      }

      /**
       * "Look" katmanı — doygunluk ve kontrast.
       *
       * Bu geçiş ton eşlemeden **önce**, doğrusal HDR tamponda çalışıyor
       * (composer'ın hedefine çizerken three ton eşleme uygulamıyor; onu en
       * sondaki OutputPass yapıyor). Dolayısıyla kontrast, %18 gri pivotu
       * etrafında düz bir kazanç olarak yazılabiliyor.
       *
       * NOT: bu yorum bir şablon dizesinin içinde — ters tırnak kullanmak
       * dizeyi kapatıp dosyayı sözdizimi hatasına düşürüyor.
       *
       * Gerekli olmasının sebebi AgX: ACES'e göre belirgin şekilde nötr
       * oturuyor ve altın saatteki kumun sıcaklığını yutuyordu. Yüksek ışık
       * davranışını AgX'ten, tonu buradan alıyoruz — sinema hattındaki
       * "tone mapper + look" ayrımının aynısı.
       */
      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(luma), color, uSaturation);
      color = max(vec3(0.0), (color - 0.18) * uContrast + 0.18);

      // Vinyet.
      vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
      float vig = 1.0 - uVignette * dot(d, d) * 0.55;
      color *= vig;

      // Film greni: bantlaşmayı kırar, kumun düz alanlarını canlı tutar.
      float noise = hash21(gl_FragCoord.xy + fract(uTime) * 133.0) - 0.5;
      color += noise * 0.018;

      gl_FragColor = vec4(color, 1.0);
    }
  `,
};

export function createSceneContext({ canvas, quality, weather }) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    // Fotoğraf modunun PNG kaydı, çizim tamponunun kare sonunda hâlâ okunabilir
    // olmasını gerektiriyor.
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.maxPixelRatio));
  /**
   * Üçüncü argüman (`updateStyle`) **false**: three, tuvale satır içi
   * `style.width/height` yazmasın.
   *
   * Yazsaydı — ve varsayılan olarak yazıyor — o satır içi ölçü, stil
   * sayfasındaki `#scene-canvas { inset: 0; width: 100%; height: 100% }`
   * kuralını ezerdi. `resize()` ise çizim tamponunu büyütürken satır içi stile
   * dokunmadığı için tuval, açılıştaki pencere boyutunda **çakılı kalıyordu**:
   * pencere büyütülünce sahne eski dikdörtgene sıkışıyor ve o dikdörtgenin
   * dışına yapılan tıklamalar tuvale hiç ulaşmıyordu (harita editörü fırçası
   * bu yüzden ölüydü).
   *
   * Yerleşimin tek sahibi CSS; burada yalnız çizim tamponu yönetiliyor.
   */
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  /**
   * AgX, ACES'in yerine geçti. Fark en çok iki yerde okunuyor: gökyüzünün
   * güneşe yakın bölgesi ve karlı bölge. ACES parlak alanları doyurup beyaza
   * çekiyor — kar tamamen düzleşiyor, gün batımında gökyüzü turuncu bir lekeye
   * dönüyordu. AgX yüksek ışıkları doygunluğunu kaybettirmeden sıkıştırıyor,
   * karın hacmi ve gökyüzünün renk geçişleri kalıyor.
   *
   * Karşılığında genel görüntü biraz daha sönük çıkıyor; pozlama buna göre
   * yükseltildi (`applyWeather`).
   */
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.25;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xd8b98a, 0.0011);

  const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.25, 6000);
  camera.position.set(0, 8, 14);

  // --- gökyüzü -------------------------------------------------------------
  const sky = new Sky();
  sky.scale.setScalar(45000);
  sky.material.uniforms.turbidity.value = 6;
  sky.material.uniforms.rayleigh.value = 1.6;
  sky.material.uniforms.mieCoefficient.value = 0.006;
  sky.material.uniforms.mieDirectionalG.value = 0.86;
  scene.add(sky);

  const stars = createStarDome();
  scene.add(stars);

  // --- ışıklar -------------------------------------------------------------
  const sun = new THREE.DirectionalLight(0xffffff, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 520;
  setShadowExtent(sun.shadow.camera, 70);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.06;
  scene.add(sun);
  scene.add(sun.target);

  const hemi = new THREE.HemisphereLight(0xb6cdf0, 0x6b4d2c, 0.5);
  scene.add(hemi);

  /** Gökten değil, kumdan yansıyan sıcak dolgu — gölgeleri siyah bırakmaz. */
  const bounce = new THREE.DirectionalLight(0xffc98a, 0.35);
  scene.add(bounce);

  // --- post-process --------------------------------------------------------
  /**
   * Composer'ın ara tamponu elle kuruluyor: varsayılanı çok örnekli değil ve
   * `antialias: true` yalnız doğrudan ekrana çizerken geçerli. Sahne bir render
   * target'a çizildiği anda kenar yumuşatma tamamen kayboluyordu.
   */
  const composerTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
    type: THREE.HalfFloatType,
    samples: quality.msaa,
  });
  const composer = new EffectComposer(renderer, composerTarget);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  /**
   * Ekran uzayı ortam örtme. Arazi zaten ufuk haritasından uzun menzilli
   * örtmesini alıyor; GTAO'nun katkısı **temas** ölçeğinde: ağaç gövdesinin
   * dibi, kayanın zeminle buluştuğu çizgi, tekerleğin altı. Nesneleri zemine
   * oturtan şey bu.
   *
   * Normal/derinlik tamponunu kendimiz çiziyoruz — sebebi `gbuffer.js`de.
   */
  const prepass = createNormalPrepass({
    renderer,
    scene,
    camera,
    width: window.innerWidth,
    height: window.innerHeight,
  });

  /**
   * G-tamponu yapıcıya parametre olarak verilmiyor, sonradan `setGBuffer` ile
   * takılıyor. Sebebi three r169'daki bir kusur: `setGBuffer`, dışarıdan
   * tampon verildiğinde hiç oluşturulmayan `normalRenderTarget`'ı sonunda
   * koşulsuz okuyup hata fırlatıyor. Önce parametresiz kurunca o hedef
   * oluşuyor, ikinci çağrı da kendi tamponumuzu bağlıyor — ve `_renderGBuffer`
   * kapandığı için o hedefe hiç çizim yapılmadığından GPU'da yer de kaplamıyor.
   */
  const gtaoPass = new GTAOPass(scene, camera, window.innerWidth, window.innerHeight);
  gtaoPass.setGBuffer(prepass.depthTexture, prepass.normalTexture);
  gtaoPass.updateGtaoMaterial({
    radius: 1.6,
    distanceExponent: 1.0,
    thickness: 1.0,
    scale: 1.0,
    samples: 16,
    screenSpaceRadius: false,
  });
  composer.addPass(gtaoPass);

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.34,
    0.7,
    0.86
  );
  composer.addPass(bloomPass);

  const gradePass = new ShaderPass(DesertGradeShader);
  composer.addPass(gradePass);

  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  let postFxEnabled = quality.postFx;
  bloomPass.enabled = postFxEnabled;
  gradePass.enabled = postFxEnabled;
  gtaoPass.enabled = quality.ambientOcclusion;

  // Gökyüzü ve yıldızlar katı yüzey değil; normal tamponuna girmemeliler.
  sky.userData.skipGBuffer = true;
  stars.userData.skipGBuffer = true;

  // --- ortam haritası ------------------------------------------------------
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const skyOnlyScene = new THREE.Scene();
  let envTarget = null;
  let envDirtyKey = null;

  const _horizonPoint = new THREE.Vector3();
  const _forward = new THREE.Vector3();
  let elapsed = 0;

  applyWeather();
  resize();

  function setShadowExtent(shadowCamera, half) {
    shadowCamera.left = -half;
    shadowCamera.right = half;
    shadowCamera.top = half;
    shadowCamera.bottom = -half;
    shadowCamera.updateProjectionMatrix();
  }

  /** Hava/saat değiştiğinde ışıkları, gökyüzünü ve sisi yeniden kurar. */
  function applyWeather() {
    const d = weather.derived;

    sky.material.uniforms.sunPosition.value.copy(weather.sunDirection).multiplyScalar(1000);
    // Berrak çöl havası: düşük bulanıklık, yüksek Rayleigh → derin mavi zenit.
    // Fırtınada tersine döner ve gökyüzü kum rengine boğulur.
    sky.material.uniforms.turbidity.value = lerp(3.4, 16, weather.state.storm);
    sky.material.uniforms.rayleigh.value = lerp(2.6, 0.4, weather.state.storm);
    sky.material.uniforms.mieCoefficient.value = lerp(0.004, 0.035, weather.state.storm);

    sun.color.copy(weather.sunColor);
    sun.intensity = d.sunIntensity;
    sun.visible = d.sunIntensity > 0.01;

    hemi.color.copy(weather.skyColor);
    hemi.groundColor.copy(weather.groundColor);
    hemi.intensity = d.skyIntensity;

    // Dolgu ışığı güneşin tam tersinden, ufka yakın gelir: kum tepelerinin
    // gölge yüzlerini kumun kendi yansımasıyla açar.
    bounce.position.set(-weather.sunDirection.x, 0.22, -weather.sunDirection.z).normalize();
    bounce.color.copy(weather.hazeColor);
    bounce.intensity = 0.22 + d.sunIntensity * 0.06;

    scene.fog.color.copy(weather.hazeColor);
    scene.fog.density = d.fogDensity;

    const night = clamp01(1 - smoothstep(-8, 2, d.elevation));
    stars.material.opacity = night * 0.9;
    stars.visible = night > 0.02;

    gradePass.uniforms.uHeat.value =
      smoothstep(12, 55, d.elevation) * (1 - weather.state.storm) * 1.0;
    gradePass.uniforms.uStorm.value = d.stormVeil;
    gradePass.uniforms.uStormColor.value.copy(weather.hazeColor);
    gradePass.uniforms.uVignette.value = lerp(0.42, 0.85, weather.state.storm);

    // Gökyüzü fiziksel ölçekte parlaklık üretiyor; pozlama buna göre kısılmalı,
    // yoksa üst yarı beyaza kırpılıyor ve sahnenin tamamı kontrastını yitiriyor.
    // Değerler AgX'in ACES'ten daha alçak oturmasını telafi edecek şekilde
    // yükseltildi.
    renderer.toneMappingExposure = lerp(1.28, 0.78, smoothstep(-4, 26, d.elevation));

    refreshEnvironment();
  }

  /**
   * Gökyüzünden IBL üretir. Her karede yeniden üretmek pahalı olurdu; anahtar
   * yeterince değiştiğinde (saatte ~0.15 dilim) yenileniyor.
   */
  function refreshEnvironment() {
    const key = `${Math.round(weather.derived.elevation * 4)}|${Math.round(weather.state.storm * 12)}`;
    if (key === envDirtyKey) return;
    envDirtyKey = key;

    skyOnlyScene.add(sky);
    const next = pmrem.fromScene(skyOnlyScene);
    scene.add(sky);

    if (envTarget) envTarget.dispose();
    envTarget = next;
    scene.environment = envTarget.texture;
    scene.environmentIntensity = lerp(0.16, 0.6, clamp01(weather.derived.elevation / 30 + 0.4));
  }

  /** Gölge kamerasını odak noktasına kilitler. */
  function updateShadowFocus(focus) {
    const dist = 220;
    sun.target.position.copy(focus);
    sun.position.copy(focus).addScaledVector(weather.sunDirection, dist);
    sun.target.updateMatrixWorld();
  }

  function updateHorizonUniform() {
    camera.getWorldDirection(_forward);
    _forward.y = 0;
    if (_forward.lengthSq() < 1e-6) _forward.set(0, 0, -1);
    _forward.normalize();
    _horizonPoint.copy(camera.position).addScaledVector(_forward, 4000);
    _horizonPoint.project(camera);
    gradePass.uniforms.uHorizon.value = _horizonPoint.y * 0.5 + 0.5;
  }

  function render(dt, focus) {
    elapsed += dt;
    gradePass.uniforms.uTime.value = elapsed;
    if (focus) updateShadowFocus(focus);
    updateHorizonUniform();

    // Gökyüzü ve yıldızlar kamerayla birlikte gezer; ufuk hep aynı uzaklıkta kalır.
    sky.position.copy(camera.position);
    stars.position.copy(camera.position);

    if (postFxEnabled) {
      // G-tamponu composer'dan önce: GTAO onu bu karede okuyacak.
      if (gtaoPass.enabled) prepass.render();
      composer.render(dt);
    } else {
      renderer.render(scene, camera);
    }
  }

  function resize(width = window.innerWidth, height = window.innerHeight) {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    composer.setSize(width, height);
    bloomPass.setSize(width, height);
    prepass.setSize(width, height);
    gtaoPass.setSize(width, height);
    gradePass.uniforms.uAspect.value = camera.aspect;
    const ratio = renderer.getPixelRatio();
    gradePass.uniforms.uTexel.value.set(1 / (width * ratio), 1 / (height * ratio));
  }

  function setQuality(preset) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, preset.maxPixelRatio));
    sun.shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize);
    if (sun.shadow.map) {
      sun.shadow.map.dispose();
      sun.shadow.map = null;
    }
    postFxEnabled = preset.postFx;
    bloomPass.enabled = postFxEnabled;
    gradePass.enabled = postFxEnabled;
    gtaoPass.enabled = preset.ambientOcclusion;

    // Örnek sayısı yalnız tampon yeniden ayrıldığında okunuyor; `dispose`
    // bir sonraki çizimde yeniden ayrılmayı tetikliyor.
    for (const target of [composer.renderTarget1, composer.renderTarget2]) {
      if (target.samples === preset.msaa) continue;
      target.samples = preset.msaa;
      target.dispose();
    }
    resize();
  }

  /** Fotoğraf modu için yüksek çözünürlüklü tek kare. */
  function captureFrame(scale = 2) {
    const width = Math.round(window.innerWidth * scale);
    const height = Math.round(window.innerHeight * scale);
    const prevPixelRatio = renderer.getPixelRatio();

    renderer.setPixelRatio(1);
    resize(width, height);
    render(0, null);
    const dataUrl = renderer.domElement.toDataURL('image/png');

    renderer.setPixelRatio(prevPixelRatio);
    resize();
    return dataUrl;
  }

  return {
    renderer,
    scene,
    camera,
    composer,
    sun,
    bloomPass,
    gradePass,
    gtaoPass,
    prepass,
    render,
    resize,
    setQuality,
    applyWeather,
    captureFrame,
    setDepthOfField(enabled, focus, aperture) {
      // Alan derinliği yalnız fotoğraf modunda devreye alınır (bkz. photoMode.js).
      bloomPass.strength = enabled ? 0.28 : 0.34;
      void focus;
      void aperture;
    },
  };
}

/** Gece için basit yıldız küresi. */
function createStarDome() {
  const count = 2200;
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const rand = mulberry32(9182);

  for (let i = 0; i < count; i++) {
    // Yarım küre yeterli; ufkun altındaki yıldızlar zaten araziyle kapanır.
    const u = rand() * 2 - 1;
    const theta = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    const y = Math.abs(u) * 0.98 + 0.02;
    positions[i * 3] = Math.cos(theta) * r * 4000;
    positions[i * 3 + 1] = y * 4000;
    positions[i * 3 + 2] = Math.sin(theta) * r * 4000;
    // Birkaç piksel: yıldızlar nokta olmalı. Daha büyüğü, gökyüzüne serpilmiş
    // kar tanelerine benziyor.
    sizes[i] = 1.1 + rand() * rand() * 3.4;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float aSize;
      varying float vTwinkle;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize;
        vTwinkle = aSize / 4.5;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying float vTwinkle;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.12, length(d));
        gl_FragColor = vec4(vec3(0.92, 0.95, 1.0), a * uOpacity * (0.25 + vTwinkle * 0.75));
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = -1;
  // `material.opacity` ile sürülebilmesi için uniform'a köprü.
  Object.defineProperty(material, 'opacity', {
    get: () => material.uniforms.uOpacity.value,
    set: (v) => {
      material.uniforms.uOpacity.value = v;
    },
  });
  return points;
}
