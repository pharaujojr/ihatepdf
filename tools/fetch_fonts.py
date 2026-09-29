#!/usr/bin/env python3
"""Baixa as fontes do Google Fonts (licenças OFL/Apache, livres para
redistribuir) para public/fonts/web/ e gera public/fonts/catalog.json.

As fontes "padrão" (equivalentes livres das do Office: Liberation =
Arial/Times/Courier, Carlito = Calibri, Caladea = Cambria, DejaVu) vêm dos
pacotes do Debian e são copiadas para public/fonts/sys/ no Dockerfile.

Uso (só quando quiser atualizar a coleção): python3 tools/fetch_fonts.py
"""
import json
import os
import re
import urllib.parse
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'fonts')
WEB_DIR = os.path.join(ROOT, 'web')

# (nome, categoria, tem negrito/itálico?)
GOOGLE = [
    ('Roboto', 'sans', True), ('Open Sans', 'sans', True), ('Lato', 'sans', True),
    ('Montserrat', 'sans', True), ('Poppins', 'sans', True), ('Inter', 'sans', True),
    ('Nunito', 'sans', True), ('Raleway', 'sans', True), ('Source Sans 3', 'sans', True),
    ('Noto Sans', 'sans', True), ('Work Sans', 'sans', True), ('Ubuntu', 'sans', True),
    ('Merriweather', 'serif', True), ('Playfair Display', 'serif', True), ('Lora', 'serif', True),
    ('PT Serif', 'serif', True), ('EB Garamond', 'serif', True), ('Noto Serif', 'serif', True),
    ('Libre Baskerville', 'serif', False),
    ('Roboto Mono', 'mono', True), ('Source Code Pro', 'mono', True), ('JetBrains Mono', 'mono', True),
    ('Oswald', 'display', False), ('Bebas Neue', 'display', False), ('Anton', 'display', False),
    ('Lobster', 'display', False), ('Permanent Marker', 'display', False), ('Abril Fatface', 'display', False),
    ('Dancing Script', 'script', False), ('Great Vibes', 'script', False), ('Caveat', 'script', False),
    ('Pacifico', 'script', False), ('Satisfy', 'script', False), ('Allura', 'script', False),
    ('Homemade Apple', 'script', False), ('Sacramento', 'script', False),
]

SYSTEM = [
    # key, nome, categoria, arquivos (sys/), apelidos de fontes que ela substitui
    ('liberation-sans', 'Arial (Liberation Sans)', 'padrao', 'LiberationSans', ['arial', 'helvetica', 'microsoftsansserif', 'sansserif', 'verdana', 'tahoma', 'segoe']),
    ('liberation-serif', 'Times New Roman (Liberation Serif)', 'padrao', 'LiberationSerif', ['times', 'timesnewroman', 'georgia', 'garamond', 'bookantiqua', 'serif']),
    ('liberation-mono', 'Courier New (Liberation Mono)', 'padrao', 'LiberationMono', ['courier', 'couriernew', 'consolas', 'lucidaconsole', 'mono']),
    ('liberation-narrow', 'Arial Narrow (Liberation Sans Narrow)', 'padrao', 'LiberationSansNarrow', ['arialnarrow', 'narrow', 'condensed']),
    ('carlito', 'Calibri (Carlito)', 'padrao', 'Carlito', ['calibri']),
    ('caladea', 'Cambria (Caladea)', 'padrao', 'Caladea', ['cambria']),
    ('dejavu-sans', 'DejaVu Sans', 'padrao', 'DejaVuSans', ['dejavusans']),
    ('dejavu-serif', 'DejaVu Serif', 'padrao', 'DejaVuSerif', ['dejavuserif']),
]
SYSTEM_STYLES = {
    'LiberationSans': ('Regular', 'Bold', 'Italic', 'BoldItalic'),
    'LiberationSerif': ('Regular', 'Bold', 'Italic', 'BoldItalic'),
    'LiberationMono': ('Regular', 'Bold', 'Italic', 'BoldItalic'),
    'LiberationSansNarrow': ('Regular', 'Bold', 'Italic', 'BoldItalic'),
    'Carlito': ('Regular', 'Bold', 'Italic', 'BoldItalic'),
    'Caladea': ('Regular', 'Bold', 'Italic', 'BoldItalic'),
    'DejaVuSans': ('', 'Bold', 'Oblique', 'BoldOblique'),
    'DejaVuSerif': ('', 'Bold', 'Italic', 'BoldItalic'),
}


def slug(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')


def download_family(name, styled):
    spec = 'ital,wght@0,400;0,700;1,400;1,700' if styled else ''
    family = urllib.parse.quote_plus(name) + (':' + spec if spec else '')
    css = urllib.request.urlopen('https://fonts.googleapis.com/css2?family=' + family, timeout=30).read().decode()
    files = {}
    for block in css.split('@font-face')[1:]:
        style = re.search(r'font-style:\s*(\w+)', block).group(1)
        weight = re.search(r'font-weight:\s*(\d+)', block).group(1)
        url = re.search(r'url\((https://[^)]+\.ttf)\)', block).group(1)
        key = ('bold' if weight == '700' else 'regular') + ('italic' if style == 'italic' else '')
        key = {'regularitalic': 'italic'}.get(key, key)
        fname = '{0}-{1}.ttf'.format(slug(name), key)
        path = os.path.join(WEB_DIR, fname)
        if not os.path.exists(path):
            with open(path, 'wb') as fh:
                fh.write(urllib.request.urlopen(url, timeout=60).read())
        files[key] = 'web/' + fname
    return files


def main():
    os.makedirs(WEB_DIR, exist_ok=True)
    fonts = []
    for key, name, cat, base, aliases in SYSTEM:
        r, b, i, bi = SYSTEM_STYLES[base]
        f = lambda s: 'sys/{0}{1}.ttf'.format(base, '-' + s if s else '')
        fonts.append({'key': key, 'name': name, 'category': cat, 'aliases': aliases,
                      'files': {'regular': f(r), 'bold': f(b), 'italic': f(i), 'bolditalic': f(bi)}})
    for name, cat, styled in GOOGLE:
        print('baixando', name)
        files = download_family(name, styled)
        fonts.append({'key': slug(name), 'name': name, 'category': cat, 'aliases': [slug(name).replace('-', '')],
                      'files': files})
    with open(os.path.join(ROOT, 'catalog.json'), 'w', encoding='utf-8') as fh:
        json.dump({'categories': {
            'padrao': 'Padrão (compatíveis com Office)', 'sans': 'Sem serifa', 'serif': 'Com serifa',
            'mono': 'Monoespaçadas', 'display': 'Títulos', 'script': 'Manuscritas e assinatura'},
            'fonts': fonts}, fh, ensure_ascii=False, indent=1)
    print(len(fonts), 'fontes no catálogo')


if __name__ == '__main__':
    main()
