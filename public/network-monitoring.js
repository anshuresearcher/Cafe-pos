"use strict";
(function(){
 const $=id=>document.getElementById(id);
 let activeRange="today",customFrom="",customTo="",activeDimension="",activePage=1,detailHasMore=false;
 const numberFmt=new Intl.NumberFormat("en-IN");
 function fmtNum(v){return numberFmt.format(Number(v||0))}
 function fmtBytes(value){let n=Math.max(0,Number(value)||0);if(n<1024)return Math.round(n)+" B";const units=["KB","MB","GB","TB"];n/=1024;let i=0;while(n>=1024&&i<units.length-1){n/=1024;i++}return n.toFixed(n>=100?0:2)+" "+units[i]}
 function safe(v){return String(v??"").replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]))}
 function notice(text,error){const el=$("notice");el.textContent=text;el.classList.toggle("error",!!error);el.hidden=!text}
 function localDate(){const d=new Date();return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")}
 function rangeParams(){const p=new URLSearchParams({range:activeRange});if(activeRange==="custom"){p.set("from",customFrom);p.set("to",customTo)}return p}
 async function api(url){const r=await fetch(url,{credentials:"same-origin",headers:{Accept:"application/json"}});let d={};try{d=await r.json()}catch(_){}if(r.status===401){location.href="/support";throw new Error("Your support session expired. Sign in again.")}if(!r.ok)throw new Error(d.error||"Could not load monitoring data.");return d}
 function renderSummary(d){
  const o=d.overview||{};$("apiRequests").textContent=fmtNum(o.apiRequests);$("responseData").textContent=fmtBytes(o.responseBytes);$("averageSize").textContent=fmtBytes(o.averageResponseBytes);$("averageTime").textContent=(Number(o.averageResponseTimeMs||0).toFixed(1))+" ms";$("failedRequests").textContent=fmtNum(o.failedRequests);$("databaseData").textContent=fmtBytes(o.estimatedDbResultBytes);$("dbQueries").textContent=fmtNum(o.dbQueryCount);$("dbErrors").textContent=fmtNum(o.dbErrorCount);
  renderDaily(d.daily||[]);renderTop(d.topEndpoints||[]);
  const m=d.monitoring||{};$("monitorWrites").textContent=fmtNum(m.monitoringBatchWrites);$("monitorReads").textContent=fmtNum(m.monitoringDatabaseReads);$("monitorRequests").textContent=fmtNum(m.monitoringApiRequests);$("monitorStorage").textContent=fmtBytes(d.storageBytes);$("monitorTransfer").textContent=fmtBytes((Number(m.monitoringApiResponseBytes)||0)+(Number(m.estimatedDatabaseWritePayloadBytes)||0)+(Number(m.estimatedDatabaseReadPayloadBytes)||0));$("monitorBuffer").textContent=fmtNum(m.bufferedRequests)+" / "+fmtNum(m.droppedRequests);$("monitorFailures").textContent=fmtNum(m.flushFailures);$("monitorCache").textContent=fmtNum(m.cacheHits)+" hits / "+fmtNum(m.cacheMisses)+" misses";
  const rate=Math.round((Number(m.dbResultSizeSampleRate)||0)*100);$("runtimeNote").textContent=(d.limitations?.runtime||"")+(rate?(" Database result sizes are sampled at about "+rate+"% and scaled to estimates."):" Database result size sampling is disabled.");
  $("updatedAt").textContent="Updated "+new Date().toLocaleTimeString();
 }
 function renderDaily(rows){
  const el=$("dailyChart");if(!rows.length){el.innerHTML='<div class="empty">No saved usage data for this range yet.</div>';return}
  const max=Math.max(1,...rows.map(x=>Number(x.responseBytes)||0));
  el.innerHTML=rows.map(x=>'<div class="barrow"><span class="barlabel">'+safe(x.day)+'</span><div class="track"><div class="fill" style="width:'+Math.max(1,Math.round((Number(x.responseBytes)||0)/max*100))+'%"></div></div><b>'+safe(fmtBytes(x.responseBytes))+'</b></div>').join("");
 }
 function renderTop(rows){
  const el=$("topEndpointRows");if(!rows.length){el.innerHTML='<tr><td colspan="4" class="empty">No saved usage data for this range yet.</td></tr>';return}
  el.innerHTML=rows.map(x=>'<tr><td><code>'+safe(x.method)+" "+safe(x.endpoint)+'</code></td><td>'+safe(x.feature)+'</td><td>'+safe(fmtNum(x.requests))+'</td><td>'+safe(fmtBytes(x.responseBytes))+'</td></tr>').join("");
 }
 async function loadSummary(){
  $("refreshButton").disabled=true;notice("Loading monitoring summary...",false);
  try{const d=await api("/api/support/network-monitoring/summary?"+rangeParams().toString());renderSummary(d);notice("",false);if(activeDimension)await loadDetails(activeDimension,activePage,false)}
  catch(e){notice(e.message,true)}
  finally{$("refreshButton").disabled=false}
 }
 const columns={
  endpoints:[["method","Method"],["endpoint","Endpoint"],["feature","Feature"],["requests","Requests"],["response_bytes","Response data"],["average_response_time_ms","Avg. time"],["errors","Errors"],["db_queries","DB queries"],["estimated_db_result_bytes","Estimated DB data"]],
  businesses:[["business_id","Business ID"],["business_name","Business"],["requests","Requests"],["response_bytes","Response data"],["errors","Errors"],["estimated_db_result_bytes","Estimated DB data"],["top_endpoint","Most used endpoint"]],
  devices:[["business_name","Business"],["device_name","Device"],["device_id","Device ID"],["requests","Requests"],["response_bytes","Response data"],["errors","Errors"],["last_activity_at","Last activity"]],
  features:[["feature","Feature"],["requests","Requests"],["response_bytes","Response data"],["average_response_time_ms","Avg. time"],["errors","Errors"],["db_queries","DB queries"],["estimated_db_result_bytes","Estimated DB data"]]
 };
 function cellValue(key,value){if(key.includes("bytes"))return fmtBytes(value);if(key==="average_response_time_ms")return Number(value||0).toFixed(1)+" ms";if(key==="last_activity_at")return value?new Date(value).toLocaleString():"-";if(["requests","errors","db_queries","business_id"].includes(key))return fmtNum(value);return value??"-"}
 async function loadDetails(dimension,page,showMessage=true){
  activeDimension=dimension;activePage=page;detailHasMore=false;
  document.querySelectorAll("[data-dimension]").forEach(b=>b.classList.toggle("active",b.dataset.dimension===dimension));
  $("detailArea").classList.remove("hidden");$("detailState").textContent="Loading "+dimension+"...";
  if(showMessage)notice("",false);
  const p=rangeParams();p.set("dimension",dimension);p.set("page",String(page));
  try{
   const d=await api("/api/support/network-monitoring/details?"+p.toString());detailHasMore=!!d.hasMore;
   $("detailHead").innerHTML="<tr>"+columns[dimension].map(x=>"<th>"+safe(x[1])+"</th>").join("")+"</tr>";
   const rows=d.rows||[];$("detailRows").innerHTML=rows.length?rows.map(row=>"<tr>"+columns[dimension].map(([key])=>"<td>"+safe(cellValue(key,row[key]))+"</td>").join("")+"</tr>").join(""):'<tr><td class="empty" colspan="'+columns[dimension].length+'">No rows for this date range.</td></tr>';
   $("pageLabel").textContent="Page "+d.page;$("previousPage").disabled=d.page<=1;$("nextPage").disabled=!d.hasMore;$("detailState").textContent="";
  }catch(e){$("detailState").textContent=e.message;notice(e.message,true)}
 }
 $("rangeSelect").addEventListener("change",()=>{$("customDates").hidden=$("rangeSelect").value!=="custom"});
 $("applyButton").addEventListener("click",()=>{activeRange=$("rangeSelect").value;if(activeRange==="custom"){customFrom=$("fromDate").value;customTo=$("toDate").value;if(!customFrom||!customTo){notice("Choose both custom dates before applying.",true);return}}activeDimension="";$("detailArea").classList.add("hidden");$("detailState").textContent="Select a section to load details.";loadSummary()});
 $("refreshButton").addEventListener("click",loadSummary);
 document.querySelectorAll("[data-dimension]").forEach(button=>button.addEventListener("click",()=>loadDetails(button.dataset.dimension,1)));
 $("previousPage").addEventListener("click",()=>{if(activePage>1)loadDetails(activeDimension,activePage-1)});
 $("nextPage").addEventListener("click",()=>{if(detailHasMore)loadDetails(activeDimension,activePage+1)});
 $("rangeSelect").value="today";$("fromDate").value=localDate();$("toDate").value=localDate();loadSummary();
})();