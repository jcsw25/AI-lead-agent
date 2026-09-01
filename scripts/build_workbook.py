"""
Builds the pair-database workbook from export-data.json.

Sheet order matters: "Introductions" first because it is the working surface -
one row per potential or live introduction, both sides on the same line.
"""
import json
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

DATA = json.load(open("export-data.json", encoding="utf-8"))

FONT = "Arial"
HDR_FILL = PatternFill("solid", fgColor="0F6466")
A_FILL = PatternFill("solid", fgColor="E3EFEF")   # side A columns
B_FILL = PatternFill("solid", fgColor="F5E8DA")   # side B columns
YELLOW = PatternFill("solid", fgColor="FFFF00")
THIN = Side(style="thin", color="D3DCDB")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

wb = Workbook()


def style_header(ws, headers, group_fills=None):
    for i, h in enumerate(headers, start=1):
        c = ws.cell(row=1, column=i, value=h)
        c.font = Font(name=FONT, bold=True, color="FFFFFF", size=10)
        c.fill = HDR_FILL
        c.alignment = Alignment(vertical="center", wrap_text=True)
        c.border = BORDER
    ws.row_dimensions[1].height = 34
    ws.freeze_panes = "A2"


def write_rows(ws, rows, keys, widths, group_fills=None):
    for r, row in enumerate(rows, start=2):
        for i, k in enumerate(keys, start=1):
            v = row.get(k, "")
            c = ws.cell(row=r, column=i, value=v if v != "" else None)
            c.font = Font(name=FONT, size=10)
            c.alignment = Alignment(vertical="top", wrap_text=isinstance(v, str) and len(str(v)) > 40)
            c.border = BORDER
            if group_fills:
                for rng, fill in group_fills:
                    if i in rng:
                        c.fill = fill
            if isinstance(v, (int, float)) and k in ("deal", "commission", "deal_low", "deal_high"):
                c.number_format = '#,##0'
            if k == "rate" and isinstance(v, (int, float)):
                c.number_format = '0.0"%"'
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.auto_filter.ref = f"A1:{get_column_letter(len(keys))}{max(2, len(rows) + 1)}"


# ---------------------------------------------------------------- Introductions
ws = wb.active
ws.title = "Introductions"
intro_headers = [
    "Data", "Status", "Company A (supplier)", "A website", "A contact person", "A title",
    "A email", "A phone", "What A provides",
    "Company B (buyer)", "B website", "B industry", "B contact person", "B title",
    "B email", "B phone", "B address",
    "Why B buys now", "Timing window", "Deal size", "Commission %", "Est. commission", "Source",
]
intro_keys = [
    "real", "status", "a_name", "a_website", "a_person", "a_title", "a_email", "a_phone", "a_provides",
    "b_name", "b_website", "b_industry", "b_person", "b_title", "b_email", "b_phone", "b_address",
    "why_now", "timing", "deal", "rate", "commission", "source",
]
intro_widths = [9, 13, 26, 24, 18, 18, 28, 15, 34, 24, 22, 26, 18, 18, 26, 15, 30, 40, 24, 12, 12, 14, 10]
style_header(ws, intro_headers)
write_rows(ws, DATA["introductions"], intro_keys, intro_widths,
           group_fills=[(range(3, 10), A_FILL), (range(10, 18), B_FILL)])

n = len(DATA["introductions"])
summary_row = n + 3
ws.cell(row=summary_row, column=1, value="TOTALS").font = Font(name=FONT, bold=True, size=10)
ws.cell(row=summary_row, column=3, value=f"=COUNTA(C2:C{n+1})").font = Font(name=FONT, bold=True, size=10)
ws.cell(row=summary_row, column=4, value="rows").font = Font(name=FONT, italic=True, size=9)
ws.cell(row=summary_row, column=20, value=f"=SUM(T2:T{n+1})").font = Font(name=FONT, bold=True, size=10)
ws.cell(row=summary_row, column=20).number_format = '#,##0'
ws.cell(row=summary_row, column=22, value=f"=SUM(V2:V{n+1})").font = Font(name=FONT, bold=True, size=10)
ws.cell(row=summary_row, column=22).number_format = '#,##0'

# ---------------------------------------------------------------- Companies
ws2 = wb.create_sheet("Companies")
co_headers = [
    "Data", "Company", "Role", "Website", "Domain", "Industry", "Size",
    "Contact person", "Title", "Email", "Phone", "All emails found",
    "Address", "City", "Data verified", "Source URL", "Scraped",
]
co_keys = ["real", "name", "role", "website", "domain", "industry", "size", "person", "title",
           "email", "phone", "all_contacts", "address", "city", "verified", "source_url", "scraped"]
co_widths = [9, 28, 15, 26, 22, 26, 10, 18, 20, 28, 15, 34, 34, 12, 13, 34, 12]
style_header(ws2, co_headers)
write_rows(ws2, DATA["companies"], co_keys, co_widths)

# ---------------------------------------------------------------- Pairings
ws3 = wb.create_sheet("Pairings")
pa_headers = [
    "Industry A (recruit)", "Industry B (sell to)", "Lane", "What A has", "What B needs",
    "Why now (trigger)", "Timing window", "Reach A", "Reach B",
    "Deal low", "Deal high", "Commission %", "Score", "Status",
]
pa_keys = ["a_industry", "b_industry", "lane", "what_a_has", "what_b_needs", "trigger",
           "timing", "reach_a", "reach_b", "deal_low", "deal_high", "rate", "score", "status"]
pa_widths = [30, 32, 13, 46, 50, 44, 26, 28, 30, 11, 11, 12, 8, 11]
style_header(ws3, pa_headers)
write_rows(ws3, DATA["pairings"], pa_keys, pa_widths)

# ---------------------------------------------------------------- Read me
ws4 = wb.create_sheet("Read me")
ws4.column_dimensions["A"].width = 26
ws4.column_dimensions["B"].width = 104

lines = [
    ("Pair database", ""),
    ("Business", DATA["business"]),
    ("Generated", DATA["generated"]),
    ("", ""),
    ("WHAT EACH TAB IS", ""),
    ("Introductions", "The working surface. One row per potential or live introduction, both sides on the same line. "
                      "Teal columns are the supplier (A), amber columns are the buyer (B)."),
    ("Companies", "Master contact list. Every company scraped or discovered, with all contact routes found and the "
                  "page each came from."),
    ("Pairings", "The reusable theses: what industry A has that industry B needs, and the trigger that makes B act."),
    ("", ""),
    ("HOW TO READ IT", ""),
    ("Data column", "REAL = scraped from the live web, every field traceable to a source URL. "
                    "SAMPLE = simulated demo data on reserved .test domains; none of those companies exist. "
                    "Delete the SAMPLE rows once you have enough real ones."),
    ("Blank contact person", "Expected, not an error. Singapore SME service businesses publish a phone and a generic "
                             "inbox, rarely a staff directory. Blank means nothing was published — never a guess."),
    ("Blank Company B", "That row is a scraped supplier not yet matched to a specific buyer. B industry shows who "
                        "they would be introduced to."),
    ("Source URL", "Every contact detail was read from that page. Nothing in this file was inferred or "
                   "pattern-guessed (no firstname.lastname@company)."),
    ("Data verified", "VERIFIED = read from the company's own site. UNVERIFIED = name found without a published "
                      "contact route; cannot be emailed by the send gate."),
    ("", ""),
    ("CELLS YOU EDIT", ""),
    ("Yellow cells", "Yours to fill in — status, notes, and anything you learn on a call."),
    ("Everything else", "Overwritten on the next export. Put durable edits in the app, not here."),
    ("", ""),
    ("KEEPING IT IN SYNC", ""),
    ("Re-export", "npm run export:xlsx  — regenerates this file from the database."),
    ("Live Google Sheets", "src/adapters/sheets.ts pushes straight into a Sheet once GOOGLE_CLIENT_ID and "
                           "GOOGLE_CLIENT_SECRET are set. Until then, import this file: Google Sheets > File > Import."),
    ("", ""),
    ("IMPORTANT", ""),
    ("Source of truth", "The app database stays authoritative for suppression and opt-outs. If someone unsubscribes, "
                        "record it in the app — a row deleted only in this sheet will still be emailed."),
]

for r, (label, text) in enumerate(lines, start=1):
    a = ws4.cell(row=r, column=1, value=label)
    b = ws4.cell(row=r, column=2, value=text)
    is_head = label.isupper() and label and not text
    a.font = Font(name=FONT, bold=bool(label) and (is_head or r <= 3), size=11 if is_head else 10,
                  color="0F6466" if is_head else "16232B")
    b.font = Font(name=FONT, size=10)
    b.alignment = Alignment(wrap_text=True, vertical="top")
    if len(str(text)) > 90:
        ws4.row_dimensions[r].height = 30

ws4["A1"].font = Font(name=FONT, bold=True, size=16, color="0F6466")

# Example of the fill-in convention
ex = len(lines) + 2
ws4.cell(row=ex, column=1, value="Example editable cell").font = Font(name=FONT, bold=True, size=10)
c = ws4.cell(row=ex, column=2, value="Called 12 Mar — asked for pricing, sending Thursday")
c.fill = YELLOW
c.font = Font(name=FONT, size=10)

wb.save("pair-database.xlsx")
print("wrote pair-database.xlsx")
