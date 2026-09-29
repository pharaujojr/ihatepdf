#!/usr/bin/env python3
"""Ferramentas avulsas de PDF (inspiradas no Stirling-PDF, reimplementadas
com PyMuPDF/pikepdf/Tesseract).

Uso: pdf_tools.py <ferramenta> <entrada.pdf> <pasta_saida> <opcoes.json>

Gera um único arquivo em <pasta_saida> (várias saídas viram .zip) e imprime
no stdout um JSON: {"file": nome, "ext": extensão, ...estatísticas}.

Códigos de saída: 3 = senha necessária/errada; 5 = erro do usuário (mensagem
na última linha do stderr).
"""
import io
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import zipfile

import pikepdf
import pymupdf as fitz

MAX_OCR_PAGES = 200


class UserError(Exception):
    pass


# --------------------------------------------------------------------------
# Utilitários
# --------------------------------------------------------------------------
def parse_ranges(spec, total):
    """"1-3, 5, 8-" (1-based, na ordem digitada) -> lista de índices 0-based.
    Aceita "fim"/"end" e "-3" (do começo até 3)."""
    spec = (spec or '').strip().lower().replace('fim', str(total)).replace('end', str(total))
    if not spec:
        raise UserError('Informe as páginas (ex.: 1-3, 5, 8-fim).')
    pages = []
    for part in re.split(r'[,;\s]+', spec):
        if not part:
            continue
        m = re.fullmatch(r'(\d*)-(\d*)', part)
        if m:
            a = int(m.group(1)) if m.group(1) else 1
            b = int(m.group(2)) if m.group(2) else total
            step = 1 if b >= a else -1
            seq = range(a, b + step, step)
        elif part.isdigit():
            seq = [int(part)]
        else:
            raise UserError('Não entendi "{0}". Use algo como 1-3, 5, 8-fim.'.format(part))
        for p in seq:
            if p < 1 or p > total:
                raise UserError('Página {0} não existe (o PDF tem {1}).'.format(p, total))
            pages.append(p - 1)
    if not pages:
        raise UserError('Nenhuma página selecionada.')
    return pages


def save_doc(doc, path):
    doc.save(path, garbage=3, deflate=True, clean=False)


def zip_files(paths, out_path):
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for p in paths:
            z.write(p, os.path.basename(p))


def hex_color(value, default=(0.5, 0.5, 0.5)):
    m = re.fullmatch(r'#?([0-9a-fA-F]{6})', str(value or ''))
    if not m:
        return default
    h = m.group(1)
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def num(opts, key, default, lo, hi):
    try:
        v = float(opts.get(key, default))
    except (TypeError, ValueError):
        v = default
    return max(lo, min(hi, v))


def visible_point(page, x, y):
    """Ponto em coordenadas visíveis (página já girada) -> coordenadas do PDF."""
    return fitz.Point(x, y) * page.derotation_matrix


# --------------------------------------------------------------------------
# Ferramentas
# --------------------------------------------------------------------------
def tool_split(src, out_dir, opts, doc):
    total = doc.page_count
    mode = opts.get('mode', 'each')
    groups = []
    if mode == 'each':
        groups = [[i] for i in range(total)]
    elif mode == 'every':
        n = int(num(opts, 'every', 1, 1, 10000))
        groups = [list(range(i, min(i + n, total))) for i in range(0, total, n)]
    elif mode == 'ranges':
        # "1-3 | 4-10 | 11-fim": cada bloco separado por | ou quebra de linha vira um PDF
        blocks = [b for b in re.split(r'[|\n]+', opts.get('ranges', '')) if b.strip()]
        groups = [parse_ranges(b, total) for b in blocks]
    else:
        raise UserError('Modo de divisão inválido.')
    if len(groups) < 2 and mode != 'ranges':
        raise UserError('Esse PDF não tem o que dividir (só sairia 1 arquivo).')
    base = opts.get('_base', 'documento')
    paths = []
    for n, pages in enumerate(groups, 1):
        part = fitz.open()
        for p in pages:
            part.insert_pdf(doc, from_page=p, to_page=p)
        label = '{0}-{1}'.format(pages[0] + 1, pages[-1] + 1) if len(pages) > 1 else str(pages[0] + 1)
        path = os.path.join(out_dir, '{0}_parte{1:02d}_p{2}.pdf'.format(base, n, label))
        save_doc(part, path)
        paths.append(path)
    if len(paths) == 1:
        return paths[0], {'parts': 1}
    out = os.path.join(out_dir, 'partes.zip')
    zip_files(paths, out)
    return out, {'parts': len(paths)}


def tool_organize(src, out_dir, opts, doc):
    pages = parse_ranges(opts.get('pages', ''), doc.page_count)
    new = fitz.open()
    for p in pages:
        new.insert_pdf(doc, from_page=p, to_page=p)
    out = os.path.join(out_dir, 'organizado.pdf')
    save_doc(new, out)
    return out, {'pages': len(pages), 'removed': doc.page_count - len(set(pages))}


def tool_rotate(src, out_dir, opts, doc):
    angle = int(opts.get('angle', 90))
    if angle not in (90, 180, 270):
        raise UserError('Ângulo inválido.')
    which = opts.get('pages', '').strip()
    targets = set(parse_ranges(which, doc.page_count)) if which else set(range(doc.page_count))
    for i in targets:
        page = doc[i]
        page.set_rotation((page.rotation + angle) % 360)
    out = os.path.join(out_dir, 'girado.pdf')
    save_doc(doc, out)
    return out, {'rotated': len(targets)}


def tool_unlock(src, out_dir, opts, doc):
    password = opts.get('password', '')
    try:
        pdf = pikepdf.open(src, password=password)
    except pikepdf.PasswordError:
        raise UserError('Senha errada. Nem o ódio abre esse PDF sem a senha certa.')
    out = os.path.join(out_dir, 'destrancado.pdf')
    was = pdf.is_encrypted
    pdf.save(out)  # sem encryption= -> salva sem criptografia
    return out, {'wasEncrypted': was}


def tool_protect(src, out_dir, opts, doc):
    user = opts.get('password', '')
    if len(user) < 4:
        raise UserError('Senha curta demais (mínimo 4 caracteres).')
    owner = opts.get('ownerPassword') or secrets.token_urlsafe(24)
    restrict = bool(opts.get('restrict'))
    allow = pikepdf.Permissions(
        extract=not restrict, print_lowres=not restrict, print_highres=not restrict,
        modify_annotation=not restrict, modify_assembly=not restrict,
        modify_form=not restrict, modify_other=not restrict, accessibility=True)
    pdf = pikepdf.open(src, password=opts.get('currentPassword', ''))
    out = os.path.join(out_dir, 'trancado.pdf')
    pdf.save(out, encryption=pikepdf.Encryption(user=user, owner=owner, R=6, allow=allow))
    return out, {'restricted': restrict}


def tool_watermark(src, out_dir, opts, doc):
    text = (opts.get('text') or '').strip()[:200]
    if not text:
        raise UserError('Escreva o texto da marca d\'água.')
    size = num(opts, 'fontSize', 60, 8, 200)
    opacity = num(opts, 'opacity', 25, 5, 100) / 100
    angle = num(opts, 'angle', 45, -90, 90)
    color = hex_color(opts.get('color'), (0.55, 0.0, 0.0))
    tile = bool(opts.get('tile'))
    width = fitz.get_text_length(text, fontname='helv', fontsize=size)
    for page in doc:
        r = page.rect  # retângulo visível
        centers = []
        if tile:
            step_x, step_y = width + size * 2, size * 5
            y = step_y / 2
            while y < r.height + step_y:
                x = step_x / 2 if int(y // step_y) % 2 == 0 else 0
                while x < r.width + step_x:
                    centers.append((x, y))
                    x += step_x
                y += step_y
        else:
            centers.append((r.width / 2, r.height / 2))
        for cx, cy in centers:
            pivot = visible_point(page, cx, cy)
            start = visible_point(page, cx - width / 2, cy + size / 3)
            page.insert_text(start, text, fontsize=size, fontname='helv', color=color,
                             fill_opacity=opacity, rotate=page.rotation,
                             morph=(pivot, fitz.Matrix(angle)), overlay=True)
    out = os.path.join(out_dir, 'marcado.pdf')
    save_doc(doc, out)
    return out, {'pages': doc.page_count}


def tool_pagenumbers(src, out_dir, opts, doc):
    fmt = (opts.get('format') or '{n}').strip()[:80]
    if '{n}' not in fmt:
        raise UserError('O formato precisa ter {n} (ex.: Página {n} de {total}).')
    start = int(num(opts, 'start', 1, -9999, 99999))
    size = num(opts, 'fontSize', 10, 6, 40)
    position = opts.get('position', 'bottom-center')
    skip_first = bool(opts.get('skipFirst'))
    margin = 28
    total = doc.page_count
    for i, page in enumerate(doc):
        if skip_first and i == 0:
            continue
        label = fmt.replace('{n}', str(start + i - (1 if skip_first else 0))).replace('{total}', str(total))
        r = page.rect
        w = fitz.get_text_length(label, fontname='helv', fontsize=size)
        vert, horiz = (position.split('-') + ['center'])[:2]
        y = margin if vert == 'top' else r.height - margin + size * 0.35
        x = {'left': margin, 'right': r.width - margin - w}.get(horiz, (r.width - w) / 2)
        page.insert_text(visible_point(page, x, y), label, fontsize=size, fontname='helv',
                         color=(0, 0, 0), rotate=page.rotation, overlay=True)
    out = os.path.join(out_dir, 'numerado.pdf')
    save_doc(doc, out)
    return out, {'pages': total}


def tool_ocr(src, out_dir, opts, doc):
    """PDF pesquisável: renderiza cada página, o Tesseract gera só a camada de
    texto invisível (textonly_pdf) e ela é sobreposta à página original —
    a aparência do PDF não muda nada."""
    if doc.page_count > MAX_OCR_PAGES:
        raise UserError('OCR aceita até {0} páginas por vez.'.format(MAX_OCR_PAGES))
    force = bool(opts.get('force'))
    done = skipped = 0
    with tempfile.TemporaryDirectory(dir=out_dir) as tmp:
        for i, page in enumerate(doc):
            if not force and len(page.get_text().strip()) >= 20:
                skipped += 1
                continue
            if page.rotation:
                page.remove_rotation()
            img = os.path.join(tmp, 'p{0}.png'.format(i))
            page.get_pixmap(dpi=300, colorspace=fitz.csGRAY).save(img)
            base = os.path.join(tmp, 'p{0}'.format(i))
            subprocess.run(['tesseract', img, base, '-l', 'por+eng', '--dpi', '300',
                            '-c', 'textonly_pdf=1', 'pdf'],
                           check=True, capture_output=True, timeout=300)
            with fitz.open(base + '.pdf') as layer:
                page.show_pdf_page(page.rect, layer, 0, overlay=True)
            os.remove(img)
            done += 1
    if not done:
        raise UserError('Esse PDF já tem texto em todas as páginas. Marque "forçar" se quiser mesmo assim.')
    out = os.path.join(out_dir, 'pesquisavel.pdf')
    save_doc(doc, out)
    return out, {'ocrPages': done, 'skipped': skipped}


def tool_sanitize(src, out_dir, opts, doc):
    pdf = pikepdf.open(src)
    root = pdf.Root
    removed = {'javascript': 0, 'attachments': 0, 'links': 0, 'metadata': 0}

    def strip_actions(obj):
        n = 0
        for key in ('/AA', '/OpenAction'):
            if key in obj:
                del obj[key]
                n += 1
        return n

    if opts.get('javascript', True):
        names = root.get('/Names')
        if names is not None and '/JavaScript' in names:
            del names['/JavaScript']
            removed['javascript'] += 1
        removed['javascript'] += strip_actions(root)
        acro = root.get('/AcroForm')
        if acro is not None and '/XFA' in acro:
            del acro['/XFA']
            removed['javascript'] += 1
    for page in pdf.pages:
        if opts.get('javascript', True):
            removed['javascript'] += strip_actions(page.obj)
        annots = page.obj.get('/Annots')
        if annots is None:
            continue
        keep = pikepdf.Array()
        for a in annots:
            sub = str(a.get('/Subtype', ''))
            action = a.get('/A')
            atype = str(action.get('/S', '')) if action is not None else ''
            if opts.get('attachments', True) and sub == '/FileAttachment':
                removed['attachments'] += 1
                continue
            if opts.get('links') and sub == '/Link' and atype in ('/URI', '/Launch', '/GoToR', '/SubmitForm'):
                removed['links'] += 1
                continue
            if opts.get('javascript', True):
                if atype in ('/JavaScript', '/Launch'):
                    del a['/A']
                    removed['javascript'] += 1
                removed['javascript'] += strip_actions(a)
            keep.append(a)
        page.obj['/Annots'] = keep
    if opts.get('attachments', True):
        names = root.get('/Names')
        if names is not None and '/EmbeddedFiles' in names:
            del names['/EmbeddedFiles']
            removed['attachments'] += 1
    if opts.get('metadata', True):
        if '/Metadata' in root:
            del root['/Metadata']
            removed['metadata'] += 1
        if pdf.trailer.get('/Info') is not None:
            del pdf.trailer['/Info']
            removed['metadata'] += 1
    out = os.path.join(out_dir, 'limpo.pdf')
    pdf.remove_unreferenced_resources()
    pdf.save(out, object_stream_mode=pikepdf.ObjectStreamMode.generate)
    return out, removed


def tool_blank(src, out_dir, opts, doc):
    # Sensibilidade 1-10: fração máxima de "tinta" para considerar em branco
    sens = num(opts, 'sensitivity', 5, 1, 10)
    max_ink = 0.0003 * sens ** 2  # 5 -> 0,75% da página
    keep, removed = [], []
    for i, page in enumerate(doc):
        if page.get_text().strip():
            keep.append(i)
            continue
        pix = page.get_pixmap(dpi=40, colorspace=fitz.csGRAY)
        samples = pix.samples
        dark = sum(1 for b in samples if b < 200)
        (removed if dark / max(len(samples), 1) <= max_ink else keep).append(i)
    if not removed:
        raise UserError('Nenhuma página em branco encontrada. Esse PDF é mais cheio que o seu ódio.')
    if not keep:
        raise UserError('Todas as páginas parecem em branco. Diminua a sensibilidade.')
    new = fitz.open()
    for i in keep:
        new.insert_pdf(doc, from_page=i, to_page=i)
    out = os.path.join(out_dir, 'sem_brancas.pdf')
    save_doc(new, out)
    return out, {'removed': len(removed), 'removedPages': [i + 1 for i in removed], 'pages': len(keep)}


def tool_images(src, out_dir, opts, doc):
    min_px = int(num(opts, 'minSize', 64, 1, 5000))
    seen, paths = set(), []
    for pno, page in enumerate(doc):
        for img in page.get_images(full=True):
            xref = img[0]
            if xref in seen:
                continue
            seen.add(xref)
            try:
                info = doc.extract_image(xref)
            except Exception:
                continue
            if not info or info.get('width', 0) < min_px or info.get('height', 0) < min_px:
                continue
            path = os.path.join(out_dir, 'pag{0:03d}_img{1}.{2}'.format(pno + 1, len(paths) + 1, info['ext']))
            with open(path, 'wb') as fh:
                fh.write(info['image'])
            paths.append(path)
    if not paths:
        raise UserError('Nenhuma imagem (do tamanho mínimo) dentro desse PDF.')
    out = os.path.join(out_dir, 'imagens.zip')
    zip_files(paths, out)
    return out, {'images': len(paths)}


def tool_flatten(src, out_dir, opts, doc):
    doc.bake(annots=True, widgets=True)
    out = os.path.join(out_dir, 'achatado.pdf')
    save_doc(doc, out)
    return out, {'pages': doc.page_count}


def tool_metadata(src, out_dir, opts, doc):
    if opts.get('clear'):
        doc.set_metadata({})
        doc.del_xml_metadata()
    else:
        meta = dict(doc.metadata or {})
        for key in ('title', 'author', 'subject', 'keywords'):
            if key in opts:
                meta[key] = str(opts[key])[:500]
        meta['producer'] = 'I HATE PDF'
        doc.set_metadata(meta)
    out = os.path.join(out_dir, 'metadados.pdf')
    save_doc(doc, out)
    return out, {'metadata': {k: v for k, v in (doc.metadata or {}).items() if v}}


def tool_nup(src, out_dir, opts, doc):
    per = int(opts.get('perSheet', 2))
    if per not in (2, 4, 6, 9):
        raise UserError('Quantidade por folha inválida.')
    cols, rows = {2: (2, 1), 4: (2, 2), 6: (2, 3), 9: (3, 3)}[per]
    a4 = fitz.paper_rect('a4')
    sheet = fitz.Rect(0, 0, a4.height, a4.width) if per == 2 else a4
    margin = 14
    cw = (sheet.width - margin * (cols + 1)) / cols
    ch = (sheet.height - margin * (rows + 1)) / rows
    new = fitz.open()
    for i in range(doc.page_count):
        slot = i % per
        if slot == 0:
            out_page = new.new_page(width=sheet.width, height=sheet.height)
        c, r = slot % cols, slot // cols
        x0 = margin + c * (cw + margin)
        y0 = margin + r * (ch + margin)
        out_page.show_pdf_page(fitz.Rect(x0, y0, x0 + cw, y0 + ch), doc, i)
    out = os.path.join(out_dir, 'varias_por_folha.pdf')
    save_doc(new, out)
    return out, {'sheets': new.page_count}


REDACT_PRESETS = {
    'cpf': r'\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b',
    'cnpj': r'\b\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}\b',
    'email': r'\b[\w.+-]+@[\w-]+\.[\w.-]+\b',
    'phone': r'\(?\b\d{2}\)?\s?9?\d{4}-?\d{4}\b',
}


def tool_redact(src, out_dir, opts, doc):
    terms = [t.strip() for t in re.split(r'[\n,;]+', opts.get('terms', '')) if t.strip()]
    patterns = [re.compile(REDACT_PRESETS[p]) for p in opts.get('presets', []) if p in REDACT_PRESETS]
    if not terms and not patterns:
        raise UserError('Diga o que tarjar: palavras ou um dos modelos (CPF, CNPJ...).')
    hits = 0
    for page in doc:
        rects = []
        for term in terms:
            rects += page.search_for(term)
        if patterns:
            text = page.get_text()
            found = {m.group(0) for p in patterns for m in p.finditer(text)}
            for value in found:
                rects += page.search_for(value)
        for r in rects:
            page.add_redact_annot(r, fill=(0, 0, 0))
        if rects:
            # Remove de verdade o texto (e pedaços de imagem) sob a tarja
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_PIXELS)
            hits += len(rects)
    if not hits:
        raise UserError('Não achei nada disso no texto do PDF (se for escaneado, passe o OCR antes).')
    out = os.path.join(out_dir, 'tarjado.pdf')
    doc.set_metadata({})
    doc.del_xml_metadata()
    save_doc(doc, out)
    return out, {'redactions': hits}


TOOLS = {
    'split': tool_split,
    'organize': tool_organize,
    'rotate': tool_rotate,
    'unlock': tool_unlock,
    'protect': tool_protect,
    'watermark': tool_watermark,
    'pagenumbers': tool_pagenumbers,
    'ocr': tool_ocr,
    'sanitize': tool_sanitize,
    'blank': tool_blank,
    'images': tool_images,
    'flatten': tool_flatten,
    'metadata': tool_metadata,
    'nup': tool_nup,
    'redact': tool_redact,
}

# Ferramentas que conseguem abrir PDF com senha por conta própria
OWN_PASSWORD = {'unlock', 'protect'}


def main():
    real_stdout, sys.stdout = sys.stdout, sys.stderr
    if len(sys.argv) < 5 or sys.argv[1] not in TOOLS:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    tool, src, out_dir, opts_path = sys.argv[1:5]
    with open(opts_path, encoding='utf-8') as fh:
        opts = json.load(fh)
    try:
        doc = None
        if tool not in OWN_PASSWORD:
            doc = fitz.open(src)
            if doc.needs_pass and not doc.authenticate(opts.get('password', '') or ''):
                print('PDF protegido por senha.', file=sys.stderr)
                sys.exit(3)
        out, stats = TOOLS[tool](src, out_dir, opts, doc)
    except UserError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(5)
    ext = os.path.splitext(out)[1].lstrip('.')
    print(json.dumps(dict(stats, file=os.path.basename(out), ext=ext), ensure_ascii=False), file=real_stdout)


if __name__ == '__main__':
    main()
