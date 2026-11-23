"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { main } = require("../src/cli");
const { runFeedback } = require("../src/feedback");
const { WinkClient } = require("../src/wink_client");
const { ENVIRONMENTS } = require("../src/runtime_config");
async function capture(fn) {
  const write = process.stdout.write, error = process.stderr.write;
  let out = "", err = "";
  process.stdout.write = s => {out += s; return true;};
  process.stderr.write = s => {err += s; return true;};
  try {return {code: await fn(), out, err};}
  finally {process.stdout.write = write;process.stderr.write = error;}
}
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wink-feedback-test-"));
  let server;
  try {
    const file = path.join(root, "content.txt");
    const original = '公共协议不一致\n"api_key":"secret-json"\n--access-token secret-cli\nCookie: secret-cookie\nBearer secret-bearer\nhttps://private.invalid/x?k=secret-url\n/Users/private-user/photo.jpg\nuser@example.com\n13812345678';
    fs.writeFileSync(file, original);
    const pre = {env: "pre", baseUrl: ENVIRONMENTS.pre};
    const flags = {type: "bug", "content-file": file, "context-id": "task-1", json: true};
    const sent = [];
    const services = {homeDir: root, readCredential: () => "test-key", createClient: opts => {
      assert.equal(opts.baseUrl, ENVIRONMENTS.pre);
      return {submitFeedback: async body => {sent.push(body);return {code: 0, data: {feedback_id: "321"}};}};
    }};
    const first = await capture(() => main(["feedback", "--env", "pre", "--type", "bug", "--content-file", file, "--context-id", "task-1", "--json"], services));
    assert.equal(first.code, 0);assert.equal(JSON.parse(first.out).feedback_id, "321");
    assert.equal(sent.length, 1);assert.equal(sent[0].client_id, "1189857724");assert(!Object.hasOwn(sent[0], "channel"));
    for (const secret of ["secret-json", "secret-cli", "secret-cookie", "secret-bearer", "secret-url", "private-user", "user@example.com", "13812345678"]) {
      assert(!JSON.stringify(sent).includes(secret), secret+" leaked");
    }
    assert.equal(fs.readFileSync(file,"utf8"), original, "never modify the source text");
    const duplicate = await capture(() => runFeedback(flags, pre, services));
    assert.equal(JSON.parse(duplicate.out).reason,"duplicate");assert.equal(sent.length,1);
    for (const env of ["release","beta"]) {
      let calls=0;
      const r=await capture(() => runFeedback(flags,{env,baseUrl:ENVIRONMENTS[env]}, {...services,
        readCredential:base=>{assert.equal(base,ENVIRONMENTS[env]);return env+"-key";},
        createClient:opts=>{assert.equal(opts.baseUrl,ENVIRONMENTS[env]);assert.equal(opts.apiKey,env+"-key");
          return {submitFeedback:async()=>{calls++;return {code:0,data:{feedback_id:"322"}};}};}}));
      assert.equal(JSON.parse(r.out).status,"submitted");assert.equal(calls,1);
    }
    for(const baseUrl of ["http://localhost:1234",ENVIRONMENTS.release]) {
      const r=await capture(()=>runFeedback(flags,{env:"pre",baseUrl},{readCredential:()=>{throw new Error("must not read auth for mismatched endpoints");}}));
      assert.equal(JSON.parse(r.out).reason,"official_environment_only");
    }
    const missing=await capture(()=>runFeedback(flags,pre,{readCredential:()=>""}));
    assert.equal(JSON.parse(missing.out).reason,"not_connected");
    const silentFlags={...flags,silent:true,"context-id":"timeout-1"};let attempts=0;
    const failing={...services,createClient:()=>({submitFeedback:async()=>{attempts++;throw new Error("secret-network-error");}})};
    for(let i=0;i<2;i++){
      const r=await capture(()=>runFeedback(silentFlags,pre,failing));assert.equal(r.code,0);assert.equal(r.out+r.err,"");
    }
    assert.equal(attempts,1,"unknown result must not be resubmitted");
    fs.writeFileSync(file,"😀".repeat(2000));
    assert.equal((await capture(()=>runFeedback({...flags,"context-id":"unicode"},pre,services))).code,0);
    assert.equal(Array.from(sent[sent.length-1].content).length,2000,"feedback must preserve valid Unicode content");
    fs.writeFileSync(file,"😀".repeat(2001));
    assert.equal((await capture(()=>runFeedback({...flags,"context-id":"too-long"},pre,services))).code,1);
    fs.writeFileSync(file," ");
    assert.equal((await capture(()=>runFeedback({...flags,silent:true},pre,services))).code,0);
    const invalid=await capture(()=>main(["feedback","--env","wrong","--silent"]));assert.equal(invalid.code,0);assert.equal(invalid.out+invalid.err,"");
    for(const marker of fs.readdirSync(path.join(root,".wink-mcp-server/feedback-attempts"))){
      assert(!marker.includes("test-key"));assert.equal(fs.readFileSync(path.join(root,".wink-mcp-server/feedback-attempts",marker),"utf8"),"attempted\n");
    }
    fs.writeFileSync(file,"测试公共问题摘要");
    for (const response of [{code:0,data:{}},{code:0,data:{feedback_id:900}},{code:10108}]) {
      const r=await capture(()=>runFeedback({...flags,"context-id":JSON.stringify(response)},pre,
        {...services,createClient:()=>({submitFeedback:async()=>response})}));
      assert.equal(r.code,1);assert.equal(JSON.parse(r.out).status,"unconfirmed");
    }
    let trickle=false;
    server=http.createServer(async(req,res)=>{
      if(trickle){
        res.writeHead(200,{"content-type":"application/json"});res.write("{");
        const timer=setInterval(()=>res.write(" "),100);
        res.on("close",()=>clearInterval(timer));return;
      }
      assert.equal(req.url,"/feedback/submit");assert.equal(req.headers.api_key,"fixture-key");assert.equal(req.headers["content-type"],"application/json");
      let text="";for await(const chunk of req)text+=chunk;
      assert.deepEqual(JSON.parse(text),{client_id:"1189857724",type:"other",content:"联调测试"});
      res.setHeader("content-type","application/json");res.end(JSON.stringify({code:0,data:{feedback_id:"900"}}));
    });
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const client=new WinkClient({baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:"fixture-key"});
    assert.equal((await client.submitFeedback({client_id:"1189857724",type:"other",content:"联调测试"})).data.feedback_id,"900");
    trickle=true;
    const started=Date.now();
    await assert.rejects(client.submitFeedback({client_id:"1189857724",type:"other",content:"timeout test"}));
    assert(Date.now()-started<4500,"slow responses must not keep feedback alive indefinitely");
    console.log("feedback: JSON protocol, existing auth, environment-scoped routing, redaction, silent failures, deduplication, Unicode limits and no retries passed");
  } finally {if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
