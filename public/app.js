const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const browseBtn = document.getElementById('browseBtn');
const fileNameEl = document.getElementById('fileName');
const compressBtn = document.getElementById('compressBtn');
const compressPaperSize = document.getElementById('compressPaperSize');
const loadingEl = document.getElementById('loading');
const loadingText = document.getElementById('loadingText');
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

const COMPRESS_PHRASES = [
  'Espreme até o talo',
  'Sem dó, sem piedade',
  'Esmaga essa praga',
  'Mata o peso desse arquivo',
  'Destrói os megabytes'
];

const MERGE_PHRASES = [
  'Une os fragmentos num só',
  'Funde tudo na escuridão',
  'Forja um PDF único',
  'Junta os pedaços perdidos',
  'Combina na treva'
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

// --- Tabs ---
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('tab-compress').classList.toggle('hidden', tab !== 'compress');
    document.getElementById('tab-merge').classList.toggle('hidden', tab !== 'merge');
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

  loadingText.textContent = 'Destruindo seu PDF...';
  loadingEl.classList.remove('hidden');
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
    resultEl.classList.remove('hidden');
  } catch (err) {
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
  resultEl.classList.add('hidden');
});

// --- Merge ---
function renderMergeList() {
  mergeList.innerHTML = '';
  mergeFiles.forEach((file, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="idx">${i + 1}.</span>
      <span class="name">${file.name}</span>
      <span class="size">${formatBytes(file.size)}</span>
      <button type="button" data-action="up" ${i === 0 ? 'disabled' : ''}>▲</button>
      <button type="button" data-action="down" ${i === mergeFiles.length - 1 ? 'disabled' : ''}>▼</button>
      <button type="button" class="remove-btn" data-action="remove">✕</button>
    `;
    li.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'up' && i > 0) {
          [mergeFiles[i - 1], mergeFiles[i]] = [mergeFiles[i], mergeFiles[i - 1]];
        } else if (action === 'down' && i < mergeFiles.length - 1) {
          [mergeFiles[i + 1], mergeFiles[i]] = [mergeFiles[i], mergeFiles[i + 1]];
        } else if (action === 'remove') {
          mergeFiles.splice(i, 1);
        }
        renderMergeList();
      });
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

  loadingText.textContent = 'Juntando seus PDFs...';
  loadingEl.classList.remove('hidden');
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
    resultEl.classList.remove('hidden');
  } catch (err) {
    showError(err.message);
  } finally {
    loadingEl.classList.add('hidden');
    mergeBtn.disabled = mergeFiles.length < 2;
  }
});
