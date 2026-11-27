"""Create an isolated MP4 and cover candidates, plus desktop matcher evidence."""
import json
import sys
from pathlib import Path
import cv2
import numpy as np
import runpy

root = Path(sys.argv[1])
rng = np.random.default_rng(321)
base = np.zeros((540, 960, 3), np.uint8) + 50
for _ in range(170):
    point = tuple(int(n) for n in rng.integers([0, 0], [960, 540]))
    cv2.circle(base, point, int(rng.integers(4, 15)), tuple(int(n) for n in rng.integers(50, 255, 3)), -1)
movie = root / 'video.mp4'
writer = cv2.VideoWriter(str(movie), cv2.VideoWriter_fourcc(*'mp4v'), 10, (960, 540))
assert writer.isOpened()
for index in range(30):
    frame = base.copy()
    cv2.putText(frame, f'frame {index:02}', (310, 270), cv2.FONT_HERSHEY_SIMPLEX, 2, (255, 255, 255), 4)
    writer.write(frame)
writer.release()
cap = cv2.VideoCapture(str(movie))
cap.set(cv2.CAP_PROP_POS_FRAMES, 10)
ok, frame = cap.read()
cap.release()
assert ok
for name, pixels in [('reference', cv2.resize(frame[:, 180:900], (360, 270))), ('hd', frame),
                     ('wrong', rng.integers(0, 255, (270, 360, 3), np.uint8))]:
    cv2.imencode('.png', pixels)[1].tofile(str(root / (name + '.png')))
match = runpy.run_path(str(Path(__file__).resolve().parents[3] / 'scripts' / 'cover-frame.py'))['match_cover']
result = match(str(movie), str(root/'reference.png'), str(root/'desktop.png'))
(root/'golden.json').write_text(json.dumps(result))
