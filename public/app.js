const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const browseBtn = document.getElementById('browseBtn');
const fileNameEl = document.getElementById('fileName');
const compressBtn = document.getElementById('compressBtn');
const loadingEl = document.getElementById('loading');
const resultEl = document.getElementById('result');
const resultInfo = document.getElementById('resultInfo');
const downloadBtn = document.getElementById('downloadBtn');
const resetBtn = document.getElementById('resetBtn');
const errorBox = document.getElementById('errorBox');

let selectedFile = null;

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
  resultEl.classList.add('hidden');
});
