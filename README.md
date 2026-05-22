# I HATE PDF

Aplicação web para compressão de PDFs usando Ghostscript.

## Compressões disponíveis

- **Compressão Marromeno** — `-dPDFSETTINGS=/screen` (qualidade razoável).
- **Compressão Braba das Braba** — esmagamento agressivo com resolução 40dpi.

## Rodando com Docker

```bash
docker compose up -d --build
```

Acesse: http://localhost:666

## Rodando local (sem Docker)

Requer Node.js 20+ e Ghostscript (`gs`) instalados.

```bash
npm install
npm start
```
