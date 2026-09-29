#!/usr/bin/env python3
"""Editor de PDF (TESTE) — mesma ideia do "PDF Text Editor" do Stirling-PDF:
o PDF é desmontado em trechos de texto posicionados, o navegador edita, e o
servidor reescreve só o que mudou.

  pdf_editor.py open  <entrada.pdf> <pasta_sessao>
      Normaliza a rotação das páginas, grava <pasta>/doc.pdf, renderiza
      <pasta>/page_N.jpg e imprime o JSON com páginas, trechos e campos.

  pdf_editor.py apply <pasta_sessao>/doc.pdf <ops.json> <saida.pdf>
      Aplica a lista de operações (coordenadas em pontos, origem no topo
      esquerdo da página):
        edit      {page, bbox, text, font, size, color, flags, origin}
        addText   {page, x, y, text, size, color, family, bold, italic}
        image     {page, rect, data (data URL png/jpeg)}
        highlight {page, rect, color}
        rect      {page, rect, color, width}
        whiteout  {page, rect}
        redact    {page, rect}
        field     {page, name, value}
      Opção global {"flattenForms": true} achata os formulários no final.

Códigos de saída: 3 = senha; 5 = erro do usuário (mensagem no stderr).
"""
import base64
import json
import os
import re
import sys

import pymupdf as fitz

MAX_PAGES = 150
RENDER_ZOOM = 1.5  # 108 dpi: nítido na tela sem pesar
FONT_DIR = '/usr/share/fonts/truetype/liberation'
MAX_IMAGE_BYTES = 8 * 1024 * 1024


class UserError(Exception):
    pass


def rgb_int(value):
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255]


def color01(value, default=(0, 0, 0)):
    if isinstance(value, (list, tuple)) and len(value) == 3:
        return tuple(max(0, min(255, float(c))) / 255 for c in value)
    m = re.fullmatch(r'#?([0-9a-fA-F]{6})', str(value or ''))
    if m:
        h = m.group(1)
        return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return default


def clean_font_name(name):
    return re.sub(r'^[A-Z]{6}\+', '', name or '')


# --------------------------------------------------------------------------
# open
# --------------------------------------------------------------------------
def page_elements(page):
    """Trechos editáveis: uma linha inteira quando ela tem estilo único,
    senão cada span separado. Só texto horizontal é editável."""
    data = page.get_text('dict', flags=fitz.TEXT_PRESERVE_WHITESPACE | fitz.TEXT_MEDIABOX_CLIP)
    elements = []
    for block in data['blocks']:
        if block['type'] != 0:
            continue
        for line in block['lines']:
            if abs(line['dir'][0] - 1) > 0.01:
                continue
            spans = [s for s in line['spans'] if s['text'].strip()]
            if not spans:
                continue
            style = lambda s: (s['font'], round(s['size'], 1), s['color'], s['flags'] & 0b10110)
            groups = [spans] if len({style(s) for s in spans}) == 1 else [[s] for s in spans]
            for group in groups:
                first = group[0]
                x0 = min(s['bbox'][0] for s in group)
                y0 = min(s['bbox'][1] for s in group)
                x1 = max(s['bbox'][2] for s in group)
                y1 = max(s['bbox'][3] for s in group)
                # Espaços entre spans do mesmo estilo que o PDF "desenhou" como vão
                text = ''
                prev = None
                for s in group:
                    if prev is not None and not text.endswith(' ') and not s['text'].startswith(' ') \
                            and s['bbox'][0] - prev['bbox'][2] > s['size'] * 0.2:
                        text += ' '
                    text += s['text']
                    prev = s
                elements.append({
                    'id': 'e{0}'.format(len(elements)),
                    'text': text.strip(),
                    'bbox': [round(v, 2) for v in (x0, y0, x1, y1)],
                    'origin': [round(first['origin'][0], 2), round(first['origin'][1], 2)],
                    'font': clean_font_name(first['font']),
                    'size': round(first['size'], 2),
                    'color': rgb_int(first['color']),
                    'flags': first['flags'],
                })
    return elements


def page_fields(page):
    fields = []
    for w in page.widgets() or []:
        kind = w.field_type_string.lower()
        if kind not in ('text', 'checkbox', 'combobox', 'listbox', 'radiobutton'):
            continue
        r = w.rect
        field = {
            'name': w.field_name,
            'type': kind,
            'value': w.field_value if not isinstance(w.field_value, bool) else ('Yes' if w.field_value else 'Off'),
            'rect': [round(v, 2) for v in (r.x0, r.y0, r.x1, r.y1)],
        }
        if kind in ('combobox', 'listbox'):
            field['options'] = [c if isinstance(c, str) else c[0] for c in (w.choice_values or [])]
        if kind in ('checkbox', 'radiobutton'):
            field['onState'] = w.on_state() or 'Yes'
            field['checked'] = w.field_value not in (False, 'Off', '', None)
        fields.append(field)
    return fields


def cmd_open(src, session_dir):
    doc = fitz.open(src)
    if doc.needs_pass:
        print('PDF protegido por senha.', file=sys.stderr)
        sys.exit(3)
    if doc.page_count > MAX_PAGES:
        raise UserError('O editor aceita até {0} páginas. Esquarteja antes.'.format(MAX_PAGES))
    pages = []
    for i, page in enumerate(doc):
        # Rotação vira conteúdo: a partir daqui "o que se vê" = coordenadas do PDF
        if page.rotation:
            page.remove_rotation()
        page.get_pixmap(matrix=fitz.Matrix(RENDER_ZOOM, RENDER_ZOOM)).save(
            os.path.join(session_dir, 'page_{0}.jpg'.format(i)), jpg_quality=85)
        pages.append({
            'width': round(page.rect.width, 2),
            'height': round(page.rect.height, 2),
            'elements': page_elements(page),
            'fields': page_fields(page),
        })
    doc.save(os.path.join(session_dir, 'doc.pdf'), garbage=1, deflate=True)
    scanned = sum(1 for p in pages if not p['elements'])
    return {'pages': pages, 'pageCount': len(pages), 'scannedPages': scanned}


# --------------------------------------------------------------------------
# apply
# --------------------------------------------------------------------------
class FontPicker:
    """Tenta a fonte embutida do próprio PDF; se faltar alguma letra (fonte
    parcial), cai para a Liberation de métricas equivalentes."""

    def __init__(self, doc):
        self.doc = doc
        self.embedded = {}   # (página, nome) -> (alias, Font) | None
        self.registered = set()
        self._used = None    # nome da fonte -> letras já desenhadas com ela no PDF

    def used_chars(self, name):
        """Fonte parcial (subset) pode declarar uma letra no mapa sem trazer o
        desenho dela. Letra que já aparece no documento com essa fonte, essa
        com certeza existe."""
        if self._used is None:
            self._used = {}
            for page in self.doc:
                for block in page.get_text('dict')['blocks']:
                    for line in block.get('lines', []):
                        for span in line['spans']:
                            self._used.setdefault(clean_font_name(span['font']), set()).update(span['text'])
        return self._used.get(name, set())

    def fallback_file(self, name, flags, bold=None, italic=None):
        low = (name or '').lower()
        if bold is None:
            bold = bool(flags & 16) or 'bold' in low or 'black' in low or 'heavy' in low
        if italic is None:
            italic = bool(flags & 2) or 'italic' in low or 'oblique' in low
        if 'mono' in low or 'courier' in low or 'consol' in low or flags & 8:
            family = 'Mono'
        elif 'times' in low or 'serif' in low and 'sans' not in low or 'georgia' in low \
                or 'garamond' in low or 'cambria' in low or (flags & 4 and 'sans' not in low):
            family = 'Serif'
        elif 'narrow' in low or 'condensed' in low:
            family = 'SansNarrow'
        else:
            family = 'Sans'
        style = 'BoldItalic' if bold and italic else 'Bold' if bold else 'Italic' if italic else 'Regular'
        return os.path.join(FONT_DIR, 'Liberation{0}-{1}.ttf'.format(family, style))

    def embedded_font(self, page, name):
        key = (page.number, name)
        if key in self.embedded:
            return self.embedded[key]
        found = None
        for xref, ext, _type, basefont, _ref, _enc in page.get_fonts(full=False) or []:
            if clean_font_name(basefont) != name or ext not in ('ttf', 'otf', 'cff', 'pfa', 'pfb'):
                continue
            try:
                _n, _e, _t, buffer = self.doc.extract_font(xref)
                if buffer:
                    alias = 'EF{0}'.format(xref)
                    subset = bool(re.match(r'^[A-Z]{6}\+', basefont or ''))
                    found = (alias, fitz.Font(fontbuffer=buffer), buffer, subset)
                    break
            except Exception:
                pass
        self.embedded[key] = found
        return found

    def for_text(self, page, text, name, flags):
        """Retorna kwargs de insert_text: fontname (+ fontfile/fontbuffer)."""
        emb = self.embedded_font(page, name) if name else None
        letters = {c for c in text if not c.isspace()}
        ok = emb and all(emb[1].has_glyph(ord(c)) for c in letters)
        if ok and emb[3]:
            ok = letters <= self.used_chars(name)
        if ok:
            alias, _font, buffer, _subset = emb
            if (page.number, alias) not in self.registered:
                page.insert_font(fontname=alias, fontbuffer=buffer)
                self.registered.add((page.number, alias))
            return {'fontname': alias}, False
        path = self.fallback_file(name, flags)
        alias = 'LB' + re.sub(r'[^A-Za-z]', '', os.path.basename(path).replace('.ttf', ''))
        return {'fontname': alias, 'fontfile': path}, True

    def by_family(self, family, bold, italic):
        name = {'serif': 'Times', 'mono': 'Courier'}.get(family, 'Arial')
        path = self.fallback_file(name, 0, bold=bold, italic=italic)
        alias = 'LB' + re.sub(r'[^A-Za-z]', '', os.path.basename(path).replace('.ttf', ''))
        return {'fontname': alias, 'fontfile': path}


def rect_of(op):
    r = op.get('rect') or op.get('bbox')
    if not isinstance(r, (list, tuple)) or len(r) != 4:
        raise UserError('Operação sem retângulo válido.')
    rect = fitz.Rect(*[float(v) for v in r])
    rect.normalize()
    return rect


def decode_image(data_url):
    m = re.fullmatch(r'data:image/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)', data_url or '')
    if not m:
        raise UserError('Imagem inválida (use PNG ou JPEG).')
    raw = base64.b64decode(m.group(2))
    if len(raw) > MAX_IMAGE_BYTES:
        raise UserError('Imagem grande demais (máximo 8 MB).')
    return raw


def cmd_apply(src, ops_path, dst):
    with open(ops_path, encoding='utf-8') as fh:
        payload = json.load(fh)
    ops = payload.get('ops') or []
    if not isinstance(ops, list) or not ops:
        raise UserError('Nenhuma alteração para salvar. Edita alguma coisa primeiro, né?')
    if len(ops) > 5000:
        raise UserError('Alterações demais de uma vez.')
    doc = fitz.open(src)
    fonts = FontPicker(doc)
    stats = {'edited': 0, 'added': 0, 'images': 0, 'shapes': 0, 'redacted': 0, 'fields': 0, 'fallbackFonts': 0}

    by_page = {}
    for op in ops:
        try:
            pno = int(op.get('page'))
        except (TypeError, ValueError):
            raise UserError('Operação sem página.')
        if pno < 0 or pno >= doc.page_count:
            raise UserError('Página inexistente numa das alterações.')
        by_page.setdefault(pno, []).append(op)

    for pno, page_ops in sorted(by_page.items()):
        page = doc[pno]

        # 1) Apaga o texto original dos trechos editados (sem tocar em imagens
        #    e desenhos) — encolhe a área na vertical para não pegar vizinhos
        edits = [op for op in page_ops if op.get('type') == 'edit']
        for op in edits:
            r = rect_of(op)
            pad = r.height * 0.18
            page.add_redact_annot(fitz.Rect(r.x0 + 0.3, r.y0 + pad, r.x1 - 0.3, r.y1 - pad), fill=False)
        if edits:
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE,
                                  graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                                  text=fitz.PDF_REDACT_TEXT_REMOVE)

        # 2) Tarja preta de verdade: remove texto, pixels de imagem e desenhos
        redacts = [op for op in page_ops if op.get('type') == 'redact']
        for op in redacts:
            page.add_redact_annot(rect_of(op), fill=(0, 0, 0))
        if redacts:
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_PIXELS,
                                  graphics=fitz.PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED,
                                  text=fitz.PDF_REDACT_TEXT_REMOVE)
            stats['redacted'] += len(redacts)

        # 3) O resto, na ordem em que o usuário criou (camadas)
        for op in page_ops:
            kind = op.get('type')
            if kind == 'edit':
                text = str(op.get('text', ''))[:2000]
                if text.strip():
                    kwargs, fallback = fonts.for_text(page, text, op.get('font'), int(op.get('flags') or 0))
                    origin = op.get('origin') or [rect_of(op).x0, rect_of(op).y1]
                    page.insert_text(fitz.Point(float(origin[0]), float(origin[1])), text,
                                     fontsize=float(op.get('size') or 11),
                                     color=color01(op.get('color')), **kwargs)
                    stats['fallbackFonts'] += int(fallback)
                stats['edited'] += 1
            elif kind == 'addText':
                text = str(op.get('text', ''))[:5000]
                if not text.strip():
                    continue
                size = max(4.0, min(200.0, float(op.get('size') or 12)))
                kwargs = fonts.by_family(op.get('family'), bool(op.get('bold')), bool(op.get('italic')))
                x, y = float(op.get('x', 0)), float(op.get('y', 0))
                page.insert_text(fitz.Point(x, y + size * 0.88), text, fontsize=size,
                                 lineheight=1.2, color=color01(op.get('color')), **kwargs)
                stats['added'] += 1
            elif kind == 'image':
                page.insert_image(rect_of(op), stream=decode_image(op.get('data')), keep_proportion=False)
                stats['images'] += 1
            elif kind == 'highlight':
                page.draw_rect(rect_of(op), color=None, fill=color01(op.get('color'), (1, 0.92, 0.2)),
                               fill_opacity=0.35, overlay=True)
                stats['shapes'] += 1
            elif kind == 'rect':
                page.draw_rect(rect_of(op), color=color01(op.get('color'), (0.8, 0, 0.1)),
                               width=max(0.5, min(20.0, float(op.get('width') or 2))), overlay=True)
                stats['shapes'] += 1
            elif kind == 'whiteout':
                page.draw_rect(rect_of(op), color=None, fill=(1, 1, 1), overlay=True)
                stats['shapes'] += 1
            elif kind == 'field':
                name = op.get('name')
                for w in page.widgets() or []:
                    if w.field_name != name:
                        continue
                    value = op.get('value')
                    if w.field_type in (fitz.PDF_WIDGET_TYPE_CHECKBOX, fitz.PDF_WIDGET_TYPE_RADIOBUTTON):
                        w.field_value = w.on_state() if value else 'Off'
                    else:
                        w.field_value = str(value if value is not None else '')[:5000]
                    w.update()
                    stats['fields'] += 1
            elif kind != 'redact':
                raise UserError('Operação desconhecida: {0}'.format(kind))

    if payload.get('flattenForms'):
        doc.bake(annots=False, widgets=True)
    doc.save(dst, garbage=3, deflate=True)
    return stats


def main():
    real_stdout, sys.stdout = sys.stdout, sys.stderr
    try:
        if len(sys.argv) == 4 and sys.argv[1] == 'open':
            result = cmd_open(sys.argv[2], sys.argv[3])
        elif len(sys.argv) == 5 and sys.argv[1] == 'apply':
            result = cmd_apply(sys.argv[2], sys.argv[3], sys.argv[4])
        else:
            print(__doc__, file=sys.stderr)
            sys.exit(2)
    except UserError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(5)
    print(json.dumps(result, ensure_ascii=False), file=real_stdout)


if __name__ == '__main__':
    main()
