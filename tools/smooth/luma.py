# M2-AC7 "no black": mean luminance of every frame vs 0.6 x the darkest of the six key frames.
# usage: python3 luma.py <dir> <glob>   (frames are p = i / (n - 1))
import sys, glob, json
import numpy as np
from PIL import Image

d, pat = sys.argv[1], sys.argv[2]
fs = sorted(glob.glob(f'{d}/{pat}'))
n = len(fs)
lum = [float(np.asarray(Image.open(f).convert('L').resize((320, 200))).mean()) for f in fs]
keys = [0.03, 0.21, 0.41, 0.6, 0.76, 0.96]
key_lum = [lum[round(k * (n - 1))] for k in keys]
floor = 0.6 * min(key_lum)
below = [(i, round(v, 2)) for i, v in enumerate(lum) if v < floor]
print(json.dumps({'frames': n, 'key_luma': [round(v, 2) for v in key_lum], 'floor': round(floor, 2),
                  'min': round(min(lum), 2), 'at': int(np.argmin(lum)), 'below_floor': below,
                  'pass': not below}))
