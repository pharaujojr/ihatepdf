// Biblioteca de fontes do I HATE PDF: tudo servido pelo próprio app
// (/fonts/...), carregado sob demanda com a FontFace API. Nada de CDN.
const FontLib = (() => {
  let catalogPromise = null;
  const loaded = new Map();

  function catalog() {
    if (!catalogPromise) {
      catalogPromise = fetch('/fonts/catalog.json')
        .then((r) => (r.ok ? r.json() : { categories: {}, fonts: [] }))
        .catch(() => ({ categories: {}, fonts: [] }));
    }
    return catalogPromise;
  }

  const family = (key) => `ihp-${key}`;
  const css = (key) => `"${family(key)}", "Liberation Sans", Arial, sans-serif`;

  // Estilo que existe de verdade no catálogo (igual ao que o servidor vai usar)
  function resolveStyle(font, bold, italic) {
    const files = font.files || {};
    const wanted = bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'regular';
    if (files[wanted]) return wanted;
    if (bold && files.bold) return 'bold';
    if (italic && files.italic) return 'italic';
    return 'regular';
  }

  async function ensure(key, bold = false, italic = false) {
    const cat = await catalog();
    const font = cat.fonts.find((f) => f.key === key);
    if (!font) return null;
    const style = resolveStyle(font, bold, italic);
    const id = `${key}:${style}`;
    if (!loaded.has(id)) {
      const face = new FontFace(family(key), `url(/fonts/${font.files[style]})`, {
        weight: style.includes('bold') ? '700' : '400',
        style: style.includes('italic') ? 'italic' : 'normal'
      });
      loaded.set(id, face.load().then((f) => { document.fonts.add(f); return f; }).catch(() => null));
    }
    return loaded.get(id);
  }

  function has(font, style) {
    return Boolean(font && font.files && font.files[style]);
  }

  return { catalog, ensure, css, family, has };
})();

// --- Aba "Fontes": catálogo com prévia ao vivo e download ---
(() => {
  let built = false;
  const STYLE_LABEL = { regular: 'Regular', bold: 'Negrito', italic: 'Itálico', bolditalic: 'Negrito itálico' };

  document.addEventListener('ihp:pane', (e) => {
    if (e.detail === 'fonts' && !built) {
      built = true;
      build();
    }
  });

  async function build() {
    const cat = await FontLib.catalog();
    const grid = document.getElementById('fontsGrid');
    const filters = document.getElementById('fontsFilters');
    const sample = document.getElementById('fontsSample');
    const size = document.getElementById('fontsSize');
    let active = 'all';

    const observer = new IntersectionObserver((entries) => entries.forEach((en) => {
      if (en.isIntersecting) {
        FontLib.ensure(en.target.dataset.key);
        observer.unobserve(en.target);
      }
    }), { rootMargin: '200px' });

    const chips = [['all', 'Todas'], ...Object.entries(cat.categories)];
    chips.forEach(([key, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = label;
      b.dataset.cat = key;
      b.setAttribute('aria-pressed', String(key === active));
      b.addEventListener('click', () => {
        active = key;
        filters.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
        grid.querySelectorAll('.font-card').forEach((c) => c.classList.toggle('hidden', active !== 'all' && c.dataset.cat !== active));
      });
      filters.appendChild(b);
    });

    cat.fonts.forEach((f) => {
      const card = document.createElement('article');
      card.className = 'font-card';
      card.dataset.cat = f.category;
      card.dataset.key = f.key;

      const head = document.createElement('div');
      head.className = 'font-card-head';
      const name = document.createElement('h3');
      name.textContent = f.name;
      const tag = document.createElement('span');
      tag.className = 'font-tag';
      tag.textContent = cat.categories[f.category] || f.category;
      head.append(name, tag);

      const preview = document.createElement('p');
      preview.className = 'font-sample';
      preview.style.fontFamily = FontLib.css(f.key);
      preview.textContent = sample.value;

      const actions = document.createElement('div');
      actions.className = 'font-actions';
      Object.entries(f.files).forEach(([style, file]) => {
        const a = document.createElement('a');
        a.href = `/fonts/${file}`;
        a.download = file.split('/').pop();
        a.className = 'font-dl';
        a.textContent = `⬇ ${STYLE_LABEL[style] || style}`;
        actions.appendChild(a);
      });
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'font-use';
      use.textContent = 'Usar no editor';
      use.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('ihp:use-font', { detail: f.key }));
        activate('editor');
      });
      actions.appendChild(use);

      card.append(head, preview, actions);
      grid.appendChild(card);
      observer.observe(card);
    });

    sample.addEventListener('input', () => {
      grid.querySelectorAll('.font-sample').forEach((p) => { p.textContent = sample.value || 'Odeio PDF'; });
    });
    const applySize = () => grid.style.setProperty('--sample-size', `${size.value}px`);
    size.addEventListener('input', applySize);
    applySize();
  }
})();
