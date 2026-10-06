"""Match an existing cover to a local video. Never upscale or invent a frame."""
import json
import math
import sys
import time
from pathlib import Path
import cv2
import numpy as np


def match_cover(video, reference, output):
    cv2.setNumThreads(2)
    started = time.monotonic()
    ref = cv2.imdecode(np.fromfile(reference, np.uint8), cv2.IMREAD_COLOR)
    if ref is None or min(ref.shape[:2]) < 64:
        raise ValueError("reference_invalid")
    rh, rw = ref.shape[:2]
    ratio = min(1.0, 720 / max(rh, rw))
    ref = cv2.resize(ref, (round(rw * ratio), round(rh * ratio)))
    rh, rw = ref.shape[:2]
    gray = cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY)
    sift = cv2.SIFT_create(nfeatures=1800)
    keypoints, descriptors = sift.detectAndCompute(gray, None)
    if descriptors is None or len(keypoints) < 20:
        raise ValueError("reference_insufficient_detail")
    cap = cv2.VideoCapture(str(video))
    try:
        count, fps = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)), cap.get(cv2.CAP_PROP_FPS)
        width, height = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        if not cap.isOpened() or count < 1 or not math.isfinite(fps) or fps <= 0:
            raise ValueError("video_decode_failed")
        scale = min(1.0, 960 / width, 720 / height)
        matcher = cv2.BFMatcher()
        checked = {}

        def evaluate(index):
            if index in checked:
                return checked[index]
            if time.monotonic() - started > 90:
                raise ValueError("matching_timeout")
            cap.set(cv2.CAP_PROP_POS_FRAMES, index)
            ok, frame = cap.read()
            checked[index] = None
            if not ok:
                return None
            small = cv2.resize(frame, (round(width * scale), round(height * scale)))
            keys, desc = sift.detectAndCompute(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), None)
            if desc is None:
                return None
            pairs = matcher.knnMatch(desc, descriptors, k=2)
            good = [p[0] for p in pairs if len(p) == 2 and p[0].distance < .7 * p[1].distance]
            if len(good) < 20:
                return None
            src = np.float32([keys[m.queryIdx].pt for m in good])
            dst = np.float32([keypoints[m.trainIdx].pt for m in good])
            affine, inliers = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=2)
            if affine is None or int(inliers.sum()) < 20 or inliers.mean() < .6:
                return None
            if affine[0, 0] <= 0 or abs(affine[1, 0] / affine[0, 0]) > .02:
                return None
            valid = cv2.warpAffine(np.ones(small.shape[:2], np.uint8), affine, (rw, rh)) > 0
            if valid.mean() < .995:
                return None
            aligned = cv2.warpAffine(small, affine, (rw, rh))
            g = cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY)
            center = np.zeros((rh, rw), bool)
            center[rh//6:rh*5//6, rw//6:rw*5//6] = True
            mask = valid & center & (gray > 12)
            if mask.sum() < 1000 or np.std(gray[mask]) < 12 or np.std(g[mask]) < 12:
                return None
            corr = float(np.corrcoef(g[mask], gray[mask])[0, 1])
            diff = np.abs(aligned.astype(np.float32) - ref.astype(np.float32))
            error = float(diff[mask].mean())
            bad = float((diff.mean(axis=2)[mask] > 30).mean())
            if not math.isfinite(corr) or corr < .97 or error > 12 or bad > .045:
                return None
            inverse = cv2.invertAffineTransform(affine)
            corners = cv2.transform(np.float32([[[0, 0], [rw, 0], [rw, rh], [0, rh]]]), inverse)[0] / scale
            left, top = np.maximum(0, np.floor(corners.min(axis=0))).astype(int)
            right, bottom = np.minimum([width, height], np.ceil(corners.max(axis=0))).astype(int)
            if min(right-left, bottom-top) < 64:
                return None
            result = {"frame": index, "seconds": index/fps, "correlation": corr,
                      "error": error, "inliers": int(inliers.sum()),
                      "crop": [int(left), int(top), int(right-left), int(bottom-top)]}
            checked[index] = result
            return result

        step = max(1, math.ceil(count / 100))
        indices = list(dict.fromkeys([min(count-1, round(t*fps/5)) for t in range(16)] + list(range(0, count, step)) + [count-1]))
        best = None
        for index in indices:
            current = evaluate(index)
            if current and (best is None or current['error'] < best['error']):
                best = current
            if best and best['error'] < 4 and best['correlation'] > .99:
                break
        if best is None:
            raise ValueError("no_reliable_hd_match")
        radius = min(45, max(step, math.ceil(fps/5)))
        for index in range(max(0, best['frame']-radius), min(count, best['frame']+radius+1)):
            current = evaluate(index)
            if current and current['error'] < best['error']:
                best = current
        cap.set(cv2.CAP_PROP_POS_FRAMES, best['frame'])
        ok, frame = cap.read()
        if not ok:
            raise ValueError("video_decode_failed")
        left, top, w, h = best['crop']
        crop = frame[top:top+h, left:left+w]
        ok, encoded = cv2.imencode('.png', crop)
        if not ok:
            raise ValueError("image_encode_failed")
        with open(output, 'xb') as file:
            file.write(encoded.tobytes())
        return {**best, "width": w, "height": h, "videoWidth": width, "videoHeight": height, "checked": len(checked), "source": "video_frame"}
    finally:
        cap.release()


if __name__ == '__main__':
    try:
        request = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
        if request.get('mode') == 'probe':
            cap = cv2.VideoCapture(request['video'])
            try:
                if not cap.isOpened():
                    raise ValueError('video_decode_failed')
                result = {'width': int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), 'height': int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))}
            finally:
                cap.release()
        else:
            result = match_cover(request['video'], request['reference'], request['output'])
        print(json.dumps({"ok": True, **result}), flush=True)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}), flush=True)
        sys.exit(1)
