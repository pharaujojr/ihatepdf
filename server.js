const express = require('express');
const multer = require('multer');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT) || 666;
const FILE_RETENTION_MS = 10 * 60 * 1000;
const STALE_WORK_MS = 30 * 60 * 1000;
// Processos pesados simultâneos (gs, LibreOffice, OCR...). O resto espera na fila.
const MAX_JOBS = Number(process.env.MAX_JOBS) || 2;
const MAX_QUEUE = Number(process.env.MAX_QUEUE) || 20;
const MAX_RASTER_PAGES = 300;

const ALLOWED_PAPER_SIZES = new Set([
  'original',
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
const EDITOR_DIR = path.join(__dirname, 'editor');
// PDFs enviados um a um antes do merge: o Cloudflare barra requisições acima
// de 100 MB, então juntar muitos arquivos numa requisição só não passa.
const STAGE_DIR = path.join(__dirname, 'uploads', 'staged');
const MAX_MERGE_FILES = 300;
const EDITOR_TTL_MS = 2 * 60 * 60 * 1000;
const TOOLS = path.join(__dirname, 'tools');
const LANG_SCRIPT = path.join(TOOLS, 'fix_docx_lang.py');
const MERGE_SCRIPT = path.join(TOOLS, 'merge_pdf.py');
const OPTIMIZE_SCRIPT = path.join(TOOLS, 'optimize_pdf.py');
const TEXT_SCRIPT = path.join(TOOLS, 'pdf_to_text.py');
const EXCEL_SCRIPT = path.join(TOOLS, 'pdf_to_excel.py');
const TOOLS_SCRIPT = path.join(TOOLS, 'pdf_tools.py');
const EDITOR_SCRIPT = path.join(TOOLS, 'pdf_editor.py');
const LO_HARDENING = path.join(TOOLS, 'lo-registrymodifications.xcu');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(WORK_DIR, { recursive: true });
fs.mkdirSync(EDITOR_DIR, { recursive: true });
fs.mkdirSync(STAGE_DIR, { recursive: true });

const PDF_EXT = ['.pdf'];
const WORD_EXT = ['.doc', '.docx', '.odt', '.rtf', '.txt'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.tiff', '.tif', '.bmp', '.gif', '.heic'];
const IMAGE_OUT_FORMATS = new Set(['png', 'jpg', 'webp', 'tiff', 'bmp']);
// Coder explícito para o ImageMagick: ele não "adivinha" o formato pelo
// conteúdo (evita que um .png com conteúdo SVG/MVG/MSL seja interpretado).
const IMAGE_CODER = {
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.webp': 'webp',
  '.tiff': 'tiff',
  '.tif': 'tiff',
  '.bmp': 'bmp',
  '.gif': 'gif',
  '.heic': 'heic'
};

// --- Erros e execução de processos -----------------------------------------

class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function run(cmd, args, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

// Fila simples: no máximo MAX_JOBS processos pesados ao mesmo tempo
let runningJobs = 0;
const jobQueue = [];

function withSlot(fn) {
  if (runningJobs >= MAX_JOBS && jobQueue.length >= MAX_QUEUE) {
    return Promise.reject(new UserError('Servidor lotado de ódio agora. Tente de novo em instantes.', 503));
  }
  return new Promise((resolve, reject) => {
    const start = () => {
      runningJobs += 1;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          runningJobs -= 1;
          const next = jobQueue.shift();
          if (next) next();
        });
    };
    if (runningJobs < MAX_JOBS) start();
    else jobQueue.push(start);
  });
}

// Última linha do stdout dos scripts Python é um JSON de estatísticas
function parseStats(stdout) {
  const last = String(stdout || '').trim().split('\n').pop();
  try {
    return JSON.parse(last);
  } catch (_) {
    return {};
  }
}

// Scripts Python: código 3 = PDF com senha, 4 = PDF sem texto
function scriptError(err, fallback) {
  if (err instanceof UserError) return err;
  console.error(`${fallback} ->`, err && err.message, err && err.stderr ? String(err.stderr).slice(-2000) : '');
  if (err && err.code === 3) return new UserError('PDF protegido por senha. Tire a senha antes e tente de novo.');
  if (err && err.code === 4) return new UserError('Não achei texto nenhum nesse PDF (é digitalizado?).');
  if (err && err.killed) return new UserError('Demorou demais e o processo foi abortado. Tente um arquivo menor.', 504);
  return new UserError(fallback, 500);
}

// --- Uploads, arquivos de trabalho e saídas --------------------------------

function makeUploader(allowedExt, maxFiles) {
  const allowed = new Set(allowedExt);
  return multer({
    dest: UPLOAD_DIR,
    limits: { fileSize: 200 * 1024 * 1024, files: maxFiles, fields: 20 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (allowed.has(ext)) {
        cb(null, true);
      } else {
        cb(new UserError(`Tipo de arquivo não aceito: ${ext || 'desconhecido'}.`));
      }
    }
  });
}

const uploadPdf = makeUploader(PDF_EXT, 1);
const uploadPdfs = makeUploader(PDF_EXT, 50);
const uploadWord = makeUploader([...PDF_EXT, ...WORD_EXT], 1);
const uploadImage = makeUploader([...PDF_EXT, ...IMAGE_EXT], 50);

function uploadedFiles(req) {
  return [req.file, ...(req.files || [])].filter(Boolean);
}

function cleanupUploads(files) {
  files.forEach((f) => f && f.path && fs.unlink(f.path, () => {}));
}

function removeWorkDir(dir) {
  if (dir) fs.rm(dir, { recursive: true, force: true }, () => {});
}

function newOutputId() {
  return crypto.randomBytes(16).toString('hex');
}

// Move o arquivo final para outputs/ e agenda a remoção
async function publish(filePath, ext) {
  const id = newOutputId();
  const outputPath = path.join(OUTPUT_DIR, `${OUTPUT_PREFIX}${id}.${ext}`);
  await fsp.rename(filePath, outputPath);
  const { size } = await fsp.stat(outputPath);
  setTimeout(() => fs.unlink(outputPath, () => {}), FILE_RETENTION_MS).unref();
  return { id, ext, size };
}

// Remove arquivos esquecidos (processo reiniciado no meio de um job, upload
// abortado etc.) — sem isso uploads/ e work/ crescem para sempre.
function sweepDir(dir, maxAgeMs, filter = () => true) {
  fs.readdir(dir, (dirErr, names) => {
    if (dirErr) return;
    const now = Date.now();
    names.filter(filter).forEach((name) => {
      const fullPath = path.join(dir, name);
      fs.stat(fullPath, (statErr, stats) => {
        if (!statErr && now - stats.mtimeMs > maxAgeMs) {
          fs.rm(fullPath, { recursive: true, force: true }, () => {});
        }
      });
    });
  });
}

function sweepAll() {
  sweepDir(OUTPUT_DIR, FILE_RETENTION_MS, (name) => name.startsWith(OUTPUT_PREFIX));
  sweepDir(UPLOAD_DIR, STALE_WORK_MS, (name) => name !== 'staged');
  sweepDir(STAGE_DIR, STALE_WORK_MS);
  sweepDir(WORK_DIR, STALE_WORK_MS);
  sweepDir(EDITOR_DIR, EDITOR_TTL_MS);
}

sweepAll();
setInterval(sweepAll, 60 * 1000).unref();

// Envolve um handler: cria pasta de trabalho, trata erros e sempre limpa tudo
function job(handler) {
  return async (req, res) => {
    const files = uploadedFiles(req);
    const jobDir = path.join(WORK_DIR, newOutputId());
    try {
      await fsp.mkdir(jobDir, { recursive: true });
      const result = await handler(req, { jobDir, files });
      res.json(result);
    } catch (err) {
      const status = err instanceof UserError ? err.status : 500;
      if (!(err instanceof UserError)) console.error(`Erro em ${req.path}:`, err.message, err.stderr ? String(err.stderr).slice(-2000) : '');
      res.status(status).json({ error: err instanceof UserError ? err.message : 'Erro inesperado.' });
    } finally {
      cleanupUploads(files);
      removeWorkDir(jobDir);
    }
  };
}

// Copia o upload para a pasta de trabalho com a extensão certa (os
// conversores detectam o formato pela extensão)
async function stage(file, jobDir, name) {
  const dest = path.join(jobDir, name);
  await fsp.copyFile(file.path, dest);
  return dest;
}

function flag(value) {
  return value === '1' || value === 'true' || value === 'on';
}

function normalizePaperSize(rawValue, fallback) {
  if (!rawValue) return fallback;
  const value = String(rawValue).trim().toLowerCase();
  if (!ALLOWED_PAPER_SIZES.has(value)) throw new UserError('Tamanho de papel inválido.');
  return value;
}

function parseOrder(raw, length) {
  const identity = Array.from({ length }, (_, i) => i);
  if (!raw) return identity;
  try {
    const parsed = JSON.parse(raw).map(Number);
    const valid = parsed.length === length &&
      new Set(parsed).size === length &&
      parsed.every((i) => Number.isInteger(i) && i >= 0 && i < length);
    return valid ? parsed : identity;
  } catch (_) {
    return identity;
  }
}

async function pageCount(pdfPath) {
  try {
    const { stdout } = await run('pdfinfo', [pdfPath], { timeout: 30000 });
    const m = stdout.match(/^Pages:\s+(\d+)/m);
    return m ? Number(m[1]) : 0;
  } catch (_) {
    return 0;
  }
}

// --- Segurança HTTP --------------------------------------------------------

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  });
  next();
});

// no-cache = o navegador sempre revalida (304 barato): depois de um deploy
// ninguém fica preso a um app.js/editor.js antigo
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.set('Cache-Control', 'no-cache')
}));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, running: runningJobs, queued: jobQueue.length });
});

// --- Compressão --------------------------------------------------------------
// Níveis de compressão via Ghostscript (pdfwrite). Diferente do -dPDFSETTINGS
// puro, aqui os JPEGs originais são SEMPRE recodificados (PassThrough=false) e
// o limiar de downsample é 1.0: PDFs escaneados a ~140-200 dpi, que antes
// passavam intactos pelo /ebook, agora encolhem de verdade.
const LEVELS = {
  cadinho: { dpi: 150, monoDpi: 300, q: 0.76 },
  marromeno: { dpi: 72, monoDpi: 200, q: 0.76 },
  braba: { dpi: 40, monoDpi: 150, q: 2.0 }
};
// Escada usada no modo "tamanho máximo": do mais leve ao mais bruto
const TARGET_LADDER = [
  { dpi: 150, monoDpi: 300, q: 0.76 },
  { dpi: 110, monoDpi: 250, q: 0.76 },
  { dpi: 72, monoDpi: 200, q: 0.76 },
  { dpi: 60, monoDpi: 200, q: 1.2 },
  { dpi: 45, monoDpi: 150, q: 1.5 },
  { dpi: 40, monoDpi: 150, q: 2.0 },
  { dpi: 40, monoDpi: 150, q: 2.0, gray: true },
  { xerox: true }
];

function gsCompressArgs(input, output, { dpi, monoDpi, q, gray }) {
  const dict = `<< /QFactor ${q} /Blend 1 /HSamples [2 1 1 2] /VSamples [2 1 1 2] >>`;
  return [
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.7',
    '-dSAFER',
    '-dNOPAUSE',
    '-dQUIET',
    '-dBATCH',
    '-dAutoRotatePages=/None',
    '-dDetectDuplicateImages=true',
    '-dCompressFonts=true',
    '-dSubsetFonts=true',
    '-dEmbedAllFonts=true',
    '-dDownsampleColorImages=true',
    '-dDownsampleGrayImages=true',
    '-dDownsampleMonoImages=true',
    `-dColorImageResolution=${dpi}`,
    `-dGrayImageResolution=${dpi}`,
    `-dMonoImageResolution=${monoDpi}`,
    '-dColorImageDownsampleThreshold=1.0',
    '-dGrayImageDownsampleThreshold=1.0',
    '-dMonoImageDownsampleThreshold=1.0',
    '-dColorImageDownsampleType=/Bicubic',
    '-dGrayImageDownsampleType=/Bicubic',
    '-dMonoImageDownsampleType=/Subsample',
    '-dAutoFilterColorImages=false',
    '-dAutoFilterGrayImages=false',
    '-dColorImageFilter=/DCTEncode',
    '-dGrayImageFilter=/DCTEncode',
    '-dPassThroughJPEGImages=false',
    '-dPassThroughJPXImages=false',
    // CMYK -> RGB (como o /ebook e o /screen fazem): 3 canais em vez de 4.
    // Em catálogo de gráfica isso sozinho corta ~40%.
    ...(gray
      ? ['-sColorConversionStrategy=Gray', '-dProcessColorModel=/DeviceGray']
      : ['-sColorConversionStrategy=RGB', '-dProcessColorModel=/DeviceRGB']),
    `-sOutputFile=${output}`,
    '-c', `<< /ColorImageDict ${dict} /GrayImageDict ${dict} >> setdistillerparams`,
    '-f', input
  ];
}

// Modo Xerox: cada página vira imagem 1-bit (preto e branco puro) em CCITT G4.
// Ideal para documento escaneado; o texto deixa de ser selecionável.
async function xeroxCompress(input, output, jobDir) {
  const pages = await pageCount(input);
  if (pages > MAX_RASTER_PAGES) {
    throw new UserError(`O modo Xerox aceita até ${MAX_RASTER_PAGES} páginas.`);
  }
  const rasterDir = path.join(jobDir, 'xerox');
  await fsp.mkdir(rasterDir, { recursive: true });
  await run('pdftoppm', ['-gray', '-r', '200', input, path.join(rasterDir, 'p')], { timeout: 300000 });
  const frames = (await fsp.readdir(rasterDir)).filter((n) => n.endsWith('.pgm')).sort();
  if (!frames.length) throw new UserError('Nenhuma página encontrada no PDF.');
  // Uma página por vez: todas juntas no ImageMagick estouram a memória
  const pagePdfs = [];
  for (const name of frames) {
    const pagePdf = path.join(rasterDir, name.replace(/\.pgm$/, '.pdf'));
    await run('convert', [`pgm:${path.join(rasterDir, name)}`, '-threshold', '55%', '-type', 'bilevel',
      '-compress', 'Group4', '-density', '200', '-units', 'PixelsPerInch', `pdf:${pagePdf}`], { timeout: 120000 });
    await fsp.unlink(path.join(rasterDir, name));
    pagePdfs.push(pagePdf);
  }
  if (pagePdfs.length === 1) {
    await fsp.rename(pagePdfs[0], output);
  } else {
    await run('python3', [MERGE_SCRIPT, output, 'original', ...pagePdfs], { timeout: 180000 });
  }
}

async function compressWith(level, input, output, jobDir) {
  const raw = `${output}.raw.pdf`;
  if (level.xerox) {
    await xeroxCompress(input, raw, jobDir);
  } else {
    await run('gs', gsCompressArgs(input, raw, level), { timeout: 300000 });
  }
  // Passo final sem perdas: object streams, Flate nível 9, sem metadados inúteis
  try {
    await run('python3', [OPTIMIZE_SCRIPT, raw, output], { timeout: 120000 });
    await fsp.unlink(raw);
  } catch (err) {
    console.error('Aviso: optimize_pdf falhou, usando saída do gs:', err.message);
    await fsp.rename(raw, output);
  }
  return (await fsp.stat(output)).size;
}

app.post('/api/compress', uploadPdf.single('pdf'), job(async (req, { jobDir }) => {
  if (!req.file) throw new UserError('Nenhum arquivo enviado.');
  const profile = String(req.body.profile || '');
  if (!LEVELS[profile] && profile !== 'xerox') throw new UserError('Perfil de compressão inválido.');
  const paperSize = normalizePaperSize(req.body.paperSize, 'original');
  const gray = flag(req.body.grayscale);
  const targetMB = req.body.targetMB ? Number(String(req.body.targetMB).replace(',', '.')) : 0;
  if (req.body.targetMB && !(targetMB > 0 && targetMB < 1000)) {
    throw new UserError('Tamanho máximo inválido.');
  }

  const input = await stage(req.file, jobDir, 'entrada.pdf');
  const inputSize = req.file.size;
  const output = path.join(jobDir, 'saida.pdf');

  return withSlot(async () => {
    let size;
    let targetMet = null;
    let usedLevel = profile;

    if (targetMB) {
      // Busca binária na escada (o tamanho cai conforme o nível sobe): acha
      // o nível mais leve que cabe no alvo com ~3 compressões em vez de 8.
      // O Xerox (último degrau) só entra se nenhum nível normal couber.
      const target = targetMB * 1024 * 1024;
      const ladder = TARGET_LADDER.map((l) => (gray && !l.xerox ? { ...l, gray: true } : l));
      const tried = new Map();
      const attempt = async (i) => {
        if (!tried.has(i)) {
          const candidate = path.join(jobDir, `tentativa_${i}.pdf`);
          try {
            tried.set(i, { path: candidate, size: await compressWith(ladder[i], input, candidate, jobDir), step: i });
          } catch (err) {
            // Um degrau que falha (ex.: Xerox com páginas demais) não derruba a busca
            console.error(`Aviso: nível ${i + 1} falhou:`, err.message);
            tried.set(i, null);
          }
        }
        return tried.get(i);
      };
      const lastNormal = ladder.length - 2;
      let lo = 0;
      let hi = lastNormal;
      let fit = null;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const r = await attempt(mid);
        if (r && r.size <= target) {
          fit = r;
          hi = mid - 1;
        } else {
          lo = mid + 1;
        }
      }
      // Xerox em PDF grande é lento e quase sempre é catálogo vetorial, onde
      // rasterizar nem ajuda — só tenta em documentos curtos
      if (!fit && (await pageCount(input)) <= 40) {
        const xerox = await attempt(ladder.length - 1);
        if (xerox && xerox.size <= target) fit = xerox;
      }
      const results = [...tried.values()].filter(Boolean);
      const best = fit || results.sort((a, b) => a.size - b.size)[0];
      if (!best) throw new UserError('Falha ao comprimir o PDF.', 500);
      await fsp.rename(best.path, output);
      size = best.size;
      targetMet = Boolean(fit);
      usedLevel = ladder[best.step].xerox ? 'modo Xerox' : `nível ${best.step + 1} de ${ladder.length}`;
    } else {
      const level = profile === 'xerox' ? { xerox: true } : { ...LEVELS[profile], gray };
      size = await compressWith(level, input, output, jobDir);
    }

    // Nunca devolve algo maior que o original (quando não há troca de papel
    // nem conversão de cor pedida, o original otimizado sem perdas é melhor)
    let alreadyOptimal = false;
    if (size >= inputSize && paperSize === 'original' && !gray && profile !== 'xerox') {
      const lossless = path.join(jobDir, 'sem_perdas.pdf');
      try {
        await run('python3', [OPTIMIZE_SCRIPT, input, lossless], { timeout: 120000 });
        const llSize = (await fsp.stat(lossless)).size;
        await fsp.rename(llSize < inputSize ? lossless : input, output);
      } catch (_) {
        await fsp.copyFile(input, output);
      }
      alreadyOptimal = true;
    }

    // Papel padronizado SEM perder a orientação: mesmo mecanismo do "Juntar".
    // Página paisagem vira A4 paisagem (antes o gs, com -dFIXEDMEDIA, forçava
    // tudo em retrato e espremia o conteúdo dentro da folha em pé).
    if (paperSize !== 'original') {
      const sized = path.join(jobDir, 'papel.pdf');
      await run('python3', [MERGE_SCRIPT, sized, paperSize, output], { timeout: 180000 });
      await fsp.rename(sized, output);
    }

    const out = await publish(output, 'pdf');
    return {
      ...out,
      originalName: req.file.originalname,
      originalSize: inputSize,
      paperSize,
      alreadyOptimal,
      targetMet,
      usedLevel
    };
  }).catch((err) => { throw scriptError(err, 'Falha ao comprimir o PDF. Ele pode estar protegido ou corrompido.'); });
}));

// --- Juntar ------------------------------------------------------------------

app.post('/api/stage', uploadPdf.single('pdf'), async (req, res) => {
  try {
    if (!req.file) throw new UserError('Nenhum arquivo enviado.');
    const id = newOutputId();
    await fsp.rename(req.file.path, path.join(STAGE_DIR, `${id}.pdf`));
    res.json({ id });
  } catch (err) {
    cleanupUploads(uploadedFiles(req));
    const status = err instanceof UserError ? err.status : 500;
    if (!(err instanceof UserError)) console.error('Erro em /api/stage:', err.message);
    res.status(status).json({ error: err instanceof UserError ? err.message : 'Erro inesperado.' });
  }
});

function stagedPaths(raw) {
  let ids;
  try {
    ids = JSON.parse(raw);
  } catch (_) {
    throw new UserError('Lista de arquivos inválida.');
  }
  if (!Array.isArray(ids) || ids.length > MAX_MERGE_FILES ||
      !ids.every((id) => /^[a-f0-9]{32}$/.test(String(id)))) {
    throw new UserError('Lista de arquivos inválida.');
  }
  return ids.map((id) => path.join(STAGE_DIR, `${id}.pdf`));
}

app.post('/api/merge', uploadPdfs.array('pdfs', 50), job(async (req, { jobDir }) => {
  const files = req.files || [];
  const staged = req.body.staged ? stagedPaths(req.body.staged) : [];
  const count = staged.length || files.length;
  try {
    if (count < 2) throw new UserError('Envie pelo menos 2 PDFs para juntar.');
    for (const p of staged) {
      if (!fs.existsSync(p)) throw new UserError('Os arquivos enviados expiraram. Envie de novo.', 404);
    }
    return await mergeFiles(staged.length ? staged : files.map((f) => f.path), req, jobDir);
  } finally {
    staged.forEach((p) => fs.unlink(p, () => {}));
  }
}));

async function mergeFiles(paths, req, jobDir) {
  const paperSize = normalizePaperSize(req.body.paperSize, 'a4');
  const order = parseOrder(req.body.order, paths.length);
  const inputPaths = order.map((i) => paths[i]);
  const output = path.join(jobDir, 'juntado.pdf');

  // merge_pdf.py embute cada página como Form XObject no PDF de saída:
  // os streams de fonte e encoding são copiados byte a byte, sem passar por
  // nenhum engine de renderização. O tamanho de papel é normalizado via CTM
  // (transformation matrix) na nova página, não por re-renderização.
  // "original" não está na tabela de tamanhos do script = mantém o tamanho.
  try {
    await withSlot(() => run('python3', [MERGE_SCRIPT, output, paperSize, ...inputPaths], { timeout: 600000 }));
  } catch (err) {
    throw scriptError(err, 'Falha ao juntar os PDFs. Algum deles pode estar protegido ou corrompido.');
  }
  const out = await publish(output, 'pdf');
  return { ...out, originalName: 'juntado.pdf', paperSize, count: paths.length };
}

// --- Word <-> PDF --------------------------------------------------------------

// Perfil do LibreOffice endurecido: macros desligadas e links externos
// (OLE/imagens vinculadas) nunca atualizados — evita que um .docx malicioso
// puxe arquivos locais ou URLs internas para dentro do PDF gerado.
async function hardenedLoProfile(jobDir) {
  const profileDir = path.join(jobDir, 'lo-profile');
  const userDir = path.join(profileDir, 'user');
  await fsp.mkdir(userDir, { recursive: true });
  await fsp.copyFile(LO_HARDENING, path.join(userDir, 'registrymodifications.xcu'));
  return profileDir;
}

app.post('/api/word', uploadWord.single('file'), job(async (req, { jobDir }) => {
  if (!req.file) throw new UserError('Nenhum arquivo enviado.');
  const direction = req.body.direction;
  const inExt = path.extname(req.file.originalname).toLowerCase();

  if (direction !== 'word2pdf' && direction !== 'pdf2word') {
    throw new UserError('Direção de conversão inválida.');
  }
  if (direction === 'word2pdf' && !WORD_EXT.includes(inExt)) {
    throw new UserError('Para Word → PDF, envie um documento (.docx, .doc, .odt, .rtf, .txt).');
  }
  if (direction === 'pdf2word' && inExt !== '.pdf') {
    throw new UserError('Para PDF → Word, envie um arquivo .pdf.');
  }

  const targetExt = direction === 'word2pdf' ? 'pdf' : 'docx';
  const inputPath = await stage(req.file, jobDir, `entrada${inExt}`);
  const producedPath = path.join(jobDir, `entrada.${targetExt}`);

  await withSlot(async () => {
    if (direction === 'pdf2word') {
      // pdf2docx reconstrói parágrafos e tabelas (evita o excesso de caixas de
      // texto soltas que o LibreOffice gera ao importar PDF)
      await run('pdf2docx', ['convert', inputPath, producedPath], { timeout: 300000 });
      // Ajusta o idioma do .docx para a língua de origem (best-effort)
      try {
        await run('python3', [LANG_SCRIPT, producedPath, inputPath], { timeout: 30000 });
      } catch (langErr) {
        console.error('Aviso ao ajustar idioma do .docx:', langErr.message);
      }
      return;
    }
    const profileDir = await hardenedLoProfile(jobDir);
    await run('soffice', [
      '--headless',
      '--norestore',
      '--nolockcheck',
      `-env:UserInstallation=file://${profileDir}`,
      '--convert-to', 'pdf',
      '--outdir', jobDir,
      inputPath
    ], { timeout: 180000 });
  }).catch((err) => {
    throw scriptError(err, direction === 'pdf2word'
      ? 'Falha na conversão. O PDF pode estar protegido, digitalizado (imagem) ou corrompido.'
      : 'Falha na conversão. O arquivo pode estar corrompido ou protegido.');
  });

  try {
    await fsp.access(producedPath);
  } catch (_) {
    throw new UserError('Arquivo convertido não encontrado.', 500);
  }
  const out = await publish(producedPath, targetExt);
  return { ...out, originalName: req.file.originalname };
}));

// --- Imagens <-> PDF -----------------------------------------------------------

app.post('/api/image', uploadImage.array('files', 50), job(async (req, ctx) => {
  const files = req.files || [];
  if (!files.length) throw new UserError('Nenhum arquivo enviado.');
  if (req.body.direction === 'img2pdf') return img2pdf(req, files, ctx);
  if (req.body.direction === 'pdf2img') return pdf2img(req, files, ctx);
  throw new UserError('Direção de conversão inválida.');
}));

async function img2pdf(req, files, { jobDir }) {
  const images = files.filter((f) => IMAGE_EXT.includes(path.extname(f.originalname).toLowerCase()));
  if (!images.length) throw new UserError('Para Imagens → PDF, envie ao menos uma imagem.');
  const order = parseOrder(req.body.order, images.length);
  const inputs = order.map((i) => {
    const f = images[i];
    return `${IMAGE_CODER[path.extname(f.originalname).toLowerCase()]}:${f.path}`;
  });
  const output = path.join(jobDir, 'imagens.pdf');

  // -auto-orient respeita EXIF; sem downsample para manter qualidade
  try {
    await withSlot(() => run('convert', ['-auto-orient', ...inputs, `pdf:${output}`], { timeout: 180000 }));
  } catch (err) {
    throw scriptError(err, 'Falha ao converter as imagens em PDF. Alguma imagem pode estar corrompida.');
  }
  const out = await publish(output, 'pdf');
  return { ...out, originalName: 'imagens.pdf', count: images.length };
}

async function pdf2img(req, files, { jobDir }) {
  const pdf = files.find((f) => path.extname(f.originalname).toLowerCase() === '.pdf');
  if (!pdf) throw new UserError('Para PDF → Imagens, envie um arquivo .pdf.');
  const format = String(req.body.format || 'png').trim().toLowerCase();
  if (!IMAGE_OUT_FORMATS.has(format)) throw new UserError('Formato de imagem inválido.');

  const pdfPath = await stage(pdf, jobDir, 'entrada.pdf');
  const pages = await pageCount(pdfPath);
  if (pages > MAX_RASTER_PAGES) {
    throw new UserError(`PDF → Imagens aceita até ${MAX_RASTER_PAGES} páginas.`);
  }
  const baseName = path.basename(pdf.originalname, path.extname(pdf.originalname));

  const produced = await withSlot(async () => {
    // pdftoppm gera PNG/JPEG/TIFF direto; webp/bmp passam pelo ImageMagick
    const pageBase = path.join(jobDir, 'pagina');
    const native = { png: ['-png', 'png'], jpg: ['-jpeg', 'jpg'], tiff: ['-tiff', 'tif'] }[format];
    const [ppmFlag, ppmExt] = native || ['-png', 'png'];
    await run('pdftoppm', [ppmFlag, '-r', '150', pdfPath, pageBase], { timeout: 300000 });
    let names = (await fsp.readdir(jobDir)).filter((n) => n.startsWith('pagina') && n.endsWith(`.${ppmExt}`)).sort();
    if (!names.length) throw new UserError('Nenhuma página encontrada no PDF.', 500);

    const finalNames = [];
    for (const name of names) {
      const target = name.replace(/\.[^.]+$/, `.${format}`);
      if (native) {
        if (target !== name) await fsp.rename(path.join(jobDir, name), path.join(jobDir, target));
      } else {
        await run('convert', [`png:${path.join(jobDir, name)}`, `${format}:${path.join(jobDir, target)}`], { timeout: 120000 });
      }
      finalNames.push(target);
    }
    names = finalNames;

    if (names.length === 1) return { file: path.join(jobDir, names[0]), ext: format, count: 1 };
    const zipPath = path.join(jobDir, 'imagens.zip');
    await run('zip', ['-j', '-q', zipPath, ...names.map((n) => path.join(jobDir, n))], { timeout: 180000 });
    return { file: zipPath, ext: 'zip', count: names.length };
  }).catch((err) => { throw scriptError(err, 'Falha ao renderizar o PDF. Pode estar protegido ou corrompido.'); });

  const out = await publish(produced.file, produced.ext);
  const originalName = produced.ext === 'zip' ? `${baseName}_${format}.zip` : `${baseName}.${format}`;
  return { ...out, originalName, count: produced.count };
}

// --- PDF -> Texto ----------------------------------------------------------------

app.post('/api/text', uploadPdf.single('pdf'), job(async (req, { jobDir }) => {
  if (!req.file) throw new UserError('Nenhum arquivo enviado.');
  const input = await stage(req.file, jobDir, 'entrada.pdf');
  const output = path.join(jobDir, 'saida.txt');
  const args = [TEXT_SCRIPT, input, output];
  if (!flag(req.body.removeHeaders ?? '1')) args.push('--keep-headers');
  if (flag(req.body.keepLines)) args.push('--keep-lines');
  if (!flag(req.body.ocr ?? '1')) args.push('--no-ocr');

  let stats;
  try {
    const { stdout } = await withSlot(() => run('python3', args, { timeout: 600000 }));
    stats = parseStats(stdout);
  } catch (err) {
    throw scriptError(err, 'Falha ao extrair o texto. O PDF pode estar corrompido.');
  }

  const fh = await fsp.open(output, 'r');
  const { bytesRead, buffer } = await fh.read(Buffer.alloc(1500), 0, 1500, 0);
  await fh.close();
  // Corta num limite de caractere UTF-8 válido
  const preview = buffer.subarray(0, bytesRead).toString('utf8').replace(/�+$/, '');

  const out = await publish(output, 'txt');
  return { ...out, originalName: req.file.originalname, stats, preview };
}));

// --- PDF -> Excel ----------------------------------------------------------------

app.post('/api/excel', uploadPdf.single('pdf'), job(async (req, { jobDir }) => {
  if (!req.file) throw new UserError('Nenhum arquivo enviado.');
  const input = await stage(req.file, jobDir, 'entrada.pdf');
  const output = path.join(jobDir, 'saida.xlsx');
  const args = [EXCEL_SCRIPT, input, output];
  if (flag(req.body.singleSheet)) args.push('--single-sheet');
  if (!flag(req.body.mergePages ?? '1')) args.push('--no-merge');
  if (!flag(req.body.convertNumbers ?? '1')) args.push('--raw');

  let stats;
  try {
    const { stdout } = await withSlot(() => run('python3', args, { timeout: 600000 }));
    stats = parseStats(stdout);
  } catch (err) {
    throw scriptError(err, 'Falha ao extrair as tabelas. O PDF pode estar corrompido.');
  }
  const out = await publish(output, 'xlsx');
  return { ...out, originalName: req.file.originalname, stats };
}));

// --- Ferramentas avulsas (tools/pdf_tools.py) ----------------------------------

const PDF_TOOLS = {
  split: { suffix: 'dividido', error: 'Falha ao dividir o PDF.' },
  organize: { suffix: 'organizado', error: 'Falha ao reorganizar as páginas.' },
  rotate: { suffix: 'girado', error: 'Falha ao girar as páginas.' },
  unlock: { suffix: 'destrancado', error: 'Falha ao tirar a senha.' },
  protect: { suffix: 'trancado', error: 'Falha ao pôr a senha.' },
  watermark: { suffix: 'marcado', error: 'Falha ao aplicar a marca d\'água.' },
  pagenumbers: { suffix: 'numerado', error: 'Falha ao numerar as páginas.' },
  ocr: { suffix: 'pesquisavel', error: 'Falha no OCR.', timeout: 1800000 },
  sanitize: { suffix: 'limpo', error: 'Falha ao limpar o PDF.' },
  blank: { suffix: 'sem_brancas', error: 'Falha ao procurar páginas em branco.' },
  images: { suffix: 'imagens', error: 'Falha ao extrair as imagens.' },
  flatten: { suffix: 'achatado', error: 'Falha ao achatar o PDF.' },
  metadata: { suffix: 'metadados', error: 'Falha ao mexer nos metadados.' },
  nup: { suffix: 'varias_por_folha', error: 'Falha ao montar as folhas.' },
  redact: { suffix: 'tarjado', error: 'Falha ao tarjar o PDF.' }
};

app.post('/api/tool/:tool', uploadPdf.single('pdf'), job(async (req, { jobDir }) => {
  const tool = req.params.tool;
  const meta = Object.prototype.hasOwnProperty.call(PDF_TOOLS, tool) ? PDF_TOOLS[tool] : null;
  if (!meta) throw new UserError('Ferramenta desconhecida.');
  if (!req.file) throw new UserError('Nenhum arquivo enviado.');

  const rawOptions = String(req.body.options || '{}');
  if (rawOptions.length > 10000) throw new UserError('Opções grandes demais.');
  let options;
  try {
    options = JSON.parse(rawOptions);
  } catch (_) {
    throw new UserError('Opções inválidas.');
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new UserError('Opções inválidas.');

  const base = path.basename(req.file.originalname, path.extname(req.file.originalname))
    .replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'documento';
  options._base = base;

  const input = await stage(req.file, jobDir, 'entrada.pdf');
  const outDir = path.join(jobDir, 'saida');
  await fsp.mkdir(outDir);
  const optsPath = path.join(jobDir, 'opcoes.json');
  await fsp.writeFile(optsPath, JSON.stringify(options));

  let stats;
  try {
    const { stdout } = await withSlot(() => run('python3', [TOOLS_SCRIPT, tool, input, outDir, optsPath],
      { timeout: meta.timeout || 600000 }));
    stats = parseStats(stdout);
  } catch (err) {
    // Código 5 = erro "do usuário", com a mensagem na última linha do stderr
    if (err && err.code === 5) {
      const msg = String(err.stderr || '').trim().split('\n').pop();
      throw new UserError(msg || meta.error);
    }
    throw scriptError(err, `${meta.error} O PDF pode estar corrompido.`);
  }
  if (!stats.file || stats.file.includes('/')) throw new UserError(meta.error, 500);

  const out = await publish(path.join(outDir, stats.file), stats.ext);
  const { file: _f, ext: _e, ...rest } = stats;
  return { ...out, originalName: `${base}_${meta.suffix}.${stats.ext}`, stats: rest };
}));

// --- Editor de PDF (TESTE) -------------------------------------------------------
// A sessão guarda o PDF normalizado e as imagens das páginas por até 2 h sem uso.

function sessionDir(id) {
  if (!/^[a-f0-9]{32}$/.test(String(id))) throw new UserError('Sessão inválida.', 404);
  return path.join(EDITOR_DIR, id);
}

async function touchSession(dir) {
  const now = new Date();
  try {
    await fsp.utimes(dir, now, now);
  } catch (_) {
    throw new UserError('Sessão do editor expirou. Abra o PDF de novo.', 404);
  }
}

app.post('/api/editor/open', uploadPdf.single('pdf'), async (req, res) => {
  const files = uploadedFiles(req);
  const id = newOutputId();
  const dir = path.join(EDITOR_DIR, id);
  try {
    if (!req.file) throw new UserError('Nenhum arquivo enviado.');
    await fsp.mkdir(dir, { recursive: true });
    const input = await stage(req.file, dir, 'original.pdf');
    let meta;
    try {
      const { stdout } = await withSlot(() => run('python3', [EDITOR_SCRIPT, 'open', input, dir], { timeout: 300000 }));
      meta = parseStats(stdout);
    } catch (err) {
      if (err && err.code === 5) throw new UserError(String(err.stderr || '').trim().split('\n').pop());
      throw scriptError(err, 'Falha ao abrir o PDF no editor. Ele pode estar corrompido.');
    }
    await fsp.unlink(input);
    res.json({ session: id, originalName: req.file.originalname, ...meta });
  } catch (err) {
    removeWorkDir(dir);
    const status = err instanceof UserError ? err.status : 500;
    if (!(err instanceof UserError)) console.error('Erro em /api/editor/open:', err.message);
    res.status(status).json({ error: err instanceof UserError ? err.message : 'Erro inesperado.' });
  } finally {
    cleanupUploads(files);
  }
});

app.get('/api/editor/:id/page/:n', (req, res) => {
  let dir;
  try {
    dir = sessionDir(req.params.id);
  } catch (err) {
    return res.status(404).end();
  }
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 0 || n > 1000) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=7200');
  res.sendFile(path.join(dir, `page_${n}.jpg`), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

app.post('/api/editor/:id/apply', express.json({ limit: '30mb' }), job(async (req, { jobDir }) => {
  const dir = sessionDir(req.params.id);
  await touchSession(dir);
  const body = req.body || {};
  if (!Array.isArray(body.ops)) throw new UserError('Alterações inválidas.');
  const opsPath = path.join(jobDir, 'ops.json');
  await fsp.writeFile(opsPath, JSON.stringify({ ops: body.ops, flattenForms: Boolean(body.flattenForms) }));
  const output = path.join(jobDir, 'editado.pdf');

  let stats;
  try {
    const { stdout } = await withSlot(() => run('python3', [EDITOR_SCRIPT, 'apply', path.join(dir, 'doc.pdf'), opsPath, output],
      { timeout: 300000 }));
    stats = parseStats(stdout);
  } catch (err) {
    if (err && err.code === 5) throw new UserError(String(err.stderr || '').trim().split('\n').pop());
    throw scriptError(err, 'Falha ao salvar as edições.');
  }
  const base = path.basename(String(body.originalName || 'documento.pdf'), '.pdf').slice(0, 80) || 'documento';
  const out = await publish(output, 'pdf');
  return { ...out, originalName: `${base}_editado.pdf`, stats };
}));

// --- Download ------------------------------------------------------------------

function safeDownloadName(raw, fallback) {
  const name = String(raw || '')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 150);
  return name || fallback;
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
      return res.status(404).send('Arquivo não encontrado (ele expira em alguns minutos).');
    }
    const filePath = path.join(OUTPUT_DIR, match);
    const ext = path.extname(match) || '.pdf';
    res.download(filePath, safeDownloadName(req.query.name, `ihatepdf${ext}`));
  });
});

// Erros do multer (tipo/tamanho/quantidade) e afins. Uploads parciais são
// apagados aqui — antes eles ficavam órfãos em uploads/ para sempre.
app.use((err, req, res, _next) => {
  cleanupUploads(uploadedFiles(req));
  let message = err instanceof UserError ? err.message : 'Erro inesperado.';
  if (err instanceof multer.MulterError) {
    message = {
      LIMIT_FILE_SIZE: 'Arquivo grande demais (máximo 200 MB).',
      LIMIT_FILE_COUNT: 'Arquivos demais de uma vez.',
      LIMIT_UNEXPECTED_FILE: 'Arquivos demais ou campo inesperado.'
    }[err.code] || 'Upload inválido.';
  }
  res.status(err.status && err.status < 600 ? err.status : 400).json({ error: message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`I HATE PDF rodando em http://0.0.0.0:${PORT} (jobs simultâneos: ${MAX_JOBS})`);
});
