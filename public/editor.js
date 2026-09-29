// --- Editor de PDF (TESTE) ---
// A página é uma imagem gerada pelo servidor; por cima vai uma camada com os
// trechos de texto do PDF (editáveis), os campos de formulário e os objetos
// que o usuário cria. Tudo guardado em pontos PDF (origem no topo esquerdo)
// e posicionado em % — a página pode ter qualquer largura na tela.
(() => {
  const $ = (id) => document.getElementById(id);
  const edDropzone = $('edDropzone');
  const edInput = $('edInput');
  const edWorkspace = $('edWorkspace');
  const edPages = $('edPages');
  const edHint = $('edHint');
  const edColor = $('edColor');
  const edSize = $('edSize');
  const edBold = $('edBold');
  const edDelete = $('edDelete');
  const edUndo = $('edUndo');
  const edSaveBtn = $('edSaveBtn');
  const edSaveSub = $('edSaveSub');
  const edFlatten = $('edFlatten');
  const edFlattenRow = $('edFlattenRow');
  const edImageInput = $('edImageInput');
  const signDialog = $('edSignDialog');
  const signCanvas = $('edSignCanvas');

  const HINTS = {
    select: 'Clique em qualquer texto do PDF para reescrever. Enter confirma, Esc desiste. Objetos que você criou podem ser arrastados.',
    text: 'Clique na página onde quer escrever. Arraste o texto depois se errar o lugar (vai errar).',
    sign: 'Desenhe a assinatura, depois clique na página onde ela vai.',
    image: 'Escolha a imagem e clique na página onde ela vai. Canto inferior direito redimensiona.',
    place: 'Agora clique na página onde isso vai.',
    highlight: 'Arraste por cima do que você quer marcar.',
    rect: 'Arraste para desenhar o retângulo.',
    whiteout: 'Arraste para cobrir de branco. Depois use "Texto novo" por cima, se quiser.',
    redact: 'Arraste por cima do que precisa sumir. Some DE VERDADE ao salvar: texto, imagem, tudo.'
  };

  let session = null;
  let originalName = '';
  let pagesMeta = [];
  let mode = 'select';
  let pendingImage = null; // { data, ratio }
  let selected = null;
  let uidSeq = 0;

  const edits = new Map(); // "página:id" -> { page, el, text }
  const objects = []; // objetos criados, na ordem (camadas)
  const fieldValues = new Map(); // "página:nome" -> { page, name, value }
  const history = []; // para desfazer: { kind, ... }

  // ---------------------------------------------------------------- utilidades
  const pct = (v, total) => `${(v / total) * 100}%`;
  const rgbCss = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

  function place(node, page, x0, y0, x1, y1) {
    const { width: w, height: h } = pagesMeta[page];
    node.style.left = pct(x0, w);
    node.style.top = pct(y0, h);
    node.style.width = pct(Math.max(x1 - x0, 1), w);
    node.style.height = pct(Math.max(y1 - y0, 1), h);
  }

  function fontSizeCss(page, sizePt) {
    // .ed-page tem container-type: inline-size — cqw acompanha a largura da página
    return `${(sizePt / pagesMeta[page].width) * 100}cqw`;
  }

  function toPdf(layer, page, clientX, clientY) {
    const r = layer.getBoundingClientRect();
    const scale = r.width / pagesMeta[page].width;
    return {
      x: Math.max(0, Math.min(pagesMeta[page].width, (clientX - r.left) / scale)),
      y: Math.max(0, Math.min(pagesMeta[page].height, (clientY - r.top) / scale)),
      scale
    };
  }

  function familyOf(font) {
    const f = (font || '').toLowerCase();
    if (/mono|courier|consol/.test(f)) return 'monospace';
    if (/times|georgia|garamond|cambria|(^|[^s])serif/.test(f) && !/sans/.test(f)) return 'serif';
    return 'sans-serif';
  }

  function changeCount() {
    let n = objects.length + fieldValues.size;
    edits.forEach((e) => { if (e.text !== e.el.text) n += 1; });
    return n;
  }

  function refreshState() {
    const n = changeCount();
    edSaveBtn.disabled = n === 0;
    edSaveSub.textContent = n === 0 ? 'Nenhuma alteração ainda' : `${n} ${n > 1 ? 'alterações' : 'alteração'} esperando`;
    edUndo.disabled = history.length === 0;
    edDelete.disabled = !selected;
  }

  function select(obj) {
    if (selected && selected.node) selected.node.classList.remove('selected');
    selected = obj;
    if (obj && obj.node) obj.node.classList.add('selected');
    refreshState();
  }

  function setMode(next) {
    mode = next;
    document.querySelectorAll('.ed-mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === next || (next === 'place' && b.dataset.mode === pendingImage?.from)));
    edPages.dataset.mode = next;
    edHint.textContent = HINTS[next] || '';
    if (next !== 'select') select(null);
  }

  // ---------------------------------------------------------------- abrir PDF
  async function openPdf(file) {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      showError('Arquivo precisa ser PDF.');
      return;
    }
    const fd = new FormData();
    fd.append('pdf', file);
    startLoading('editor');
    try {
      const data = await postForm('/api/editor/open', fd);
      stopLoading(true);
      loadSession(data);
    } catch (err) {
      stopLoading(false);
      showError(err.message);
    } finally {
      loadingEl.classList.add('hidden');
    }
  }

  function resetState() {
    session = null;
    pagesMeta = [];
    edits.clear();
    objects.length = 0;
    fieldValues.clear();
    history.length = 0;
    selected = null;
    pendingImage = null;
    edPages.innerHTML = '';
  }

  function loadSession(data) {
    resetState();
    session = data.session;
    originalName = data.originalName || 'documento.pdf';
    pagesMeta = data.pages;
    edDropzone.classList.add('hidden');
    edWorkspace.classList.remove('hidden');
    const hasFields = pagesMeta.some((p) => p.fields.length);
    edFlattenRow.classList.toggle('hidden', !hasFields);
    pagesMeta.forEach((p, i) => edPages.appendChild(buildPage(p, i)));
    setMode('select');
    if (data.scannedPages) {
      edHint.textContent = `${data.scannedPages} página(s) escaneada(s): não têm texto editável. Passe no OCR antes, ou use Corretivo + Texto novo.`;
    }
    refreshState();
  }

  function buildPage(meta, i) {
    const pageEl = document.createElement('div');
    pageEl.className = 'ed-page';
    pageEl.style.aspectRatio = `${meta.width} / ${meta.height}`;
    pageEl.dataset.page = i;

    const img = document.createElement('img');
    img.src = `/api/editor/${session}/page/${i}`;
    img.alt = `Página ${i + 1}`;
    img.loading = 'lazy';
    img.draggable = false;
    pageEl.appendChild(img);

    const layer = document.createElement('div');
    layer.className = 'ed-layer';
    pageEl.appendChild(layer);

    meta.elements.forEach((el) => layer.appendChild(buildTextEl(i, el)));
    meta.fields.forEach((f) => layer.appendChild(buildField(i, f)));
    attachLayerEvents(layer, i);

    const label = document.createElement('span');
    label.className = 'ed-page-num';
    label.textContent = `${i + 1} / ${pagesMeta.length}`;
    pageEl.appendChild(label);
    return pageEl;
  }

  // ------------------------------------------------- trechos de texto do PDF
  function buildTextEl(page, el) {
    const node = document.createElement('div');
    node.className = 'ed-text';
    const [x0, y0, x1, y1] = el.bbox;
    place(node, page, x0, y0, x1, y1);
    // Ao editar, o fundo branco cobre no mínimo a largura do texto original
    node.style.setProperty('--w', node.style.width);
    node.style.fontSize = fontSizeCss(page, el.size);
    node.style.fontFamily = familyOf(el.font);
    node.style.setProperty('--c', rgbCss(el.color));
    if (el.flags & 16) node.style.fontWeight = 'bold';
    if (el.flags & 2) node.style.fontStyle = 'italic';
    node.textContent = el.text;
    node.spellcheck = false;
    const key = `${page}:${el.id}`;

    node.addEventListener('click', (e) => {
      if (mode !== 'select') return;
      e.stopPropagation();
      if (node.isContentEditable) return;
      node.contentEditable = 'plaintext-only';
      if (node.contentEditable !== 'plaintext-only') node.contentEditable = 'true';
      node.classList.add('editing');
      node.focus();
      const range = document.createRange();
      range.selectNodeContents(node);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); node.blur(); }
      if (e.key === 'Escape') {
        const current = edits.get(key);
        node.textContent = current ? current.text : el.text;
        node.blur();
      }
    });
    node.addEventListener('paste', (e) => {
      e.preventDefault();
      document.execCommand('insertText', false, (e.clipboardData.getData('text/plain') || '').replace(/\s*\n\s*/g, ' '));
    });
    node.addEventListener('blur', () => {
      node.contentEditable = 'false';
      node.classList.remove('editing');
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      const prev = edits.get(key);
      const prevText = prev ? prev.text : el.text;
      if (text === prevText) return;
      history.push({ kind: 'edit', key, node, prevText, hadPrev: Boolean(prev) });
      if (text === el.text) edits.delete(key);
      else edits.set(key, { page, el, text });
      node.classList.toggle('edited', edits.has(key));
      node.classList.toggle('deleted', edits.has(key) && text === '');
      refreshState();
    });
    return node;
  }

  // ------------------------------------------------- campos de formulário
  function buildField(page, f) {
    let input;
    if (f.type === 'checkbox' || f.type === 'radiobutton') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(f.checked);
    } else if (f.type === 'combobox' || f.type === 'listbox') {
      input = document.createElement('select');
      ['', ...(f.options || [])].forEach((opt) => {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        input.appendChild(o);
      });
      input.value = f.value || '';
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.value = f.value || '';
    }
    input.className = `ed-field ed-field-${f.type}`;
    input.title = f.name;
    input.setAttribute('aria-label', f.name);
    const [x0, y0, x1, y1] = f.rect;
    place(input, page, x0, y0, x1, y1);
    if (input.type === 'text') input.style.fontSize = fontSizeCss(page, Math.min(12, (y1 - y0) * 0.7));
    input.addEventListener('change', () => {
      const value = input.type === 'checkbox' ? input.checked : input.value;
      fieldValues.set(`${page}:${f.name}`, { page, name: f.name, value });
      refreshState();
    });
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    return input;
  }

  // ------------------------------------------------- objetos criados
  function addObject(obj, { focus = false } = {}) {
    obj.uid = ++uidSeq;
    const layer = edPages.querySelector(`.ed-page[data-page="${obj.page}"] .ed-layer`);
    const node = document.createElement('div');
    node.className = `ed-obj ed-obj-${obj.type}`;
    obj.node = node;

    if (obj.type === 'addText') {
      node.textContent = obj.text || '';
      node.style.fontSize = fontSizeCss(obj.page, obj.size);
      node.style.color = obj.color;
      node.style.fontWeight = obj.bold ? 'bold' : 'normal';
      node.style.left = pct(obj.x, pagesMeta[obj.page].width);
      node.style.top = pct(obj.y, pagesMeta[obj.page].height);
      node.spellcheck = false;
      node.addEventListener('blur', () => {
        node.contentEditable = 'false';
        obj.text = node.innerText.replace(/ /g, ' ').replace(/\n$/, '');
        if (!obj.text.trim()) removeObject(obj, { record: false });
        refreshState();
      });
      node.addEventListener('keydown', (e) => { if (e.key === 'Escape') node.blur(); });
    } else {
      syncRect(obj);
      if (obj.type === 'image') {
        const img = document.createElement('img');
        img.src = obj.data;
        img.alt = '';
        img.draggable = false;
        node.appendChild(img);
      } else if (obj.type === 'rect') {
        node.style.borderColor = obj.color;
      } else if (obj.type === 'highlight') {
        node.style.background = obj.color;
      }
      if (obj.type === 'image' || obj.type === 'rect' || obj.type === 'highlight' || obj.type === 'whiteout' || obj.type === 'redact') {
        const handle = document.createElement('span');
        handle.className = 'ed-handle';
        node.appendChild(handle);
      }
    }
    attachObjectDrag(obj, layer);
    layer.appendChild(node);
    objects.push(obj);
    history.push({ kind: 'add', obj });
    if (focus && obj.type === 'addText') startTextEditing(obj);
    select(obj);
    refreshState();
    return obj;
  }

  function syncRect(obj) {
    const [x0, y0, x1, y1] = obj.rect;
    place(obj.node, obj.page, x0, y0, x1, y1);
  }

  function startTextEditing(obj) {
    const node = obj.node;
    node.contentEditable = 'plaintext-only';
    if (node.contentEditable !== 'plaintext-only') node.contentEditable = 'true';
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function removeObject(obj, { record = true } = {}) {
    const i = objects.indexOf(obj);
    if (i < 0) return;
    objects.splice(i, 1);
    obj.node.remove();
    if (record) history.push({ kind: 'remove', obj, index: i });
    if (selected === obj) select(null);
    refreshState();
  }

  function attachObjectDrag(obj, layer) {
    const node = obj.node;
    node.addEventListener('pointerdown', (e) => {
      if (node.isContentEditable) return; // selecionando texto dentro dele
      e.stopPropagation();
      e.preventDefault();
      select(obj);
      const resizing = e.target.classList.contains('ed-handle');
      const start = toPdf(layer, obj.page, e.clientX, e.clientY);
      const orig = obj.rect ? [...obj.rect] : [obj.x, obj.y];
      let moved = false;
      node.setPointerCapture(e.pointerId);

      const onMove = (ev) => {
        const p = toPdf(layer, obj.page, ev.clientX, ev.clientY);
        const dx = p.x - start.x;
        const dy = p.y - start.y;
        if (!moved && Math.hypot(dx, dy) * start.scale < 3) return;
        moved = true;
        if (obj.type === 'addText') {
          obj.x = orig[0] + dx;
          obj.y = orig[1] + dy;
          node.style.left = pct(obj.x, pagesMeta[obj.page].width);
          node.style.top = pct(obj.y, pagesMeta[obj.page].height);
        } else if (resizing) {
          let x1 = Math.max(orig[0] + 4, orig[2] + dx);
          let y1 = Math.max(orig[1] + 4, orig[3] + dy);
          if (obj.type === 'image' && obj.ratio) y1 = orig[1] + (x1 - orig[0]) / obj.ratio;
          obj.rect = [orig[0], orig[1], x1, y1];
          syncRect(obj);
        } else {
          obj.rect = [orig[0] + dx, orig[1] + dy, orig[2] + dx, orig[3] + dy];
          syncRect(obj);
        }
      };
      const onUp = () => {
        node.removeEventListener('pointermove', onMove);
        node.removeEventListener('pointerup', onUp);
        if (moved) {
          history.push({ kind: 'move', obj, prev: orig });
          refreshState();
        } else if (obj.type === 'addText') {
          startTextEditing(obj);
        }
      };
      node.addEventListener('pointermove', onMove);
      node.addEventListener('pointerup', onUp);
    });
  }

  // ------------------------------------------------- cliques e arrastos na página
  function attachLayerEvents(layer, page) {
    layer.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const p = toPdf(layer, page, e.clientX, e.clientY);

      if (mode === 'select') {
        select(null);
        return;
      }
      if (mode === 'text') {
        e.preventDefault();
        const size = Number(edSize.value) || 12;
        addObject({ type: 'addText', page, x: p.x, y: p.y - size * 0.6, text: '', size, color: edColor.value, bold: edBold.checked }, { focus: true });
        return;
      }
      if (mode === 'place' && pendingImage) {
        e.preventDefault();
        const w = pendingImage.from === 'sign' ? 160 : 200;
        const h = w / pendingImage.ratio;
        addObject({ type: 'image', page, rect: [p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2], data: pendingImage.data, ratio: pendingImage.ratio });
        pendingImage = null;
        setMode('select');
        return;
      }
      if (['highlight', 'rect', 'whiteout', 'redact'].includes(mode)) {
        e.preventDefault();
        const ghost = document.createElement('div');
        ghost.className = `ed-obj ed-obj-${mode} ed-ghost`;
        layer.appendChild(ghost);
        layer.setPointerCapture(e.pointerId);
        let end = p;
        const draw = () => place(ghost, page, Math.min(p.x, end.x), Math.min(p.y, end.y), Math.max(p.x, end.x), Math.max(p.y, end.y));
        draw();
        const onMove = (ev) => { end = toPdf(layer, page, ev.clientX, ev.clientY); draw(); };
        const onUp = () => {
          layer.removeEventListener('pointermove', onMove);
          layer.removeEventListener('pointerup', onUp);
          ghost.remove();
          const rect = [Math.min(p.x, end.x), Math.min(p.y, end.y), Math.max(p.x, end.x), Math.max(p.y, end.y)];
          if (rect[2] - rect[0] < 3 || rect[3] - rect[1] < 3) return;
          const color = mode === 'highlight' ? (edColor.value === '#000000' ? '#ffeb33' : edColor.value)
            : mode === 'rect' ? (edColor.value === '#000000' ? '#cc0000' : edColor.value) : null;
          addObject({ type: mode, page, rect, color, width: 2 });
        };
        layer.addEventListener('pointermove', onMove);
        layer.addEventListener('pointerup', onUp);
      }
    });
  }

  // ------------------------------------------------- assinatura e imagens
  function readImage(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(png|jpeg)$/.test(file.type)) return reject(new Error('Use imagem PNG ou JPEG.'));
      if (file.size > 8 * 1024 * 1024) return reject(new Error('Imagem grande demais (máximo 8 MB).'));
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => resolve({ data: reader.result, ratio: img.naturalWidth / img.naturalHeight });
        img.onerror = () => reject(new Error('Imagem inválida.'));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error('Não consegui ler a imagem.'));
      reader.readAsDataURL(file);
    });
  }

  let imageTarget = 'image';
  edImageInput.addEventListener('change', async () => {
    const file = edImageInput.files[0];
    edImageInput.value = '';
    if (!file) return;
    try {
      const img = await readImage(file);
      pendingImage = { ...img, from: imageTarget };
      if (signDialog.open) signDialog.close();
      setMode('place');
    } catch (err) {
      showError(err.message);
    }
  });

  // Canvas da assinatura
  const ctx = signCanvas.getContext('2d');
  let drawing = false;
  let signDirty = false;
  function clearSign() {
    ctx.clearRect(0, 0, signCanvas.width, signCanvas.height);
    signDirty = false;
  }
  function canvasPoint(e) {
    const r = signCanvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (signCanvas.width / r.width), (e.clientY - r.top) * (signCanvas.height / r.height)];
  }
  signCanvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    signDirty = true;
    signCanvas.setPointerCapture(e.pointerId);
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = edColor.value === '#000000' ? '#0b1f6b' : edColor.value;
    ctx.beginPath();
    ctx.moveTo(...canvasPoint(e));
  });
  signCanvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    ctx.lineTo(...canvasPoint(e));
    ctx.stroke();
  });
  signCanvas.addEventListener('pointerup', () => { drawing = false; });
  $('edSignClear').addEventListener('click', clearSign);
  $('edSignCancel').addEventListener('click', () => { signDialog.close(); setMode('select'); });
  $('edSignUpload').addEventListener('click', () => { imageTarget = 'sign'; edImageInput.click(); });
  $('edSignOk').addEventListener('click', () => {
    if (!signDirty) {
      showError('Rabisca alguma coisa antes, né.');
      return;
    }
    // Recorta o espaço vazio em volta do rabisco
    const { width, height } = signCanvas;
    const px = ctx.getImageData(0, 0, width, height).data;
    let minX = width; let minY = height; let maxX = 0; let maxY = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (px[(y * width + x) * 4 + 3] > 10) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const pad = 6;
    const cw = Math.min(width, maxX - minX + pad * 2);
    const ch = Math.min(height, maxY - minY + pad * 2);
    const out = document.createElement('canvas');
    out.width = cw;
    out.height = ch;
    out.getContext('2d').drawImage(signCanvas, Math.max(0, minX - pad), Math.max(0, minY - pad), cw, ch, 0, 0, cw, ch);
    pendingImage = { data: out.toDataURL('image/png'), ratio: cw / ch, from: 'sign' };
    signDialog.close();
    setMode('place');
  });

  // ------------------------------------------------- barra de ferramentas
  document.querySelectorAll('.ed-mode').forEach((btn) => btn.addEventListener('click', () => {
    const m = btn.dataset.mode;
    if (m === 'sign') {
      clearSign();
      setMode('sign');
      signDialog.showModal();
      return;
    }
    if (m === 'image') {
      imageTarget = 'image';
      setMode('image');
      edImageInput.click();
      return;
    }
    setMode(m);
  }));

  edDelete.addEventListener('click', () => { if (selected) removeObject(selected); });

  edUndo.addEventListener('click', () => {
    const last = history.pop();
    if (!last) return;
    if (last.kind === 'add') {
      removeObject(last.obj, { record: false });
    } else if (last.kind === 'remove') {
      const layer = edPages.querySelector(`.ed-page[data-page="${last.obj.page}"] .ed-layer`);
      layer.appendChild(last.obj.node);
      objects.splice(last.index, 0, last.obj);
    } else if (last.kind === 'move') {
      if (last.obj.type === 'addText') {
        [last.obj.x, last.obj.y] = last.prev;
        last.obj.node.style.left = pct(last.obj.x, pagesMeta[last.obj.page].width);
        last.obj.node.style.top = pct(last.obj.y, pagesMeta[last.obj.page].height);
      } else {
        last.obj.rect = last.prev;
        syncRect(last.obj);
      }
    } else if (last.kind === 'edit') {
      const current = edits.get(last.key);
      const el = current ? current.el : null;
      if (last.hadPrev && el) edits.set(last.key, { ...current, text: last.prevText });
      else edits.delete(last.key);
      last.node.textContent = last.prevText;
      last.node.classList.toggle('edited', edits.has(last.key));
      last.node.classList.toggle('deleted', edits.has(last.key) && last.prevText === '');
    }
    refreshState();
  });

  document.addEventListener('keydown', (e) => {
    if (!session || document.getElementById('tab-editor').classList.contains('hidden')) return;
    const typing = e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (typing) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault();
      removeObject(selected);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      edUndo.click();
    }
  });

  // Mudar cor/tamanho/negrito afeta o texto novo selecionado
  [edColor, edSize, edBold].forEach((input) => input.addEventListener('change', () => {
    if (!selected || selected.type !== 'addText') return;
    selected.color = edColor.value;
    selected.size = Number(edSize.value) || 12;
    selected.bold = edBold.checked;
    selected.node.style.color = selected.color;
    selected.node.style.fontSize = fontSizeCss(selected.page, selected.size);
    selected.node.style.fontWeight = selected.bold ? 'bold' : 'normal';
  }));

  // ------------------------------------------------- salvar
  function buildOps() {
    const ops = [];
    edits.forEach(({ page, el, text }) => {
      if (text === el.text) return;
      ops.push({ type: 'edit', page, bbox: el.bbox, origin: el.origin, text, font: el.font, size: el.size, color: el.color, flags: el.flags });
    });
    objects.forEach((o) => {
      if (o.type === 'addText') {
        if (o.text && o.text.trim()) ops.push({ type: 'addText', page: o.page, x: o.x, y: o.y, text: o.text, size: o.size, color: o.color, bold: o.bold, family: 'sans' });
      } else if (o.type === 'image') {
        ops.push({ type: 'image', page: o.page, rect: o.rect, data: o.data });
      } else {
        ops.push({ type: o.type, page: o.page, rect: o.rect, color: o.color, width: o.width });
      }
    });
    fieldValues.forEach(({ page, name, value }) => ops.push({ type: 'field', page, name, value }));
    return ops;
  }

  edSaveBtn.addEventListener('click', async () => {
    if (document.activeElement && document.activeElement.isContentEditable) document.activeElement.blur();
    const ops = buildOps();
    if (!ops.length) return;
    startLoading('editor');
    resultEl.classList.add('hidden');
    edSaveBtn.disabled = true;
    try {
      const res = await fetch(`/api/editor/${session}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ops, flattenForms: edFlatten.checked, originalName })
      });
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      if (!res.ok || !data) {
        if (res.status === 404) throw new Error((data && data.error) || 'Sessão expirou. Abra o PDF de novo (suas edições na tela continuam, mas o servidor esqueceu o arquivo).');
        throw new Error((data && data.error) || `Erro no servidor (${res.status}).`);
      }
      const s = data.stats || {};
      const parts = [];
      if (s.edited) parts.push(`Trechos reescritos: <strong>${s.edited}</strong>`);
      if (s.added) parts.push(`Textos novos: <strong>${s.added}</strong>`);
      if (s.images) parts.push(`Imagens/assinaturas: <strong>${s.images}</strong>`);
      if (s.shapes) parts.push(`Marcações: <strong>${s.shapes}</strong>`);
      if (s.redacted) parts.push(`Tarjas: <strong>${s.redacted}</strong>`);
      if (s.fields) parts.push(`Campos preenchidos: <strong>${s.fields}</strong>`);
      const fallback = s.fallbackFonts
        ? `<br><em>${s.fallbackFonts} trecho(s) usaram fonte parecida (a original não tinha todas as letras). Confere se ficou aceitável.</em>`
        : '';
      await showResult({
        info: `${parts.join('<br>')}${fallback}<br>Tamanho: <strong>${formatBytes(data.size)}</strong><br><em>Pode continuar editando e salvar de novo.</em>`,
        label: 'BAIXAR PDF ADULTERADO',
        id: data.id,
        outName: data.originalName
      });
      resultEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (err) {
      stopLoading(false);
      showError(err.message);
    } finally {
      loadingEl.classList.add('hidden');
      refreshState();
    }
  });

  // ------------------------------------------------- entrada e saída
  $('edBrowseBtn').addEventListener('click', (e) => { e.stopPropagation(); edInput.click(); });
  edDropzone.addEventListener('click', () => edInput.click());
  edInput.addEventListener('change', () => { if (edInput.files[0]) openPdf(edInput.files[0]); edInput.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => edDropzone.addEventListener(ev, (e) => { e.preventDefault(); edDropzone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => edDropzone.addEventListener(ev, (e) => { e.preventDefault(); edDropzone.classList.remove('dragover'); }));
  edDropzone.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) openPdf(f); });

  $('edCloseBtn').addEventListener('click', () => {
    if (changeCount() && !window.confirm('Largar esse PDF? As alterações não salvas vão pro lixo.')) return;
    resetState();
    edWorkspace.classList.add('hidden');
    edDropzone.classList.remove('hidden');
    resultEl.classList.add('hidden');
  });

  window.addEventListener('beforeunload', (e) => {
    if (session && changeCount()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  LOADING_MESSAGES.editor = [
    'Desmontando o PDF peça por peça...',
    'Anotando onde cada letra mora...',
    'Falsificando com responsabilidade...',
    'Convencendo a fonte a aceitar letra nova...',
    'Passando corretivo digital...'
  ];
})();
