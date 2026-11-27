const fs=require("fs"),path=require("path"),crypto=require("crypto");
const PASS=process.env.SHARE_PASS||"";
const ITER=600000;
const SALT=crypto.createHash("sha256").update("looki-share-v1:salt").digest().subarray(0,16);
let bad=0,n=0,skipped=0;
for(const f of fs.readdirSync("d").filter(x=>/^\d{4}-\d{2}-\d{2}\.html$/.test(x))){
  const h=fs.readFileSync(path.join("d",f),"utf8");
  const a=h.indexOf("var E="); if(a<0)continue;
  const i=h.indexOf("{",a); let d=0,q=false,esc=false,j=i;
  for(;j<h.length;j++){const c=h[j];
    if(q){if(esc)esc=false;else if(c==="\\")esc=true;else if(c==='"')q=false;continue}
    if(c==='"'){q=true;continue}
    if(c==="{")d++;else if(c==="}"){d--;if(!d)break}}
  let E; try{E=JSON.parse(h.slice(i,j+1))}catch{skipped++;console.log(`  ! ${f} 头信息解不开，跳过`);continue}
  const iv=Buffer.from(E.iv,"base64"),ct=Buffer.from(E.ct,"base64");
  const tag=ct.subarray(ct.length-16),body=ct.subarray(0,ct.length-16);
  const k=crypto.pbkdf2Sync(PASS,SALT,ITER,32,"sha256");
  const dc=crypto.createDecipheriv("aes-256-gcm",k,iv); dc.setAuthTag(tag);
  let p; try{p=JSON.parse(Buffer.concat([dc.update(body),dc.final()]).toString("utf8"))}catch(e){skipped++;console.log(`  ! ${f} 解不开（${e.message}），跳过`);continue}
  const rels=new Set();
  const add=r=>{if(r&&(r.startsWith("i/")||r.startsWith("m/")))rels.add(r)};
  if(p.journal){add(p.journal.img);add(p.journal.full)}
  if(p.comic){add(p.comic.src);add(p.comic.full)}
  if(p.vlog){add(p.vlog.poster);add(p.vlog.src)}
  for(const it of p.items||[]){add(it.img);add(it.full)}
  let lb=0;
  for(const r of rels){n++; if(!fs.existsSync(r)){bad++;lb++;console.log(`  ✗ ${f} 引用不存在的文件：${r}`)}}
  console.log(`  · ${f} ${rels.size} 个引用，缺 ${lb}`);
}
console.log(`  自检：${n} 个引用，缺 ${bad} 个${skipped?`，跳过 ${skipped} 页`:""}`);
