from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import base64

W, H = 1280, 676
im = Image.new('RGB', (W, H), 'white')
d = ImageDraw.Draw(im)
reg = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
bold = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'
f = ImageFont.truetype(reg, 17)
fb = ImageFont.truetype(bold, 18)
fh = ImageFont.truetype(bold, 18)
cols = [0, 90, 360, 500, 685, 800, 930, 1085, 1280]
headers = ['TIME', 'TEAMS', 'RUNLINE', 'TOTAL', 'ML', 'ALT', 'F5 RL', 'F5 TOTAL']
d.rectangle((0, 0, W, 38), fill=(34, 93, 151))
for i, header in enumerate(headers):
    d.text((cols[i] + 8, 8), header, font=fh, fill='white')
rows = [
    ('CLE Guardians', 'CWS White Sox', ('away', '0'), '8-80', ('home', '0'), '4-90'),
    ('MIN Twins', 'MIL Brewers', ('home', '2+60'), '7-50', ('home', '1-35'), '4+50'),
    ('CHC Cubs', 'KC Royals', ('away', '1-90'), '10+10', ('away', '1+90'), '5-50'),
    ('COL Rockies', 'STL Cardinals', ('home', '1-30'), '9-50', ('home', '1+80'), '5-60'),
    ('BAL Orioles', 'TEX Rangers', ('home', '1+50'), '8平', ('home', '0-55'), '4-90'),
    ('DET Tigers', 'SF Giants', ('away', '1+40'), '7-70', ('away', '0-50'), '4+50'),
    ('LAD Dodgers', 'ARI D-backs', ('away', '1-35'), '9+50', ('away', '0-65'), '4.5'),
]
y = 38
row_height = 90
for index, (away, home, runline, total, first5_runline, first5_total) in enumerate(rows):
    fill = (246, 246, 246) if index % 2 == 0 else (207, 207, 207)
    d.rectangle((0, y, W, y + row_height), fill=fill)
    for x in cols:
        d.line((x, y, x, y + row_height), fill=(170, 180, 190), width=1)
    d.line((0, y + row_height, W, y + row_height), fill=(150, 160, 170), width=1)
    d.text((8, y + 16), '08-10', font=f, fill=(20, 20, 20))
    d.text((8, y + 51), f'{2 + index // 5:02d}:{10 if index < 5 else 5:02d}', font=f, fill=(20, 20, 20))
    d.text((98, y + 14), away, font=fb, fill=(20, 20, 20))
    d.text((98, y + 49), home, font=fb, fill=(20, 20, 20))

    side, line = runline
    d.text((368, y + (14 if side == 'away' else 49)), line, font=fb, fill=(20, 20, 20))
    d.text((430, y + 14), '0.950', font=f, fill=(190, 50, 50))
    d.text((430, y + 49), '0.950', font=f, fill=(190, 50, 50))

    d.text((508, y + 14), f'{total} O', font=fb, fill=(20, 20, 20))
    d.text((620, y + 14), '0.940', font=f, fill=(190, 50, 50))
    d.text((570, y + 49), 'U', font=fb, fill=(20, 20, 20))
    d.text((620, y + 49), '0.940', font=f, fill=(190, 50, 50))

    d.text((700, y + 14), '0.650', font=f, fill=(190, 50, 50))
    d.text((700, y + 49), '1.160', font=f, fill=(190, 50, 50))
    d.text((820, y + 14), '1.5 1.160', font=f, fill=(190, 50, 50))
    d.text((820, y + 49), '0.760', font=f, fill=(190, 50, 50))

    side5, line5 = first5_runline
    d.text((938, y + (14 if side5 == 'away' else 49)), line5, font=fb, fill=(20, 20, 20))
    d.text((1015, y + 14), '0.940', font=f, fill=(190, 50, 50))
    d.text((1015, y + 49), '0.940', font=f, fill=(190, 50, 50))

    d.text((1093, y + 14), f'{first5_total} O', font=fb, fill=(20, 20, 20))
    d.text((1200, y + 14), '0.930', font=f, fill=(190, 50, 50))
    d.text((1150, y + 49), 'U', font=fb, fill=(20, 20, 20))
    d.text((1200, y + 49), '0.930', font=f, fill=(190, 50, 50))
    y += row_height

output = Path('/tmp/dense-board-7games.jpg')
im.save(output, 'JPEG', quality=90, optimize=True)
raw = output.read_bytes()
assert raw[:3] == b'\xff\xd8\xff'
Path('scripts/fixtures/dense-board-7games.b64').write_text(base64.b64encode(raw).decode('ascii') + '\n')
print(f'fixture={len(raw)} bytes')
