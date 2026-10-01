import * as THREE from 'three';

/**
 * GTAO için normal + derinlik ön geçişi.
 *
 * `GTAOPass` normalleri kendisi çizebiliyor ama bunu `scene.overrideMaterial`
 * ile yapıyor: sahnedeki her materyalin yerine `MeshNormalMaterial` koyuyor.
 * Bizim arazimizin geometrisi vertex shader'da doğduğu için o geçişte düz bir
 * tabla olarak görünür ve üretilen örtme baştan aşağı yanlış olurdu.
 *
 * Çözüm, G-tamponunu kendimiz çizip `setGBuffer()` ile pass'e vermek: her
 * nesne kendi normal materyalini kullanıyor, arazi de yer değiştirmesini
 * taşıyan özel materyalini.
 *
 * Nesne başına materyal değiştirmek yerine `object.userData.normalMaterial`
 * bakılıyor; olmayanlar paylaşılan `MeshNormalMaterial`'e düşüyor.
 */
export function createNormalPrepass({ renderer, scene, camera, width, height }) {
  const depthTexture = new THREE.DepthTexture(width, height);
  depthTexture.format = THREE.DepthStencilFormat;
  depthTexture.type = THREE.UnsignedInt248Type;

  const target = new THREE.WebGLRenderTarget(width, height, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    type: THREE.HalfFloatType,
    depthTexture,
  });
  target.texture.name = 'GBufferNormal';

  const fallback = new THREE.MeshNormalMaterial();
  fallback.blending = THREE.NoBlending;

  const swapped = [];

  function render() {
    swapped.length = 0;

    scene.traverse((object) => {
      if (!object.isMesh && !object.isInstancedMesh) return;
      if (!object.visible) return;
      // Gökyüzü, yıldızlar ve parçacıklar örtmeye katılmamalı: hiçbiri katı
      // yüzey değil, hepsi G-tamponunu kirletirdi.
      if (object.userData.skipGBuffer) return;

      swapped.push([object, object.material]);
      object.material = object.userData.normalMaterial || fallback;
    });

    const previousTarget = renderer.getRenderTarget();
    const previousBackground = scene.background;
    scene.background = null;

    renderer.setRenderTarget(target);
    renderer.setClearColor(0x7777ff, 1);
    renderer.clear();
    renderer.render(scene, camera);

    scene.background = previousBackground;
    renderer.setRenderTarget(previousTarget);

    for (const [object, material] of swapped) object.material = material;
  }

  function setSize(w, h) {
    target.setSize(w, h);
  }

  function dispose() {
    target.dispose();
    depthTexture.dispose();
    fallback.dispose();
  }

  return {
    render,
    setSize,
    dispose,
    normalTexture: target.texture,
    depthTexture,
  };
}
