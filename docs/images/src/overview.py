"""study-kit 全景图：资料 → 知识库 → 知识输出 三个区，带循环动画的 SVG。

用法：python3 overview.py <输出.svg>
版式、配色和动画顺序与宣传片的总览一幕一致。改内容改下面的常量。
"""
import math, sys

SRC, KNOW, PRAC = "#38D6FF", "#9B7BFF", "#FFB020"
BG, INK = "#0B0D14", "#EEF1F8"
CJK = "'PingFang SC','Noto Sans CJK SC','Microsoft YaHei',sans-serif"
MONO = "'SF Mono',Menlo,Consolas,'DejaVu Sans Mono',monospace"
DY = 40                         # 给标题留出的高度
CYCLE = 13.0                    # 一轮动画秒数

# 方框：中心 x, y, 宽, 高
B = {
    "video": (250, 235, 150, 64), "docs": (250, 395, 290, 64),
    "src": (790, 315, 190, 110), "know": (1390, 315, 340, 170),
    "answer": (930, 690, 170, 64), "prac": (1700, 690, 230, 150),
}
CAP = {"reach": (490, 235, "bili-reach", SRC), "wiki": (1045, 315, "study-wiki", KNOW),
       "practice": (1390, 690, "study-practice", PRAC)}
CAP_H = 60
def capw(label): return len(label) * 16.8 + 56
MERGE, LOOP_Y = (640, 315), 880

def L(k): x, y, w, h = B[k]; return (x - w / 2, y)
def R(k): x, y, w, h = B[k]; return (x + w / 2, y)
def cL(k): x, y, t, _ = CAP[k]; return (x - capw(t) / 2, y)
def cR(k): x, y, t, _ = CAP[k]; return (x + capw(t) / 2, y)

m = MERGE
# 连线：id -> (点列, 颜色, 是否箭头, 是否虚线, 开始秒, 结束秒)
E = {
    "video":    ([R("video"), cL("reach")], SRC, False, False, 0.2, 0.7),
    "reachOut": ([cR("reach"), (m[0] - 40, 235), (m[0], m[1] - 30), m], SRC, False, False, 0.7, 1.3),
    "docs":     ([R("docs"), (m[0] - 40, 395), (m[0], m[1] + 30), m], SRC, False, False, 0.2, 1.3),
    "toSrc":    ([m, L("src")], SRC, True, False, 1.3, 1.7),
    "toWiki":   ([R("src"), cL("wiki")], KNOW, True, False, 2.1, 2.6),
    "toKnow":   ([cR("wiki"), L("know")], KNOW, True, False, 2.8, 3.3),
    "down":     ([(1390, 315 + 85), (1390, 690 - CAP_H / 2)], KNOW, True, True, 4.1, 5.0),
    "answer":   ([R("answer"), cL("practice")], PRAC, True, False, 5.0, 5.5),
    "toPrac":   ([cR("practice"), L("prac")], PRAC, True, False, 5.6, 6.1),
    "loop":     ([(1700, 690 + 75), (1700, LOOP_Y), (930, LOOP_Y), (930, 690 + 32)], PRAC, True, False, 6.6, 7.9),
}
# 亮起时刻（秒）
LIT = {"src": 1.7, "wiki": 2.6, "know": 3.3, "answer": 5.0, "practice": 5.5, "prac": 6.1, "loop": 7.9}

def pct(t): return f"{100 * t / CYCLE:.2f}%"
def d_of(pts): return "M " + " L ".join(f"{x:.0f},{y:.0f}" for x, y in pts)
def plen(pts): return sum(math.dist(a, b) for a, b in zip(pts, pts[1:]))

css, out = [], []
def anim(sel, t, lo=0.35, name=None, fade_out=True):
    """sel 在 t 秒从 lo 亮到 1，末尾回到 lo。"""
    name = name or "k" + str(len(css))
    end = f"{pct(CYCLE - 0.6)}{{opacity:1}}100%{{opacity:{lo}}}" if fade_out else "100%{opacity:1}"
    css.append(f"{sel}{{animation:{name} {CYCLE}s ease-out infinite}}"
               f"@keyframes {name}{{0%,{pct(max(t - 0.05, 0))}{{opacity:{lo}}}{pct(t + 0.25)},{end}}}")

def text(x, y, s, size, color, weight=600, anchor="middle", font=CJK, extra=""):
    return (f'<text x="{x:.0f}" y="{y:.0f}" font-family="{font}" font-size="{size}" font-weight="{weight}" '
            f'fill="{color}" text-anchor="{anchor}" dominant-baseline="central"{extra}>{s}</text>')

def box(key, label, col, corner=False, words=(), lit=0.0):
    x, y, w, h = B[key]
    g = [f'<g class="bx-{key}">',
         f'<rect x="{x - w/2}" y="{y - h/2}" width="{w}" height="{h}" rx="14" fill="{col}" fill-opacity="0.13" '
         f'stroke="{col}" stroke-width="2.5" filter="url(#glow)"/>']
    if corner:
        g.append(text(x - w / 2 + 22, y - h / 2 + 34, label, 38, col, 700, "start"))
    else:
        g.append(text(x, y + 1, label, 26, col, 600))
    g.append("</g>")
    out.extend(g)
    anim(f".bx-{key}", lit)
    # 框里的小词，依次浮出
    if words:
        cw = [len(wd) * 22 + 28 for wd in words]
        cx = x - w / 2 + 18
        for i, (wd, ww) in enumerate(zip(words, cw)):
            out.append(f'<g class="wd-{key}-{i}"><rect x="{cx}" y="{y + h/2 - 62}" width="{ww}" height="42" rx="10" '
                       f'fill="{col}" fill-opacity="0.18" stroke="{col}" stroke-opacity="0.6" stroke-width="1.5"/>'
                       + text(cx + ww / 2, y + h / 2 - 41, wd, 22, INK, 600) + "</g>")
            anim(f".wd-{key}-{i}", lit + 0.25 + 0.2 * i, lo=0)
            cx += ww + 10

def capsule(key, lit):
    x, y, t, col = CAP[key]; w = capw(t)
    out.append(f'<g class="cp-{key}"><rect x="{x - w/2:.0f}" y="{y - CAP_H/2}" width="{w:.0f}" height="{CAP_H}" rx="30" '
               f'fill="{col}" fill-opacity="0.14" stroke="{col}" stroke-width="2.5" filter="url(#glow)"/>'
               + text(x, y + 1, t, 28, col, 600, font=MONO) + "</g>")
    anim(f".cp-{key}", lit)

def bubble(x, y, s, col, tail, t, cls):
    w, h = len(s) * 26 + 54, 52
    g = [f'<g class="{cls}">']
    if tail == "down":
        g.append(f'<path d="M {x-10},{y+h/2-1} L {x},{y+h/2+12} L {x+10},{y+h/2-1} Z" fill="#F3F4F8"/>')
    elif tail == "right":
        g.append(f'<path d="M {x+w/2-1},{y-10} L {x+w/2+12},{y} L {x+w/2-1},{y+10} Z" fill="#F3F4F8"/>')
    g.append(f'<rect x="{x-w/2}" y="{y-h/2}" width="{w}" height="{h}" rx="{h/2}" fill="#F3F4F8" filter="url(#shadow)"/>')
    g.append(f'<rect x="{x-w/2+16}" y="{y-12}" width="5" height="24" rx="2" fill="{col}"/>')
    g.append(text(x + 8, y + 1, s, 24, "#1B2033", 600))
    g.append("</g>")
    out.extend(g)
    anim(f".{cls}", t, lo=0)

# 区底色 + 区名
ZONES = [((100, 160, 810, 300), SRC, "① 资料", "原件放进来，保持原样", LIT["src"]),
         ((925, 200, 655, 230), KNOW, "② 知识库", "拆成知识点和题目，连成网", LIT["know"]),
         ((790, 600, 1060, 320), PRAC, "③ 知识输出", "做题时取出来用，错了记下来", LIT["prac"])]
for i, ((x, y, w, h), col, name, sub, t) in enumerate(ZONES):
    out.append(f'<g class="zn-{i}"><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="28" fill="{col}" fill-opacity="0.06" '
               f'stroke="{col}" stroke-opacity="0.22" stroke-width="1.5"/></g>')
    anim(f".zn-{i}", t, lo=0.25)
for i, ((x, y, w, h), col, name, sub, t) in enumerate(ZONES):
    ty = y + h + 32
    out.append(f'<g class="zt-{i}">' + text(x + 8, ty, name, 30, col, 700, "start")
               + text(x + 8 + len(name) * 26 + 30, ty + 1, sub, 23, "#8A90A6", 500, "start") + "</g>")
    anim(f".zt-{i}", t, lo=0.45)

# 连线（底层暗，经过时亮）+ 光点
for k, (pts, col, arrow, dash, t0, t1) in E.items():
    d = d_of(pts)
    extra = ' stroke-dasharray="10 9"' if dash else ""
    mk = f' marker-end="url(#ar-{col[1:]})"' if arrow else ""
    out.append(f'<path class="ln-{k}" d="{d}" fill="none" stroke="{col}" stroke-width="3" stroke-linejoin="round"{extra}{mk}/>')
    anim(f".ln-{k}", t1, lo=0.22)
for k, (pts, col, arrow, dash, t0, t1) in E.items():
    d, Lp = d_of(pts), plen(pts)
    for part, (dash_len, width, color, op) in {"t": (60, 5, col, 0.9), "h": (0.1, 14, "#ffffff", 1)}.items():
        name = f"mv-{k}-{part}"
        start, end = dash_len, -(Lp - (0 if part == "h" else 0))
        out.append(f'<path class="{name}" d="{d}" fill="none" stroke="{color}" stroke-width="{width}" stroke-linecap="round" '
                   f'stroke-linejoin="round" stroke-dasharray="{dash_len} {Lp + 80:.0f}" stroke-dashoffset="{start}" '
                   f'opacity="0" filter="url(#glow)"/>')
        css.append(f".{name}{{animation:{name} {CYCLE}s linear infinite}}"
                   f"@keyframes {name}{{0%,{pct(t0)}{{stroke-dashoffset:{start};opacity:{op}}}"
                   f"{pct(t1)}{{stroke-dashoffset:{end:.0f};opacity:{op}}}{pct(t1 + 0.15)},100%{{stroke-dashoffset:{end:.0f};opacity:0}}}}")

out.append(text(1412, (315 + 85 + 690 - CAP_H / 2) / 2, "讲解 · 出处 · 同类题", 24, "#C9B8FF", 600, "start",
                extra=' class="lk"'))
anim(".lk", 4.1, lo=0.4)

box("video", "网课", SRC, lit=0.2)
box("docs", "卷子 · 书 · 讲义", SRC, lit=0.2)
box("src", "资料/", SRC, corner=True, lit=LIT["src"])
box("know", "知识/", KNOW, corner=True, words=("知识点", "题目", "导图"), lit=LIT["know"])
box("answer", "学生作答", PRAC, lit=LIT["answer"])
box("prac", "练习/", PRAC, corner=True, words=("错题本", "进度"), lit=LIT["prac"])
capsule("reach", 0.7); capsule("wiki", LIT["wiki"]); capsule("practice", LIT["practice"])

bubble(490, 158, "把这个加进去", SRC, "down", LIT["src"], "bb-0")
bubble(600, 690, "这是我做的，帮我看看", PRAC, "right", LIT["answer"], "bb-1")
bubble(1315, LOOP_Y, "今天练什么？", PRAC, "none", LIT["loop"], "bb-2")

css.append("@media (prefers-reduced-motion:reduce){*{animation:none!important}[class^=mv-]{display:none}}")

markers = "".join(
    f'<marker id="ar-{c[1:]}" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="12" markerHeight="12" '
    f'markerUnits="userSpaceOnUse" orient="auto"><path d="M 0,0 L 12,6 L 0,12 Z" fill="{c}"/></marker>'
    for c in (SRC, KNOW, PRAC))
title = (f'<text x="975" y="62" font-family="{CJK}" font-size="44" font-weight="700" fill="{INK}" text-anchor="middle">'
         f'<tspan fill="{SRC}">资料</tspan>进来，<tspan fill="{KNOW}">知识</tspan>连起来，'
         f'<tspan fill="{PRAC}">练习</tspan>跟上去</text>')
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="70 0 1810 {975 + DY}" width="1810" height="{975 + DY}" role="img" aria-label="study-kit 全景：资料、知识库、知识输出三个区">
<defs>
<filter id="glow" filterUnits="userSpaceOnUse" x="0" y="0" width="2000" height="1200"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<filter id="shadow" filterUnits="userSpaceOnUse" x="0" y="0" width="2000" height="1200"><feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#000" flood-opacity="0.55"/></filter>
{markers}
<style>{"".join(css)}</style>
</defs>
<rect x="70" y="0" width="1810" height="{975 + DY}" fill="{BG}"/>
{title}
<g transform="translate(0,{DY})">
{chr(10).join(out)}
</g>
</svg>
'''
open(sys.argv[1], "w").write(svg)
print("ok", len(svg), "bytes")
