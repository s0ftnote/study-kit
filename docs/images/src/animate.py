"""Inject staged CSS flow animation into fireworks-tech-graph SVGs."""
import re, sys, math, pathlib

STAGES = {
  "overview": {"a1":0,"a2":0,"a4":1,"a5":2,"a6":3,"a3":4,"a7":4,"a8":5,"a9":6},
  "bili": {"e1":0,"e2":0,"e3":1,"e4":1,"e5":2,"e6":3,"e7":4,"e9":5,"e10":6},
  "wiki": {"e1":0,"e2":0,"e3":1,"e4":1,"e5":2,"e6":3,"e7":3,"e8":4,"e9":4,"e10":5},
  "practice": {"e1":0,"e2":1,"e3":2,"e4":2,"e5":3,"e6":3,"e7":4,"e8":5,"e9":6},
  "states": {"t1":0,"t2":0,"t3":1,"t4":2},
}
STEP, TRAVEL, HOLD, COMET = 1.0, 0.9, 2.6, 40

def plen(d):
    pts = [tuple(map(float, p)) for p in re.findall(r"(-?[\d.]+)[ ,](-?[\d.]+)", d)]
    return sum(math.dist(a, b) for a, b in zip(pts, pts[1:]))

def pct(t, T): return f"{100*t/T:.2f}%"

def main(src, dst, name):
    svg = pathlib.Path(src).read_text()
    stages = STAGES[name]
    nstage = max(stages.values()) + 1
    T = nstage * STEP + HOLD
    edges = re.findall(r'<path id="([^"]+)" data-graph-role="edge"[^>]*?data-source="([^"]+)" data-target="([^"]+)"[^>]*? d="([^"]+)"[^>]*? stroke="([^"]+)"', svg)
    assert {e[0] for e in edges} == set(stages), (name, [e[0] for e in edges])
    css, overlay = [], []
    arrive = {}
    for eid, s, t, d, color in edges:
        st = stages[eid]; t0 = st * STEP; t1 = t0 + TRAVEL
        arrive[t] = min(arrive.get(t, 1e9), t1)
        arrive.setdefault(s, 1e9)
        L = plen(d) + 12
        overlay.append(f'<path class="fx-c fx-c-{eid}" d="{d}" fill="none" stroke="{color}" stroke-width="6" stroke-linecap="round" filter="url(#fx-glow)" stroke-dasharray="{COMET} {L+COMET:.0f}" stroke-dashoffset="{COMET}"/>')
        css.append(f".fx-c-{eid}{{animation:fx-c-{eid} {T}s linear infinite}}"
                   f"@keyframes fx-c-{eid}{{0%,{pct(t0,T)}{{stroke-dashoffset:{COMET};opacity:1}}"
                   f"{pct(t1,T)}{{stroke-dashoffset:{-L:.0f};opacity:1}}{pct(t1+0.01,T)},100%{{stroke-dashoffset:{-L:.0f};opacity:0}}}}")
        css.append(f"#{eid}{{animation:fx-e-{eid} {T}s linear infinite}}"
                   f"@keyframes fx-e-{eid}{{0%,{pct(t0,T)}{{opacity:.18}}{pct(t1,T)},{pct(T-0.5,T)}{{opacity:1}}100%{{opacity:.18}}}}")
    for node, ta in arrive.items():
        if ta >= 1e9:  # source node: lit from the start
            ta = 0.0
        css.append(f"#node-{node}{{animation:fx-n-{node} {T}s ease-out infinite}}"
                   f"@keyframes fx-n-{node}{{0%,{pct(max(ta-0.15,0),T)}{{opacity:{1 if ta==0 else .3}}}"
                   f"{pct(ta+0.05,T)},{pct(T-0.5,T)}{{opacity:1}}100%{{opacity:{1 if ta==0 else .3}}}}}")
    css.append("@media (prefers-reduced-motion:reduce){*{animation:none!important}.fx-c{display:none}}")
    style = "<style>" + "".join(css) + "</style>"
    glow = '<filter id="fx-glow" filterUnits="userSpaceOnUse" x="0" y="0" width="4000" height="4000"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
    svg = svg.replace("</defs>", glow + style + "</defs>", 1)
    last = [m.end() for m in re.finditer(r'<path id="[^"]+" data-graph-role="edge"[^>]*/>', svg)][-1]
    svg = svg[:last] + '\n<g class="fx-overlay">' + "".join(overlay) + "</g>" + svg[last:]
    pathlib.Path(dst).write_text(svg)
    print(name, f"cycle {T:.1f}s", len(edges), "edges")

if __name__ == "__main__":
    main(*sys.argv[1:])
