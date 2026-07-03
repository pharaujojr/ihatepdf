#!/usr/bin/env python3
"""
Merge PDFs with optional paper size normalization using Form XObjects.

Each source page is embedded as an opaque Form XObject in a new page of the
target size. Font streams and encoding tables are copied verbatim — nothing is
re-interpreted or re-rendered by a PostScript/PDF engine.

Usage: merge_pdf.py <output> <papersize|passthrough> <input1> [input2 ...]
"""

import sys
import pikepdf
from pikepdf import Dictionary, Name, Array

PAPER_SIZES = {
    'a3':        (842,  1191),
    'a4':        (595,   842),
    'a5':        (420,   595),
    'letter':    (612,   792),
    'legal':     (612,  1008),
    'tabloid':   (792,  1224),
    'executive': (522,   756),
    'b5':        (499,   709),
}

def _rotation_matrix(rot, w, h):
    """CTM to undo page-level /Rotate when embedding as Form XObject."""
    if rot == 90:
        return Array([0, 1, -1, 0, h, 0])
    if rot == 180:
        return Array([-1, 0, 0, -1, w, h])
    if rot == 270:
        return Array([0, -1, 1, 0, 0, w])
    return None


def _read_contents(page_obj):
    """Decoded bytes from all content streams of a page (already in target PDF)."""
    if '/Contents' not in page_obj:
        return b''
    contents = page_obj['/Contents']
    if isinstance(contents, pikepdf.Array):
        parts = []
        for ref in contents:
            parts.append(ref.read_bytes())
            parts.append(b'\n')
        return b''.join(parts)
    return contents.read_bytes()


def merge(input_paths, output_path, paper_size):
    target = PAPER_SIZES.get(paper_size)   # None → passthrough (keep original size)

    out = pikepdf.new()

    for path in input_paths:
        with pikepdf.open(path) as src:
            for src_page in src.pages:
                # Page objects are always indirect in PDF, so copy_foreign works directly.
                # This pulls the page AND all its transitive dependencies (fonts, images,
                # colour spaces…) into `out` with correct object numbering.
                page_copy = out.copy_foreign(src_page.obj)

                # Dimensions from the source (before the copy, while src is still open)
                mb = src_page.mediabox
                x0, y0, x1, y1 = (float(mb[i]) for i in range(4))
                src_w, src_h = x1 - x0, y1 - y0

                rot = int(src_page.obj.get('/Rotate', 0)) % 360
                vis_w, vis_h = (src_h, src_w) if rot in (90, 270) else (src_w, src_h)

                if target is None:
                    pw, ph = vis_w, vis_h
                else:
                    tw, th = target
                    pw, ph = (float(th), float(tw)) if (vis_w > vis_h) != (tw > th) else (float(tw), float(th))

                scale = min(pw / vis_w, ph / vis_h) if target else 1.0
                tx = (pw - vis_w * scale) / 2
                ty = (ph - vis_h * scale) / 2

                # Build Form XObject from the already-copied page data.
                # Resources are now in `out`, so no further copy_foreign needed.
                content_bytes = _read_contents(page_copy)
                res = page_copy.get('/Resources', Dictionary())

                xobj = out.make_stream(content_bytes)
                xobj['/Type']      = Name('/XObject')
                xobj['/Subtype']   = Name('/Form')
                xobj['/FormType']  = 1
                xobj['/BBox']      = Array([x0, y0, x1, y1])
                xobj['/Resources'] = res

                rmat = _rotation_matrix(rot, src_w, src_h)
                if rmat is not None:
                    xobj['/Matrix'] = rmat

                xobj_ref = out.make_indirect(xobj)

                ops = (
                    f'q {scale:.6f} 0 0 {scale:.6f} {tx:.6f} {ty:.6f} cm /Xp Do Q'
                ).encode()

                new_page = out.make_indirect(Dictionary(
                    Type=Name.Page,
                    MediaBox=Array([0, 0, pw, ph]),
                    Resources=Dictionary(XObject=Dictionary(Xp=xobj_ref)),
                    Contents=out.make_stream(ops),
                ))
                out.pages.append(pikepdf.Page(new_page))

    out.save(output_path)


if __name__ == '__main__':
    if len(sys.argv) < 4:
        print('Usage: merge_pdf.py <output> <papersize|passthrough> <input1> [input2 ...]',
              file=sys.stderr)
        sys.exit(1)

    merge(sys.argv[3:], sys.argv[1], sys.argv[2])
