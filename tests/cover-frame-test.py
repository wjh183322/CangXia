import sys
import importlib.util
import unittest
import tempfile
from pathlib import Path
import cv2
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
spec = importlib.util.spec_from_file_location('cover_frame', Path(__file__).resolve().parents[1] / 'scripts' / 'cover-frame.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
match_cover = module.match_cover


class Matching(unittest.TestCase):
    def test_native_crop_and_unrelated_rejection(self):
        with tempfile.TemporaryDirectory(prefix='cx-frame-') as directory:
            root = Path(directory)
            video, reference, output = root/'video.avi', root/'reference.png', root/'result.png'
            rng = np.random.default_rng(321)
            base = np.zeros((540, 960, 3), np.uint8) + 50
            for i in range(170):
                point = tuple(int(n) for n in rng.integers([0, 0], [960, 540]))
                cv2.circle(base, point, int(rng.integers(4, 15)), tuple(int(n) for n in rng.integers(50, 255, 3)), -1)
            writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*'MJPG'), 10, (960, 540))
            self.assertTrue(writer.isOpened())
            for i in range(30):
                frame = base.copy()
                cv2.putText(frame, f'frame {i:02}', (310, 270), cv2.FONT_HERSHEY_SIMPLEX, 2, (255, 255, 255), 4)
                writer.write(frame)
            writer.release()
            cap = cv2.VideoCapture(str(video));cap.set(cv2.CAP_PROP_POS_FRAMES, 10);ok, decoded = cap.read();cap.release()
            self.assertTrue(ok)
            cv2.imencode('.png', cv2.resize(decoded[:, 180:900], (360, 270)))[1].tofile(str(reference))
            result = match_cover(str(video), str(reference), str(output))
            self.assertEqual(result['frame'], 10)
            self.assertLessEqual(abs(result['width'] - 720), 4)
            self.assertEqual(result['height'], 540)
            self.assertLess(result['width'], 960)
            self.assertEqual(cv2.imdecode(np.fromfile(output, np.uint8), 1).shape[:2], (result['height'], result['width']))
            wrong = root/'wrong.png'
            cv2.imencode('.png', rng.integers(0, 255, (270, 360, 3), np.uint8))[1].tofile(str(wrong))
            with self.assertRaisesRegex(ValueError, 'no_reliable_hd_match'):
                match_cover(str(video), str(wrong), str(root/'must-not-exist.png'))
            self.assertFalse((root/'must-not-exist.png').exists())


if __name__ == '__main__':
    unittest.main()
