import { KEYS } from '../config/settings.js';
import { moveTowards } from '../utils/math.js';

/**
 * Klavye girişi. Analog eksenler (gaz, fren, direksiyon) tuş basımından
 * doğrudan 0/1 okunmaz, hedefe doğru yumuşatılır: klavyeyle sürerken ani
 * girdiler aracı sürekli tutuş sınırında tutar ve yarı-gerçekçi lastik modeli
 * cezalandırıcı hale gelirdi.
 */
export function createInput(target = window) {
  const held = new Set();
  const pressed = new Set();

  const axes = {
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: 0,
    lowRange: false,
  };

  function isHeld(action) {
    return KEYS[action].some((code) => held.has(code));
  }

  function onKeyDown(event) {
    // Arayüz alanlarına yazarken sürüş tuşları tetiklenmesin.
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (!held.has(event.code)) pressed.add(event.code);
    held.add(event.code);

    // Boşluk sayfayı kaydırmasın, oklar da öyle.
    if (
      event.code === 'Space' ||
      event.code.startsWith('Arrow') ||
      event.code === 'Tab'
    ) {
      event.preventDefault();
    }
  }

  function onKeyUp(event) {
    held.delete(event.code);
  }

  function onBlur() {
    held.clear();
  }

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', onBlur);

  /** Kare başına bir kez: eksenleri tuş durumuna doğru yumuşatır. */
  function update(dt) {
    const wantThrottle = isHeld('throttle') ? 1 : 0;
    const wantBrake = isHeld('brake') ? 1 : 0;
    const steerDir = (isHeld('right') ? 1 : 0) - (isHeld('left') ? 1 : 0);

    axes.throttle = moveTowards(axes.throttle, wantThrottle, dt * (wantThrottle ? 4.5 : 8));
    axes.brake = moveTowards(axes.brake, wantBrake, dt * (wantBrake ? 6 : 10));
    axes.steer = moveTowards(axes.steer, steerDir, dt * (steerDir === 0 ? 6 : 4));
    axes.handbrake = moveTowards(axes.handbrake, isHeld('handbrake') ? 1 : 0, dt * 14);
    axes.lowRange = isHeld('lowRange');
    return axes;
  }

  /** Tek seferlik tuş: okunduğunda tüketilir. */
  function consume(action) {
    const codes = KEYS[action];
    for (const code of codes) {
      if (pressed.has(code)) {
        pressed.delete(code);
        return true;
      }
    }
    return false;
  }

  function endFrame() {
    pressed.clear();
  }

  function dispose() {
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('keyup', onKeyUp);
    target.removeEventListener('blur', onBlur);
  }

  return { axes, update, consume, endFrame, isHeld, dispose };
}
