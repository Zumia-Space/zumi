# Chair cut-out for the video rooms (T-31 room picker, 13-10). The talk plate (resources-pinned/room-v2/B-talk-plate.png)
# has the office chair PAINTED into it; the room videos were made with the chair removed, so a video room draws this
# cut-out back over the video, in the plate's own pixel space, with the same crop as the plate. Same polygons as the
# 12-10 mock compositor (the rooms-1012 chair.py), kept in plate coordinates here (no
# 16:9 crop) and trimmed to their bounding box; the box's top-left goes into assets/rooms-video/rooms.json `chair`.
#   python scripts/gen-scene-chair.py   (prints the sha256 + box to paste into rooms.json)
import hashlib, os
from PIL import Image, ImageDraw, ImageFilter
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
plate = Image.open(os.path.join(ROOT, 'resources-pinned', 'room-v2', 'B-talk-plate.png')).convert('RGBA')
ox, oy = 520, 420
back = [(218,95),(240,42),(290,22),(440,17),(600,22),(645,42),(664,95),(662,300),(652,380),(662,500),(690,520),(735,560),(755,600),(752,622),(128,622),(130,598),(150,560),(195,520),(225,500),(232,380),(216,300)]
la = [(38,365),(60,343),(150,338),(188,348),(190,380),(165,410),(158,420),(160,585),(120,590),(110,420),(60,418),(40,405)]
ra = [(690,350),(728,338),(820,343),(843,365),(840,405),(790,415),(770,420),(770,585),(730,590),(722,420),(700,410),(690,382)]
m = Image.new('L', plate.size, 0); d = ImageDraw.Draw(m)
for p in (back, la, ra): d.polygon([(x + ox, y + oy) for x, y in p], fill=255)
m = m.filter(ImageFilter.GaussianBlur(1.0))
plate.putalpha(m)
box = m.getbbox()
out = os.path.join(ROOT, 'assets', 'rooms-video', 'chair-talk.png')
plate.crop(box).save(out, optimize=True)
print('box', box, 'bytes', os.path.getsize(out), 'sha256', hashlib.sha256(open(out, 'rb').read()).hexdigest())
