import sys, json, hashlib
from pathlib import Path
sys.path.insert(0, str(Path('.test-output/audio-python-libs').resolve()))
import av
if len(sys.argv)!=2:
    raise SystemExit('Usage: python scripts/research-audio-decode.py .test-output/<research-folder>')
root=Path(sys.argv[1]).resolve()
if not root.is_relative_to(Path('.test-output').resolve()):
    raise SystemExit('Research folder must stay under .test-output')
report=json.loads((root/'report.json').read_text(encoding='utf-8'))
output={'decoder':'PyAV '+av.__version__,'objects':[]}
for obj in report['objects']:
    result={'sha256':obj['sha256'],'bytes':obj['bytes']}
    try:
        with av.open(str(root/obj['file'])) as container:
            stream=container.streams.audio[0]
            result.update(format=container.format.name,streamTypes=[s.type for s in container.streams],codec=stream.codec_context.name,sampleRate=stream.codec_context.sample_rate,channels=stream.codec_context.channels,containerDuration=container.duration/av.time_base if container.duration else None,streamDuration=float(stream.duration*stream.time_base) if stream.duration is not None else None)
            total=0;pcm=hashlib.sha256()
            for frame in container.decode(stream):
                total+=frame.samples
                pcm.update(frame.to_ndarray().tobytes())
            result.update(decodedSamples=total,decodedDuration=total/result['sampleRate'],decodedNativePCMHash=pcm.hexdigest(),decodeComplete=True)
    except Exception as e:
        result.update(decodeComplete=False,error=type(e).__name__)
    output['objects'].append(result)
(root/'decoded.json').write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
for sample in report['samples']:
    obj=next((x for x in output['objects'] if x['sha256']==sample.get('audio',{}).get('sha256')),None)
    if not obj:continue
    print(json.dumps({'id':sample['id'],'musicDuration':sample.get('music',{}).get('duration'),'album':sample.get('album'),'bytes':obj['bytes'],'format':obj.get('format'),'codec':obj.get('codec'),'decodedDuration':obj.get('decodedDuration'),'sampleRate':obj.get('sampleRate'),'channels':obj.get('channels'),'decodeComplete':obj['decodeComplete']},ensure_ascii=False))
