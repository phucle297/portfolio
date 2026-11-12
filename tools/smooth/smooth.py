# frame-to-frame smoothness check: python3 smooth.py <dir> <glob> <label>
import sys,glob,json,numpy as np
from PIL import Image
d,pat,label=sys.argv[1],sys.argv[2],sys.argv[3]
fs=sorted(glob.glob(f'{d}/{pat}'))
prev=None;full=[];blk=[];green=0
for f in fs:
  im=Image.open(f).convert('RGB'); a=np.asarray(im).astype(np.int16)
  R,G,B=a[...,0],a[...,1],a[...,2]; green+=int(((G>R+12)&(G>B+12)&(G>40)).sum())
  g=np.asarray(im.convert('L').resize((320,200),Image.BILINEAR)).astype(np.float32)
  if prev is not None:
    dif=np.abs(g-prev); full.append(float(dif.mean()))
    blk.append(float(dif.reshape(10,20,20,16).mean(axis=(1,3)).max()))  # worst 32x20 block of a 320x200 grid
  prev=g
def spikes(x,k=8,ratio=3.0,floor=1.5):
  x=np.array(x);out=[]
  for i in range(len(x)):
    nb=np.r_[x[max(0,i-k):i],x[i+1:i+1+k]]; m=float(np.median(nb))
    if x[i]>floor and x[i]>ratio*max(m,.3): out.append((i,i+1,round(float(x[i]),2),round(m,2)))
  return out
r={'label':label,'frames':len(fs),'pairs':len(full),
 'mean_abs_diff':{'median':round(float(np.median(full)),3),'p95':round(float(np.percentile(full,95)),3),'max':round(float(max(full)),3),'at_pair':int(np.argmax(full))},
 'worst_block':{'median':round(float(np.median(blk)),3),'p95':round(float(np.percentile(blk,95)),3),'max':round(float(max(blk)),3),'at_pair':int(np.argmax(blk))},
 'spikes_mean(>3x local median & >1.5)':spikes(full),'spikes_block(>3x local median & >6)':spikes(blk,floor=6.0),'green_px_total':green}
print(json.dumps(r))
np.savetxt(f'{d}/../diff_{label}.csv',np.c_[full,blk],delimiter=',',header='mean_abs_diff,worst_block_diff (0-255 gray, 320x200)',fmt='%.4f',comments='')
