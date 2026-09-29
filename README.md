# I HATE PDF

Canivete suíço de PDF auto-hospedado, com barra lateral de ferramentas:

- **Esmagar:** comprimir (4 perfis, tons de cinza, tamanho máximo em MB).
- **Converter:** Word ⇄ PDF, imagens ⇄ PDF, PDF → Texto (sem cabeçalho/rodapé, com OCR),
  PDF → Excel (tabelas com e sem grade).
- **Organizar:** juntar, esquartejar (dividir), reorganizar/excluir páginas, girar,
  várias páginas por folha, remover páginas em branco.
- **Segurança:** trancar com senha (AES-256), tirar senha, tarja preta (CPF, CNPJ, e-mail,
  telefone, termos livres — remove o texto de verdade), exorcizar (remove JavaScript,
  anexos, metadados, links) e editar metadados.
- **Editar:** marca d'água, numerar páginas, PDF pesquisável (OCR invisível), achatar
  formulários/anotações, extrair imagens.

As ferramentas avulsas ficam em `tools/pdf_tools.py` (inspiradas no Stirling-PDF,
reimplementadas com PyMuPDF, pikepdf e Tesseract). Cada ferramenta tem link direto:
`http://host:666/#redact`, `#split`, `#ocr`...

## Compressões disponíveis

Todas usam Ghostscript com recompressão forçada dos JPEGs + otimização sem perdas (pikepdf).

- **Apertar um Cadinho** — 150 dpi, boa qualidade.
- **Compressão Marromeno** — 72 dpi.
- **Compressão Braba das Braba** — 40 dpi, JPEG agressivo.
- **Modo Xerox** — páginas em preto e branco puro (CCITT G4). Ideal para escaneados.
- Opcionais: **tons de cinza** e **tamanho máximo em MB** (busca o nível mais leve que cabe).
- Se o resultado ficar maior que o original, devolve o original otimizado sem perdas.

## Rodando com Docker

```bash
docker compose up -d --build
```

Acesse: http://localhost:666

Variáveis: `MAX_JOBS` (processos pesados simultâneos, padrão 2), `MAX_QUEUE` (fila, padrão 20).

## Segurança

- Container roda como usuário sem privilégios (`node`).
- LibreOffice com perfil endurecido (sem macros, sem links/imagens externas: evita SSRF).
- ImageMagick só com os formatos usados e limites de recurso (`tools/imagemagick-policy.xml`).
- Nomes de arquivo nunca viram HTML; cabeçalhos CSP/nosniff/frame-deny.
- Uploads e arquivos de trabalho são apagados mesmo em erro; saídas expiram em 10 min.

## Rodando local (sem Docker)

Requer Node.js 22+, Ghostscript, poppler-utils, ImageMagick, LibreOffice, Tesseract e
`pip install pdf2docx pikepdf openpyxl langdetect`.

```bash
npm install
npm start
```
