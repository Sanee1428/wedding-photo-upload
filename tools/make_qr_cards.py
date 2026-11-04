#!/usr/bin/env python3
"""
Make print-ready QR cards (PDF) from the links that setup() printed.

Works offline — the secret links never leave your computer.
(Don't paste them into online QR websites: anyone running that site would get the key.)

Usage:
    pip install reportlab
    python make_qr_cards.py links.txt --couple "Bride & Groom"
    python make_qr_cards.py links.txt --couple "Bride & Groom" --pin Wedding=4821

links.txt is the text copied from the Apps Script log, e.g.
    Haldi:  https://your-site.netlify.app/?e=haldi&k=....
    Sangeet:  https://your-site.netlify.app/?e=sangeet&k=....
"""
import argparse
import re
import sys

from reportlab.graphics import renderPDF
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A5
from reportlab.pdfgen import canvas

MAROON = HexColor('#7a1f2b')
GOLD = HexColor('#b8892f')
INK = HexColor('#2b2220')
MUTED = HexColor('#7a6b63')
IVORY = HexColor('#fbf6ee')

LINE_RE = re.compile(r'^\s*(.+?):\s+(https://\S+\?e=[a-z0-9-]+&k=[A-Za-z0-9]+)\s*$')


def read_links(path):
    out = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            m = LINE_RE.match(line)
            if m:
                out.append((m.group(1).strip(), m.group(2)))
    return out


def qr_drawing(url, size):
    w = QrCodeWidget(url, barLevel='Q')  # 'Q' = still scans if ~25% is smudged or creased
    x1, y1, x2, y2 = w.getBounds()
    d = Drawing(size, size, transform=[size / (x2 - x1), 0, 0, size / (y2 - y1), 0, 0])
    d.add(w)
    return d


def card(c, title, url, couple, pin):
    W, H = A5
    c.setFillColor(IVORY)
    c.rect(0, 0, W, H, fill=1, stroke=0)
    c.setStrokeColor(GOLD)
    c.setLineWidth(1.2)
    c.roundRect(18, 18, W - 36, H - 36, 14, fill=0, stroke=1)
    c.setLineWidth(0.4)
    c.roundRect(24, 24, W - 48, H - 48, 11, fill=0, stroke=1)

    y = H - 70
    c.setFillColor(GOLD)
    c.setFont('Helvetica-Bold', 11)
    c.drawCentredString(W / 2, y, ' '.join(title.upper()))
    y -= 38
    c.setFillColor(MAROON)
    c.setFont('Times-Bold', 30)
    c.drawCentredString(W / 2, y, couple)
    y -= 34
    c.setFillColor(INK)
    c.setFont('Times-Italic', 17)
    c.drawCentredString(W / 2, y, 'Share your photos & videos with us')

    qs = 230
    qx, qy = (W - qs) / 2, y - 24 - qs
    c.setFillColorRGB(1, 1, 1)
    c.roundRect(qx - 12, qy - 12, qs + 24, qs + 24, 10, fill=1, stroke=0)
    renderPDF.draw(qr_drawing(url, qs), c, qx, qy)

    y = qy - 40
    c.setFillColor(INK)
    c.setFont('Helvetica', 12)
    for line in ['1. Scan with your phone camera',
                 '2. Type your name',
                 '3. Pick the photos you’d like to share']:
        c.drawCentredString(W / 2, y, line)
        y -= 18
    if pin:
        y -= 6
        c.setFillColor(MAROON)
        c.setFont('Helvetica-Bold', 14)
        c.drawCentredString(W / 2, y, 'PIN: ' + pin)
        y -= 18
    c.setFillColor(MUTED)
    c.setFont('Helvetica', 9)
    c.drawCentredString(W / 2, 40, 'No app needed. Photos go only to the family’s private folder.')
    c.showPage()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('links')
    ap.add_argument('--couple', required=True)
    ap.add_argument('--pin', action='append', default=[], help='Event=PIN, repeatable')
    ap.add_argument('--out', default='qr-cards.pdf')
    a = ap.parse_args()

    links = read_links(a.links)
    if not links:
        sys.exit('No links found. Paste the lines from the Apps Script log into ' + a.links)
    pins = dict(p.split('=', 1) for p in a.pin)

    c = canvas.Canvas(a.out, pagesize=A5)
    c.setTitle('QR cards')
    for title, url in links:
        card(c, title, url, a.couple, pins.get(title, ''))
    c.save()
    print('Made %d card(s): %s' % (len(links), a.out))


if __name__ == '__main__':
    main()
