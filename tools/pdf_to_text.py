#!/usr/bin/env python3
"""Extrai o texto de um PDF para .txt, sem cabeçalhos/rodapés.

- Cabeçalhos e rodapés: linhas nas margens (topo/base, ou texto vertical nas
  laterais) que se repetem em várias páginas são descartadas. Os dígitos são
  normalizados antes da comparação, então "Página 3 de 10" casa com
  "Página 4 de 10". Números de página soltos nas margens também saem.
- Parágrafos: as linhas de um mesmo bloco são reunidas em parágrafos, com
  desifenização ("exem-" + "plo" -> "exemplo"), preservando listas.
- OCR: páginas sem texto (digitalizadas) passam pelo Tesseract (por+eng).

Uso: pdf_to_text.py <entrada.pdf> <saida.txt> [--keep-headers] [--keep-lines] [--no-ocr]
Imprime um JSON com estatísticas no stdout.
"""
import json
import math
import re
import sys

import pymupdf as fitz

MARGIN_TOP = 0.11      # fração da altura considerada zona de cabeçalho
MARGIN_BOTTOM = 0.11   # fração da altura considerada zona de rodapé
MARGIN_SIDE = 0.09     # fração da largura para texto vertical nas laterais
MIN_OCR_CHARS = 20     # abaixo disso a página é tratada como digitalizada
OCR_LANG = 'por+eng'
OCR_DPI = 300

PAGE_NUM_RE = re.compile(
    r'^[\s\-–—|]*'
    r'(p[áa]g(ina)?\.?|page|folha|fls?\.?|p\.)?\s*'
    r'\d{1,4}\s*((de|of|/)\s*\d{1,4})?'
    r'[\s\-–—|]*$',
    re.IGNORECASE)
BULLET_RE = re.compile(r'^([\-–—•·*▪●◦■□➢✓]\s|\(?\d{1,3}[\.\)]\s|\(?[a-zA-Z][\.\)]\s|[IVXLC]+[\.\)\-–]\s)')
SENTENCE_END = ('.', ':', ';', '!', '?', '"', '”', ')')


def norm_key(text):
    t = text.strip().lower()
    t = re.sub(r'\d+', '#', t)
    t = re.sub(r'\s+', ' ', t)
    return t


def line_text(line):
    """Monta o texto da linha a partir dos spans, inserindo espaço/tab conforme o vão."""
    out = ''
    prev = None
    for span in line['spans']:
        txt = span['text']
        if not txt:
            continue
        if prev is not None and out and not out.endswith(' ') and not txt.startswith(' '):
            gap = span['bbox'][0] - prev['bbox'][2]
            size = max(span.get('size', 10), 1)
            if gap > size * 2.5:
                out += '\t'
            elif gap > size * 0.2:
                out += ' '
        out += txt
        prev = span
    return re.sub(r'[  ]{2,}', ' ', out).strip()


def page_lines(page, use_ocr, stats):
    """Retorna (linhas, usou_ocr). Cada linha: dict com texto, bbox, bloco, direção."""
    flags = fitz.TEXT_PRESERVE_WHITESPACE | fitz.TEXT_MEDIABOX_CLIP
    data = page.get_text('dict', flags=flags)
    chars = sum(len(s['text'].strip()) for b in data['blocks'] if b['type'] == 0
                for l in b['lines'] for s in l['spans'])
    ocr_used = False
    if chars < MIN_OCR_CHARS and use_ocr and page.get_images():
        try:
            tp = page.get_textpage_ocr(language=OCR_LANG, dpi=OCR_DPI, full=True)
            data = page.get_text('dict', textpage=tp)
            ocr_used = True
        except Exception as exc:  # Tesseract ausente ou falhou: segue sem OCR
            stats.setdefault('warnings', []).append('OCR falhou: {0}'.format(exc))
    lines = []
    for b_idx, block in enumerate(data['blocks']):
        if block['type'] != 0:
            continue
        for line in block['lines']:
            txt = line_text(line)
            if not txt:
                continue
            lines.append({
                'text': txt,
                'bbox': line['bbox'],
                'block': b_idx,
                'horizontal': abs(line['dir'][0]) > 0.9,
            })
    return lines, ocr_used


def margin_zone(line, width, height):
    x0, y0, x1, y1 = line['bbox']
    if not line['horizontal']:
        cx = (x0 + x1) / 2
        if cx < width * MARGIN_SIDE:
            return 'left'
        if cx > width * (1 - MARGIN_SIDE):
            return 'right'
        return None
    if y1 <= height * MARGIN_TOP:
        return 'top'
    if y0 >= height * (1 - MARGIN_BOTTOM):
        return 'bottom'
    return None


def mark_headers(pages):
    """Marca linhas de cabeçalho/rodapé (campo 'drop'). Retorna quantas saíram."""
    n = len(pages)
    counts = {}
    for p in pages:
        seen = set()
        for line in p['lines']:
            zone = margin_zone(line, p['w'], p['h'])
            line['zone'] = zone
            if zone:
                key = (zone, norm_key(line['text']))
                if key not in seen:
                    seen.add(key)
                    counts[key] = counts.get(key, 0) + 1
    # Cabeçalhos alternados (páginas pares/ímpares) aparecem em ~metade das páginas
    threshold = max(2, math.ceil(n * 0.4))
    removed = 0
    for p in pages:
        for line in p['lines']:
            zone = line['zone']
            if not zone:
                continue
            key = norm_key(line['text'])
            repeated = n >= 2 and counts.get((zone, key), 0) >= threshold
            # Só números (ex.: "12") podem ser célula de tabela perto da margem:
            # nesse caso exige que a linha esteja sozinha na altura dela.
            has_letters = any(ch.isalpha() for ch in key)
            if (repeated and has_letters) or \
                    ((repeated or PAGE_NUM_RE.match(line['text'])) and alone_in_row(line, p['lines'])):
                line['drop'] = True
                removed += 1
    return removed


def alone_in_row(line, lines):
    if not line['horizontal']:
        return True
    x0, y0, x1, y1 = line['bbox']
    for other in lines:
        if other is line or not other['horizontal']:
            continue
        oy0, oy1 = other['bbox'][1], other['bbox'][3]
        height = min(y1 - y0, oy1 - oy0)
        if height > 0 and min(y1, oy1) - max(y0, oy0) > height * 0.5:
            return False
    return True


def merge_rows(lines):
    """Une linhas consecutivas que estão na mesma altura (ex.: "1." e o título
    ao lado ficam em blocos diferentes no PDF, mas são uma linha só)."""
    merged = []
    for line in lines:
        prev = merged[-1] if merged else None
        if prev and prev['horizontal'] and line['horizontal']:
            px0, py0, px1, py1 = prev['bbox']
            x0, y0, x1, y1 = line['bbox']
            height = min(py1 - py0, y1 - y0)
            overlap = min(py1, y1) - max(py0, y0)
            if height > 0 and overlap > height * 0.5 and x0 >= px1 - 1:
                sep = '\t' if x0 - px1 > height * 2.5 else ' '
                prev = dict(prev, text=prev['text'] + sep + line['text'],
                            bbox=(px0, min(py0, y0), x1, max(py1, y1)))
                merged[-1] = prev
                continue
        merged.append(line)
    return merged


def lines_to_paragraphs(lines):
    """Agrupa as linhas por bloco e reconstrói parágrafos."""
    paragraphs = []
    blocks = []
    for line in lines:
        if blocks and blocks[-1][0] == line['block']:
            blocks[-1][1].append(line)
        else:
            blocks.append((line['block'], [line]))
    for _, blines in blocks:
        widths = [l['bbox'][2] - l['bbox'][0] for l in blines]
        full = max(widths) if widths else 0
        current = ''
        prev_line = ''
        prev_width = 0
        for line, width in zip(blines, widths):
            txt = line['text']
            if current:
                # Linha anterior curta terminando em pontuação = fim de parágrafo
                ends_para = prev_line.endswith(SENTENCE_END) and prev_width < full * 0.75
                if BULLET_RE.match(txt) or ends_para or '\t' in txt or '\t' in prev_line:
                    paragraphs.append(current)
                    current = txt
                elif current.endswith('-') and txt[:1].islower():
                    current = current[:-1] + txt
                else:
                    current = current + ' ' + txt
            else:
                current = txt
            prev_line = txt
            prev_width = width
        if current:
            paragraphs.append(current)
    return paragraphs


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    opts = {a for a in sys.argv[1:] if a.startswith('--')}
    if len(args) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    src, dst = args[0], args[1]
    keep_headers = '--keep-headers' in opts
    keep_lines = '--keep-lines' in opts
    use_ocr = '--no-ocr' not in opts

    doc = fitz.open(src)
    if doc.needs_pass and not doc.authenticate(''):
        print('PDF protegido por senha.', file=sys.stderr)
        sys.exit(3)

    stats = {'pages': doc.page_count, 'ocr_pages': 0, 'removed_lines': 0}
    pages = []
    for page in doc:
        lines, ocr_used = page_lines(page, use_ocr, stats)
        if ocr_used:
            stats['ocr_pages'] += 1
        rect = page.rect
        pages.append({'lines': lines, 'w': rect.width, 'h': rect.height})

    if not keep_headers:
        stats['removed_lines'] = mark_headers(pages)

    chunks = []
    for p in pages:
        lines = merge_rows([l for l in p['lines'] if not l.get('drop')])
        if keep_lines:
            chunk = '\n'.join(l['text'] for l in lines)
            if chunk:
                chunks.append(chunk)
            continue
        paras = lines_to_paragraphs(lines)
        if not paras:
            continue
        # Parágrafo que atravessa a quebra de página: emenda com o anterior
        if chunks and chunks[-1] and not chunks[-1][-1].endswith(SENTENCE_END) \
                and paras[0][:1].islower():
            last = chunks[-1].pop()
            if last.endswith('-'):
                paras[0] = last[:-1] + paras[0]
            else:
                paras[0] = last + ' ' + paras[0]
        chunks.append(paras)

    if keep_lines:
        text = '\n\n'.join(chunks)
    else:
        text = '\n\n'.join('\n\n'.join(c) for c in chunks if c)
    text = text.strip() + '\n'

    with open(dst, 'w', encoding='utf-8') as fh:
        fh.write(text)

    stats['chars'] = len(text.strip())
    print(json.dumps(stats, ensure_ascii=False))


if __name__ == '__main__':
    main()
