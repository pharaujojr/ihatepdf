// --- Editor de PDF (TESTE), com cara de Word ---
// A página é uma imagem gerada pelo servidor; por cima vai uma camada com os
// trechos de texto do PDF (editáveis e formatáveis), os campos de formulário
// e os objetos criados. Tudo guardado em pontos PDF (origem no topo esquerdo)
// e posicionado em % dentro da página — o zoom só muda a largura da página.
(() => {
  const $ = (id) => document.getElementById(id);
  const edDropzone = $('edDropzone');
  const edInput = $('edInput');
  const edWorkspace = $('edWorkspace');
  const edCanvas = $('edCanvas');
  const edPages = $('edPages');
  const edHint = $('edHint');
  const edColor = $('edColor');
  const edColorBar = $('edColorBar');
  const edSize = $('edSize');
  const edBold = $('edBold');
  const edItalic = $('edItalic');
  const edUnderline = $('edUnderline');
  const edFontBtn = $('edFontBtn');
  const edFontMenu = $('edFontMenu');
  const edDelete = $('edDelete');
  const edUndo = $('edUndo');
  const edSaveBtn = $('edSaveBtn');
  const edSaveSub = $('edSaveSub');
  const edFlatten = $('edFlatten');
  const edFlattenRow = $('edFlattenRow');
  const edImageInput = $('edImageInput');
  const edStatusPage = $('edStatusPage');
  const edZoomRange = $('edZoomRange');
  const edZoomLabel = $('edZoomLabel');
  const signDialog = $('edSignDialog');
  const signCanvas = $('edSignCanvas');
  const testBanner = document.querySelector('#tab-editor .test-banner');

  const PT_TO_PX = 96 / 72;
  const DEFAULT_FONT = 'liberation-sans';

  const HINTS = {
    select: 'Clique num texto do PDF para reescrever; a faixa "Fonte" formata o trecho selecionado.',
    text: 'Clique na página onde quer escrever.',
    sign: 'Desenhe a assinatura, depois clique na página onde ela vai.',
    image: 'Escolha a imagem e clique na página onde ela vai.',
    place: 'Agora clique na página onde isso vai.',
    highlight: 'Arraste por cima do que você quer marcar.',
    rect: 'Arraste para desenhar o retângulo.',
    whiteout: 'Arraste para cobrir de branco.',
    redact: 'Arraste por cima do que precisa sumir. Some DE VERDADE ao salvar.'
  };

  let session = null;
  let originalName = '';
  let pagesMeta = [];
  let catalog = { categories: {}, fonts: [] };
  let mode = 'select';
  let zoom = 1;
  let pendingImage = null;
  let selected = null; // objeto criado selecionado
  let target = null; // { kind: 'orig', key } | { kind: 'obj', obj } — alvo da faixa "Fonte"
  let uidSeq = 0;
  let lastSaved = ''; // ops do último salvamento (para não avisar à toa ao sair)
  const defaults = { fontKey: DEFAULT_FONT, size: 12, bold: false, italic: false, underline: false, color: '#000000' };

  const origs = new Map(); // "página:id" -> { page, el, node }
  const edits = new Map(); // "página:id" -> { text, fmt|null }
  const objects = [];
  const fieldValues = new Map();
  const history = [];

  // ---------------------------------------------------------------- utilidades
  const pct = (v, total) => `${(v / total) * 100}%`;
  const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const fontByKey = (key) => catalog.fonts.find((f) => f.key === key);
  const fontName = (key) => (fontByKey(key) || { name: key }).name;

  function place(node, page, x0, y0, x1, y1) {
    const { width: w, height: h } = pagesMeta[page];
    node.style.left = pct(x0, w);
    node.style.top = pct(y0, h);
    node.style.width = pct(Math.max(x1 - x0, 1), w);
    node.style.height = pct(Math.max(y1 - y0, 1), h);
  }

  // .ed-page tem container-type: inline-size — cqw acompanha a largura da página
  const fontSizeCss = (page, sizePt) => `${(sizePt / pagesMeta[page].width) * 100}cqw`;

  function toPdf(layer, page, clientX, clientY) {
    const r = layer.getBoundingClientRect();
    const scale = r.width / pagesMeta[page].width;
    return {
      x: Math.max(0, Math.min(pagesMeta[page].width, (clientX - r.left) / scale)),
      y: Math.max(0, Math.min(pagesMeta[page].height, (clientY - r.top) / scale)),
      scale
    };
  }

  function applyFontStyle(node, page, fmt) {
    FontLib.ensure(fmt.fontKey, fmt.bold, fmt.italic);
    node.style.fontFamily = FontLib.css(fmt.fontKey);
    node.style.fontSize = fontSizeCss(page, fmt.size);
    node.style.fontWeight = fmt.bold ? '700' : '400';
    node.style.fontStyle = fmt.italic ? 'italic' : 'normal';
    node.style.textDecoration = fmt.underline ? 'underline' : 'none';
    node.style.setProperty('--c', fmt.color);
  }

  function baseFmt(el) {
    return { fontKey: el.fontKey || DEFAULT_FONT, size: el.size, bold: Boolean(el.bold), italic: Boolean(el.italic), underline: false, color: hex(el.color) };
  }

  function isChanged(key, e) {
    const { el } = origs.get(key);
    return Boolean(e.fmt) || e.text !== el.text;
  }

  function changeCount() {
    let n = objects.length + fieldValues.size;
    edits.forEach((e, key) => { if (isChanged(key, e)) n += 1; });
    return n;
  }

  const hasUnsaved = () => changeCount() > 0 && JSON.stringify(buildOps()) !== lastSaved;

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
    if (obj && obj.type === 'addText') setTarget({ kind: 'obj', obj });
    refreshState();
  }

  function setMode(next) {
    mode = next;
    document.querySelectorAll('.ed-mode').forEach((b) => b.classList.toggle('active',
      b.dataset.mode === next || (next === 'place' && pendingImage && b.dataset.mode === pendingImage.from)));
    edPages.dataset.mode = next;
    edHint.textContent = HINTS[next] || '';
    if (next !== 'select') select(null);
  }

  // ---------------------------------------------------------------- faixa "Fonte"
  function currentFmt() {
    if (target && target.kind === 'orig') {
      const e = edits.get(target.key);
      return (e && e.fmt) || baseFmt(origs.get(target.key).el);
    }
    if (target && target.kind === 'obj') return target.obj;
    return defaults;
  }

  function reflectRibbon() {
    const fmt = currentFmt();
    edFontBtn.textContent = fontName(fmt.fontKey);
    edFontBtn.style.fontFamily = FontLib.css(fmt.fontKey);
    FontLib.ensure(fmt.fontKey);
    edSize.value = String(Math.round(fmt.size * 10) / 10);
    edBold.setAttribute('aria-pressed', String(Boolean(fmt.bold)));
    edItalic.setAttribute('aria-pressed', String(Boolean(fmt.italic)));
    edUnderline.setAttribute('aria-pressed', String(Boolean(fmt.underline)));
    edColor.value = fmt.color;
    edColorBar.style.background = fmt.color;
    const font = fontByKey(fmt.fontKey);
    edBold.classList.toggle('unavailable', Boolean(font) && !FontLib.has(font, 'bold'));
    edItalic.classList.toggle('unavailable', Boolean(font) && !FontLib.has(font, 'italic'));
  }

  function setTarget(t) {
    target = t;
    reflectRibbon();
  }

  // Aplica uma mudança de formatação ao alvo (ou ao padrão do próximo texto novo)
  function applyFormat(change) {
    if (target && target.kind === 'orig') {
      const { key } = target;
      const { el, node } = origs.get(key);
      const existing = edits.get(key);
      const prev = existing ? { text: existing.text, fmt: existing.fmt && { ...existing.fmt } } : null;
      const entry = existing || { text: node.isContentEditable ? node.textContent : el.text, fmt: null };
      entry.fmt = { ...(entry.fmt || baseFmt(el)), ...change };
      edits.set(key, entry);
      history.push({ kind: 'orig', key, prev });
      renderOrig(key);
    } else if (target && target.kind === 'obj') {
      const obj = target.obj;
      history.push({ kind: 'objFormat', obj, prev: { fontKey: obj.fontKey, size: obj.size, bold: obj.bold, italic: obj.italic, underline: obj.underline, color: obj.color } });
      Object.assign(obj, change);
      applyFontStyle(obj.node, obj.page, obj);
      obj.node.style.color = obj.color;
    } else {
      Object.assign(defaults, change);
    }
    reflectRibbon();
    refreshState();
  }

  // Botões da faixa não roubam o foco do texto sendo editado (como no Word)
  document.querySelectorAll('#edToolbar button.rbtn, .font-btn').forEach((b) => b.addEventListener('pointerdown', (e) => e.preventDefault()));

  edBold.addEventListener('click', () => applyFormat({ bold: !currentFmt().bold }));
  edItalic.addEventListener('click', () => applyFormat({ italic: !currentFmt().italic }));
  edUnderline.addEventListener('click', () => applyFormat({ underline: !currentFmt().underline }));
  $('edGrow').addEventListener('click', () => applyFormat({ size: Math.min(300, Math.round(currentFmt().size + 1)) }));
  $('edShrink').addEventListener('click', () => applyFormat({ size: Math.max(2, Math.round(currentFmt().size - 1)) }));
  edSize.addEventListener('change', () => {
    const v = Number(String(edSize.value).replace(',', '.'));
    if (v >= 2 && v <= 300) applyFormat({ size: v });
    else reflectRibbon();
  });
  edColor.addEventListener('input', () => { edColorBar.style.background = edColor.value; });
  edColor.addEventListener('change', () => applyFormat({ color: edColor.value }));

  // Seletor de fontes com prévia (cada nome escrito na própria fonte)
  function buildFontMenu() {
    edFontMenu.innerHTML = '';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'font-search';
    search.placeholder = 'Procurar fonte...';
    edFontMenu.appendChild(search);
    const list = document.createElement('div');
    list.className = 'font-list';
    edFontMenu.appendChild(list);
    const observer = new IntersectionObserver((entries) => entries.forEach((en) => {
      if (en.isIntersecting) {
        FontLib.ensure(en.target.dataset.key);
        observer.unobserve(en.target);
      }
    }), { root: list });
    Object.entries(catalog.categories).forEach(([cat, label]) => {
      const fonts = catalog.fonts.filter((f) => f.category === cat);
      if (!fonts.length) return;
      const h = document.createElement('p');
      h.className = 'font-cat';
      h.textContent = label;
      list.appendChild(h);
      fonts.forEach((f) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'font-item';
        item.dataset.key = f.key;
        item.dataset.search = f.name.toLowerCase();
        item.setAttribute('role', 'option');
        item.textContent = f.name;
        item.style.fontFamily = FontLib.css(f.key);
        item.addEventListener('pointerdown', (e) => e.preventDefault());
        item.addEventListener('click', () => {
          closeFontMenu();
          applyFormat({ fontKey: f.key });
        });
        list.appendChild(item);
        observer.observe(item);
      });
    });
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      list.querySelectorAll('.font-item').forEach((i) => i.classList.toggle('hidden', Boolean(q) && !i.dataset.search.includes(q)));
    });
  }

  function closeFontMenu() {
    edFontMenu.classList.add('hidden');
    edFontBtn.setAttribute('aria-expanded', 'false');
  }

  edFontBtn.addEventListener('click', () => {
    if (!edFontMenu.classList.contains('hidden')) {
      closeFontMenu();
      return;
    }
    const r = edFontBtn.getBoundingClientRect();
    edFontMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 310))}px`;
    edFontMenu.style.top = `${r.bottom}px`;
    edFontMenu.classList.remove('hidden');
    edFontBtn.setAttribute('aria-expanded', 'true');
    const current = edFontMenu.querySelector(`.font-item[data-key="${currentFmt().fontKey}"]`);
    edFontMenu.querySelectorAll('.font-item').forEach((i) => i.classList.toggle('current', i === current));
    if (current) current.scrollIntoView({ block: 'center' });
  });
  document.addEventListener('pointerdown', (e) => {
    if (!edFontMenu.classList.contains('hidden') && !$('edFontPicker').contains(e.target)) closeFontMenu();
  });

  // Abas da faixa de opções
  function showRibbonTab(name) {
    document.querySelectorAll('.word-tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.rtab === name);
      t.setAttribute('aria-selected', String(t.dataset.rtab === name));
    });
    document.querySelectorAll('.rgroup').forEach((g) => g.classList.toggle('hidden', g.dataset.rtab !== name));
  }
  document.querySelectorAll('.word-tab').forEach((t) => t.addEventListener('click', () => showRibbonTab(t.dataset.rtab)));

  // ---------------------------------------------------------------- zoom
  function setZoom(z) {
    zoom = Math.max(0.4, Math.min(2.5, z));
    edPages.querySelectorAll('.ed-page').forEach((p) => {
      p.style.width = `${pagesMeta[p.dataset.page].width * zoom * PT_TO_PX}px`;
    });
    edZoomRange.value = String(Math.round(zoom * 100));
    edZoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  function fitWidth() {
    const maxW = Math.max(...pagesMeta.map((p) => p.width));
    setZoom((edCanvas.clientWidth - 48) / (maxW * PT_TO_PX));
  }

  function fitPage() {
    const p = pagesMeta[0];
    setZoom(Math.min((edCanvas.clientWidth - 48) / (p.width * PT_TO_PX), (edCanvas.clientHeight - 32) / (p.height * PT_TO_PX)));
  }

  $('edFitWidth').addEventListener('click', fitWidth);
  $('edFitPage').addEventListener('click', fitPage);
  $('edZoom100').addEventListener('click', () => setZoom(1));
  $('edZoomIn').addEventListener('click', () => setZoom(Math.round(zoom * 10 + 1) / 10));
  $('edZoomOut').addEventListener('click', () => setZoom(Math.round(zoom * 10 - 1) / 10));
  edZoomRange.addEventListener('input', () => setZoom(Number(edZoomRange.value) / 100));
  edCanvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.1 : 0.9));
  }, { passive: false });

  edCanvas.addEventListener('scroll', () => {
    const mid = edCanvas.getBoundingClientRect().top + edCanvas.clientHeight / 2;
    let current = 0;
    edPages.querySelectorAll('.ed-page').forEach((p, i) => {
      if (p.getBoundingClientRect().top < mid) current = i;
    });
    edStatusPage.textContent = `Página ${current + 1} de ${pagesMeta.length}`;
  }, { passive: true });

  // ---------------------------------------------------------------- modo largo
  function setWide(on) {
    document.body.classList.toggle('ed-wide', on);
    if (testBanner) testBanner.classList.toggle('hidden', on);
  }

  document.addEventListener('ihp:pane', (e) => setWide(e.detail === 'editor' && Boolean(session)));

  // "Usar no editor" da aba Fontes: vira a fonte padrão (ou do texto selecionado)
  document.addEventListener('ihp:use-font', (e) => {
    catalog.fonts.length ? applyFormat({ fontKey: e.detail }) : Object.assign(defaults, { fontKey: e.detail });
    if (!session) edHint.textContent = `Fonte escolhida: ${e.detail}. Abra um PDF e use "Caixa de texto".`;
  });

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
      const [data, cat] = await Promise.all([postForm('/api/editor/open', fd), FontLib.catalog()]);
      catalog = cat;
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
    lastSaved = '';
    pagesMeta = [];
    origs.clear();
    edits.clear();
    objects.length = 0;
    fieldValues.clear();
    history.length = 0;
    selected = null;
    target = null;
    pendingImage = null;
    edPages.innerHTML = '';
  }

  function loadSession(data) {
    resetState();
    session = data.session;
    originalName = data.originalName || 'documento.pdf';
    pagesMeta = data.pages;
    $('edDocName').textContent = originalName;
    edDropzone.classList.add('hidden');
    edWorkspace.classList.remove('hidden');
    edFlattenRow.classList.toggle('hidden', !pagesMeta.some((p) => p.fields.length));
    buildFontMenu();
    pagesMeta.forEach((p, i) => edPages.appendChild(buildPage(p, i)));
    setWide(true);
    showRibbonTab('home');
    setMode('select');
    setTarget(null);
    requestAnimationFrame(fitWidth);
    edStatusPage.textContent = `Página 1 de ${pagesMeta.length}`;
    if (data.scannedPages) {
      edHint.textContent = `${data.scannedPages} página(s) escaneada(s) sem texto editável: passe no OCR antes, ou use Corretivo + Caixa de texto.`;
    }
    refreshState();
  }

  function buildPage(meta, i) {
    const pageEl = document.createElement('div');
    pageEl.className = 'ed-page';
    pageEl.style.aspectRatio = `${meta.width} / ${meta.height}`;
    pageEl.style.width = `${meta.width * zoom * PT_TO_PX}px`;
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

    meta.elements.forEach((el) => layer.appendChild(buildOrig(i, el)));
    meta.fields.forEach((f) => layer.appendChild(buildField(i, f)));
    attachLayerEvents(layer, i);
    return pageEl;
  }

  // ------------------------------------------------- trechos de texto do PDF
  function renderOrig(key) {
    const { page, el, node } = origs.get(key);
    const entry = edits.get(key);
    const fmt = (entry && entry.fmt) || baseFmt(el);
    if (!node.isContentEditable) node.textContent = entry ? entry.text : el.text;
    applyFontStyle(node, page, fmt);
    const changed = Boolean(entry) && isChanged(key, entry);
    node.classList.toggle('edited', changed);
    node.classList.toggle('deleted', changed && entry.text === '');
    if (entry && !changed) edits.delete(key);
  }

  function buildOrig(page, el) {
    const node = document.createElement('div');
    node.className = 'ed-text';
    const [x0, y0, x1, y1] = el.bbox;
    place(node, page, x0, y0, x1, y1);
    // Ao editar, o fundo branco cobre no mínimo a largura do texto original
    node.style.setProperty('--w', node.style.width);
    node.textContent = el.text;
    node.spellcheck = false;
    const key = `${page}:${el.id}`;
    origs.set(key, { page, el, node });
    applyFontStyle(node, page, baseFmt(el));
    let before = null;

    node.addEventListener('click', (e) => {
      if (mode !== 'select') return;
      e.stopPropagation();
      select(null);
      setTarget({ kind: 'orig', key });
      if (node.isContentEditable) return;
      const current = edits.get(key);
      before = current ? { text: current.text, fmt: current.fmt && { ...current.fmt } } : null;
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
      formatShortcut(e);
    });
    node.addEventListener('paste', (e) => {
      e.preventDefault();
      document.execCommand('insertText', false, (e.clipboardData.getData('text/plain') || '').replace(/\s*\n\s*/g, ' '));
    });
    node.addEventListener('blur', () => {
      node.contentEditable = 'false';
      node.classList.remove('editing');
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      const current = edits.get(key);
      const prevText = current ? current.text : el.text;
      if (text !== prevText) {
        history.push({ kind: 'orig', key, prev: before });
        edits.set(key, { text, fmt: current ? current.fmt : null });
      }
      renderOrig(key);
      refreshState();
    });
    return node;
  }

  function formatShortcut(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'b' || k === 'n') { e.preventDefault(); edBold.click(); }
    if (k === 'i') { e.preventDefault(); edItalic.click(); }
    if (k === 'u') { e.preventDefault(); edUnderline.click(); }
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
  const layerOf = (page) => edPages.querySelector(`.ed-page[data-page="${page}"] .ed-layer`);

  function addObject(obj, { focus = false } = {}) {
    obj.uid = ++uidSeq;
    const layer = layerOf(obj.page);
    const node = document.createElement('div');
    node.className = `ed-obj ed-obj-${obj.type}`;
    obj.node = node;

    if (obj.type === 'addText') {
      node.textContent = obj.text || '';
      applyFontStyle(node, obj.page, obj);
      node.style.color = obj.color;
      node.style.left = pct(obj.x, pagesMeta[obj.page].width);
      node.style.top = pct(obj.y, pagesMeta[obj.page].height);
      node.spellcheck = false;
      node.addEventListener('blur', () => {
        node.contentEditable = 'false';
        obj.text = node.innerText.replace(/ /g, ' ').replace(/\n$/, '');
        if (!obj.text.trim()) removeObject(obj, { record: false });
        refreshState();
      });
      node.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') node.blur();
        formatShortcut(e);
      });
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
      const handle = document.createElement('span');
      handle.className = 'ed-handle';
      node.appendChild(handle);
    }
    attachObjectDrag(obj, layer);
    layer.appendChild(node);
    objects.push(obj);
    history.push({ kind: 'add', obj });
    select(obj);
    if (focus && obj.type === 'addText') startTextEditing(obj);
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
    if (target && target.obj === obj) setTarget(null);
    refreshState();
  }

  function attachObjectDrag(obj, layer) {
    const node = obj.node;
    node.addEventListener('pointerdown', (e) => {
      if (node.isContentEditable) return;
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
          const x1 = Math.max(orig[0] + 4, orig[2] + dx);
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
        setTarget(null);
        return;
      }
      if (mode === 'text') {
        e.preventDefault();
        addObject({ type: 'addText', page, x: p.x, y: p.y - defaults.size * 0.6, text: '', ...defaults }, { focus: true });
        setMode('select');
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
        const kind = mode;
        const ghost = document.createElement('div');
        ghost.className = `ed-obj ed-obj-${kind} ed-ghost`;
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
          const color = kind === 'highlight' ? '#ffeb33' : kind === 'rect' ? (defaults.color === '#000000' ? '#cc0000' : defaults.color) : null;
          addObject({ type: kind, page, rect, color, width: 2 });
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
    ctx.strokeStyle = defaults.color === '#000000' ? '#0b1f6b' : defaults.color;
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

  // ------------------------------------------------- modos, desfazer, apagar
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
      layerOf(last.obj.page).appendChild(last.obj.node);
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
    } else if (last.kind === 'objFormat') {
      Object.assign(last.obj, last.prev);
      applyFontStyle(last.obj.node, last.obj.page, last.obj);
      last.obj.node.style.color = last.obj.color;
    } else if (last.kind === 'orig') {
      if (last.prev) edits.set(last.key, last.prev);
      else edits.delete(last.key);
      const { node, el } = origs.get(last.key);
      node.textContent = last.prev ? last.prev.text : el.text;
      renderOrig(last.key);
    }
    reflectRibbon();
    refreshState();
  });

  document.addEventListener('keydown', (e) => {
    if (!session || $('tab-editor').classList.contains('hidden')) return;
    const typing = e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (!edSaveBtn.disabled) edSaveBtn.click();
      return;
    }
    if (typing) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault();
      removeObject(selected);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      edUndo.click();
    } else {
      formatShortcut(e);
    }
  });

  // ------------------------------------------------- salvar
  function buildOps() {
    const ops = [];
    edits.forEach((entry, key) => {
      if (!isChanged(key, entry)) return;
      const { page, el } = origs.get(key);
      const op = { type: 'edit', page, bbox: el.bbox, origin: el.origin, text: entry.text, font: el.font, size: el.size, color: el.color, flags: el.flags };
      if (entry.fmt) {
        Object.assign(op, {
          fontKey: entry.fmt.fontKey, size: entry.fmt.size, color: entry.fmt.color,
          bold: entry.fmt.bold, italic: entry.fmt.italic, underline: entry.fmt.underline
        });
      }
      ops.push(op);
    });
    objects.forEach((o) => {
      if (o.type === 'addText') {
        if (o.text && o.text.trim()) {
          ops.push({ type: 'addText', page: o.page, x: o.x, y: o.y, text: o.text, size: o.size, color: o.color,
            fontKey: o.fontKey, bold: o.bold, italic: o.italic, underline: o.underline });
        }
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
        if (res.status === 404) throw new Error((data && data.error) || 'Sessão expirou. Abra o PDF de novo.');
        throw new Error((data && data.error) || `Erro no servidor (${res.status}).`);
      }
      lastSaved = JSON.stringify(ops);
      const s = data.stats || {};
      const parts = [];
      if (s.edited) parts.push(`Trechos reescritos: <strong>${s.edited}</strong>`);
      if (s.added) parts.push(`Textos novos: <strong>${s.added}</strong>`);
      if (s.images) parts.push(`Imagens/assinaturas: <strong>${s.images}</strong>`);
      if (s.shapes) parts.push(`Marcações: <strong>${s.shapes}</strong>`);
      if (s.redacted) parts.push(`Tarjas: <strong>${s.redacted}</strong>`);
      if (s.fields) parts.push(`Campos preenchidos: <strong>${s.fields}</strong>`);
      const fallback = s.fallbackFonts
        ? `<br><em>${s.fallbackFonts} trecho(s) usaram fonte parecida (a original não tinha todas as letras).</em>`
        : '';
      resultEl.classList.add('ed-result-floating');
      await showResult({
        info: `${parts.join('<br>')}${fallback}<br>Tamanho: <strong>${formatBytes(data.size)}</strong><br><em>Pode continuar editando e salvar de novo.</em>`,
        label: 'BAIXAR PDF ADULTERADO',
        id: data.id,
        outName: data.originalName
      });
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
    if (hasUnsaved() && !window.confirm('Largar esse PDF? As alterações não salvas vão pro lixo.')) return;
    resetState();
    setWide(false);
    edWorkspace.classList.add('hidden');
    edDropzone.classList.remove('hidden');
    resultEl.classList.add('hidden');
    resultEl.classList.remove('ed-result-floating');
  });

  window.addEventListener('beforeunload', (e) => {
    if (session && hasUnsaved()) {
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
