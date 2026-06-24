FROM node:20-slim

# Ghostscript: compressão/merge de PDF
# libreoffice-writer: conversão Word -> PDF (Writer + core)
# poppler-utils: pdftoppm para PDF -> imagem
# imagemagick: conversão de formatos de imagem e imagem -> PDF
# zip: empacotar múltiplas imagens
# python3 + pdf2docx: conversão PDF -> Word com parágrafos reais (não caixas de texto)
# fontes: para o LibreOffice/Ghostscript renderizarem decentemente
RUN apt-get update && apt-get install -y --no-install-recommends \
      ghostscript \
      libreoffice-writer \
      poppler-utils \
      imagemagick \
      zip \
      python3 \
      python3-pip \
      libglib2.0-0 \
      fonts-dejavu \
      fonts-liberation \
  && pip install --no-cache-dir --break-system-packages pdf2docx langdetect \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Libera leitura/escrita de PDF no ImageMagick (policy padrão bloqueia)
RUN for f in /etc/ImageMagick-7/policy.xml /etc/ImageMagick-6/policy.xml; do \
      if [ -f "$f" ]; then \
        sed -i 's/.*pattern="PDF".*/  <policy domain="coder" rights="read|write" pattern="PDF" \/>/' "$f"; \
        sed -i 's/.*pattern="LABEL".*/  <policy domain="coder" rights="read|write" pattern="LABEL" \/>/' "$f"; \
      fi; \
    done

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public
COPY tools ./tools

RUN mkdir -p uploads outputs

# LibreOffice precisa de HOME gravável
ENV HOME=/tmp

EXPOSE 666

CMD ["node", "server.js"]
