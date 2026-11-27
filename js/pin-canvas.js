// Reusable zero-build responsive percentage-coordinate damage pin canvas.
// Supports both editable customer intake mode and readonly admin/customer inspection mode.
import { escapeHTML } from './utils.js';
import { t } from './i18n.js';

function clampPercent(val) {
  const num = Number(val);
  if (!Number.isFinite(num)) return 50;
  return Math.round(Math.min(100, Math.max(0, num)) * 100) / 100;
}

function normalizePins(rawPins, maxPins = 10) {
  if (!Array.isArray(rawPins)) return [];
  return rawPins
    .slice(0, maxPins)
    .map((pin, idx) => ({
      id: idx + 1,
      x: clampPercent(pin?.x),
      y: clampPercent(pin?.y),
      note: String(pin?.note || ''),
    }));
}

export function createPinCanvas(container, options = {}) {
  if (!container) return null;

  const mode = options.mode === 'edit' ? 'edit' : 'readonly';
  const maxPins = Number.isInteger(options.maxPins) && options.maxPins > 0 ? options.maxPins : 10;
  const onChange = typeof options.onChange === 'function' ? options.onChange : null;
  const onZoom = typeof options.onZoom === 'function' ? options.onZoom : null;

  let imageUrl = options.imageUrl || '';
  let imageAlt = options.imageAlt || t('tracker.photoModalImgAlt');
  let pins = normalizePins(options.pins, maxPins);
  let activeIndex = pins.length > 0 ? 0 : -1;

  const emitChange = () => {
    if (onChange) {
      onChange(pins.map((p, idx) => ({ id: idx + 1, x: p.x, y: p.y, note: p.note })));
    }
  };

  const render = (focusNoteIndex = -1) => {
    if (!imageUrl) {
      container.innerHTML = '';
      return;
    }

    const hintText =
      mode === 'edit'
        ? t('pin.stageHintEdit', { count: pins.length, max: maxPins })
        : t('pin.stageHintReadonly');

    const pinsOverlayHTML = pins
      .map((pin, idx) => {
        const num = idx + 1;
        const isActive = idx === activeIndex;
        const ariaText = t('pin.selectAria', {
          number: num,
          note: pin.note || t('pin.label', { number: num }),
        });
        return `<button
          type="button"
          data-pin-marker="${idx}"
          aria-label="${escapeHTML(ariaText)}"
          aria-pressed="${isActive ? 'true' : 'false'}"
          class="mt-pin-dot ${isActive ? 'is-active' : ''}"
          style="left: ${pin.x}%; top: ${pin.y}%;"
        >${num}</button>`;
      })
      .join('');

    const pinListHTML =
      pins.length === 0
        ? `<p class="text-xs mt-muted py-2">${escapeHTML(
            mode === 'edit' ? t('pin.emptyEdit') : t('pin.emptyReadonly')
          )}</p>`
        : pins
            .map((pin, idx) => {
              const num = idx + 1;
              const isActive = idx === activeIndex;
              if (mode === 'edit') {
                return `<div data-pin-row="${idx}" class="mt-pin-list-item ${isActive ? 'is-active' : ''}">
                  <button type="button" data-pin-focus="${idx}" class="mt-pin-badge-btn shrink-0" aria-label="${escapeHTML(t('pin.label', { number: num }))}">
                    <span class="mt-pin-badge" aria-hidden="true">${num}</span>
                  </button>
                  <div class="flex-1 min-w-0">
                    <label for="pin-note-${idx}" class="sr-only">${escapeHTML(t('pin.noteAria', { number: num }))}</label>
                    <input
                      id="pin-note-${idx}"
                      type="text"
                      maxlength="240"
                      required
                      data-pin-note="${idx}"
                      value="${escapeHTML(pin.note)}"
                      placeholder="${escapeHTML(t('pin.notePlaceholder'))}"
                      class="mt-input text-xs"
                    />
                  </div>
                  <button
                    type="button"
                    data-pin-delete="${idx}"
                    aria-label="${escapeHTML(t('pin.deleteAria', { number: num }))}"
                    title="${escapeHTML(t('pin.deleteBtn'))}"
                    class="mt-btn-icon mt-btn-danger-ghost shrink-0"
                  >
                    <i data-lucide="trash-2" class="w-4 h-4" aria-hidden="true"></i>
                  </button>
                </div>`;
              }

              return `<button
                type="button"
                data-pin-row="${idx}"
                aria-pressed="${isActive ? 'true' : 'false'}"
                class="mt-pin-list-item mt-pin-list-item-btn w-full text-left ${isActive ? 'is-active' : ''}"
              >
                <span class="mt-pin-badge shrink-0" aria-hidden="true">${num}</span>
                <span class="flex-1 min-w-0 text-xs sm:text-sm mt-text leading-relaxed">${escapeHTML(pin.note || '-')}</span>
              </button>`;
            })
            .join('');

    const toolbarHTML =
      mode === 'edit'
        ? `<div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-xs mt-muted">${escapeHTML(hintText)}</p>
            <button type="button" data-pin-add-center class="mt-btn mt-btn-secondary text-xs" ${pins.length >= maxPins ? 'disabled' : ''}>
              <i data-lucide="map-pin-plus" class="w-4 h-4" aria-hidden="true"></i>
              <span>${escapeHTML(t('pin.addCenterBtn'))}</span>
            </button>
          </div>`
        : `<div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-xs mt-muted">${escapeHTML(hintText)}</p>
            ${
              onZoom
                ? `<button type="button" data-pin-zoom aria-label="${escapeHTML(t('pin.zoomAria'))}" class="mt-btn mt-btn-secondary text-xs">
                    <i data-lucide="maximize-2" class="w-4 h-4" aria-hidden="true"></i>
                    <span>${escapeHTML(t('pin.zoomBtn'))}</span>
                  </button>`
                : ''
            }
          </div>`;

    container.innerHTML = `
      <div class="space-y-3">
        ${toolbarHTML}
        <div class="mt-pin-frame">
          <div class="mt-pin-stage ${mode === 'edit' ? 'is-editable' : ''}" data-pin-stage>
            <img src="${escapeHTML(imageUrl)}" alt="${escapeHTML(imageAlt)}" width="800" height="600" class="mt-pin-img" data-pin-img />
            ${pinsOverlayHTML}
          </div>
        </div>
        <div class="space-y-2" data-pin-list>
          ${pinListHTML}
        </div>
      </div>
    `;

    const stage = container.querySelector('[data-pin-stage]');
    const img = container.querySelector('[data-pin-img]');

    if (mode === 'edit' && stage && img) {
      stage.addEventListener('click', (event) => {
        if (event.target.closest('[data-pin-marker]')) return;
        if (pins.length >= maxPins) return;
        const rect = img.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const x = clampPercent(((event.clientX - rect.left) / rect.width) * 100);
        const y = clampPercent(((event.clientY - rect.top) / rect.height) * 100);
        pins.push({ id: pins.length + 1, x, y, note: '' });
        activeIndex = pins.length - 1;
        emitChange();
        render(activeIndex);
      });
    }

    container.querySelector('[data-pin-add-center]')?.addEventListener('click', () => {
      if (mode !== 'edit' || pins.length >= maxPins) return;
      const offset = (pins.length % 5) * 4;
      pins.push({ id: pins.length + 1, x: clampPercent(46 + offset), y: clampPercent(46 + offset), note: '' });
      activeIndex = pins.length - 1;
      emitChange();
      render(activeIndex);
    });

    container.querySelector('[data-pin-zoom]')?.addEventListener('click', () => {
      if (onZoom && imageUrl) onZoom(imageUrl);
    });

    container.querySelectorAll('[data-pin-marker]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const idx = Number(btn.getAttribute('data-pin-marker'));
        if (!Number.isInteger(idx) || idx < 0 || idx >= pins.length) return;
        activeIndex = idx;
        render(mode === 'edit' ? idx : -1);
      });
    });

    container.querySelectorAll('[data-pin-focus]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-pin-focus'));
        if (!Number.isInteger(idx)) return;
        activeIndex = idx;
        render(idx);
      });
    });

    if (mode === 'readonly') {
      container.querySelectorAll('[data-pin-row]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-pin-row'));
          if (!Number.isInteger(idx)) return;
          activeIndex = idx;
          render();
        });
      });
    }

    container.querySelectorAll('[data-pin-note]').forEach((input) => {
      input.addEventListener('focus', () => {
        const idx = Number(input.getAttribute('data-pin-note'));
        if (idx !== activeIndex) {
          activeIndex = idx;
          container.querySelectorAll('[data-pin-marker]').forEach((m) => {
            const mIdx = Number(m.getAttribute('data-pin-marker'));
            m.classList.toggle('is-active', mIdx === activeIndex);
            m.setAttribute('aria-pressed', mIdx === activeIndex ? 'true' : 'false');
          });
          container.querySelectorAll('[data-pin-row]').forEach((r) => {
            const rIdx = Number(r.getAttribute('data-pin-row'));
            r.classList.toggle('is-active', rIdx === activeIndex);
          });
        }
      });
      input.addEventListener('input', () => {
        const idx = Number(input.getAttribute('data-pin-note'));
        if (!Number.isInteger(idx) || !pins[idx]) return;
        pins[idx].note = input.value;
        emitChange();
      });
    });

    container.querySelectorAll('[data-pin-delete]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-pin-delete'));
        if (!Number.isInteger(idx) || idx < 0 || idx >= pins.length) return;
        pins.splice(idx, 1);
        pins = pins.map((p, i) => ({ ...p, id: i + 1 }));
        activeIndex = pins.length ? Math.min(idx, pins.length - 1) : -1;
        emitChange();
        render();
      });
    });

    if (window.lucide) window.lucide.createIcons();

    if (focusNoteIndex >= 0) {
      const targetInput = container.querySelector(`[data-pin-note="${focusNoteIndex}"]`);
      if (targetInput) targetInput.focus();
    }
  };

  render();

  return {
    getPins: () => pins.map((p, idx) => ({ id: idx + 1, x: p.x, y: p.y, note: String(p.note || '').trim() })),
    setImage: (nextUrl, nextAlt = null) => {
      imageUrl = nextUrl || '';
      if (nextAlt !== null) imageAlt = nextAlt;
      render();
    },
    setPins: (nextPins) => {
      pins = normalizePins(nextPins, maxPins);
      activeIndex = pins.length > 0 ? 0 : -1;
      render();
    },
    rerender: () => render(),
    clear: () => {
      imageUrl = '';
      pins = [];
      activeIndex = -1;
      container.innerHTML = '';
      emitChange();
    },
  };
}
