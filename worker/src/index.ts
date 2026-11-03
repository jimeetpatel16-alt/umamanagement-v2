interface Env { DB:D1Database; EVIDENCE:R2Bucket; ASSETS:Fetcher; BOOTSTRAP_SECRET:string; SESSION_DAYS?:string }
type U={id:string;name:string;email:string;role:string;company_id:string|null;driver_id:string|null;labour_id:string|null;active:number};
const now=()=>new Date().toISOString(), uid=()=>crypto.randomUUID();
const out=(v:unknown,s=200)=>new Response(JSON.stringify(v),{status:s,headers:{"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"strict-origin-when-cross-origin"}});
const err=(m:string,s=400)=>out({error:m},s);
async function digest(v:string){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function hashPass(p:string,salt=crypto.getRandomValues(new Uint8Array(16))){const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(p),"PBKDF2",false,["deriveBits"]);const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations:100000,hash:"SHA-256"},k,256);const h=(a:Uint8Array)=>[...a].map(x=>x.toString(16).padStart(2,"0")).join("");return `pbkdf2$${h(salt)}$${h(new Uint8Array(bits))}`}
async function checkPass(p:string,s:string){const a=s.split("$");if(a.length!==3||a[0]!=="pbkdf2")return false;const salt=new Uint8Array(a[1].match(/../g)!.map(x=>parseInt(x,16)));return await hashPass(p,salt)===s}

function normalizeMobile(value: string) {
  let n = String(value || "").replace(/[^\d+]/g, "");

  // Convert Australian mobile formats to E.164.
  if (/^04\d{8}$/.test(n)) n = "+61" + n.slice(1);
  else if (/^614\d{8}$/.test(n)) n = "+" + n;
  else if (/^61\d{9}$/.test(n)) n = "+" + n;

  if (!/^\+[1-9]\d{7,14}$/.test(n)) {
    return null;
  }

  return n;
}

async function makePinHash(pin: string) {
  if (!/^\d{4}$/.test(pin)) {
    throw new Error("PIN must contain exactly four digits");
  }

  return await hashPass(pin);
}

async function makeLoginKey(mobile: string) {
  return await digest("UMA_LOGIN:" + mobile);
}

async function createLoginSession(
  e: Env,
  u: any
) {
  const t = crypto.randomUUID() + crypto.randomUUID();
  const days = Math.min(
    30,
    Math.max(1, Number(e.SESSION_DAYS) || 7)
  );

  await e.DB.prepare(
    "INSERT INTO sessions VALUES(?,?,?,?)"
  ).bind(
    await digest(t),
    u.id,
    new Date(Date.now() + days * 864e5).toISOString(),
    now()
  ).run();

  const res = out({
    user: {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      companyId: u.company_id,
      driverId: u.driver_id,
      labourId: u.labour_id
    }
  });

  res.headers.append(
    "set-cookie",
    `uma=${encodeURIComponent(t)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${days * 86400}`
  );

  return res;
}
function token(req:Request){return (req.headers.get("cookie")||"").split(";").map(x=>x.trim()).find(x=>x.startsWith("uma="))?.slice(4)}
async function current(req:Request,e:Env){const t=token(req);if(!t)return null;return await e.DB.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>? AND u.active=1").bind(await digest(decodeURIComponent(t)),now()).first<U>()}
async function audit(e:Env,u:string,a:string,t:string,id:string|null){await e.DB.prepare("INSERT INTO audit_log VALUES(?,?,?,?,?,?,?)").bind(uid(),u,a,t,id,null,now()).run()}
const jsonBody=async(r:Request)=>{try{return await r.json<any>()}catch{return null}};
async function route(r:Request,e:Env){
 const p=new URL(r.url).pathname,m=r.method;
 if(p==="/api/health")return out({ok:true,service:"UMA Management V2"});
 if(p==="/api/bootstrap"&&m==="POST"){
  if(!e.BOOTSTRAP_SECRET||r.headers.get("x-bootstrap-secret")!==e.BOOTSTRAP_SECRET)return err("Not authorised",401);
  const n=await e.DB.prepare("SELECT COUNT(*) n FROM users WHERE role='admin'").first<any>();if(n?.n)return err("Bootstrap closed",409);
  const b=await jsonBody(r);if(!b?.name||!b?.email||!b?.password||b.password.length<14)return err("Name, email and 14+ character password required");
  const id=uid();await e.DB.prepare("INSERT INTO users(id,name,email,password_hash,role,active,created_at,updated_at) VALUES(?,?,?,?, 'admin',1,?,?)").bind(id,b.name,b.email.toLowerCase(),await hashPass(b.password),now(),now()).run();return out({ok:true},201);
 }
 if (p === "/api/login" && m === "POST"){
  const b=await jsonBody(r);if(!b?.email||!b?.password)return err("Email and password required");
  const u=await e.DB.prepare("SELECT * FROM users WHERE email=?").bind(b.email.toLowerCase()).first<any>();
  if(!u||!u.active||!await checkPass(b.password,u.password_hash))return err("Invalid login details",401);
  const t=crypto.randomUUID()+crypto.randomUUID(),days=Math.min(30,Math.max(1,Number(e.SESSION_DAYS)||7));
  await e.DB.prepare("INSERT INTO sessions VALUES(?,?,?,?)").bind(await digest(t),u.id,new Date(Date.now()+days*864e5).toISOString(),now()).run();
  const res=out({user:{id:u.id,name:u.name,email:u.email,role:u.role,companyId:u.company_id,driverId:u.driver_id,labourId:u.labour_id}});
  res.headers.append("set-cookie",`uma=${encodeURIComponent(t)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${days*86400}`);return res;
 }
 if(p==="/api/logout"&&m==="POST"){const t=token(r);if(t)await e.DB.prepare("DELETE FROM sessions WHERE id_hash=?").bind(await digest(decodeURIComponent(t))).run();const x=out({ok:true});x.headers.append("set-cookie","uma=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");return x}
 const u=await current(r,e);
 if(p==="/api/me")return u?out({user:{id:u.id,name:u.name,email:u.email,role:u.role,companyId:u.company_id,driverId:u.driver_id,labourId:u.labour_id}}):err("Sign in required",401);
 if(!u)return err("Sign in required",401);
  // ADMIN ONLY: assign or update a user's mobile number and PIN.
const pinSetup = p.match(/^\/api\/users\/([^/]+)\/pin$/);

if (pinSetup && m === "POST") {
  if (u.role !== "admin") {
    return err("Admin access required", 403);
  }

  const b = await jsonBody(r);
  if (!b) return err("Invalid request");

  const mobile = normalizeMobile(String(b.mobile || ""));
  const pin = String(b.pin || "");

  if (!mobile) {
    return err("Enter a valid mobile number");
  }

  if (!/^\d{4}$/.test(pin)) {
    return err("PIN must contain exactly four digits");
  }

  const targetId = pinSetup[1];

  const target = await e.DB.prepare(
    "SELECT id FROM users WHERE id=?"
  ).bind(targetId).first<any>();

  if (!target) {
    return err("User account not found", 404);
  }

  const existing = await e.DB.prepare(
    "SELECT id FROM users WHERE mobile=? AND id<>?"
  ).bind(mobile, targetId).first<any>();

  if (existing) {
    return err("This mobile number is already assigned to another user", 409);
  }

  const pinHash = await makePinHash(pin);

  await e.DB.prepare(`
    UPDATE users
    SET mobile=?, pin_hash=?, updated_at=?
    WHERE id=?
  `).bind(mobile, pinHash, now(), targetId).run();

  await audit(e, u.id, "USER_PIN_UPDATED", "users", targetId);

  return out({ ok: true, message: "Mobile number and PIN updated" });
}
 if(p==="/api/dashboard"){
  if(!["admin","manager","staff"].includes(u.role))return err("Forbidden",403);
  const scope=u.role==="admin"||u.role==="manager"?"":" WHERE company_id=?";
  const bind=u.role==="admin"||u.role==="manager"?[]:[u.company_id||""];
  const count=async(t:string)=>{const x=await e.DB.prepare(`SELECT COUNT(*) n FROM ${t}${scope}`).bind(...bind).first<any>();return x?.n||0};
  return out({companies:await count("companies"),drivers:await count("drivers"),labour:await count("labour"),days:await count("delivery_days")});
 }
 if(p==="/api/users"&&m==="GET"){
  if(!["admin","manager"].includes(u.role))return err("Forbidden",403);
  const q=await e.DB.prepare("SELECT id,name,email,mobile,role,company_id,driver_id,labour_id,active,created_at FROM users ORDER BY created_at DESC").all();return out(q.results);
 }
 if (p === "/api/users" && m === "POST") {
  if (u.role !== "admin") return err("Admin only", 403);

  const b = await jsonBody(r);

  if (
    !b?.name ||
    !b?.email ||
    !b?.password ||
    b.password.length < 14 ||
    !["admin", "manager", "staff", "driver", "labour"].includes(b.role)
  ) {
    return err("Valid account details required");
  }

  const mobile = normalizeMobile(String(b.mobile || ""));
  const pin = String(b.pin || "");

  if (!mobile) return err("Enter a valid mobile number");
  if (!/^\d{4}$/.test(pin)) return err("PIN must contain exactly four digits");

  const existing = await e.DB.prepare(
    "SELECT id FROM users WHERE mobile=?"
  ).bind(mobile).first<any>();

  if (existing) return err("This mobile number is already assigned", 409);

  const id = uid();
  const pinHash = await makePinHash(pin);

  await e.DB.prepare(`
    INSERT INTO users(
      id,name,email,password_hash,pin_hash,mobile,role,
      company_id,driver_id,labour_id,active,created_at,updated_at
    )
    VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)
  `).bind(
    id,
    b.name,
    b.email.toLowerCase(),
    await hashPass(b.password),
    pinHash,
    mobile,
    b.role,
    b.companyId || null,
    b.driverId || null,
    b.labourId || null,
    now(),
    now()
  ).run();

  await audit(e, u.id, "create", "user", id);
  return out({ id }, 201);
}
 const action=p.match(/^\/api\/users\/([^/]+)\/(disable|enable|delete)$/);
 if(action&&m==="POST"){
  if(u.role!=="admin")return err("Admin only",403);const [,target,op]=action;
  const victim=await e.DB.prepare("SELECT id,role FROM users WHERE id=?").bind(target).first<any>();if(!victim)return err("Account not found",404);
  if(victim.role==="admin"&&op!=="enable"){const n=await e.DB.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1").first<any>();if(n.n<=1)return err("Cannot disable or delete the last active Admin",409)}
  if(target===u.id)return err("Cannot modify your own account",409);
  if(op==="delete")await e.DB.prepare("DELETE FROM users WHERE id=?").bind(target).run();else await e.DB.prepare("UPDATE users SET active=?,updated_at=? WHERE id=?").bind(op==="enable"?1:0,now(),target).run();
  await e.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(target).run();await audit(e,u.id,op,"user",target);return out({ok:true});
 }
 const map:Record<string,{table:string;roles:string[]}>={
  "/api/companies":{table:"companies",roles:["admin","manager","staff"]},"/api/drivers":{table:"drivers",roles:["admin","manager","staff"]},
  "/api/labour":{table:"labour",roles:["admin","manager","staff"]},"/api/delivery-days":{table:"delivery_days",roles:["admin","manager","staff"]},
  "/api/submissions":{table:"driver_submissions",roles:["admin","manager","staff","driver"]},"/api/labour-shifts":{table:"labour_shifts",roles:["admin","manager","staff","labour"]},
  "/api/invoices":{table:"invoices",roles:["admin","manager"]},"/api/blocks":{table:"delivery_blocks",roles:["admin","manager","staff"]},
  "/api/assignments":{table:"driver_assignments",roles:["admin","manager","staff"]},"/api/rate-cards":{table:"rate_cards",roles:["admin","manager","staff"]}
 };
 if(map[p]&&m==="GET"){
  if(!map[p].roles.includes(u.role))return err("Forbidden",403);const t=map[p].table;
  const scoped=!["admin","manager"].includes(u.role)&&t!=="companies";
  const q=await e.DB.prepare(`SELECT * FROM ${t}${scoped?" WHERE company_id=?":""} ORDER BY created_at DESC LIMIT 500`).bind(...(scoped?[u.company_id||""]:[])).all();return out(q.results);
 }
 if(p==="/api/evidence"&&m==="POST"){
  if(!["admin","manager","staff","driver"].includes(u.role))return err("Forbidden",403);
  const f=await r.formData(),file=f.get("file");if(!(file instanceof File)||file.size>10*1024*1024)return err("File must be under 10MB");
  if(!["image/jpeg","image/png","image/webp","application/pdf"].includes(file.type))return err("Unsupported evidence type");
  const key=`evidence/${u.company_id||"admin"}/${u.id}/${uid()}`;await e.EVIDENCE.put(key,file.stream(),{httpMetadata:{contentType:file.type}});return out({key},201);
 }
 return err("API route not found",404);
}
export default {async fetch(r:Request,e:Env){try{if(new URL(r.url).pathname.startsWith("/api/"))return await route(r,e);return e.ASSETS.fetch(r)}catch(ex){console.error(ex);return err("Server error",500)}}};
