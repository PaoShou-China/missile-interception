"""Generate original vector figures for the framework paper."""
from pathlib import Path

import reportlab
from reportlab.lib.colors import HexColor
from reportlab.lib.utils import simpleSplit
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas

PAPER = Path(__file__).resolve().parents[1]
OUT = PAPER / "figures"
OUT.mkdir(exist_ok=True)
FONT_DIR = Path(reportlab.__file__).parent / "fonts"
pdfmetrics.registerFont(TTFont("Vera", str(FONT_DIR / "Vera.ttf")))
pdfmetrics.registerFont(TTFont("VeraBold", str(FONT_DIR / "VeraBd.ttf")))

INK = HexColor("#142C44")
MUTED = HexColor("#526171")
EDGE = HexColor("#A2B3C2")
BLUE = HexColor("#EAF1F8")
GREEN = HexColor("#EAF3EE")
SAND = HexColor("#F5F0E6")
RED = HexColor("#F5E9E7")
TEAL = HexColor("#257557")
AMBER = HexColor("#B28130")


def new_canvas(name, height):
    c = Canvas(str(OUT / name), pagesize=(500, height), pageCompression=1,
               initialFontName="Vera", initialFontSize=10)
    c.setTitle(name.replace(".pdf", "").replace("_", " "))
    c.setAuthor("Anonymous Authors")
    return c


def label(c, x, y, text, size=10, bold=False, color=INK):
    c.setFillColor(color)
    c.setFont("VeraBold" if bold else "Vera", size)
    c.drawString(x, y, text)


def box(c, x, y, w, h, title, lines=(), fill=BLUE, body=8.8, head=9.7):
    c.setFillColor(fill)
    c.setStrokeColor(EDGE)
    c.setLineWidth(0.65)
    c.roundRect(x, y, w, h, 4, fill=1, stroke=1)
    pos = y + h - 15
    for row in simpleSplit(title, "VeraBold", head, w - 14):
        label(c, x + 7, pos, row, head, True)
        pos -= head + 2
    pos -= 1
    for item in lines:
        for row in simpleSplit(item, "Vera", body, w - 14):
            label(c, x + 7, pos, row, body, color=MUTED)
            pos -= body + 3


def line(c, points, dashed=False, arrow=True, color=MUTED, width=0.85):
    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(width)
    c.setDash(3, 3) if dashed else c.setDash()
    path = c.beginPath()
    path.moveTo(*points[0])
    for point in points[1:]:
        path.lineTo(*point)
    c.drawPath(path, stroke=1, fill=0)
    c.setDash()
    if not arrow:
        return
    (x0, y0), (x, y) = points[-2:]
    p = c.beginPath()
    p.moveTo(x, y)
    if abs(x - x0) >= abs(y - y0):
        sign = 1 if x > x0 else -1
        p.lineTo(x - sign * 5, y + 2.5)
        p.lineTo(x - sign * 5, y - 2.5)
    else:
        sign = 1 if y > y0 else -1
        p.lineTo(x + 2.5, y - sign * 5)
        p.lineTo(x - 2.5, y - sign * 5)
    p.close()
    c.drawPath(p, stroke=0, fill=1)


def architecture():
    c = new_canvas("framework_architecture.pdf", 365)
    label(c, 12, 348, "CONTRACT-DRIVEN END-TO-END FRAMEWORK", 11, True)
    box(c, 12, 284, 112, 43, "Configuration", ["scenario / periods / seeds"])
    box(c, 142, 284, 216, 43, "Simulation coordinator", ["outer grid / phase / release order"], GREEN)
    box(c, 376, 284, 112, 43, "Batch runner", ["checkpoint / resume"])
    line(c, [(126, 305), (140, 305)])
    line(c, [(374, 305), (360, 305)])

    titles = [(12, "Environment", "sampled disturbance"), (132, "Observation", "sensor / estimator"),
              (252, "Decision", "phase / guidance"), (372, "Command", "control / actuator")]
    for x, title, detail in titles:
        box(c, x, 204, 108, 48, title, [detail], BLUE)
    line(c, [(250, 282), (250, 264)], arrow=False)
    line(c, [(66, 264), (426, 264)], arrow=False)
    for x in (66, 186, 306, 426):
        line(c, [(x, 264), (x, 254)])

    box(c, 12, 119, 148, 53, "State contract", ["names / shapes / units", "frames / owners / layout ID"], GREEN)
    box(c, 176, 119, 148, 53, "Continuous kernel", ["fixed RK4 / event refinement", "sample-and-hold inputs"], GREEN)
    box(c, 340, 119, 148, 53, "Telemetry contract", ["bounded named records", "view / copy / export"], GREEN)
    line(c, [(250, 202), (250, 174)])
    line(c, [(174, 146), (162, 146)])
    line(c, [(326, 146), (338, 146)])

    box(c, 12, 25, 476, 55, "Layered verification and traceability",
        ["analytic cases + invariants  |  interface probes  |  application tests  |  evidence records"], SAND)
    for x in (86, 250, 414):
        line(c, [(x, 117), (x, 82)], dashed=True)
    label(c, 12, 7, "Solid: execution/data path.  Dashed: evidence attached to the implementation layer.", 8.4, color=MUTED)
    c.save()


def timeline():
    c = new_canvas("multirate_timeline.pdf", 235)
    label(c, 12, 218, "OUTER-GRID SAMPLE-AND-HOLD SEMANTICS", 11, True)
    x0, x1 = 82, 476
    rows = [(181, "outer grid"), (142, "module A"), (103, "module B"), (64, "RK4 stages")]
    for y, name in rows:
        label(c, 12, y - 3, name, 8.8, color=MUTED)
        line(c, [(x0, y), (x1, y)], arrow=False, color=EDGE)
    ticks = [82, 180, 278, 376, 474]
    for i, x in enumerate(ticks):
        c.setStrokeColor(INK)
        c.line(x, 176, x, 186)
        label(c, x - 8, 192, f"t{i}", 8.5, color=INK)
    for x in ticks[:-1]:
        c.setFillColor(TEAL)
        c.circle(x, 142, 3.5, fill=1, stroke=0)
    for x in (82, 278):
        c.setFillColor(AMBER)
        c.circle(x, 103, 3.5, fill=1, stroke=0)
    for idx, (a, b) in enumerate(zip(ticks[:-1], ticks[1:])):
        for x, lab in ((a + 4, "k1"), ((a + b) / 2, "k2/3"), (b - 10, "k4")):
            c.setStrokeColor(INK)
            c.line(x, 58, x, 70)
            if idx == 0:
                label(c, x - 7, 44, lab, 7.7, color=MUTED)
        c.setFillColor(BLUE)
        c.rect(a + 1, 78, b - a - 2, 12, fill=1, stroke=0)
    label(c, 93, 81, "held output", 7.6, color=MUTED)
    label(c, 289, 81, "held output", 7.6, color=MUTED)

    event_x = 337
    c.setStrokeColor(AMBER)
    c.setLineWidth(1.4)
    c.line(event_x, 54, event_x, 187)
    label(c, event_x - 22, 18, "refined event", 8.3, True, AMBER)
    line(c, [(event_x, 30), (event_x, 52)], color=AMBER)
    label(c, 12, 7, "Event refinement splits continuous time only; it does not create a second discrete release.", 8.4, color=MUTED)
    c.save()


def contracts():
    c = new_canvas("data_contracts.pdf", 250)
    label(c, 12, 233, "ONE SCHEMA, FOUR ENFORCED REPRESENTATIONS", 11, True)
    box(c, 12, 124, 118, 83, "StateField sequence", ["key + shape", "unit + frame", "owner + order"])
    box(c, 146, 124, 104, 83, "Derived slices", ["offsets", "dimension D", "duplicate guard"], GREEN)
    box(c, 266, 124, 104, 83, "Flat vector", ["pack: finite", "unpack: copies", "shape guard"], GREEN)
    box(c, 386, 124, 102, 83, "Layout ID", ["metadata hash", "change detector", "not value hash"], SAND)
    line(c, [(132, 165), (144, 165)])
    line(c, [(252, 165), (264, 165)])
    line(c, [(372, 165), (384, 165)])

    box(c, 12, 40, 142, 52, "Telemetry admission", ["width / finite payload / time"], BLUE)
    box(c, 179, 40, 142, 52, "Bounded N x C storage", ["occupied prefix + overflow count"], GREEN)
    box(c, 346, 40, 142, 52, "Access and export", ["view vs copy / fixed decimals"], SAND)
    line(c, [(156, 66), (177, 66)])
    line(c, [(323, 66), (344, 66)])
    label(c, 12, 14, "Known diagnostic gaps: unpack finiteness and nonfinite timestamps in the isolated Python path.", 8.4, color=AMBER)
    c.save()


def verification_layers():
    c = new_canvas("verification_layers.pdf", 260)
    label(c, 12, 243, "EVIDENCE LAYERS AND CLAIM BOUNDARIES", 11, True)
    rows = [
        (183, "Numerical core", "5 / 5", "order, invariants, cross-integrator", GREEN, TEAL),
        (137, "Application suite", "83 / 83", "scheduler, events, integration", GREEN, TEAL),
        (91, "Interface probes", "21 / 23", "contracts + 2 diagnostic gaps", SAND, AMBER),
        (45, "Paper artifact", "ZIP + PDF", "clean compile and visual checks", GREEN, TEAL),
    ]
    for y, title, result, claim, fill, color in rows:
        box(c, 12, y, 132, 34, title, fill=BLUE, head=9.0)
        box(c, 158, y, 92, 34, result, fill=fill, head=9.0)
        box(c, 264, y, 224, 34, claim, fill=fill, head=8.7)
        c.setFillColor(color)
        c.circle(238, y + 17, 3, fill=1, stroke=0)
    c.setStrokeColor(HexColor("#B54B4B"))
    c.setLineWidth(1.0)
    c.line(12, 30, 488, 30)
    label(c, 12, 10, "Not established: real-system fidelity, operational effectiveness, or historical-report provenance.", 8.5, True, HexColor("#9E3E3E"))
    c.save()


if __name__ == "__main__":
    architecture()
    timeline()
    contracts()
    verification_layers()
    print("Wrote four original framework figures.")
