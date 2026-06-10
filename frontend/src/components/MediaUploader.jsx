// ═══════════════════════════════════════════════════════════
// MEDIA UPLOADER — extracted verbatim from App.jsx
// ═══════════════════════════════════════════════════════════
import { useState, useRef } from 'react';
import { C } from '../theme.js';

export default function MediaUploader({files,onAdd,onRemove}){
  const inputRef=useRef(null);
  const [dragging,setDragging]=useState(false);

  const handle=fs=>{
    const valid=Array.from(fs).filter(f=>f.type.startsWith("image/")||f.type.startsWith("video/"));
    valid.forEach(f=>{f.preview=URL.createObjectURL(f);});
    onAdd(valid);
  };

  return(
    <div>
      <div style={{background:C.amberF,border:`1px solid ${C.amber}33`,borderRadius:8,padding:'10px 14px',marginBottom:12,fontSize:12,color:C.dim,lineHeight:1.6}}>
        ⚠️ Please ensure photos do not include patients, patient faces, or any patient
        identifying information. Uploading patient PHI may violate HIPAA.
      </div>
      <input ref={inputRef} type="file" multiple accept="image/*,video/*" style={{display:"none"}} onChange={e=>handle(e.target.files)}/>
      <div
        onClick={()=>inputRef.current?.click()}
        onDragOver={e=>{e.preventDefault();setDragging(true);}}
        onDragLeave={()=>setDragging(false)}
        onDrop={e=>{e.preventDefault();setDragging(false);handle(e.dataTransfer.files);}}
        style={{border:`1.5px dashed ${dragging?C.amber:C.border}`,borderRadius:9,padding:"20px 16px",textAlign:"center",cursor:"pointer",transition:"border-color .2s",background:dragging?C.amberF:"transparent",marginBottom:12}}
      >
        <div style={{fontSize:22,marginBottom:6}}>📎</div>
        <div style={{fontSize:13,color:C.dim}}>Drop photos or videos here, or <span style={{color:C.amber,textDecoration:"underline"}}>browse</span></div>
        <div style={{fontSize:11,color:C.muted,marginTop:4}}>Photos of injury site, incident location, equipment — up to 10 files</div>
      </div>
      {files.length>0&&(
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(90px,1fr))",gap:8}}>
          {files.map((f,i)=>(
            <div key={i} style={{position:"relative",borderRadius:7,overflow:"hidden",border:`1px solid ${C.border}`,aspectRatio:"1",background:C.bg}}>
              {f.type.startsWith("image/")?
                <img src={f.preview} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:
                <div style={{width:"100%",height:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4}}>
                  <span style={{fontSize:24}}>🎬</span>
                  <span style={{fontSize:9,color:C.muted,textAlign:"center",padding:"0 4px"}}>{f.name?.slice(0,14)}</span>
                </div>}
              <button onClick={e=>{e.stopPropagation();onRemove(i);}} style={{position:"absolute",top:3,right:3,width:18,height:18,borderRadius:"50%",background:"rgba(0,0,0,.7)",border:"none",color:"#fff",cursor:"pointer",fontSize:10,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

