const express = require('express');
const multer = require('multer');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT) || 666;
const FILE_RETENTION_MS = 5 * 60 * 1000;
const DEFAULT_PAPER_SIZE = 'a4';
const ALLOWED_PAPER_SIZES = new Set([
  'a3',
  'a4',
  'a5',
  'letter',
  'legal',
  'tabloid',
  'executive',
  'b5'
]);

const OUTPUT_PREFIX = 'comprimido_';

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');
const WORK_DIR = path.join(__dirname, 'work');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(WORK_DIR, { recursive: true });

const PDF_EXT = ['.pdf'];
const WORD_EXT = ['.doc', '.docx', '.odt', '.rtf', '.txt'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.tiff', '.tif', '.bmp', '.gif', '.heic'];
const IMAGE_OUT_FORMATS = new Set(['png', 'jpg', 'webp', 'tiff', 'bmp']);

function makeUploader(allowedExt) {
  const allowed = new Set(allowedExt);
  return multer({
    dest: UPLOAD_DIR,
    limits: { fileSize: 200 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (allowed.has(ext)) {
        cb(null, true);
      } else {
        cb(new Error(`Tipo de arquivo não aceito: ${ext || 'desconhecido'}.`));
      }
    }
  });
}

const uploadPdf = makeUploader(PDF_EXT);
const uploadWord = makeUploader([...PDF_EXT, ...WORD_EXT]);
const uploadImage = makeUploader([...PDF_EXT, ...IMAGE_EXT]);

app.use(express.static(path.join(__dirname, 'public')));

function normalizePaperSize(rawValue) {
  if (!rawValue) return DEFAULT_PAPER_SIZE;
  const value = String(rawValue).trim().toLowerCase();
  if (!ALLOWED_PAPER_SIZES.has(value)) return null;
  return value;
}

function buildPaperArgs(paperSize) {
  return [
    `-sPAPERSIZE=${paperSize}`,
    '-dFIXEDMEDIA',
    '-dPDFFitPage'
  ];
}

function newOutputId() {
  return crypto.randomBytes(16).toString('hex');
}

function outputPathFor(id, ext) {
  return path.join(OUTPUT_DIR, `${OUTPUT_PREFIX}${id}.${ext}`);
}

function scheduleOutputCleanup(filePath) {
  setTimeout(() => {
    fs.unlink(filePath, () => {});
  }, FILE_RETENTION_MS).unref();
}

function cleanupExpiredOutputs() {
  fs.readdir(OUTPUT_DIR, (dirErr, files) => {
    if (dirErr) return;

    const now = Date.now();
    files
      .filter((name) => name.startsWith(OUTPUT_PREFIX))
      .forEach((name) => {
        const fullPath = path.join(OUTPUT_DIR, name);
        fs.stat(fullPath, (statErr, stats) => {
          if (statErr) return;
          if (now - stats.mtimeMs > FILE_RETENTION_MS) {
            fs.unlink(fullPath, () => {});
          }
        });
      });
  });
}

cleanupExpiredOutputs();
setInterval(cleanupExpiredOutputs, 60 * 1000).unref();

// Remove arquivos enviados (caminhos temporários do multer)
function cleanupUploads(files) {
  files.forEach((f) => f && f.path && fs.unlink(f.path, () => {}));
}

// Remove um diretório de trabalho recursivamente
function removeWorkDir(dir) {
  fs.rm(dir, { recursive: true, force: true }, () => {});
}

const GS_PROFILES = {
  cadinho: (input, output, paperSize) => ([
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.4',
    '-dPDFSETTINGS=/ebook',
    '-dAutoRotatePages=/None',
    ...buildPaperArgs(paperSize),
    '-dNOPAUSE',
    '-dQUIET',
    '-dBATCH',
    `-sOutputFile=${output}`,
    input
  ]),
  marromeno: (input, output, paperSize) => ([
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.4',
    '-dPDFSETTINGS=/screen',
    '-dAutoRotatePages=/None',
    ...buildPaperArgs(paperSize),
    '-dNOPAUSE',
    '-dQUIET',
    '-dBATCH',
    `-sOutputFile=${output}`,
    input
  ]),
  braba: (input, output, paperSize) => ([
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.4',
    '-dAutoRotatePages=/None',
    ...buildPaperArgs(paperSize),
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

app.post('/api/compress', uploadPdf.single('pdf'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  const profile = req.body.profile;
  if (!GS_PROFILES[profile]) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Perfil de compressão inválido.' });
  }
  const paperSize = normalizePaperSize(req.body.paperSize);
  if (!paperSize) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Tamanho de papel inválido.' });
  }

  const inputPath = req.file.path;
  const outputId = newOutputId();
  const outputPath = outputPathFor(outputId, 'pdf');

  const args = GS_PROFILES[profile](inputPath, outputPath, paperSize);

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
      scheduleOutputCleanup(outputPath);
      res.json({
        id: outputId,
        ext: 'pdf',
        size: stats.size,
        originalName: req.file.originalname,
        paperSize
      });
    });
  });
});

app.post('/api/merge', uploadPdf.array('pdfs', 50), (req, res) => {
  const files = req.files || [];
  if (files.length < 2) {
    cleanupUploads(files);
    return res.status(400).json({ error: 'Envie pelo menos 2 PDFs para juntar.' });
  }

  const paperSize = normalizePaperSize(req.body.paperSize);
  if (!paperSize) {
    cleanupUploads(files);
    return res.status(400).json({ error: 'Tamanho de papel inválido.' });
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
  const outputId = newOutputId();
  const outputPath = outputPathFor(outputId, 'pdf');

  const args = [
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.4',
    '-dAutoRotatePages=/None',
    ...buildPaperArgs(paperSize),
    '-dNOPAUSE',
    '-dQUIET',
    '-dBATCH',
    `-sOutputFile=${outputPath}`,
    ...inputPaths
  ];

  execFile('gs', args, (err) => {
    cleanupUploads(files);

    if (err) {
      console.error('Erro no Ghostscript (merge):', err);
      return res.status(500).json({ error: 'Falha ao juntar os PDFs.' });
    }

    fs.stat(outputPath, (statErr, stats) => {
      if (statErr) {
        return res.status(500).json({ error: 'Arquivo de saída não encontrado.' });
      }
      scheduleOutputCleanup(outputPath);
      res.json({
        id: outputId,
        ext: 'pdf',
        size: stats.size,
        originalName: 'merged.pdf',
        paperSize
      });
    });
  });
});

// --- Conversão Word <-> PDF (LibreOffice headless) ---
app.post('/api/word', uploadWord.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  const direction = req.body.direction;
  const inExt = path.extname(req.file.originalname).toLowerCase();

  let targetFormat;
  let targetExt;
  let inFilter = null;
  if (direction === 'word2pdf') {
    if (!WORD_EXT.includes(inExt)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Para Word → PDF, envie um documento (.docx, .doc, .odt, .rtf, .txt).' });
    }
    targetFormat = 'pdf';
    targetExt = 'pdf';
  } else if (direction === 'pdf2word') {
    if (inExt !== '.pdf') {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Para PDF → Word, envie um arquivo .pdf.' });
    }
    // writer_pdf_import força o PDF a abrir como documento Writer (e não Draw),
    // permitindo salvar como .docx
    targetFormat = 'docx:Office Open XML Text';
    targetExt = 'docx';
    inFilter = 'writer_pdf_import';
  } else {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Direção de conversão inválida.' });
  }

  const jobId = newOutputId();
  const jobDir = path.join(WORK_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  // LibreOffice detecta o formato pela extensão: copia com a extensão correta
  const inputPath = path.join(jobDir, `entrada${inExt}`);
  fs.copyFileSync(req.file.path, inputPath);
  fs.unlink(req.file.path, () => {});

  const profileDir = path.join(jobDir, 'lo-profile');
  const args = [
    '--headless',
    '--norestore',
    `-env:UserInstallation=file://${profileDir}`
  ];
  if (inFilter) {
    args.push(`--infilter=${inFilter}`);
  }
  args.push('--convert-to', targetFormat, '--outdir', jobDir, inputPath);

  execFile('soffice', args, { timeout: 120000 }, (err) => {
    if (err) {
      console.error('Erro no LibreOffice:', err);
      removeWorkDir(jobDir);
      return res.status(500).json({ error: 'Falha na conversão. O arquivo pode estar corrompido ou protegido.' });
    }

    const producedPath = path.join(jobDir, `entrada.${targetExt}`);
    fs.stat(producedPath, (statErr, stats) => {
      if (statErr) {
        removeWorkDir(jobDir);
        return res.status(500).json({ error: 'Arquivo convertido não encontrado.' });
      }

      const outputId = newOutputId();
      const outputPath = outputPathFor(outputId, targetExt);
      fs.copyFile(producedPath, outputPath, (copyErr) => {
        removeWorkDir(jobDir);
        if (copyErr) {
          return res.status(500).json({ error: 'Falha ao salvar o arquivo convertido.' });
        }
        scheduleOutputCleanup(outputPath);
        res.json({
          id: outputId,
          ext: targetExt,
          size: stats.size,
          originalName: req.file.originalname
        });
      });
    });
  });
});

// --- Conversão de imagens (PDF <-> imagem) ---
app.post('/api/image', uploadImage.array('files', 50), (req, res) => {
  const files = req.files || [];
  if (!files.length) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  const direction = req.body.direction;

  if (direction === 'img2pdf') {
    return handleImg2Pdf(req, res, files);
  }
  if (direction === 'pdf2img') {
    return handlePdf2Img(req, res, files);
  }

  cleanupUploads(files);
  return res.status(400).json({ error: 'Direção de conversão inválida.' });
});

function handleImg2Pdf(req, res, files) {
  const images = files.filter((f) => IMAGE_EXT.includes(path.extname(f.originalname).toLowerCase()));
  if (!images.length) {
    cleanupUploads(files);
    return res.status(400).json({ error: 'Para Imagens → PDF, envie ao menos uma imagem.' });
  }

  let order = images.map((_, i) => i);
  if (req.body.order) {
    try {
      const parsed = JSON.parse(req.body.order);
      if (Array.isArray(parsed) && parsed.length === images.length) {
        order = parsed.map(Number);
      }
    } catch (_) {}
  }
  const orderedPaths = order.map((i) => images[i].path);

  const outputId = newOutputId();
  const outputPath = outputPathFor(outputId, 'pdf');

  // -auto-orient respeita EXIF; sem downsample para manter qualidade
  const args = ['-auto-orient', ...orderedPaths, outputPath];

  execFile('convert', args, { timeout: 120000 }, (err) => {
    cleanupUploads(files);
    if (err) {
      console.error('Erro no ImageMagick (img2pdf):', err);
      return res.status(500).json({ error: 'Falha ao converter as imagens em PDF.' });
    }
    fs.stat(outputPath, (statErr, stats) => {
      if (statErr) {
        return res.status(500).json({ error: 'Arquivo de saída não encontrado.' });
      }
      scheduleOutputCleanup(outputPath);
      res.json({
        id: outputId,
        ext: 'pdf',
        size: stats.size,
        originalName: 'imagens.pdf',
        count: images.length
      });
    });
  });
}

function handlePdf2Img(req, res, files) {
  const pdf = files.find((f) => path.extname(f.originalname).toLowerCase() === '.pdf');
  if (!pdf) {
    cleanupUploads(files);
    return res.status(400).json({ error: 'Para PDF → Imagens, envie um arquivo .pdf.' });
  }

  const format = String(req.body.format || 'png').trim().toLowerCase();
  if (!IMAGE_OUT_FORMATS.has(format)) {
    cleanupUploads(files);
    return res.status(400).json({ error: 'Formato de imagem inválido.' });
  }

  const jobId = newOutputId();
  const jobDir = path.join(WORK_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const pdfPath = path.join(jobDir, 'entrada.pdf');
  fs.copyFileSync(pdf.path, pdfPath);
  cleanupUploads(files);

  // pdftoppm renderiza páginas em PNG (sem problemas de policy), 150 dpi
  const pageBase = path.join(jobDir, 'pagina');
  execFile('pdftoppm', ['-png', '-r', '150', pdfPath, pageBase], { timeout: 120000 }, (ppmErr) => {
    if (ppmErr) {
      console.error('Erro no pdftoppm:', ppmErr);
      removeWorkDir(jobDir);
      return res.status(500).json({ error: 'Falha ao renderizar o PDF. Pode estar protegido ou corrompido.' });
    }

    const pngPages = fs.readdirSync(jobDir)
      .filter((n) => n.startsWith('pagina') && n.endsWith('.png'))
      .sort();

    if (!pngPages.length) {
      removeWorkDir(jobDir);
      return res.status(500).json({ error: 'Nenhuma página encontrada no PDF.' });
    }

    convertPages(jobDir, pngPages, format, (convErr, finalPages) => {
      if (convErr) {
        console.error('Erro ao converter formato:', convErr);
        removeWorkDir(jobDir);
        return res.status(500).json({ error: 'Falha ao converter o formato das imagens.' });
      }
      finalizePdf2Img(res, jobDir, finalPages, format, pdf.originalname);
    });
  });
}

// Converte cada PNG para o formato alvo (ou mantém se já for PNG)
function convertPages(jobDir, pngPages, format, done) {
  if (format === 'png') {
    return done(null, pngPages);
  }
  const finalPages = [];
  let i = 0;
  const next = () => {
    if (i >= pngPages.length) return done(null, finalPages);
    const src = path.join(jobDir, pngPages[i]);
    const outName = pngPages[i].replace(/\.png$/, `.${format}`);
    const dst = path.join(jobDir, outName);
    execFile('convert', [src, dst], { timeout: 120000 }, (err) => {
      if (err) return done(err);
      finalPages.push(outName);
      i += 1;
      next();
    });
  };
  next();
}

function finalizePdf2Img(res, jobDir, pages, format, originalName) {
  const baseName = path.basename(originalName, path.extname(originalName));

  if (pages.length === 1) {
    const outputId = newOutputId();
    const outputPath = outputPathFor(outputId, format);
    fs.copyFile(path.join(jobDir, pages[0]), outputPath, (err) => {
      removeWorkDir(jobDir);
      if (err) {
        return res.status(500).json({ error: 'Falha ao salvar a imagem.' });
      }
      fs.stat(outputPath, (statErr, stats) => {
        scheduleOutputCleanup(outputPath);
        res.json({
          id: outputId,
          ext: format,
          size: statErr ? 0 : stats.size,
          originalName: `${baseName}.${format}`,
          count: 1
        });
      });
    });
    return;
  }

  // Múltiplas páginas -> zip
  const outputId = newOutputId();
  const outputPath = outputPathFor(outputId, 'zip');
  execFile('zip', ['-j', '-q', outputPath, ...pages.map((p) => path.join(jobDir, p))], { timeout: 120000 }, (err) => {
    removeWorkDir(jobDir);
    if (err) {
      console.error('Erro ao zipar imagens:', err);
      return res.status(500).json({ error: 'Falha ao empacotar as imagens.' });
    }
    fs.stat(outputPath, (statErr, stats) => {
      if (statErr) {
        return res.status(500).json({ error: 'Arquivo de saída não encontrado.' });
      }
      scheduleOutputCleanup(outputPath);
      res.json({
        id: outputId,
        ext: 'zip',
        size: stats.size,
        originalName: `${baseName}_${format}.zip`,
        count: pages.length
      });
    });
  });
}

app.get('/api/download/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[a-f0-9]{32}$/.test(id)) {
    return res.status(400).send('ID inválido.');
  }

  fs.readdir(OUTPUT_DIR, (err, files) => {
    if (err) {
      return res.status(500).send('Erro ao acessar o arquivo.');
    }
    const match = files.find((name) => name.startsWith(`${OUTPUT_PREFIX}${id}.`));
    if (!match) {
      return res.status(404).send('Arquivo não encontrado.');
    }
    const filePath = path.join(OUTPUT_DIR, match);
    const fallbackExt = path.extname(match) || '.pdf';
    const downloadName = (req.query.name || `comprimido${fallbackExt}`).replace(/[^\w\-. ]/g, '_');
    res.download(filePath, downloadName);
  });
});

app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message || 'Erro inesperado.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`I HATE PDF rodando em http://0.0.0.0:${PORT}`);
});
