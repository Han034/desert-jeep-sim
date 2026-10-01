import { TOOL_GROUPS } from '../map/editor.js';
import {
  createEmptyDoc,
  downloadDoc,
  listLocal,
  loadLocal,
  pickDocFile,
  saveLocal,
  deleteLocal,
} from '../map/mapDoc.js';

/**
 * Harita editörünün arayüzü. `M` ile açılır.
 *
 * Panel, editörün `state` nesnesini doğrudan yazıyor: arada bir kopya durum
 * tutmak, ikisinin ayrışmasından başka bir şey üretmezdi.
 */
export function createEditorPanel(root, { editor, props, doc, onLoadDoc, onNewDoc, onPlay }) {
  const element = document.createElement('div');
  element.className = 'editor hidden';
  element.innerHTML = `
    <div class="editor-head">
      <input class="editor-name" value="${escapeHtml(doc.name)}" spellcheck="false">
      <button class="panel-close e-close" title="Editörden çık (M)">×</button>
    </div>

    <div class="editor-tools">
      ${TOOL_GROUPS.map(
        (group) => `
        <div class="editor-group">
          <div class="editor-group-label">${group.label}</div>
          <div class="editor-buttons">
            ${group.tools
              .map(
                (tool) =>
                  `<button class="editor-tool" data-tool="${tool.id}" title="${tool.hint}">${tool.label}</button>`
              )
              .join('')}
          </div>
        </div>`
      ).join('')}
    </div>

    <label class="panel-row e-kind-row">
      <span class="panel-label">Nesne türü</span>
      <select class="panel-select e-kind">
        ${Object.entries(props.kinds)
          .map(([id, kind]) => `<option value="${id}">${kind.label}</option>`)
          .join('')}
      </select>
    </label>

    <label class="panel-row">
      <span class="panel-label">Fırça boyu <b class="v-radius">18 m</b></span>
      <input class="panel-slider s-radius" type="range" min="3" max="120" step="1" value="18">
    </label>

    <label class="panel-row">
      <span class="panel-label">Güç <b class="v-strength">0.55</b></span>
      <input class="panel-slider s-strength" type="range" min="0.02" max="3" step="0.01" value="0.55">
    </label>

    <label class="panel-row e-scale-row">
      <span class="panel-label">Nesne ölçeği <b class="v-scale">1.0×</b></span>
      <input class="panel-slider s-scale" type="range" min="0.3" max="4" step="0.05" value="1">
    </label>

    <div class="editor-stats">
      <span><b class="v-strokes">0</b> darbe</span>
      <span><b class="v-props">0</b> nesne</span>
    </div>

    <div class="panel-actions">
      <button class="panel-button b-play">Sürüşe dön (M)</button>
      <button class="panel-button b-save">Kaydet</button>
      <button class="panel-button b-export">Dosyaya aktar</button>
      <button class="panel-button b-import">Dosyadan al</button>
      <button class="panel-button b-new">Yeni harita</button>
    </div>

    <div class="editor-saved">
      <div class="editor-group-label">Kayıtlı haritalar</div>
      <div class="editor-list"></div>
    </div>

    <div class="panel-note e-message">
      Sol tık boyar · sağ tık döndürür · orta tık kaydırır ·
      <kbd>Ctrl</kbd>+tekerlek fırça boyu · <kbd>Shift</kbd>+tekerlek güç ·
      <kbd>Ctrl</kbd>+<kbd>Z</kbd> geri al
    </div>
  `;
  root.appendChild(element);

  const nameInput = element.querySelector('.editor-name');
  const kindSelect = element.querySelector('.e-kind');
  const kindRow = element.querySelector('.e-kind-row');
  const scaleRow = element.querySelector('.e-scale-row');
  const radiusSlider = element.querySelector('.s-radius');
  const strengthSlider = element.querySelector('.s-strength');
  const scaleSlider = element.querySelector('.s-scale');
  const radiusValue = element.querySelector('.v-radius');
  const strengthValue = element.querySelector('.v-strength');
  const scaleValue = element.querySelector('.v-scale');
  const strokesValue = element.querySelector('.v-strokes');
  const propsValue = element.querySelector('.v-props');
  const listBox = element.querySelector('.editor-list');
  const messageBox = element.querySelector('.e-message');
  const toolButtons = [...element.querySelectorAll('.editor-tool')];

  let currentDoc = doc;

  function selectTool(id) {
    editor.setTool(id);
    for (const button of toolButtons) {
      button.classList.toggle('active', button.dataset.tool === id);
    }
    const isProp = id.startsWith('nesne:');
    kindRow.style.display = isProp && id !== 'nesne:dogus' ? '' : 'none';
    scaleRow.style.display = id === 'nesne:ekle' ? '' : 'none';
  }

  for (const button of toolButtons) {
    button.addEventListener('click', () => selectTool(button.dataset.tool));
  }
  selectTool(editor.state.tool);

  kindSelect.addEventListener('change', () => {
    editor.state.propKind = kindSelect.value;
  });
  kindSelect.value = editor.state.propKind;

  radiusSlider.addEventListener('input', () => {
    editor.state.radius = parseFloat(radiusSlider.value);
  });
  strengthSlider.addEventListener('input', () => {
    editor.state.strength = parseFloat(strengthSlider.value);
  });
  scaleSlider.addEventListener('input', () => {
    editor.state.propScale = parseFloat(scaleSlider.value);
  });

  nameInput.addEventListener('change', () => {
    currentDoc.name = nameInput.value.trim() || 'Adsız harita';
  });

  element.querySelector('.b-play').addEventListener('click', () => onPlay());
  element.querySelector('.e-close').addEventListener('click', () => onPlay());

  element.querySelector('.b-save').addEventListener('click', () => {
    currentDoc.name = nameInput.value.trim() || 'Adsız harita';
    currentDoc.props = props.toJSON();
    saveLocal(currentDoc);
    refreshList();
    flash(`“${currentDoc.name}” kaydedildi.`);
  });

  element.querySelector('.b-export').addEventListener('click', () => {
    currentDoc.name = nameInput.value.trim() || 'Adsız harita';
    currentDoc.props = props.toJSON();
    downloadDoc(currentDoc);
    flash('Dosya indiriliyor.');
  });

  element.querySelector('.b-import').addEventListener('click', async () => {
    try {
      const loaded = await pickDocFile();
      if (loaded) onLoadDoc(loaded);
    } catch (error) {
      flash(error.message);
    }
  });

  element.querySelector('.b-new').addEventListener('click', () => {
    onNewDoc(createEmptyDoc());
  });

  function refreshList() {
    const saved = listLocal();
    if (saved.length === 0) {
      listBox.innerHTML = '<div class="editor-empty">Henüz kayıt yok.</div>';
      return;
    }
    listBox.innerHTML = saved
      .map(
        (entry) => `
        <div class="editor-saved-row">
          <button class="editor-saved-load" data-slot="${entry.slot}">${escapeHtml(entry.name)}</button>
          <button class="editor-saved-del" data-slot="${entry.slot}" title="Sil">×</button>
        </div>`
      )
      .join('');

    for (const button of listBox.querySelectorAll('.editor-saved-load')) {
      button.addEventListener('click', () => {
        const loaded = loadLocal(button.dataset.slot);
        if (loaded) onLoadDoc(loaded);
      });
    }
    for (const button of listBox.querySelectorAll('.editor-saved-del')) {
      button.addEventListener('click', () => {
        deleteLocal(button.dataset.slot);
        refreshList();
      });
    }
  }
  refreshList();

  let flashTimer = 0;
  const defaultMessage = messageBox.innerHTML;

  function flash(text) {
    messageBox.textContent = text;
    flashTimer = 3;
  }

  function update(dt) {
    if (editor.state.message) {
      flash(editor.state.message);
      editor.state.message = '';
    }
    if (flashTimer > 0) {
      flashTimer -= dt;
      if (flashTimer <= 0) messageBox.innerHTML = defaultMessage;
    }

    radiusValue.textContent = `${Math.round(editor.state.radius)} m`;
    strengthValue.textContent = editor.state.strength.toFixed(2);
    scaleValue.textContent = `${editor.state.propScale.toFixed(1)}×`;
    radiusSlider.value = String(editor.state.radius);
    strengthSlider.value = String(editor.state.strength);
    strokesValue.textContent = String(currentDoc.strokes.length);
    propsValue.textContent = String(props.count);
  }

  return {
    element,
    update,
    refreshList,
    setVisible(visible) {
      element.classList.toggle('hidden', !visible);
    },
    setDoc(next) {
      currentDoc = next;
      nameInput.value = next.name;
    },
  };
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
