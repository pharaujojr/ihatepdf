const express = require('express');
const multer = require('multer');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = 666;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Somente arquivos PDF são aceitos.'));
    }
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const GS_PROFILES = {
  marromeno: (input, output) => ([
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.4',
    '-dPDFSETTINGS=/screen',
    '-dAutoRotatePages=/None',
    '-dNOPAUSE',
    '-dQUIET',
    '-dBATCH',
    `-sOutputFile=${output}`,
    input
  ]),
  braba: (input, output) => ([
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.4',
    '-dAutoRotatePages=/None',
    '-dNOPAUSE',
    '-dQUIET',
    '-dBATCH',
    '-dPDFSETTINGS=/screen',
    '-dColorImageResolution=40',
    '-dGrayImageResolution=40',
    '-dDownsampleColorImages=true',
    '-dDownsampleGrayImages=true',
    '-dColorImageDownsampleType=/Average',
    '-dGrayImageDownsampleType=/Average',
    '-dAutoFilterColorImages=false',
    '-dColorImageFilter=/DCTEncode',
    '-dAutoFilterGrayImages=false',
    '-dGrayImageFilter=/DCTEncode',
    `-sOutputFile=${output}`,
    input
  ])
};

app.post('/api/compress', upload.single('pdf'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  const profile = req.body.profile;
  if (!GS_PROFILES[profile]) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Perfil de compressão inválido.' });
  }

  const inputPath = req.file.path;
  const outputId = crypto.randomBytes(16).toString('hex');
  const outputName = `comprimido_${outputId}.pdf`;
  const outputPath = path.join(OUTPUT_DIR, outputName);

  const args = GS_PROFILES[profile](inputPath, outputPath);

  execFile('gs', args, (err) => {
    fs.unlink(inputPath, () => {});

    if (err) {
      console.error('Erro no Ghostscript:', err);
      return res.status(500).json({ error: 'Falha ao comprimir o PDF.' });
    }

    fs.stat(outputPath, (statErr, stats) => {
      if (statErr) {
        return res.status(500).json({ error: 'Arquivo de saída não encontrado.' });
      }
      res.json({
        id: outputId,
        size: stats.size,
        originalName: req.file.originalname
      });
    });
  });
});

app.post('/api/merge', upload.array('pdfs', 50), (req, res) => {
  const files = req.files || [];
  if (files.length < 2) {
    files.forEach(f => fs.unlink(f.path, () => {}));
    return res.status(400).json({ error: 'Envie pelo menos 2 PDFs para juntar.' });
  }

  let order = files.map((_, i) => i);
  if (req.body.order) {
    try {
      const parsed = JSON.parse(req.body.order);
      if (Array.isArray(parsed) && parsed.length === files.length) {
        order = parsed.map(Number);
      }
    } catch (_) {}
  }

  const inputPaths = order.map(i => files[i].path);
  const outputId = crypto.randomBytes(16).toString('hex');
  const outputName = `comprimido_${outputId}.pdf`;
  const outputPath = path.join(OUTPUT_DIR, outputName);

  const args = [
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.4',
    '-dAutoRotatePages=/None',
    '-dNOPAUSE',
    '-dQUIET',
    '-dBATCH',
    `-sOutputFile=${outputPath}`,
    ...inputPaths
  ];

  execFile('gs', args, (err) => {
    files.forEach(f => fs.unlink(f.path, () => {}));

    if (err) {
      console.error('Erro no Ghostscript (merge):', err);
      return res.status(500).json({ error: 'Falha ao juntar os PDFs.' });
    }

    fs.stat(outputPath, (statErr, stats) => {
      if (statErr) {
        return res.status(500).json({ error: 'Arquivo de saída não encontrado.' });
      }
      res.json({
        id: outputId,
        size: stats.size,
        originalName: 'merged.pdf'
      });
    });
  });
});

app.get('/api/download/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[a-f0-9]{32}$/.test(id)) {
    return res.status(400).send('ID inválido.');
  }
  const filePath = path.join(OUTPUT_DIR, `comprimido_${id}.pdf`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Arquivo não encontrado.');
  }
  const downloadName = (req.query.name || 'comprimido.pdf').replace(/[^\w\-. ]/g, '_');
  res.download(filePath, downloadName, (err) => {
    if (!err) {
      setTimeout(() => fs.unlink(filePath, () => {}), 5000);
    }
  });
});

app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message || 'Erro inesperado.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`I HATE PDF rodando em http://0.0.0.0:${PORT}`);
});
