const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const browseBtn = document.getElementById('browseBtn');
const fileNameEl = document.getElementById('fileName');
const compressBtn = document.getElementById('compressBtn');
const compressPaperSize = document.getElementById('compressPaperSize');
const loadingEl = document.getElementById('loading');
const loadingText = document.getElementById('loadingText');
const heartLoader = document.getElementById('heartLoader');
const heartProgressPercent = document.getElementById('heartProgressPercent');
const resultEl = document.getElementById('result');
const resultInfo = document.getElementById('resultInfo');
const downloadBtn = document.getElementById('downloadBtn');
const resetBtn = document.getElementById('resetBtn');
const errorBox = document.getElementById('errorBox');

const mergeDropzone = document.getElementById('mergeDropzone');
const mergeInput = document.getElementById('mergeInput');
const mergeBrowseBtn = document.getElementById('mergeBrowseBtn');
const mergeList = document.getElementById('mergeList');
const mergeBtn = document.getElementById('mergeBtn');
const mergePaperSize = document.getElementById('mergePaperSize');

let selectedFile = null;
let mergeFiles = [];
let draggedMergeIndex = null;
let loadingProgressTimer = null;

const COMPRESS_PHRASES = [
  'Espreme até o talo',
  'Sem dó, sem piedade',
  'Esmaga essa bodega',
  'Arrocha no encolhimento',
  'Meu e-mail não é GugoDraive'
];

const MERGE_PHRASES = [
  'Mistura, mistura, mistura...',
  'Forje-os no ódio',
  'Junta esses trem',
  'Não precisa tá perto pra tá junto...s2',
  'Bate com limão e gelo'
];

const WORD_PHRASES = [
  'Troca esse trem na base do Ódio',
  'Vira a casaca do arquivo',
  'De cá pra lá, de lá pra cá',
  'Troca de figurino',
  'Modo Emilia Perez no bagulho!'
];

const IMAGE_PHRASES = [
  'Pixel vai, pixel vem',
  'Fatia ou empilha, tu manda',
  'Vira retrato na parede',
  'Espreme em pixels',
  'Imagem é tudo, papel é nada'
];

const LOADING_MESSAGES = {
  compress: [
    'Mandando os megabytes fazerem dieta...',
    'Negociando com pixels teimosos...',
    'Colocando o PDF numa roupa mais justa...',
    'Tirando o excesso sem chamar atenção...',
    'Convencendo o arquivo a ocupar menos espaço...'
  ],
  merge: [
    'Chamando os PDFs para uma reunião estranha...',
    'Alinhando as páginas no pacto final...',
    'Misturando tudo sem derrubar no chão...',
    'Fazendo os arquivos aceitarem a convivência...',
    'Juntando as tretas num documento só...'
  ],
  word: [
    'Acordando o LibreOffice na marra...',
    'Reescrevendo cada parágrafo na mão...',
    'Negociando as fontes com o documento...',
    'Trocando o crachá do arquivo...',
    'Convertendo sem prometer milagres de formatação...'
  ],
  image: [
    'Revelando as imagens no quarto escuro...',
    'Picotando as páginas em pixels...',
    'Escolhendo a melhor moldura...',
    'Amassando os pixels no formato certo...',
    'Empacotando as imagens com carinho de ódio...'
  ],
  text: [
    'Arrancando cabeçalho por cabeçalho...',
    'Jogando os números de página no lixo...',
    'Colando as linhas de volta em parágrafos...',
    'Forçando o robô a ler o escaneado...',
    'Separando o miolo da casca...'
  ],
  excel: [
    'Caçando tabelas escondidas...',
    'Desenhando a grade na régua...',
    'Convertendo R$ em número de verdade...',
    'Emendando a tabela que fugiu pra outra página...',
    'Brigando com célula mesclada...'
  ]
};

const TEXT_PHRASES = [
  'Só o miolo, sem a casca',
  'Tchau, rodapé chato',
  'Texto puro, sem firula',
  'Ctrl+C sem sofrimento'
];

const EXCEL_PHRASES = [
  'Célula por célula, no ódio',
  'Tabela boa é tabela somável',
  'Adeus, digitar na mão',
  'PROCV que lute'
];

function rotatePhrase(el, list) {
  if (!el) return;
  let i = Math.floor(Math.random() * list.length);
  el.textContent = list[i];
  setInterval(() => {
    i = (i + 1) % list.length;
    el.style.opacity = '0';
    setTimeout(() => {
      el.textContent = list[i];
      el.style.opacity = '0.85';
    }, 220);
  }, 3500);
}

rotatePhrase(document.getElementById('compressPhrase'), COMPRESS_PHRASES);
rotatePhrase(document.getElementById('mergePhrase'), MERGE_PHRASES);
rotatePhrase(document.getElementById('wordPhrase'), WORD_PHRASES);
rotatePhrase(document.getElementById('imagePhrase'), IMAGE_PHRASES);
rotatePhrase(document.getElementById('textPhrase'), TEXT_PHRASES);
rotatePhrase(document.getElementById('excelPhrase'), EXCEL_PHRASES);

const resultPreview = document.getElementById('resultPreview');

// Escapa texto vindo do usuário/servidor antes de ir para innerHTML
function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// POST de formulário tolerante a respostas não-JSON (ex.: 413 do proxy)
async function postForm(url, formData) {
  const res = await fetch(url, { method: 'POST', body: formData });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }
  if (!res.ok || !data) {
    if (res.status === 413) throw new Error('Arquivo grande demais para o servidor.');
    throw new Error((data && data.error) || `Erro no servidor (${res.status}).`);
  }
  return data;
}

async function showResult({ info, label, id, outName, preview }) {
  resultInfo.innerHTML = info;
  downloadBtn.textContent = label;
  downloadBtn.href = `/api/download/${id}?name=${encodeURIComponent(outName)}`;
  downloadBtn.setAttribute('download', outName);
  resultPreview.textContent = preview || '';
  resultPreview.classList.toggle('hidden', !preview);
  stopLoading(true);
  await wait(350);
  resultEl.classList.remove('hidden');
}

// Item de lista arrastável (merge e imagens). Monta via DOM com textContent:
// nome de arquivo nunca vira HTML.
function buildListItem(file, i) {
  const li = document.createElement('li');
  li.draggable = true;
  li.dataset.index = i;
  const parts = [
    ['span', 'drag-handle', ''],
    ['span', 'idx', `${i + 1}.`],
    ['span', 'name', file.name],
    ['span', 'size', formatBytes(file.size)]
  ];
  parts.forEach(([tag, cls, text]) => {
    const el = document.createElement(tag);
    el.className = cls;
    el.textContent = text;
    if (cls === 'drag-handle') el.setAttribute('aria-hidden', 'true');
    li.appendChild(el);
  });
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove-btn';
  remove.dataset.action = 'remove';
  remove.setAttribute('aria-label', `Remover ${file.name}`);
  remove.textContent = '✕';
  li.appendChild(remove);
  return li;
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.remove('hidden');
  setTimeout(() => errorBox.classList.add('hidden'), 5000);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function setLoadingProgress(value) {
  const progress = Math.max(0, Math.min(100, Math.round(value)));
  if (heartLoader) heartLoader.style.setProperty('--progress', `${progress}%`);
  if (heartProgressPercent) heartProgressPercent.textContent = `${progress}%`;
}

function startLoading(kind) {
  const messages = LOADING_MESSAGES[kind] || LOADING_MESSAGES.compress;
  let progress = 0;
  let messageIndex = Math.floor(Math.random() * messages.length);

  clearInterval(loadingProgressTimer);
  setLoadingProgress(0);
  loadingText.textContent = messages[messageIndex];
  loadingEl.classList.remove('hidden');

  loadingProgressTimer = setInterval(() => {
    progress = Math.min(94, progress + Math.random() * 8 + 2);
    setLoadingProgress(progress);

    if (Math.random() > 0.58) {
      messageIndex = (messageIndex + 1) % messages.length;
      loadingText.style.opacity = '0';
      setTimeout(() => {
        loadingText.textContent = messages[messageIndex];
        loadingText.style.opacity = '1';
      }, 180);
    }
  }, 520);
}

function stopLoading(done = false) {
  clearInterval(loadingProgressTimer);
  loadingProgressTimer = null;
  if (done) {
    setLoadingProgress(100);
    loadingText.textContent = 'Fechando o caixão e passando o verniz...';
  }
}

// --- Compress ---
function setFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    showError('Arquivo precisa ser PDF.');
    return;
  }
  selectedFile = file;
  fileNameEl.textContent = `${file.name} (${formatBytes(file.size)})`;
  compressBtn.disabled = false;
}

browseBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.click();
});

dropzone.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) setFile(e.target.files[0]);
});

['dragenter', 'dragover'].forEach(ev => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach(ev => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  });
});

dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) setFile(file);
});

compressBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  const profile = document.querySelector('input[name="profile"]:checked').value;
  const originalSize = selectedFile.size;
  const target = document.getElementById('compressTarget').value.trim();

  const formData = new FormData();
  formData.append('pdf', selectedFile);
  formData.append('profile', profile);
  formData.append('paperSize', compressPaperSize?.value || 'original');
  formData.append('grayscale', document.getElementById('compressGray').checked ? '1' : '0');
  if (target) formData.append('targetMB', target);

  startLoading('compress');
  resultEl.classList.add('hidden');
  compressBtn.disabled = true;

  try {
    const data = await postForm('/api/compress', formData);

    const reduction = Math.max(0, (1 - data.size / originalSize) * 100).toFixed(1);
    const outName = data.originalName.replace(/\.pdf$/i, '') + '_comprimido.pdf';
    let extra = '';
    if (data.alreadyOptimal) {
      extra = '<br><em>Esse PDF já estava no osso: devolvemos o original, só com uma faxina sem perdas.</em>';
    } else if (data.targetMet === false) {
      extra = `<br><em>Não coube no tamanho pedido nem no talo. Esse é o menor que deu (${esc(data.usedLevel)}).</em>`;
    } else if (data.targetMet) {
      extra = `<br><em>Coube! Usamos o ${esc(data.usedLevel)}.</em>`;
    }

    await showResult({
      info: `
        Original: <strong>${formatBytes(originalSize)}</strong><br>
        Comprimido: <strong>${formatBytes(data.size)}</strong><br>
        Redução: <strong style="color:#ff2a4d">${reduction}%</strong>${extra}
      `,
      label: 'BAIXAR PDF COMPRIMIDO',
      id: data.id,
      outName
    });
  } catch (err) {
    stopLoading(false);
    showError(err.message);
  } finally {
    loadingEl.classList.add('hidden');
    compressBtn.disabled = false;
  }
});

resetBtn.addEventListener('click', () => {
  selectedFile = null;
  fileInput.value = '';
  fileNameEl.textContent = '';
  compressBtn.disabled = true;
  if (compressPaperSize) compressPaperSize.value = 'original';
  if (mergePaperSize) mergePaperSize.value = 'a4';
  mergeFiles = [];
  mergeInput.value = '';
  renderMergeList();
  resetWord();
  resetImage();
  singlePdfTools.forEach((t) => t.reset());
  resultEl.classList.add('hidden');
});

// --- Merge ---
function renderMergeList() {
  mergeList.innerHTML = '';
  mergeFiles.forEach((file, i) => {
    const li = buildListItem(file, i);

    li.addEventListener('dragstart', (e) => {
      draggedMergeIndex = i;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    });

    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (draggedMergeIndex !== null && draggedMergeIndex !== i) {
        li.classList.add('drag-over');
      }
    });

    li.addEventListener('dragleave', () => {
      li.classList.remove('drag-over');
    });

    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('drag-over');
      const fromIndex = draggedMergeIndex ?? Number(e.dataTransfer.getData('text/plain'));
      if (!Number.isInteger(fromIndex) || fromIndex === i) return;

      const [movedFile] = mergeFiles.splice(fromIndex, 1);
      mergeFiles.splice(i, 0, movedFile);
      draggedMergeIndex = null;
      renderMergeList();
    });

    li.addEventListener('dragend', () => {
      draggedMergeIndex = null;
      li.classList.remove('dragging', 'drag-over');
    });

    li.querySelector('.remove-btn').addEventListener('click', () => {
      mergeFiles.splice(i, 1);
      renderMergeList();
    });

    mergeList.appendChild(li);
  });
  mergeBtn.disabled = mergeFiles.length < 2;
}

function addMergeFiles(fileList) {
  for (const f of fileList) {
    if (f.name.toLowerCase().endsWith('.pdf')) {
      mergeFiles.push(f);
    }
  }
  renderMergeList();
}

mergeBrowseBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  mergeInput.click();
});

mergeDropzone.addEventListener('click', () => mergeInput.click());

mergeInput.addEventListener('change', (e) => {
  if (e.target.files.length) addMergeFiles(e.target.files);
  mergeInput.value = '';
});

['dragenter', 'dragover'].forEach(ev => {
  mergeDropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    mergeDropzone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach(ev => {
  mergeDropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    mergeDropzone.classList.remove('dragover');
  });
});

mergeDropzone.addEventListener('drop', (e) => {
  if (e.dataTransfer.files.length) addMergeFiles(e.dataTransfer.files);
});

mergeBtn.addEventListener('click', async () => {
  if (mergeFiles.length < 2) return;

  const formData = new FormData();
  mergeFiles.forEach(f => formData.append('pdfs', f));
  formData.append('paperSize', mergePaperSize?.value || 'a4');

  startLoading('merge');
  resultEl.classList.add('hidden');
  mergeBtn.disabled = true;

  try {
    const data = await postForm('/api/merge', formData);

    const outName = 'juntado.pdf';
    await showResult({
      info: `
        Arquivos juntados: <strong>${mergeFiles.length}</strong><br>
        Tamanho final: <strong>${formatBytes(data.size)}</strong>
      `,
      label: 'BAIXAR PDF JUNTADO',
      id: data.id,
      outName
    });
  } catch (err) {
    stopLoading(false);
    showError(err.message);
  } finally {
    loadingEl.classList.add('hidden');
    mergeBtn.disabled = mergeFiles.length < 2;
  }
});

// --- Conversão Word <-> PDF ---
const wordDropzone = document.getElementById('wordDropzone');
const wordInput = document.getElementById('wordInput');
const wordBrowseBtn = document.getElementById('wordBrowseBtn');
const wordBtn = document.getElementById('wordBtn');
const wordFileName = document.getElementById('wordFileName');
const wordDzText = document.getElementById('wordDzText');

const WORD_ACCEPT = {
  pdf2word: '.pdf,application/pdf',
  word2pdf: '.doc,.docx,.odt,.rtf,.txt'
};
const WORD_DOC_EXT = ['.doc', '.docx', '.odt', '.rtf', '.txt'];
let wordFile = null;

function wordDirection() {
  return document.querySelector('input[name="wordDir"]:checked').value;
}

function updateWordUI() {
  const dir = wordDirection();
  wordInput.setAttribute('accept', WORD_ACCEPT[dir]);
  wordDzText.textContent = dir === 'pdf2word' ? 'Arraste seu PDF aqui' : 'Arraste seu documento aqui';
  // limpa seleção que não bate com a direção
  if (wordFile && !wordFileMatchesDir(wordFile, dir)) {
    resetWord();
  }
}

function wordFileMatchesDir(file, dir) {
  const name = file.name.toLowerCase();
  if (dir === 'pdf2word') return name.endsWith('.pdf');
  return WORD_DOC_EXT.some(ext => name.endsWith(ext));
}

function setWordFile(file) {
  if (!file) return;
  const dir = wordDirection();
  if (!wordFileMatchesDir(file, dir)) {
    showError(dir === 'pdf2word' ? 'Para PDF → Word, envie um arquivo .pdf.' : 'Para Word → PDF, envie .docx, .doc, .odt, .rtf ou .txt.');
    return;
  }
  wordFile = file;
  wordFileName.textContent = `${file.name} (${formatBytes(file.size)})`;
  wordBtn.disabled = false;
}

function resetWord() {
  wordFile = null;
  if (wordInput) wordInput.value = '';
  if (wordFileName) wordFileName.textContent = '';
  if (wordBtn) wordBtn.disabled = true;
}

document.querySelectorAll('input[name="wordDir"]').forEach(r => r.addEventListener('change', updateWordUI));
wordBrowseBtn.addEventListener('click', (e) => { e.stopPropagation(); wordInput.click(); });
wordDropzone.addEventListener('click', () => wordInput.click());
wordInput.addEventListener('change', (e) => { if (e.target.files[0]) setWordFile(e.target.files[0]); });

['dragenter', 'dragover'].forEach(ev => wordDropzone.addEventListener(ev, (e) => { e.preventDefault(); wordDropzone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(ev => wordDropzone.addEventListener(ev, (e) => { e.preventDefault(); wordDropzone.classList.remove('dragover'); }));
wordDropzone.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) setWordFile(f); });

wordBtn.addEventListener('click', async () => {
  if (!wordFile) return;
  const dir = wordDirection();
  const formData = new FormData();
  formData.append('file', wordFile);
  formData.append('direction', dir);

  startLoading('word');
  resultEl.classList.add('hidden');
  wordBtn.disabled = true;

  try {
    const data = await postForm('/api/word', formData);

    const base = wordFile.name.replace(/\.[^.]+$/, '');
    const outName = `${base}.${data.ext}`;
    const label = dir === 'pdf2word' ? 'BAIXAR WORD' : 'BAIXAR PDF';
    await showResult({ info: `
      Convertido para <strong>.${data.ext}</strong><br>
      Tamanho final: <strong>${formatBytes(data.size)}</strong>
    `, label, id: data.id, outName });
  } catch (err) {
    stopLoading(false);
    showError(err.message);
  } finally {
    loadingEl.classList.add('hidden');
    wordBtn.disabled = !wordFile;
  }
});

updateWordUI();

// --- Conversão de imagens ---
const imageDropzone = document.getElementById('imageDropzone');
const imageInput = document.getElementById('imageInput');
const imageBrowseBtn = document.getElementById('imageBrowseBtn');
const imageBtn = document.getElementById('imageBtn');
const imageDzText = document.getElementById('imageDzText');
const imageListSection = document.getElementById('imageListSection');
const imageListEl = document.getElementById('imageListEl');
const imageFormatPanel = document.getElementById('imageFormatPanel');
const imageFormat = document.getElementById('imageFormat');

const IMG_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.tiff', '.tif', '.bmp', '.gif', '.heic'];
const IMG_ACCEPT = {
  img2pdf: 'image/*,' + IMG_EXT.join(','),
  pdf2img: '.pdf,application/pdf'
};
let imageFiles = [];
let imagePdf = null;
let draggedImageIndex = null;

function imageDirection() {
  return document.querySelector('input[name="imageDir"]:checked').value;
}

function updateImageUI() {
  const dir = imageDirection();
  const isImg2Pdf = dir === 'img2pdf';
  imageInput.setAttribute('accept', IMG_ACCEPT[dir]);
  imageInput.toggleAttribute('multiple', isImg2Pdf);
  imageDzText.textContent = isImg2Pdf ? 'Arraste suas imagens aqui' : 'Arraste seu PDF aqui';
  imageListSection.classList.toggle('hidden', !isImg2Pdf);
  imageFormatPanel.classList.toggle('hidden', isImg2Pdf);
  // reseta seleções ao trocar de direção
  imageFiles = [];
  imagePdf = null;
  imageInput.value = '';
  renderImageList();
  updateImageBtn();
}

function updateImageBtn() {
  imageBtn.disabled = imageDirection() === 'img2pdf' ? imageFiles.length < 1 : !imagePdf;
}

function resetImage() {
  imageFiles = [];
  imagePdf = null;
  if (imageInput) imageInput.value = '';
  renderImageList();
  if (imageBtn) imageBtn.disabled = true;
}

function renderImageList() {
  imageListEl.innerHTML = '';
  imageFiles.forEach((file, i) => {
    const li = buildListItem(file, i);

    li.addEventListener('dragstart', (e) => {
      draggedImageIndex = i;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    });
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (draggedImageIndex !== null && draggedImageIndex !== i) li.classList.add('drag-over');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('drag-over');
      const fromIndex = draggedImageIndex ?? Number(e.dataTransfer.getData('text/plain'));
      if (!Number.isInteger(fromIndex) || fromIndex === i) return;
      const [moved] = imageFiles.splice(fromIndex, 1);
      imageFiles.splice(i, 0, moved);
      draggedImageIndex = null;
      renderImageList();
    });
    li.addEventListener('dragend', () => {
      draggedImageIndex = null;
      li.classList.remove('dragging', 'drag-over');
    });
    li.querySelector('.remove-btn').addEventListener('click', () => {
      imageFiles.splice(i, 1);
      renderImageList();
      updateImageBtn();
    });

    imageListEl.appendChild(li);
  });
  updateImageBtn();
}

function isImageFile(name) {
  return IMG_EXT.some(ext => name.toLowerCase().endsWith(ext));
}

function addImageInputs(fileList) {
  const dir = imageDirection();
  if (dir === 'img2pdf') {
    for (const f of fileList) {
      if (isImageFile(f.name)) imageFiles.push(f);
    }
    renderImageList();
  } else {
    const pdf = Array.from(fileList).find(f => f.name.toLowerCase().endsWith('.pdf'));
    if (!pdf) {
      showError('Para PDF → Imagens, envie um arquivo .pdf.');
      return;
    }
    imagePdf = pdf;
    imageDzText.textContent = `${pdf.name} (${formatBytes(pdf.size)})`;
    updateImageBtn();
  }
}

document.querySelectorAll('input[name="imageDir"]').forEach(r => r.addEventListener('change', updateImageUI));
imageBrowseBtn.addEventListener('click', (e) => { e.stopPropagation(); imageInput.click(); });
imageDropzone.addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', (e) => { if (e.target.files.length) addImageInputs(e.target.files); imageInput.value = ''; });

['dragenter', 'dragover'].forEach(ev => imageDropzone.addEventListener(ev, (e) => { e.preventDefault(); imageDropzone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(ev => imageDropzone.addEventListener(ev, (e) => { e.preventDefault(); imageDropzone.classList.remove('dragover'); }));
imageDropzone.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) addImageInputs(e.dataTransfer.files); });

imageBtn.addEventListener('click', async () => {
  const dir = imageDirection();
  const formData = new FormData();
  formData.append('direction', dir);

  if (dir === 'img2pdf') {
    if (imageFiles.length < 1) return;
    imageFiles.forEach(f => formData.append('files', f));
  } else {
    if (!imagePdf) return;
    formData.append('files', imagePdf);
    formData.append('format', imageFormat.value);
  }

  startLoading('image');
  resultEl.classList.add('hidden');
  imageBtn.disabled = true;

  try {
    const data = await postForm('/api/image', formData);

    let outName, info, label;
    if (dir === 'img2pdf') {
      outName = 'imagens.pdf';
      info = `Imagens juntadas: <strong>${data.count}</strong><br>Tamanho final: <strong>${formatBytes(data.size)}</strong>`;
      label = 'BAIXAR PDF';
    } else {
      const base = imagePdf.name.replace(/\.pdf$/i, '');
      outName = data.ext === 'zip' ? `${base}_${imageFormat.value}.zip` : `${base}.${data.ext}`;
      const what = data.ext === 'zip' ? `${data.count} imagens (.zip)` : `1 imagem (.${data.ext})`;
      info = `Geradas: <strong>${what}</strong><br>Tamanho final: <strong>${formatBytes(data.size)}</strong>`;
      label = data.ext === 'zip' ? 'BAIXAR ZIP' : 'BAIXAR IMAGEM';
    }

    await showResult({ info: info, label, id: data.id, outName });
  } catch (err) {
    stopLoading(false);
    showError(err.message);
  } finally {
    loadingEl.classList.add('hidden');
    updateImageBtn();
  }
});

updateImageUI();

// --- Ferramentas de um PDF só (Texto, Excel) ---
function setupSinglePdfTool({ prefix, endpoint, loadingKind, buildForm, describe }) {
  const dropzoneEl = document.getElementById(`${prefix}Dropzone`);
  const inputEl = document.getElementById(`${prefix}Input`);
  const browseEl = document.getElementById(`${prefix}BrowseBtn`);
  const nameEl = document.getElementById(`${prefix}FileName`);
  const buttonEl = document.getElementById(`${prefix}Btn`);
  let file = null;

  const setToolFile = (f) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.pdf')) {
      showError('Arquivo precisa ser PDF.');
      return;
    }
    file = f;
    nameEl.textContent = `${f.name} (${formatBytes(f.size)})`;
    buttonEl.disabled = false;
  };

  const reset = () => {
    file = null;
    inputEl.value = '';
    nameEl.textContent = '';
    buttonEl.disabled = true;
  };

  browseEl.addEventListener('click', (e) => { e.stopPropagation(); inputEl.click(); });
  dropzoneEl.addEventListener('click', () => inputEl.click());
  inputEl.addEventListener('change', (e) => { if (e.target.files[0]) setToolFile(e.target.files[0]); });
  ['dragenter', 'dragover'].forEach(ev => dropzoneEl.addEventListener(ev, (e) => { e.preventDefault(); dropzoneEl.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev => dropzoneEl.addEventListener(ev, (e) => { e.preventDefault(); dropzoneEl.classList.remove('dragover'); }));
  dropzoneEl.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) setToolFile(f); });

  buttonEl.addEventListener('click', async () => {
    if (!file) return;
    const formData = new FormData();
    formData.append('pdf', file);
    buildForm(formData);

    startLoading(loadingKind);
    resultEl.classList.add('hidden');
    buttonEl.disabled = true;
    try {
      const data = await postForm(endpoint, formData);
      await showResult(describe(data, file));
    } catch (err) {
      stopLoading(false);
      showError(err.message);
    } finally {
      loadingEl.classList.add('hidden');
      buttonEl.disabled = !file;
    }
  });

  return { reset };
}

const checked = (id) => (document.getElementById(id).checked ? '1' : '0');
const baseName = (f) => f.name.replace(/\.pdf$/i, '');

const singlePdfTools = [
  setupSinglePdfTool({
    prefix: 'text',
    endpoint: '/api/text',
    loadingKind: 'text',
    buildForm: (fd) => {
      fd.append('removeHeaders', checked('textRemoveHeaders'));
      fd.append('keepLines', document.getElementById('textParagraphs').checked ? '0' : '1');
      fd.append('ocr', checked('textOcr'));
    },
    describe: (data, file) => {
      const s = data.stats || {};
      const ocr = s.ocr_pages ? `<br>Páginas lidas por OCR: <strong>${s.ocr_pages}</strong>` : '';
      const removed = s.removed_lines ? `<br>Linhas de cabeçalho/rodapé arrancadas: <strong>${s.removed_lines}</strong>` : '';
      return {
        info: `Páginas: <strong>${s.pages ?? '?'}</strong> · Caracteres: <strong>${(s.chars ?? 0).toLocaleString('pt-BR')}</strong>${removed}${ocr}`,
        label: 'BAIXAR TXT',
        id: data.id,
        outName: `${baseName(file)}.txt`,
        preview: data.preview
      };
    }
  }),
  setupSinglePdfTool({
    prefix: 'excel',
    endpoint: '/api/excel',
    loadingKind: 'excel',
    buildForm: (fd) => {
      fd.append('mergePages', checked('excelMerge'));
      fd.append('convertNumbers', checked('excelNumbers'));
      fd.append('singleSheet', checked('excelSingle'));
    },
    describe: (data, file) => {
      const s = data.stats || {};
      const what = s.fallback
        ? 'Nenhuma tabela de verdade encontrada: mandamos o texto do PDF dividido em colunas.'
        : `Tabelas encontradas: <strong>${s.tables}</strong> · Linhas: <strong>${s.rows}</strong>`;
      return {
        info: `${what}<br>Tamanho: <strong>${formatBytes(data.size)}</strong>`,
        label: 'BAIXAR EXCEL',
        id: data.id,
        outName: `${baseName(file)}.xlsx`
      };
    }
  })
];

// --- Arsenal: ferramentas avulsas (POST /api/tool/:tool) ---
// Cada campo: { key, type: text|textarea|number|password|select|check|checks, label, ... }
const TOOL_DEFS = {
  split: {
    title: 'Esquartejar PDF',
    desc: 'Corta o PDF em pedaços. Jack, o Estripador de páginas. Vários pedaços chegam num .zip.',
    button: 'ESQUARTEJAR',
    phrase: 'Picadinho de página',
    fields: [
      { key: 'mode', type: 'select', label: 'Como cortar', options: [
        ['each', 'Cada página vira um PDF'],
        ['every', 'A cada N páginas'],
        ['ranges', 'Por intervalos que eu escolho']
      ] },
      { key: 'every', type: 'number', label: 'Páginas por pedaço', value: 2, min: 1, showIf: { mode: 'every' } },
      { key: 'ranges', type: 'text', label: 'Intervalos (separe os PDFs com |)', placeholder: '1-3 | 4-10 | 11-fim', showIf: { mode: 'ranges' } }
    ],
    describe: (s) => `Pedaços gerados: <strong>${s.parts}</strong>`
  },
  organize: {
    title: 'Reorganizar / Excluir Páginas',
    desc: 'Diz quais páginas ficam e em que ordem. As que você não citar vão pro limbo sem direito a velório.',
    button: 'REORGANIZAR',
    phrase: 'Dança das cadeiras',
    fields: [
      { key: 'pages', type: 'text', label: 'Páginas, na ordem que você quer', placeholder: '3, 1, 2, 5-fim' }
    ],
    describe: (s) => `Páginas no resultado: <strong>${s.pages}</strong> · Mandadas pro limbo: <strong>${s.removed}</strong>`
  },
  rotate: {
    title: 'Girar Páginas',
    desc: 'Pro PDF que o estagiário escaneou de cabeça pra baixo. De novo.',
    button: 'GIRAR',
    phrase: 'Roda, roda, roda',
    fields: [
      { key: 'angle', type: 'select', label: 'Quanto girar', options: [
        ['90', '90° pra direita'], ['180', '180° (de ponta-cabeça)'], ['270', '90° pra esquerda']
      ] },
      { key: 'pages', type: 'text', label: 'Só essas páginas (vazio = todas)', placeholder: '1, 3-5' }
    ],
    describe: (s) => `Páginas giradas: <strong>${s.rotated}</strong>`
  },
  nup: {
    title: 'Várias Páginas por Folha',
    desc: 'Enfia várias páginas numa folha A4. A árvore agradece, o oftalmologista também.',
    button: 'ESPREMER NA FOLHA',
    phrase: 'Economia de papel raivosa',
    fields: [
      { key: 'perSheet', type: 'select', label: 'Páginas por folha', options: [['2', '2 (lado a lado)'], ['4', '4'], ['6', '6'], ['9', '9 (boa sorte lendo)']] }
    ],
    describe: (s) => `Folhas geradas: <strong>${s.sheets}</strong>`
  },
  blank: {
    title: 'Remover Páginas em Branco',
    desc: 'Caça aquelas páginas vazias que o scanner cospe de brinde e joga fora.',
    button: 'CAÇAR PÁGINA VAZIA',
    phrase: 'Vazio existencial, não',
    fields: [
      { key: 'sensitivity', type: 'number', label: 'Sensibilidade (1 = só branco total, 10 = aceita sujeirinha)', value: 5, min: 1, max: 10 }
    ],
    describe: (s) => `Páginas removidas: <strong>${s.removed}</strong> (${esc((s.removedPages || []).join(', '))})<br>Sobraram: <strong>${s.pages}</strong>`
  },
  protect: {
    title: 'Trancar a Sete Chaves',
    desc: 'Põe senha no PDF (AES-256). Se esquecer a senha, nem nós, nem Deus.',
    button: 'TRANCAR',
    phrase: 'Cadeado no ódio',
    fields: [
      { key: 'password', type: 'password', label: 'Senha para abrir' },
      { key: 'restrict', type: 'check', label: 'Bloquear impressão, cópia e edição também' }
    ],
    describe: (s) => `Trancado com AES-256${s.restricted ? ' e com restrições de impressão/cópia' : ''}.`
  },
  unlock: {
    title: 'Tirar Senha',
    desc: 'Remove a senha e as restrições do PDF. Precisa saber a senha, né? Aqui não é filme de hacker.',
    button: 'DESTRANCAR',
    phrase: 'Abre-te, sésamo',
    fields: [
      { key: 'password', type: 'password', label: 'Senha atual (vazio se só tiver restrição de impressão/cópia)' }
    ],
    describe: (s) => (s.wasEncrypted ? 'Senha arrancada com sucesso.' : 'Esse PDF nem tinha senha, mas tá aí limpinho.')
  },
  redact: {
    title: 'Tarja Preta',
    desc: 'Esconde CPF, CNPJ, e-mail, telefone ou o que você mandar. O texto some DE VERDADE, não é só um retângulo preto por cima (oi, órgão público).',
    button: 'TARJAR',
    phrase: 'Censura com carinho',
    fields: [
      { key: 'presets', type: 'checks', label: 'Tarjar automaticamente', options: [['cpf', 'CPF'], ['cnpj', 'CNPJ'], ['email', 'E-mail'], ['phone', 'Telefone']] },
      { key: 'terms', type: 'textarea', label: 'Palavras ou frases (uma por linha)', placeholder: 'Fulano de Tal\nSalário' }
    ],
    describe: (s) => `Tarjas aplicadas: <strong>${s.redactions}</strong><br><em>Metadados também foram apagados.</em>`
  },
  sanitize: {
    title: 'Exorcizar PDF',
    desc: 'Tira o encosto do arquivo: JavaScript, anexos escondidos, metadados fofoqueiros e links suspeitos.',
    button: 'EXORCIZAR',
    phrase: 'Sai, capiroto',
    fields: [
      { key: 'javascript', type: 'check', label: 'Remover JavaScript e ações automáticas', value: true },
      { key: 'attachments', type: 'check', label: 'Remover arquivos anexados', value: true },
      { key: 'metadata', type: 'check', label: 'Remover metadados (autor, programa, datas)', value: true },
      { key: 'links', type: 'check', label: 'Remover links externos' }
    ],
    describe: (s) => `JavaScript/ações: <strong>${s.javascript}</strong> · Anexos: <strong>${s.attachments}</strong> · Links: <strong>${s.links}</strong> · Metadados: <strong>${s.metadata}</strong>`
  },
  metadata: {
    title: 'Metadados',
    desc: 'Troca título, autor e afins. Ou apaga tudo, pra ninguém saber que foi você.',
    button: 'REESCREVER A HISTÓRIA',
    phrase: 'Álibi documental',
    fields: [
      { key: 'clear', type: 'check', label: 'Apagar todos os metadados (ignora os campos abaixo)' },
      { key: 'title', type: 'text', label: 'Título', showIf: { clear: false } },
      { key: 'author', type: 'text', label: 'Autor', showIf: { clear: false } },
      { key: 'subject', type: 'text', label: 'Assunto', showIf: { clear: false } },
      { key: 'keywords', type: 'text', label: 'Palavras-chave', showIf: { clear: false } }
    ],
    describe: (s) => {
      const m = s.metadata || {};
      const rows = ['title', 'author', 'subject', 'keywords'].filter((k) => m[k]).map((k) => `${k}: <strong>${esc(m[k])}</strong>`);
      return rows.length ? rows.join('<br>') : 'Metadados apagados. Você nunca esteve aqui.';
    }
  },
  watermark: {
    title: 'Marca d\'Água',
    desc: 'Carimba CONFIDENCIAL pra ninguém copiar. (Vão copiar.)',
    button: 'CARIMBAR',
    phrase: 'Marcando território',
    fields: [
      { key: 'text', type: 'text', label: 'Texto', value: 'CONFIDENCIAL' },
      { key: 'fontSize', type: 'number', label: 'Tamanho da letra', value: 60, min: 8, max: 200 },
      { key: 'opacity', type: 'number', label: 'Opacidade (%)', value: 25, min: 5, max: 100 },
      { key: 'angle', type: 'number', label: 'Inclinação (graus)', value: 45, min: -90, max: 90 },
      { key: 'color', type: 'color', label: 'Cor', value: '#8b0000' },
      { key: 'tile', type: 'check', label: 'Repetir em mosaico pela página toda' }
    ],
    describe: (s) => `Páginas carimbadas: <strong>${s.pages}</strong>`
  },
  pagenumbers: {
    title: 'Numerar Páginas',
    desc: 'Põe número nas páginas. Porque "a página lá do meio" não é referência.',
    button: 'NUMERAR',
    phrase: 'Um, dois, três, ódio',
    fields: [
      { key: 'format', type: 'text', label: 'Formato ({n} = número, {total} = total)', value: 'Página {n} de {total}' },
      { key: 'position', type: 'select', label: 'Posição', options: [
        ['bottom-center', 'Embaixo, no meio'], ['bottom-right', 'Embaixo, à direita'], ['bottom-left', 'Embaixo, à esquerda'],
        ['top-center', 'Em cima, no meio'], ['top-right', 'Em cima, à direita'], ['top-left', 'Em cima, à esquerda']
      ] },
      { key: 'start', type: 'number', label: 'Começar do número', value: 1 },
      { key: 'fontSize', type: 'number', label: 'Tamanho da letra', value: 10, min: 6, max: 40 },
      { key: 'skipFirst', type: 'check', label: 'Pular a capa (primeira página)' }
    ],
    describe: (s) => `Páginas numeradas: <strong>${s.pages}</strong>`
  },
  ocr: {
    title: 'PDF Pesquisável (OCR)',
    desc: 'Faz o PDF escaneado aceitar Ctrl+F e copiar texto. A aparência não muda nada: o robô escreve por baixo, invisível.',
    button: 'LER NA MARRA',
    phrase: 'O robô lê, você colhe',
    fields: [
      { key: 'force', type: 'check', label: 'Forçar OCR até nas páginas que já têm texto' }
    ],
    describe: (s) => `Páginas lidas pelo OCR: <strong>${s.ocrPages}</strong>${s.skipped ? ` · já tinham texto: <strong>${s.skipped}</strong>` : ''}`
  },
  flatten: {
    title: 'Achatar',
    desc: 'Formulários e anotações viram parte da página. Ninguém mais edita nada. Nem você.',
    button: 'PASSAR O ROLO',
    phrase: 'Rolo compressor',
    fields: [],
    describe: (s) => `Páginas achatadas: <strong>${s.pages}</strong>`
  },
  images: {
    title: 'Extrair Imagens',
    desc: 'Arranca as imagens originais de dentro do PDF, sem perda, num .zip.',
    button: 'ARRANCAR IMAGENS',
    phrase: 'Garimpo de pixel',
    fields: [
      { key: 'minSize', type: 'number', label: 'Ignorar imagens menores que (px)', value: 64, min: 1 }
    ],
    describe: (s) => `Imagens extraídas: <strong>${s.images}</strong>`
  }
};

// --- Navegação lateral ---
const ICONS = {
  compress: 'M4 6h16l-3 3H7zM4 18h16l-3-3H7zM8 11h8v2H8z',
  merge: 'M12 21C6 16 3 12 5 8c1.5-3 5-3 7 0 2-3 5.5-3 7 0 2 4-1 8-7 13z',
  word: 'M6 3h9l4 4v14H6zM9 11l1.5 6 1.5-4 1.5 4 1.5-6',
  image: 'M4 5h16v14H4zM8 10a1.5 1.5 0 1 0 0-.1M5 18l5-6 4 4 2-2 3 4',
  text: 'M6 3h9l4 4v14H6zM9 10h7M9 14h7M9 18h4',
  excel: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14M15 5v14',
  split: 'M6 3h7l4 4v5M6 3v18h6M14 15l6 6M20 15l-6 6',
  organize: 'M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4zM13 13h7v6h-7z',
  rotate: 'M20 12a8 8 0 1 1-3-6.2M20 4v5h-5',
  nup: 'M3 5h8v14H3zM13 5h8v14h-8z',
  blank: 'M6 3h9l4 4v14H6zM9 12l6 6M15 12l-6 6',
  protect: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  unlock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 7.5-2',
  redact: 'M6 3h9l4 4v14H6zM8 10h9v3H8zM8 15h6v3H8z',
  sanitize: 'M12 3l7 3v6c0 5-3 8-7 9-4-1-7-4-7-9V6zM9 12l2 2 4-4',
  metadata: 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5',
  watermark: 'M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z',
  pagenumbers: 'M6 3h9l4 4v14H6zM13 15h2M14 15v4M13 19h2',
  ocr: 'M3 7V4h3M21 7V4h-3M3 17v3h3M21 17v3h-3M8 9h8M8 12h8M8 15h5',
  flatten: 'M4 17h16M6 13h12M8 9h8M10 5h4',
  images: 'M4 5h16v14H4zM8 10a1.5 1.5 0 1 0 0-.1M5 18l5-6 4 4 2-2 3 4M17 2v5M14.5 4.5 17 7l2.5-2.5'
};

const NAV = [
  ['Esmagar', [['compress', 'Comprimir']]],
  ['Converter', [['word', 'Word ⇄ PDF'], ['image', 'Imagens ⇄ PDF'], ['text', 'PDF → Texto'], ['excel', 'PDF → Excel']]],
  ['Organizar', [['merge', 'Juntar'], ['tool:split', 'Esquartejar'], ['tool:organize', 'Reorganizar / Excluir'],
    ['tool:rotate', 'Girar'], ['tool:nup', 'Várias por folha'], ['tool:blank', 'Remover em branco']]],
  ['Segurança', [['tool:protect', 'Trancar com senha'], ['tool:unlock', 'Tirar senha'], ['tool:redact', 'Tarja Preta'],
    ['tool:sanitize', 'Exorcizar'], ['tool:metadata', 'Metadados']]],
  ['Editar', [['tool:watermark', 'Marca d\'água'], ['tool:pagenumbers', 'Numerar páginas'], ['tool:ocr', 'PDF pesquisável (OCR)'],
    ['tool:flatten', 'Achatar'], ['tool:images', 'Extrair imagens']]]
];

const PANES = ['compress', 'merge', 'word', 'image', 'text', 'excel', 'tools'];
const sideNav = document.getElementById('sideNav');
const sidebar = document.getElementById('sidebar');
const navToggle = document.getElementById('navToggle');
const navToggleLabel = document.getElementById('navToggleLabel');
const navBackdrop = document.getElementById('navBackdrop');
const navButtons = new Map();

function svgIcon(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'side-icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  return svg;
}

NAV.forEach(([group, items]) => {
  const title = document.createElement('p');
  title.className = 'side-group';
  title.textContent = group;
  sideNav.appendChild(title);
  items.forEach(([key, label]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'side-item';
    btn.appendChild(svgIcon(ICONS[key.replace('tool:', '')] || ICONS.text));
    const span = document.createElement('span');
    span.textContent = label;
    btn.appendChild(span);
    btn.addEventListener('click', () => activate(key));
    sideNav.appendChild(btn);
    navButtons.set(key, { btn, label });
  });
});

function setNavOpen(open) {
  sidebar.classList.toggle('open', open);
  navBackdrop.classList.toggle('hidden', !open);
  navToggle.setAttribute('aria-expanded', String(open));
}

navToggle.addEventListener('click', () => setNavOpen(!sidebar.classList.contains('open')));
navBackdrop.addEventListener('click', () => setNavOpen(false));

function activate(key, { updateHash = true } = {}) {
  if (!navButtons.has(key)) key = 'compress';
  const isTool = key.startsWith('tool:');
  const pane = isTool ? 'tools' : key;
  PANES.forEach((id) => document.getElementById(`tab-${id}`).classList.toggle('hidden', id !== pane));
  navButtons.forEach(({ btn }, k) => {
    btn.classList.toggle('active', k === key);
    if (k === key) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  if (isTool) selectTool(key.slice(5));
  navToggleLabel.textContent = navButtons.get(key).label;
  resultEl.classList.add('hidden');
  setNavOpen(false);
  if (updateHash) history.replaceState(null, '', `#${key.replace('tool:', '')}`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- Painel do Arsenal ---
const toolTitle = document.getElementById('toolTitle');
const toolDesc = document.getElementById('toolDesc');
const toolOptions = document.getElementById('toolOptions');
const toolBtn = document.getElementById('toolBtn');
const toolBtnLabel = document.getElementById('toolBtnLabel');
const toolPhrase = document.getElementById('toolPhrase');
const toolInput = document.getElementById('toolInput');
const toolFileName = document.getElementById('toolFileName');
const toolDropzone = document.getElementById('toolDropzone');
let currentTool = null;
let toolFile = null;
let toolControls = {};

function buildField(field) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  wrap.dataset.key = field.key;
  const id = `opt_${field.key}`;
  let control;

  if (field.type === 'check') {
    control = document.createElement('input');
    control.type = 'checkbox';
    control.id = id;
    control.checked = Boolean(field.value);
    const span = document.createElement('span');
    span.textContent = field.label;
    const label = document.createElement('label');
    label.className = 'check-row';
    label.dataset.key = field.key;
    label.append(control, span);
    toolControls[field.key] = { field, get: () => control.checked, el: label, input: control };
    return label;
  }

  const label = document.createElement('label');
  label.className = 'field-label';
  label.htmlFor = id;
  label.textContent = field.label;
  wrap.appendChild(label);

  if (field.type === 'checks') {
    const group = document.createElement('div');
    group.className = 'checks-inline';
    const boxes = field.options.map(([value, text]) => {
      const l = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = value;
      const t = document.createElement('span');
      t.textContent = text;
      l.append(cb, t);
      group.appendChild(l);
      return cb;
    });
    wrap.appendChild(group);
    toolControls[field.key] = { field, get: () => boxes.filter((b) => b.checked).map((b) => b.value), el: wrap };
    return wrap;
  }

  if (field.type === 'select') {
    control = document.createElement('select');
    control.className = 'paper-size-select';
    field.options.forEach(([value, text]) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      control.appendChild(o);
    });
  } else if (field.type === 'textarea') {
    control = document.createElement('textarea');
    control.className = 'text-input';
    control.rows = 4;
  } else {
    control = document.createElement('input');
    control.type = field.type;
    control.className = field.type === 'color' ? 'color-input' : 'text-input';
    if (field.type === 'number') {
      control.inputMode = 'decimal';
      if (field.min !== undefined) control.min = field.min;
      if (field.max !== undefined) control.max = field.max;
    }
    if (field.type === 'password') control.autocomplete = 'off';
  }
  control.id = id;
  if (field.placeholder) control.placeholder = field.placeholder;
  if (field.value !== undefined) control.value = field.value;
  wrap.appendChild(control);
  toolControls[field.key] = { field, get: () => control.value, el: wrap, input: control };
  return wrap;
}

function refreshVisibility() {
  Object.values(toolControls).forEach(({ field, el }) => {
    if (!field.showIf) return;
    const visible = Object.entries(field.showIf).every(([k, v]) => {
      const other = toolControls[k];
      return other && other.get() === v;
    });
    el.classList.toggle('hidden', !visible);
  });
}

function selectTool(name) {
  const def = TOOL_DEFS[name];
  currentTool = name;
  toolControls = {};
  toolTitle.textContent = def.title;
  toolDesc.textContent = def.desc;
  toolBtnLabel.textContent = def.button;
  toolPhrase.textContent = def.phrase;
  toolOptions.innerHTML = '';
  def.fields.forEach((f) => toolOptions.appendChild(buildField(f)));
  if (!def.fields.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Sem opções. É só mandar o PDF e apertar o botão, sem frescura.';
    toolOptions.appendChild(p);
  }
  Object.values(toolControls).forEach(({ input }) => input && input.addEventListener('change', refreshVisibility));
  refreshVisibility();
}

function collectOptions() {
  const opts = {};
  Object.entries(toolControls).forEach(([key, { field, el, get }]) => {
    if (el.classList.contains('hidden')) return;
    let value = get();
    if (field.type === 'number') value = value === '' ? undefined : Number(value);
    if (value !== undefined) opts[key] = value;
  });
  return opts;
}

function setToolFile(f) {
  if (!f) return;
  if (!f.name.toLowerCase().endsWith('.pdf')) {
    showError('Arquivo precisa ser PDF.');
    return;
  }
  toolFile = f;
  toolFileName.textContent = `${f.name} (${formatBytes(f.size)})`;
  toolBtn.disabled = false;
}

function resetTool() {
  toolFile = null;
  toolInput.value = '';
  toolFileName.textContent = '';
  toolBtn.disabled = true;
}

document.getElementById('toolBrowseBtn').addEventListener('click', (e) => { e.stopPropagation(); toolInput.click(); });
toolDropzone.addEventListener('click', () => toolInput.click());
toolInput.addEventListener('change', (e) => { if (e.target.files[0]) setToolFile(e.target.files[0]); });
['dragenter', 'dragover'].forEach(ev => toolDropzone.addEventListener(ev, (e) => { e.preventDefault(); toolDropzone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(ev => toolDropzone.addEventListener(ev, (e) => { e.preventDefault(); toolDropzone.classList.remove('dragover'); }));
toolDropzone.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) setToolFile(f); });
resetBtn.addEventListener('click', resetTool);

LOADING_MESSAGES.tools = [
  'Afiando a faca...',
  'Aplicando violência controlada no PDF...',
  'O PDF pediu arrego, mas continuamos...',
  'Fazendo o serviço sujo por você...',
  'Quase lá. O PDF já está chorando...'
];

toolBtn.addEventListener('click', async () => {
  if (!toolFile || !currentTool) return;
  const def = TOOL_DEFS[currentTool];
  const formData = new FormData();
  formData.append('pdf', toolFile);
  formData.append('options', JSON.stringify(collectOptions()));

  startLoading('tools');
  resultEl.classList.add('hidden');
  toolBtn.disabled = true;
  try {
    const data = await postForm(`/api/tool/${currentTool}`, formData);
    await showResult({
      info: `${def.describe(data.stats || {})}<br>Tamanho: <strong>${formatBytes(data.size)}</strong>`,
      label: data.ext === 'zip' ? 'BAIXAR ZIP' : 'BAIXAR PDF',
      id: data.id,
      outName: data.originalName
    });
  } catch (err) {
    stopLoading(false);
    showError(err.message);
  } finally {
    loadingEl.classList.add('hidden');
    toolBtn.disabled = !toolFile;
  }
});

// Abre a ferramenta do link (#tarja, #comprimir...) ou a compressão
(function initNav() {
  const hash = decodeURIComponent(location.hash.slice(1));
  const key = navButtons.has(hash) ? hash : (TOOL_DEFS[hash] ? `tool:${hash}` : 'compress');
  activate(key, { updateHash: Boolean(location.hash) });
})();
