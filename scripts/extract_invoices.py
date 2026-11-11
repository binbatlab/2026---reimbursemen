# -*- coding: utf-8 -*-
"""把发票 PDF 批量转成文本 JSON（供 invoice_parse.py 使用）
用法:
    python extract_invoices.py [pdf目录] [输出json]
默认:
    pdf目录   ./invoices/raw
    输出      ./invoices/raw/texts.json
"""
import sys
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass
import os
import io
import glob
import json

try:
    from pypdf import PdfReader
except ImportError:
    print("缺少 pypdf：请用 skill 自带的 runtime\\python\\python.exe 运行，或 pip install pypdf", file=sys.stderr)
    raise SystemExit(2)


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join("invoices", "raw")
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join("invoices", "raw", "texts.json")

    files = sorted(glob.glob(os.path.join(src, "**", "*.pdf"), recursive=True))
    if not files:
        print(f"在 {src} 下没找到 PDF", file=sys.stderr)
        return 1

    texts = {}
    for f in files:
        name = os.path.basename(f)
        try:
            reader = PdfReader(f)
            text = "\n".join((p.extract_text() or "") for p in reader.pages)
        except Exception as e:  # noqa: BLE001
            text = f"ERR {e}"
        texts[name] = text
        print(f"  {name:48s} {len(text):5d} 字符")

    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with io.open(out, "w", encoding="utf-8") as fh:
        json.dump(texts, fh, ensure_ascii=False, indent=1)
    print(f"\n共 {len(files)} 个 PDF -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
