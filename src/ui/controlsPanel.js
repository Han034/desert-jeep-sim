import { QUALITY_PRESETS } from '../config/settings.js';

/**
 * Zaman, hava ve kalite paneli. `T` ile açılıp kapanır.
 *
 * Saat kaydırıcısı tek başına gökyüzünü, güneşi, sisi, gölgeleri, farları ve
 * ton eşlemeyi birlikte sürüyor; fırtına kaydırıcısı ise görüşü daraltmanın
 * yanında **izlerin silinme hızını** da artırıyor — bıraktığın izlerin
 * gözünün önünde yok olmasını izleyebiliyorsun.
 */
export function createControlsPanel(root, options) {
  const { weather, qualityKey, audio, onQualityChange, onClearTracks, onReset, onWeatherChange } =
    options;

  const element = document.createElement('div');
  element.className = 'panel hidden';
  element.innerHTML = `
    <div class="panel-head">
      <span>Çevre</span>
      <button class="panel-close" title="Kapat (T)">×</button>
    </div>

    <label class="panel-row">
      <span class="panel-label">Saat <b class="v-time">17:20</b></span>
      <input class="panel-slider s-time" type="range" min="0" max="24" step="0.05" value="${weather.state.timeOfDay}">
    </label>

    <label class="panel-row">
      <span class="panel-label">Zaman akışı <b class="v-speed">durdu</b></span>
      <input class="panel-slider s-timespeed" type="range" min="0" max="3" step="0.05" value="0">
    </label>

    <label class="panel-row">
      <span class="panel-label">Kum fırtınası <b class="v-storm">%0</b></span>
      <input class="panel-slider s-storm" type="range" min="0" max="1" step="0.01" value="0">
    </label>

    <label class="panel-row">
      <span class="panel-label">Ses <b class="v-volume">%70</b></span>
      <input class="panel-slider s-volume" type="range" min="0" max="1" step="0.01" value="${audio.settings.volume}">
    </label>

    <label class="panel-row">
      <span class="panel-label">Kalite</span>
      <select class="panel-select s-quality">
        ${Object.entries(QUALITY_PRESETS)
          .map(
            ([key, preset]) =>
              `<option value="${key}" ${key === qualityKey ? 'selected' : ''}>${preset.label} — iz ${preset.trackRes}px</option>`
          )
          .join('')}
      </select>
    </label>

    <div class="panel-actions">
      <button class="panel-button b-clear">İzleri temizle</button>
      <button class="panel-button b-reset">Aracı sıfırla (R)</button>
    </div>

    <div class="panel-note">
      Fırtına açıkken izler rüzgârla gözle görülür hızda siliniyor.
      Kalite değiştirmek iz haritasını yeniden kurar, mevcut izler silinir.
    </div>
  `;
  root.appendChild(element);

  const timeSlider = element.querySelector('.s-time');
  const timeSpeedSlider = element.querySelector('.s-timespeed');
  const stormSlider = element.querySelector('.s-storm');
  const qualitySelect = element.querySelector('.s-quality');
  const volumeSlider = element.querySelector('.s-volume');
  const timeValue = element.querySelector('.v-time');
  const speedValue = element.querySelector('.v-speed');
  const stormValue = element.querySelector('.v-storm');
  const volumeValue = element.querySelector('.v-volume');

  function formatTime(hours) {
    const h = Math.floor(hours) % 24;
    const m = Math.floor((hours - Math.floor(hours)) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  function refreshLabels() {
    timeValue.textContent = formatTime(weather.state.timeOfDay);
    stormValue.textContent = `%${Math.round(weather.state.storm * 100)}`;
    speedValue.textContent =
      weather.state.timeSpeed === 0 ? 'durdu' : `${weather.state.timeSpeed.toFixed(2)}×`;
    volumeValue.textContent =
      audio.settings.volume === 0 ? 'kapalı' : `%${Math.round(audio.settings.volume * 100)}`;
  }
  refreshLabels();

  timeSlider.addEventListener('input', () => {
    weather.setTimeOfDay(parseFloat(timeSlider.value));
    refreshLabels();
    onWeatherChange();
  });

  timeSpeedSlider.addEventListener('input', () => {
    weather.state.timeSpeed = parseFloat(timeSpeedSlider.value);
    refreshLabels();
  });

  stormSlider.addEventListener('input', () => {
    weather.setStorm(parseFloat(stormSlider.value));
    refreshLabels();
    onWeatherChange();
  });

  volumeSlider.addEventListener('input', () => {
    const value = parseFloat(volumeSlider.value);
    // Kaydırıcıya dokunmak zaten bir kullanıcı etkileşimi: ses bağlamı burada
    // güvenle açılabiliyor.
    audio.start();
    audio.setVolume(value);
    audio.setEnabled(value > 0);
    refreshLabels();
  });

  qualitySelect.addEventListener('change', () => onQualityChange(qualitySelect.value));
  element.querySelector('.b-clear').addEventListener('click', onClearTracks);
  element.querySelector('.b-reset').addEventListener('click', onReset);
  element.querySelector('.panel-close').addEventListener('click', () => toggle(false));

  let open = false;

  function toggle(force) {
    open = force === undefined ? !open : force;
    element.classList.toggle('hidden', !open);
    if (open) {
      // Saat kendi kendine akıyorsa kaydırıcı gerçeği göstersin.
      timeSlider.value = String(weather.state.timeOfDay);
      refreshLabels();
    }
  }

  return {
    element,
    toggle,
    refreshLabels,
    setVisible(visible) {
      element.style.display = visible ? '' : 'none';
    },
    get isOpen() {
      return open;
    },
  };
}
