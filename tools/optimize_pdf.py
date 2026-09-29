#!/usr/bin/env python3
"""Otimização sem perdas de um PDF (pós-Ghostscript ou no original).

- Remove lixo que não aparece na tela: miniaturas de página (/Thumb),
  dados privados de aplicativos (/PieceInfo) e metadados XMP.
- Remove recursos não referenciados pelas páginas.
- Recomprime os streams Flate no nível máximo e empacota os objetos em
  object streams (xref comprimida).

Uso: optimize_pdf.py <entrada.pdf> <saida.pdf>
"""
import sys

import pikepdf


def main():
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    src, dst = sys.argv[1], sys.argv[2]
    pikepdf.settings.set_flate_compression_level(9)
    with pikepdf.open(src) as pdf:
        root = pdf.Root
        for key in ('/PieceInfo', '/Metadata'):
            if key in root:
                del root[key]
        for page in pdf.pages:
            for key in ('/Thumb', '/PieceInfo'):
                if key in page.obj:
                    del page.obj[key]
        try:
            pdf.remove_unreferenced_resources()
        except Exception:
            pass
        pdf.save(
            dst,
            compress_streams=True,
            recompress_flate=True,
            object_stream_mode=pikepdf.ObjectStreamMode.generate,
        )


if __name__ == '__main__':
    main()
