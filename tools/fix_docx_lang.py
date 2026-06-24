#!/usr/bin/env python3
"""Ajusta o idioma de um .docx gerado pelo pdf2docx.

O pdf2docx grava sempre w:lang w:val="en-US" no docDefaults do styles.xml,
o que faz o Word marcar o documento inteiro como Inglês (EUA). Este script
detecta o idioma a partir do texto do PDF de origem e reescreve esse valor
para a língua correta. Best-effort: qualquer falha mantém o arquivo intacto.

Uso: fix_docx_lang.py <saida.docx> <origem.pdf>
"""
import os
import re
import sys
import zipfile

# Mapeia o código do langdetect para um locale do Word (BCP-47)
LOCALE = {
    'pt': 'pt-BR', 'en': 'en-US', 'es': 'es-ES', 'fr': 'fr-FR',
    'de': 'de-DE', 'it': 'it-IT', 'nl': 'nl-NL', 'ru': 'ru-RU',
    'pl': 'pl-PL', 'sv': 'sv-SE', 'da': 'da-DK', 'no': 'nb-NO',
    'fi': 'fi-FI', 'tr': 'tr-TR', 'cs': 'cs-CZ', 'ja': 'ja-JP',
    'ko': 'ko-KR', 'zh-cn': 'zh-CN', 'zh-tw': 'zh-TW', 'ar': 'ar-SA',
    'he': 'he-IL', 'el': 'el-GR', 'ro': 'ro-RO', 'hu': 'hu-HU',
    'uk': 'uk-UA', 'ca': 'ca-ES', 'bg': 'bg-BG', 'hr': 'hr-HR',
    'sk': 'sk-SK', 'sl': 'sl-SI', 'et': 'et-EE', 'lt': 'lt-LT',
    'lv': 'lv-LV', 'id': 'id-ID', 'vi': 'vi-VN', 'th': 'th-TH',
}
# Sem texto detectável (ex.: PDF digitalizado), assume a língua mais provável
# do público desta aplicação.
FALLBACK = 'pt-BR'


def get_text_from_pdf(pdf_path):
    try:
        import fitz  # PyMuPDF (já é dependência do pdf2docx)
        doc = fitz.open(pdf_path)
        chunks = []
        total = 0
        for page in doc:
            t = page.get_text()
            chunks.append(t)
            total += len(t)
            if total > 4000:
                break
        return "\n".join(chunks)
    except Exception:
        return ""


def detect_locale(text):
    try:
        from langdetect import detect, DetectorFactory
        DetectorFactory.seed = 0
        code = detect(text).lower()
    except Exception:
        return None
    if code in LOCALE:
        return LOCALE[code]
    base = code.split('-')[0]
    if base in LOCALE:
        return LOCALE[base]
    return "{0}-{1}".format(base, base.upper())


def set_lang(docx_path, locale):
    tmp = docx_path + ".tmp"
    changed = False
    with zipfile.ZipFile(docx_path) as zin, \
         zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == 'word/styles.xml':
                xml = data.decode('utf-8', 'ignore')
                # troca o w:val do primeiro <w:lang ...> (o do docDefaults)
                new_xml, n = re.subn(
                    r'(<w:lang\b[^>]*?\bw:val=")[^"]*(")',
                    lambda m: m.group(1) + locale + m.group(2),
                    xml, count=1)
                if n:
                    data = new_xml.encode('utf-8')
                    changed = True
            zout.writestr(item, data)
    if changed:
        os.replace(tmp, docx_path)
    else:
        os.remove(tmp)


def main():
    if len(sys.argv) < 3:
        return
    docx_path, pdf_path = sys.argv[1], sys.argv[2]
    if not os.path.isfile(docx_path):
        return
    text = get_text_from_pdf(pdf_path)
    locale = detect_locale(text) if text and text.strip() else None
    if not locale:
        locale = FALLBACK
    try:
        set_lang(docx_path, locale)
    except Exception:
        pass


if __name__ == '__main__':
    main()
