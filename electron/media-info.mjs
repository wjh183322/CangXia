// Read only bounded headers; do not execute codecs or external programs.
export function imageDimensions(b) {
  try {
    if (b.length >= 24 && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { width:b.readUInt32BE(16), height:b.readUInt32BE(20) };
    if (b.length >= 4 && b[0] === 255 && b[1] === 216) {
      let offset=2;
      for(let step=0;step<10000 && offset+4<b.length;step++) {
        if(b[offset]!==255){offset++;continue;}
        const marker=b[offset+1];if(marker===255){offset++;continue;}
        if(marker===0xd9||marker===0xda)break;
        if(marker===0x01||(marker>=0xd0&&marker<=0xd7)){offset+=2;continue;}
        const length=b.readUInt16BE(offset+2); if(length<2||offset+2+length>b.length)break;
        if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&length>=7)return {width:b.readUInt16BE(offset+7),height:b.readUInt16BE(offset+5)};
        offset+=length+2;
      }
    }
    if(b.length>=30&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP'){
      const type=b.toString('ascii',12,16);
      if(type==='VP8X')return {width:1+b.readUIntLE(24,3),height:1+b.readUIntLE(27,3)};
      if(type==='VP8 ')return {width:b.readUInt16LE(26)&0x3fff,height:b.readUInt16LE(28)&0x3fff};
      if(type==='VP8L'&&b[20]===0x2f){const bits=b.readUInt32LE(21);return {width:(bits&0x3fff)+1,height:((bits>>>14)&0x3fff)+1};}
    }
  } catch {}
  return { width:null, height:null };
}
