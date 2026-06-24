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
  'Muda de lado sem dó',
  'Vira a casaca do arquivo',
  'De cá pra lá, de lá pra cá',
  'Troca de figurino',
  'Converte essa lelê'
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
  ]
};

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

// --- Tabs ---
const TAB_IDS = ['compress', 'merge', 'word', 'image'];
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    TAB_IDS.forEach(id => {
      document.getElementById(`tab-${id}`).classList.toggle('hidden', id !== tab);
    });
    resultEl.classList.add('hidden');
  });
});

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

  const formData = new FormData();
  formData.append('pdf', selectedFile);
  formData.append('profile', profile);
  formData.append('paperSize', compressPaperSize?.value || 'a4');

  startLoading('compress');
  resultEl.classList.add('hidden');
  compressBtn.disabled = true;

  try {
    const res = await fetch('/api/compress', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao comprimir.');

    const reduction = ((1 - data.size / originalSize) * 100).toFixed(1);
    const outName = data.originalName.replace(/\.pdf$/i, '') + '_comprimido.pdf';

    resultInfo.innerHTML = `
      Original: <strong>${formatBytes(originalSize)}</strong><br>
      Comprimido: <strong>${formatBytes(data.size)}</strong><br>
      Redução: <strong style="color:#ff2a4d">${reduction}%</strong>
    `;
    downloadBtn.textContent = 'BAIXAR PDF COMPRIMIDO';
    downloadBtn.href = `/api/download/${data.id}?name=${encodeURIComponent(outName)}`;
    downloadBtn.setAttribute('download', outName);
    stopLoading(true);
    await wait(350);
    resultEl.classList.remove('hidden');
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
  if (compressPaperSize) compressPaperSize.value = 'a4';
  if (mergePaperSize) mergePaperSize.value = 'a4';
  mergeFiles = [];
  mergeInput.value = '';
  renderMergeList();
  resetWord();
  resetImage();
  resultEl.classList.add('hidden');
});

// --- Merge ---
function renderMergeList() {
  mergeList.innerHTML = '';
  mergeFiles.forEach((file, i) => {
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.index = i;
    li.innerHTML = `
      <span class="drag-handle" aria-hidden="true"></span>
      <span class="idx">${i + 1}.</span>
      <span class="name">${file.name}</span>
      <span class="size">${formatBytes(file.size)}</span>
      <button type="button" class="remove-btn" data-action="remove">✕</button>
    `;

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
    const res = await fetch('/api/merge', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao juntar.');

    const outName = 'juntado.pdf';
    resultInfo.innerHTML = `
      Arquivos juntados: <strong>${mergeFiles.length}</strong><br>
      Tamanho final: <strong>${formatBytes(data.size)}</strong>
    `;
    downloadBtn.textContent = 'BAIXAR PDF JUNTADO';
    downloadBtn.href = `/api/download/${data.id}?name=${encodeURIComponent(outName)}`;
    downloadBtn.setAttribute('download', outName);
    stopLoading(true);
    await wait(350);
    resultEl.classList.remove('hidden');
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
    const res = await fetch('/api/word', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro na conversão.');

    const base = wordFile.name.replace(/\.[^.]+$/, '');
    const outName = `${base}.${data.ext}`;
    const label = dir === 'pdf2word' ? 'BAIXAR WORD' : 'BAIXAR PDF';
    resultInfo.innerHTML = `
      Convertido para <strong>.${data.ext}</strong><br>
      Tamanho final: <strong>${formatBytes(data.size)}</strong>
    `;
    downloadBtn.textContent = label;
    downloadBtn.href = `/api/download/${data.id}?name=${encodeURIComponent(outName)}`;
    downloadBtn.setAttribute('download', outName);
    stopLoading(true);
    await wait(350);
    resultEl.classList.remove('hidden');
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
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.index = i;
    li.innerHTML = `
      <span class="drag-handle" aria-hidden="true"></span>
      <span class="idx">${i + 1}.</span>
      <span class="name">${file.name}</span>
      <span class="size">${formatBytes(file.size)}</span>
      <button type="button" class="remove-btn" data-action="remove">✕</button>
    `;

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
    const res = await fetch('/api/image', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro na conversão.');

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

    resultInfo.innerHTML = info;
    downloadBtn.textContent = label;
    downloadBtn.href = `/api/download/${data.id}?name=${encodeURIComponent(outName)}`;
    downloadBtn.setAttribute('download', outName);
    stopLoading(true);
    await wait(350);
    resultEl.classList.remove('hidden');
  } catch (err) {
    stopLoading(false);
    showError(err.message);
  } finally {
    loadingEl.classList.add('hidden');
    updateImageBtn();
  }
});

updateImageUI();
