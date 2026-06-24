FROM node:20-alpine

# Ghostscript: compressão/merge de PDF
# LibreOffice: conversão Word <-> PDF
# poppler-utils: pdftoppm para PDF -> imagem
# imagemagick: conversão de formatos de imagem e imagem -> PDF
# zip: empacotar múltiplas imagens
# ttf-* + fontconfig: fontes para o LibreOffice renderizar PDFs decentes
RUN apk add --no-cache \
      ghostscript \
      libreoffice \
      poppler-utils \
      imagemagick \
      zip \
      fontconfig \
      ttf-dejavu \
      ttf-liberation \
  && fc-cache -f

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

RUN mkdir -p uploads outputs

# LibreOffice precisa de HOME gravável
ENV HOME=/tmp

EXPOSE 666

CMD ["node", "server.js"]
