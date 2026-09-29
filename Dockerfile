# Node 22 LTS (o Node 20 saiu de suporte em abril/2026)
FROM node:22-slim

# Ghostscript: compressão de PDF
# libreoffice-writer: conversão Word -> PDF (Writer + core)
# poppler-utils: pdftoppm/pdfinfo para PDF -> imagem e modo Xerox
# imagemagick: conversão de formatos de imagem e imagem -> PDF
# zip: empacotar múltiplas imagens
# tesseract-ocr (+por): OCR de PDFs digitalizados no PDF -> Texto
# python3 + pdf2docx: conversão PDF -> Word com parágrafos reais (não caixas de texto)
#   (traz o PyMuPDF, usado também no PDF -> Texto e PDF -> Excel)
# pikepdf: merge e pós-otimização da compressão; openpyxl: geração do .xlsx
# fontes: para o LibreOffice/Ghostscript renderizarem decentemente
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
      ghostscript \
      libreoffice-writer \
      poppler-utils \
      imagemagick \
      zip \
      tesseract-ocr \
      tesseract-ocr-por \
      python3 \
      python3-pip \
      libglib2.0-0 \
      fonts-dejavu \
      fonts-liberation \
  && pip install --no-cache-dir --break-system-packages pdf2docx langdetect pikepdf openpyxl \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Política do ImageMagick restrita aos formatos usados (ver tools/imagemagick-policy.xml)
COPY tools/imagemagick-policy.xml /tmp/im-policy.xml
RUN for d in /etc/ImageMagick-6 /etc/ImageMagick-7; do \
      if [ -d "$d" ]; then cp /tmp/im-policy.xml "$d/policy.xml"; fi; \
    done && rm /tmp/im-policy.xml

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public
COPY tools ./tools

# Roda sem root: só as pastas de trabalho são graváveis
RUN mkdir -p uploads outputs work && chown -R node:node uploads outputs work
USER node

# LibreOffice precisa de HOME gravável
ENV HOME=/tmp
ENV NODE_ENV=production
ENV TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata
# Evita que o Tesseract dispare várias threads por página (o container tem CPU limitada)
ENV OMP_THREAD_LIMIT=1

EXPOSE 666

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:666/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
