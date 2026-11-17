# -*- coding: utf-8 -*-
"""
slides-extract.py —— 把课件（PDF / PPTX / DOCX）提成纯文本 + 每页标题清单

设计原则：**能机械提取的绝不交给模型**——避免幻觉。
  本脚本只做：取文字、取每页首行当「幻灯片标题」、数每页字数与图片数。
  课程地图的骨架（每讲页范围 + 每页标题）就由这些机械数据拼出来。

用法：
  python slides-extract.py "课件\\某课程\\xx.pdf"                 # 单个文件
  python slides-extract.py "课件\\某课程"                          # 目录（递归取全部支持格式）

产物（与输入同目录，或 --out 指定）：
  _文本.txt      每页用 === p<N> === 分隔的全文（给模型/人看）
  _pages.json    [{n, chars, images, title}, ...]（给 read-slides.js 拼地图）
"""
import io
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

SUPPORT = (".pdf", ".pptx", ".docx")


FOOTER = re.compile(r"^(KR\s*∧?\s*R\b|—|–|-{2,}|\d+$)")
# 首行以这些词/符号结尾 → 标题还没写完，下一行是它的续行（而不是第一条 bullet）
CONT = re.compile(r"\b(to|of|the|a|an|and|or|in|on|for|with|vs|as|by|from|at|into|using|about)$", re.I)
BULLET = re.compile(r"^[•·▪‣·\-–—*]\s*")


def title_of(text):
    """每页第一行通常就是幻灯片标题（Beamer 尤其如此）。
    frame title 折行时，**只有首行看起来没写完**才把下一行并进来——
    否则会把标题和第一条 bullet 粘在一起（这个坑踩过一次）。"""
    lines = [l.strip() for l in (text or "").split("\n") if len(l.strip()) >= 2]
    if not lines:
        return ""
    t = lines[0]
    if len(t) < 44 and len(lines) > 1:
        nxt = lines[1]
        if not FOOTER.match(nxt) and not BULLET.match(nxt):
            if CONT.search(t) or t.endswith((":", ",")) or re.match(r"^[a-z(]", nxt):
                t = t + " " + nxt
    return t[:120]


def from_pdf(path):
    import pdfplumber
    pages = []
    with pdfplumber.open(path) as pdf:
        for i, page in enumerate(pdf.pages):
            t = (page.extract_text() or "").strip()
            pages.append({"n": i + 1, "chars": len(t),
                          "images": len(page.images or []), "title": title_of(t), "text": t})
    return pages


def from_pptx(path):
    from pptx import Presentation
    prs = Presentation(path)
    pages = []
    for i, slide in enumerate(prs.slides):
        buf = []
        for shape in slide.shapes:
            if shape.has_text_frame and shape.text_frame.text.strip():
                buf.append(shape.text_frame.text.strip())
        t = "\n".join(buf).strip()
        pages.append({"n": i + 1, "chars": len(t), "images": 0, "title": title_of(t), "text": t})
    return pages


def from_docx(path):
    import docx
    d = docx.Document(path)
    paras = [p.text.strip() for p in d.paragraphs]
    t = "\n".join([p for p in paras if p])
    # docx 没有「页」的概念，按 2000 字符切块，方便和幻灯片口径统一
    chunks = [t[i:i + 2000] for i in range(0, len(t), 2000)] or [""]
    return [{"n": i + 1, "chars": len(c), "images": 0, "title": title_of(c), "text": c}
            for i, c in enumerate(chunks)]


def extract(path):
    low = path.lower()
    if low.endswith(".pdf"):
        return from_pdf(path)
    if low.endswith(".pptx"):
        return from_pptx(path)
    if low.endswith(".docx"):
        return from_docx(path)
    raise ValueError("不支持：%s（支持 %s）" % (path, ", ".join(SUPPORT)))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    outdir = None
    if "--out" in sys.argv:
        outdir = sys.argv[sys.argv.index("--out") + 1]
    if not args:
        print("用法：python slides-extract.py <文件或目录> [--out 目录]")
        return 10
    target = os.path.abspath(args[0])
    if not os.path.exists(target):
        print("[X] 找不到：%s" % target)
        return 10

    files = []
    if os.path.isdir(target):
        for root, _dirs, names in os.walk(target):
            for n in sorted(names):
                if n.lower().endswith(SUPPORT) and not n.startswith("_"):
                    files.append(os.path.join(root, n))
    else:
        files = [target]
    if not files:
        print("[!] 目录里没有 %s 文件" % ", ".join(SUPPORT))
        return 10

    summary = []
    for f in files:
        try:
            pages = extract(f)
        except Exception as e:
            print("[X] %s 提取失败：%s" % (os.path.basename(f), e))
            continue
        d = outdir or os.path.dirname(f)
        if not os.path.isdir(d):
            os.makedirs(d, exist_ok=True)
        stem = os.path.splitext(os.path.basename(f))[0]
        txt_path = os.path.join(d, stem + "_文本.txt")
        json_path = os.path.join(d, stem + "_pages.json")
        with io.open(txt_path, "w", encoding="utf-8") as fp:
            for p in pages:
                fp.write("=== p%d ===\n%s\n\n" % (p["n"], p["text"]))
        with io.open(json_path, "w", encoding="utf-8") as fp:
            json.dump([{k: v for k, v in p.items() if k != "text"} for p in pages],
                      fp, ensure_ascii=False, indent=1)
        total = sum(p["chars"] for p in pages)
        empty = [p["n"] for p in pages if p["chars"] < 20]
        summary.append((os.path.basename(f), len(pages), total, empty, txt_path, json_path))

    print("== 提取完成 ==")
    for name, npages, total, empty, tp, jp in summary:
        print("  %s" % name)
        print("    页数 %d｜文字 %d 字符｜几乎无文字的页 %s" % (npages, total, empty if empty else "无"))
        print("    文本 → %s" % tp)
        print("    页清单 → %s" % jp)
    return 0


if __name__ == "__main__":
    sys.exit(main())
