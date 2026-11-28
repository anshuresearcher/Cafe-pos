#!/usr/bin/env node
"use strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const TYPES = new Map([["image/jpeg","jpg"],["image/png","png"],["image/webp","webp"]]);
const ALLOWED_BUCKETS = new Set(["cafe-menu-items","cafe-category-images"]);
const MAX_BYTES = 10 * 1024 * 1024;

function parseArgs(argv) {
  const o = { ids: [], bucket: "slash-pos-assets-pilot", execute: false, yes: false };
  for (let i=0;i<argv.length;i++) {
    if (argv[i]==="--input") o.input=argv[++i];
    else if (argv[i]==="--business-id") o.ids.push(Number(argv[++i]));
    else if (argv[i]==="--bucket") o.bucket=argv[++i];
    else if (argv[i]==="--execute") o.execute=true;
    else if (argv[i]==="--yes") o.yes=true;
    else throw new Error("Usage: node scripts/migrate-images-to-r2.js --input <menu-pilot-data.sql> --business-id <id> [--business-id <id>] [--bucket <name>] [--execute]");
  }
  o.ids=[...new Set(o.ids)];
  if(!o.input||!o.ids.length) throw new Error("--input and at least one --business-id are required.");
  if(o.ids.some(id=>!Number.isSafeInteger(id)||id<=0)) throw new Error("Business IDs must be positive integers.");
  if(!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(o.bucket)) throw new Error("R2 bucket must be 3-63 lowercase letters, digits, or hyphens.");
  return o;
}

function getImages(sql, ids) {
  const allowed=new Set(ids.map(String)), found=new Map();
  const re=/https:\/\/[a-z0-9.-]+\.supabase\.co\/storage\/v1\/object\/public\/(cafe-menu-items|cafe-category-images)\/([A-Za-z0-9._%/-]+)/gi;
  for(const m of sql.matchAll(re)) {
    let objectPath;
    try { objectPath=m[2].split("/").map(decodeURIComponent).join("/"); }
    catch { throw new Error("Invalid URL encoding in an image path."); }
    const parts=objectPath.split("/");
    if(parts.some(p=>!p||p==="."||p===".."||p.includes("\\")||!/^[A-Za-z0-9._-]+$/.test(p))) throw new Error("Unsafe image object path found.");
    const businessId=parts[0];
    if(!allowed.has(businessId)) continue;
    const unique=businessId+"/"+m[1]+"/"+objectPath, sourceUrl=m[0];
    if(found.has(unique)&&found.get(unique).sourceUrl!==sourceUrl) throw new Error("Conflicting URLs for the same image path.");
    if(!found.has(unique)) found.set(unique,{businessId:Number(businessId),sourceBucket:m[1],sourcePath:objectPath,sourceUrl,destinationKey:"pilot/business-"+businessId+"/"+m[1]+"/"+objectPath});
  }
  return [...found.values()].sort((a,b)=>a.businessId-b.businessId||a.destinationKey.localeCompare(b.destinationKey));
}

function digest(data) { return createHash("sha256").update(data).digest("hex"); }

async function boundedBody(body) {
  const reader=body.getReader(), chunks=[]; let size=0;
  while(true) {
    const next=await reader.read(); if(next.done) break;
    size+=next.value.byteLength;
    if(size>MAX_BYTES) { await reader.cancel(); throw new Error("Image exceeds the 10 MB limit."); }
    chunks.push(Buffer.from(next.value));
  }
  return Buffer.concat(chunks,size);
}

function wrangler(args) {
  const win=process.platform==="win32";
  return new Promise((resolve,reject)=>{
    const child=spawn(win?"npx.cmd":"npx",["wrangler",...args],{
      cwd:path.dirname(fileURLToPath(import.meta.url)),
      stdio:["ignore","pipe","pipe"],
      shell:win
    });
    let stderr="";
    child.stdout.on("data",chunk=>process.stdout.write(chunk));
    child.stderr.on("data",chunk=>{stderr+=chunk.toString();process.stderr.write(chunk);});
    child.on("error",reject);
    child.on("close",code=>code===0?resolve():reject(new Error("Wrangler exited with code "+code+". "+stderr.slice(-400))));
  });
}
async function confirmCopy() {
  if(!process.stdin.isTTY) throw new Error("Interactive confirmation required. Run from PowerShell after reviewing the dry-run plan.");
  const rl=createInterface({input:process.stdin,output:process.stdout});
  try { if((await rl.question("Type COPY to begin the Supabase-to-R2 image transfer: ")).trim()!=="COPY") throw new Error("Copy cancelled."); }
  finally { rl.close(); }
}

async function copy(items,ids,bucket,reportPath,yes) {
  if(!yes) await confirmCopy();
  const tmpRoot=path.resolve(os.tmpdir()), tmp=fs.mkdtempSync(path.join(tmpRoot,"slash-r2-pilot-"));
  if(!path.resolve(tmp).startsWith(tmpRoot+path.sep)) throw new Error("Temporary path is outside the temp folder.");
  const results=new Array(items.length); let sourceBytes=0, nextIndex=0;
  async function processOne(i) {
    const item=items[i];
    try {
      const response=await fetch(item.sourceUrl,{redirect:"error",signal:AbortSignal.timeout(30000)});
      if(!response.ok) throw new Error("Supabase returned HTTP "+response.status+".");
      const bytes=await boundedBody(response.body); if(!bytes.length) throw new Error("Image is empty.");
      sourceBytes+=bytes.length;
      const type=String(response.headers.get("content-type")||"").split(";")[0].trim().toLowerCase(), ext=TYPES.get(type);
      if(!ext) throw new Error("Only JPEG, PNG, and WebP images are accepted.");
      const key=item.destinationKey.toLowerCase().endsWith("."+ext)?item.destinationKey:item.destinationKey+"."+ext;
      const object=bucket+"/"+key, file=path.join(tmp,i+"."+ext), verify=path.join(tmp,i+"-verify."+ext);
      const sourceHash=digest(bytes); fs.writeFileSync(file,bytes);
      console.log("Copy "+(i+1)+"/"+items.length+": "+key);
      await wrangler(["r2","object","put",object,"--file="+file,"--content-type="+type,"--remote"]);
      await wrangler(["r2","object","get",object,"--file="+verify,"--remote"]);
      if(digest(fs.readFileSync(verify))!==sourceHash) throw new Error("R2 checksum verification failed.");
      results[i]={key,bytes:bytes.length,contentType:type,sha256:sourceHash,status:"verified"};
    } catch(error) {
      results[i]={key:item.destinationKey,status:"failed",error:String(error.message||error).slice(0,200)};
      console.error("Failed: "+item.destinationKey+" - "+String(error.message||error));
    }
  }
  async function worker() {
    while(true) {
      const i=nextIndex++;
      if(i>=items.length) return;
      await processOne(i);
    }
  }
  try {
    await Promise.all(Array.from({length:Math.min(4,items.length)},()=>worker()));
  } finally {
    fs.rmSync(tmp,{recursive:true,force:true});
  }
  const report={completedAt:new Date().toISOString(),bucket,businessIds:ids,uniqueImages:items.length,verified:results.filter(r=>r.status==="verified").length,failed:results.filter(r=>r.status==="failed").length,sourceBytesDownloaded:sourceBytes,results};
  fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+"\n","utf8");
  console.log("Report: "+reportPath);
  console.log("Verified "+report.verified+"/"+report.uniqueImages+"; source bytes downloaded: "+sourceBytes);
  if(report.failed) process.exitCode=1;
}
async function main() {
  const o=parseArgs(process.argv.slice(2)), sql=fs.readFileSync(path.resolve(o.input),"utf8");
  const items=getImages(sql,o.ids), scriptDir=path.dirname(fileURLToPath(import.meta.url));
  const generated=path.resolve(scriptDir,"..","..","phase-1-menu-pilot","generated");
  fs.mkdirSync(generated,{recursive:true});
  const manifestPath=path.join(generated,"r2-image-manifest.json"), reportPath=path.join(generated,"r2-copy-report.json");
  fs.writeFileSync(manifestPath,JSON.stringify({createdAt:new Date().toISOString(),bucket:o.bucket,businessIds:o.ids,uniqueImages:items.length,items},null,2)+"\n","utf8");
  console.log("R2 copy plan (no live URLs or POS behavior will change):");
  console.log("  businesses: "+o.ids.join(", "));
  console.log("  bucket: "+o.bucket);
  console.log("  unique item/category images: "+items.length);
  for(const id of o.ids) console.log("  business "+id+": "+items.filter(i=>i.businessId===id).length);
  console.log("  manifest: "+manifestPath);
  if(o.execute) { if(!items.length) throw new Error("No matching menu/category images found."); await copy(items,o.ids,o.bucket,reportPath,o.yes); }
  else console.log("Dry run only. Review the manifest, create/select the R2 bucket, then add --execute.");
}

main().catch(error=>{console.error(error.message);process.exitCode=1;});
