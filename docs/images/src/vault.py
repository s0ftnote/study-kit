"""学习库效果图：在 Obsidian 里打开学习库的样子（文件树、一页知识点、关系图谱）。

用法：python3 docs/images/src/vault.py docs/images/vault.svg
示例内容是虚构的（计数入门 P3、练习卷 A），格式照 skills/study-wiki/assets/学习库模板/库规则.md。
库规则的模板变了，这里的示例页跟着改。
"""
import random
import sys

W, H = 1280, 900
BG, WIN, SIDE, PANEL, LINE = "#0f172a", "#1e1e2e", "#181825", "#1b1b2b", "#313244"
INK, SUB, MUTE = "#e2e8f0", "#a6adc8", "#6c7086"
SRC, KNOW, PRAC, LINK, REC = "#58a6ff", "#bc8cff", "#f59e0b", "#b4a5ff", "#34d399"
CJK = "'PingFang SC','Noto Sans CJK SC','Microsoft YaHei',sans-serif"
MONO = "'SF Mono',Menlo,Consolas,monospace"
CYCLE = 8.0

out, css = [], []


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def text(x, y, s, size=14, color=INK, weight=400, anchor="start", font=CJK):
    return (f'<text x="{x:.0f}" y="{y:.0f}" font-family="{font}" font-size="{size}" font-weight="{weight}" '
            f'fill="{color}" text-anchor="{anchor}">{esc(s)}</text>')


def tw(s, size):
    """粗估文字宽度：中文一个字号宽，其余半个多。"""
    return sum(size if ord(ch) > 0x2E80 else size * 0.58 for ch in s)


def pulse(cls, i, n):
    """n 个高亮轮流亮，第 i 个占第 i 段。"""
    a, b = 100 * i / n, 100 * (i + 1) / n
    css.append(f".{cls}{{animation:{cls} {CYCLE}s ease-in-out infinite}}"
               f"@keyframes {cls}{{0%,{max(a - 0.01, 0):.2f}%{{opacity:0}}{a + 3:.2f}%,{b - 4:.2f}%{{opacity:1}}"
               f"{b:.2f}%,100%{{opacity:0}}}}")


# ---- 标题 ----
out.append(text(W / 2, 52, "学习库在 Obsidian 里的样子", 30, "#f8fafc", 700, "middle"))
out.append(text(W / 2, 80, "一个文件夹，三个区；每页是带双链的 Markdown，链起来就是知识图谱", 15, "#cbd5e1", 500, "middle"))

# ---- 窗口 ----
X0, Y0, WW, WH = 40, 104, 1200, 640
out.append(f'<rect x="{X0}" y="{Y0}" width="{WW}" height="{WH}" rx="12" fill="{WIN}" stroke="{LINE}" stroke-width="1.5"/>')
for i, c in enumerate(("#f38ba8", "#f9e2af", "#a6e3a1")):
    out.append(f'<circle cx="{X0 + 20 + i * 18}" cy="{Y0 + 18}" r="6" fill="{c}" fill-opacity="0.8"/>')
out.append(text(X0 + WW / 2, Y0 + 23, "学习库 — 知识/数学/知识点/抽屉原理.md", 13, MUTE, 400, "middle"))

# ---- 左栏：文件树 ----
SX, SW = X0, 268
out.append(f'<path d="M {SX} {Y0 + 36} H {SX + SW} V {Y0 + WH} H {SX + 12} Q {SX} {Y0 + WH} {SX} {Y0 + WH - 12} Z" fill="{SIDE}"/>')
out.append(f'<path d="M {X0} {Y0 + 36} H {X0 + WW}" stroke="{LINE}"/>')
TREE = [
    (0, "学习库", "root"),
    (1, "库规则.md", "file"), (1, "首页.md", "file"), (1, "日志.md", "file"),
    (1, "资料", SRC), (2, "视频", "dir"), (3, "BV1xx411c7mD-123456", "dir"), (2, "试卷", "dir"),
    (1, "知识", KNOW), (2, "数学", "dir"), (3, "数学总览.md", "file"), (3, "数学导图.canvas", "file"),
    (3, "来源", "dir"), (4, "计数入门 P3 抽屉原理", "file"),
    (3, "知识点", "dir"), (4, "抽屉原理", "active"), (4, "最不利原则", "file"), (4, "乘法原理", "file"),
    (3, "题目", "dir"), (4, "练习卷A-12", "file"), (4, "计数入门P3-例1", "file"),
    (1, "练习", PRAC), (2, "进度.md", "file"), (2, "错题本.md", "file"), (2, "记录", "dir"),
]
STEP = 23.2
ty = Y0 + 64
zone_y = {}
for depth, name, kind in TREE:
    x = SX + 16 + depth * 16
    if kind == "active":
        out.append(f'<rect x="{SX + 8}" y="{ty - 16}" width="{SW - 16}" height="23" rx="5" fill="{KNOW}" fill-opacity="0.2"/>')
    if kind == "root":
        out.append(text(x, ty, name, 14, INK, 700))
    elif kind in (SRC, KNOW, PRAC):
        zone_y[kind] = ty
        out.append(f'<rect x="{x}" y="{ty - 11}" width="12" height="10" rx="2" fill="{kind}"/>')
        out.append(text(x + 18, ty, name + "/", 14, kind, 700))
    elif kind == "dir":
        out.append(text(x, ty, "▾", 11, MUTE))
        out.append(text(x + 14, ty, name, 13.5, SUB))
    else:
        out.append(text(x + 14, ty, name, 13.5, INK if kind == "active" else SUB, 600 if kind == "active" else 400))
    ty += STEP
for col, note in ((SRC, "原件，保持原样"), (KNOW, "AI 整理"), (PRAC, "作答和进度")):
    out.append(text(SX + SW - 14, zone_y[col], note, 11.5, col, 500, "end"))

# ---- 中栏：一页知识点 ----
EX, EW = SX + SW, 560
out.append(f'<rect x="{EX}" y="{Y0 + 37}" width="{EW}" height="32" fill="{SIDE}"/>')
out.append(f'<rect x="{EX + 10}" y="{Y0 + 41}" width="110" height="28" rx="6" fill="{WIN}"/>')
out.append(text(EX + 24, Y0 + 60, "抽屉原理", 13, INK, 600))
out.append(f'<path d="M {EX} {Y0 + 36} V {Y0 + WH}" stroke="{LINE}"/>')
ex, ey = EX + 36, Y0 + 104

out.append(f'<rect x="{ex - 12}" y="{ey - 20}" width="{EW - 50}" height="84" rx="8" fill="{PANEL}" stroke="{LINE}"/>')
for i, (k, v) in enumerate((("类型", "知识点"), ("学科", "数学"), ("aliases", "鸽巢原理"))):
    out.append(text(ex + 2, ey + 2 + i * 24, k, 13, MUTE, 400, font=MONO if k == "aliases" else CJK))
    out.append(f'<rect x="{ex + 96}" y="{ey - 13 + i * 24}" width="{tw(v, 13) + 16:.0f}" height="20" rx="10" fill="{LINE}"/>')
    out.append(text(ex + 104, ey + 2 + i * 24, v, 13, INK))
ey += 104
out.append(text(ex - 4, ey, "抽屉原理", 28, "#f8fafc", 700))
ey += 32
out.append(text(ex - 4, ey, "把多于 n 个东西放进 n 个抽屉，至少有一个抽屉里有两个或更多。", 14.5, SUB))

LINKS = []  # (x, y, 宽, 图谱节点)


def h2(title):
    global ey
    ey += 40
    out.append(text(ex - 4, ey, title, 18, "#f8fafc", 700))
    ey += 6


def bullet(parts, node=None):
    """parts: (文字, 是否链接)。返回这一行结尾的 x。"""
    global ey
    ey += 27
    out.append(f'<circle cx="{ex + 4}" cy="{ey - 5}" r="2.5" fill="{SUB}"/>')
    x = ex + 16
    for s, is_link in parts:
        w = tw(s, 15)
        if is_link:
            if node:
                LINKS.append((x, ey, w, node))
            out.append(text(x, ey, s, 15, LINK, 500))
            out.append(f'<line x1="{x:.0f}" y1="{ey + 4}" x2="{x + w:.0f}" y2="{ey + 4}" stroke="{LINK}" stroke-opacity="0.45"/>')
        else:
            out.append(text(x, ey, s, 15, SUB))
        x += w
    return x


h2("讲解")
ey += 22
out.append(text(ex - 4, ey, "先找出谁是“抽屉”、谁是“苹果”，再按最坏的情况去放。", 14.5, SUB))
h2("例题")
bullet([("练习卷A-12", True), ("：至少取几只袜子才有一双同色", False)], "q12")
h2("出处")
end = bullet([("计数入门 P3 抽屉原理", True)], "src") + 12
out.append(f'<rect x="{end:.0f}" y="{ey - 16}" width="72" height="22" rx="11" fill="{SRC}" fill-opacity="0.18" '
           f'stroke="{SRC}" stroke-opacity="0.6"/>')
out.append(text(end + 36, ey, "▶ 03:20", 12.5, SRC, 600, "middle", MONO))
TIME_XY = (end + 72, ey - 5)
h2("相关")
bullet([("最不利原则", True), ("：经常一起用", False)], "worst")
bullet([("乘法原理", True), ("：要先会这个", False)], "mult")

# ---- 右栏：关系图谱 ----
GX, GW = EX + EW, WW - SW - EW
gy0 = Y0 + 36
out.append(f'<path d="M {GX} {gy0} V {Y0 + WH}" stroke="{LINE}"/>')
out.append(f'<rect x="{GX + 1}" y="{gy0 + 1}" width="{GW - 1}" height="32" fill="{SIDE}"/>')
out.append(text(GX + 18, gy0 + 22, "关系图谱", 13, INK, 600))
cx, cy = GX + GW / 2, gy0 + 270
N = {
    "draw": (cx, cy, "抽屉原理", KNOW, 13),
    "worst": (cx + 112, cy - 92, "最不利原则", KNOW, 9),
    "mult": (cx - 120, cy - 108, "乘法原理", KNOW, 9),
    "src": (cx - 126, cy + 78, "计数入门 P3", SRC, 9),
    "q12": (cx + 112, cy + 92, "练习卷A-12", PRAC, 9),
    "ex1": (cx - 28, cy + 168, "计数入门P3-例1", PRAC, 7),
    "rec": (cx + 128, cy + 196, "11-15 练习记录", REC, 7),
    "ov": (cx + 6, cy - 196, "数学总览", INK, 8),
    "add": (cx - 168, cy - 18, "加法原理", KNOW, 7),
}
EDGES = [("draw", "worst"), ("draw", "mult"), ("draw", "src"), ("draw", "q12"), ("draw", "ex1"),
         ("src", "ex1"), ("q12", "rec"), ("ov", "draw"), ("ov", "worst"), ("ov", "mult"), ("ov", "add"),
         ("mult", "add"), ("worst", "q12")]
random.seed(7)
FAINT = []
while len(FAINT) < 24:
    p = (GX + random.uniform(24, GW - 24), gy0 + random.uniform(60, 470))
    if all((p[0] - x) ** 2 + (p[1] - y) ** 2 > 50 ** 2 for x, y, *_ in N.values()):
        FAINT.append(p)
for i, (x, y) in enumerate(FAINT):
    j = FAINT[(i * 5 + 3) % len(FAINT)]
    out.append(f'<line x1="{x:.0f}" y1="{y:.0f}" x2="{j[0]:.0f}" y2="{j[1]:.0f}" stroke="{MUTE}" stroke-opacity="0.16"/>')
for x, y in FAINT:
    out.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="3" fill="{MUTE}" fill-opacity="0.45"/>')
for a, b in EDGES:
    (x1, y1, *_), (x2, y2, *_) = N[a], N[b]
    hot = "draw" in (a, b)
    out.append(f'<line x1="{x1:.0f}" y1="{y1:.0f}" x2="{x2:.0f}" y2="{y2:.0f}" stroke="{KNOW if hot else MUTE}" '
               f'stroke-opacity="{0.6 if hot else 0.4}" stroke-width="{1.6 if hot else 1.2}"/>')
for k, (x, y, label, col, r) in N.items():
    if k == "draw":
        out.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r + 8}" fill="{col}" fill-opacity="0.15"/>')
    out.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r}" fill="{col}"/>')
    out.append(text(x, y + r + 17, label, 12.5 if k == "draw" else 11.5, INK if k == "draw" else SUB,
                    700 if k == "draw" else 400, "middle"))
ly = Y0 + WH - 58
for i, (lab, col) in enumerate((("知识点", KNOW), ("来源", SRC), ("题目", PRAC), ("练习记录", REC))):
    x = GX + 24 + (i % 2) * 150
    y = ly + (i // 2) * 24
    out.append(f'<circle cx="{x}" cy="{y - 4}" r="5" fill="{col}"/>')
    out.append(text(x + 12, y, lab, 12, SUB))

# 编辑区的链接和图谱里的点轮流高亮：页里链到谁，图谱里就连着谁
for i, (x, y, w, node) in enumerate(LINKS):
    cls = f"hl-{i}"
    nx, ny, _, col, r = N[node]
    dx, dy = N["draw"][0], N["draw"][1]
    out.append(f'<g class="{cls}"><rect x="{x - 4:.0f}" y="{y - 17}" width="{w + 8:.0f}" height="24" rx="5" '
               f'fill="{LINK}" fill-opacity="0.16" stroke="{LINK}" stroke-opacity="0.7"/>'
               f'<line x1="{dx:.0f}" y1="{dy:.0f}" x2="{nx:.0f}" y2="{ny:.0f}" stroke="{col}" stroke-width="3"/>'
               f'<circle cx="{nx:.0f}" cy="{ny:.0f}" r="{r + 7}" fill="none" stroke="{col}" stroke-width="2.5"/></g>')
    pulse(cls, i, len(LINKS))

# ---- 编号和底部说明 ----
MARKS = [(SX + SW - 26, Y0 + 58), (EX + EW - 30, Y0 + 92), (GX + GW - 26, gy0 + 18), (TIME_XY[0] + 18, TIME_XY[1])]
for i, (x, y) in enumerate(MARKS):
    out.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="11" fill="#f8fafc"/>')
    out.append(text(x, y + 5, str(i + 1), 13, "#0f172a", 800, "middle"))
NOTES = [
    ("一个文件夹就是学习库", "资料/ 放原件，知识/ 是整理，练习/ 是作答"),
    ("每页是一份 Markdown", "顶上是属性，下面按固定小节写"),
    ("[[双链]] 连成知识图谱", "知识点、来源、题目互相链着"),
    ("出处带时间", "点 ▶ 03:20 回到原片那一段"),
]
nw = WW / 4
for i, (head, sub) in enumerate(NOTES):
    x = X0 + i * nw + 2
    out.append(f'<circle cx="{x + 11}" cy="{Y0 + WH + 42}" r="11" fill="#f8fafc"/>')
    out.append(text(x + 11, Y0 + WH + 47, str(i + 1), 13, "#0f172a", 800, "middle"))
    out.append(text(x + 30, Y0 + WH + 48, head, 16, "#f8fafc", 700))
    out.append(text(x + 30, Y0 + WH + 74, sub, 13, "#94a3b8"))

css.append("@media (prefers-reduced-motion:reduce){*{animation:none!important}[class^=hl-]{opacity:0}}")
svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" '
       f'aria-label="学习库在 Obsidian 里的样子：文件树、一页知识点、关系图谱">\n'
       f'<defs><style>{"".join(css)}</style></defs>\n'
       f'<rect width="{W}" height="{H}" fill="{BG}"/>\n' + "\n".join(out) + "\n</svg>\n")
open(sys.argv[1], "w").write(svg)
print("ok", len(svg), "bytes")
