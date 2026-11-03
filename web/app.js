const $=s=>document.querySelector(s),S={user:null,route:"dashboard"};
const names={dashboard:"Dashboard",companies:"Companies",drivers:"Drivers",labour:"Labour",days:"Delivery days",submissions:"Driver submissions",shifts:"Labour shifts",users:"Login accounts",invoices:"Invoices",blocks:"Delivery blocks",assignments:"Driver assignments",rates:"Rate cards",profile:"My profile"};
const menus={admin:Object.keys(names),manager:["dashboard","companies","drivers","labour","days","submissions","shifts","invoices","blocks","assignments","rates","profile"],staff:["dashboard","drivers","labour","days","submissions","shifts","blocks","assignments","profile"],driver:["submissions","profile"],labour:["shifts","profile"]};
const endpoints={companies:"companies",drivers:"drivers",labour:"labour",days:"delivery-days",submissions:"submissions",shifts:"labour-shifts",invoices:"invoices",blocks:"blocks",assignments:"assignments",rates:"rate-cards"};
async function api(path,opts={}){let r=await fetch("/api"+path,{credentials:"same-origin",...opts,headers:{"content-type":"application/json",...(opts.headers||{})}}),d=await r.json();if(!r.ok)throw Error(d.error||"Request failed");return d}
function esc(x){return String(x??"—").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function loginView(){$("#login").classList.remove("hide");$("#app").classList.add("hide")}
function appView(){$("#login").classList.add("hide");$("#app").classList.remove("hide");$("#who").textContent=S.user.name+" · "+S.user.role;drawNav();go((menus[S.user.role]||["profile"])[0])}
function drawNav(){$("#nav").innerHTML=(menus[S.user.role]||[]).map(k=>`<button data-r="${k}" class="${S.route===k?"active":""}">${names[k]}</button>`).join("");$("#nav").querySelectorAll("button").forEach(b=>b.onclick=()=>go(b.dataset.r))}
function go(k){if(!(menus[S.user.role]||[]).includes(k))return;S.route=k;drawNav();$("#title").textContent=names[k];$("#role").textContent=S.user.role.toUpperCase()+" PORTAL";render().catch(e=>$("#content").innerHTML=`<div class="notice">${esc(e.message)}</div>`)}
async function render(){if(S.route==="dashboard"){let d=await api("/dashboard");$("#content").innerHTML=`<div class="hero"><h3>Welcome back, ${esc(S.user.name.split(" ")[0])}</h3><p>Your operations snapshot across the UMA workspace.</p></div><div class="cards">${[["Companies",d.companies],["Drivers",d.drivers],["Labour",d.labour],["Delivery days",d.days]].map(x=>`<div class="card"><small>${x[0]}</small><strong>${x[1]}</strong></div>`).join("")}</div><div class="notice">Your data is stored in a shared D1 database. Permissions are checked by the server.</div>`;return}
if(S.route==="users"){if(S.user.role!=="admin")throw Error("Admin only");let rows=await api("/users");$("#content").innerHTML=`<div class="panel"><h3>Login accounts <button id="add" style="float:right">＋ Create login</button></h3><div class="table"><table><thead><tr><th>Name</th><th>Email</th><th>Mobile</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows.map(u=>`<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.mobile||"Not set")}</td><td>${esc(u.role)}</td><td>${u.active?"Active":"Disabled"}</td><td><div class="actions">
<button data-pin="${u.id}" data-name="${esc(u.name)}">Set Mobile & PIN</button>
${u.active?`<button data-op="disable" data-id="${u.id}">Disable</button>`:`<button data-op="enable" data-id="${u.id}">Enable</button>`}
<button class="danger" data-op="delete" data-id="${u.id}">Delete login</button>
</div></td></tr>`).join("")}</tbody></table></div></div><div class="notice">Deleting a login removes access only. Worker and payment history is retained. The last active Admin is protected.</div>`;
$("#add").onclick=()=>{let name=prompt("Full name"),email=prompt("Email"),role=prompt("Role: staff, driver, labour, manager or admin","staff"),password=prompt("Temporary password (minimum 14 characters)");if(!name||!email||!role||!password)return;api("/users",{method:"POST",body:JSON.stringify({name,email,role,password})}).then(()=>go("users")).catch(e=>alert(e.message))};
$("#content").querySelectorAll("[data-pin]").forEach(b=>{
  b.onclick=async()=>{
    const mobile=prompt("Enter mobile number for "+b.dataset.name);
    if(!mobile)return;

    const pin=prompt("Enter a new four-digit PIN. Do not share it with anyone.");
    if(!pin)return;

    if(!/^\d{4}$/.test(pin)){
      alert("PIN must contain exactly four digits.");
      return;
    }

    if(!confirm("Save this mobile number and PIN for "+b.dataset.name+"?"))return;

    try{
      await api(`/users/${b.dataset.pin}/pin`,{
        method:"POST",
        body:JSON.stringify({mobile,pin})
      });
      alert("Mobile number and PIN saved.");
      go("users");
    }catch(e){
      alert(e.message);
    }
  };
});

$("#content").querySelectorAll("[data-op]").forEach(b=>{
  b.onclick=()=>{
    if(!confirm("Confirm "+b.dataset.op+" login?"))return;
    api(`/users/${b.dataset.id}/${b.dataset.op}`,{
      method:"POST",
      body:"{}"
    }).then(()=>go("users")).catch(e=>alert(e.message));
  };
});
return}
if(S.route==="profile"){$("#content").innerHTML=`<div class="panel"><h3>My profile</h3><p>${esc(S.user.name)} · ${esc(S.user.email)}</p><p class="muted">Role: ${esc(S.user.role)}</p></div>`;return}
let rows=await api("/"+endpoints[S.route]);let keys=rows.length?Object.keys(rows[0]).filter(k=>k!=="password_hash").slice(0,8):[];$("#content").innerHTML=`<div class="panel"><h3>${names[S.route]} <span class="muted">· ${rows.length} records</span></h3>${rows.length?`<div class="table"><table><thead><tr>${keys.map(k=>`<th>${esc(k.replaceAll("_"," "))}</th>`).join("")}</tr></thead><tbody>${rows.map(row=>`<tr>${keys.map(k=>`<td>${esc(row[k])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`:`<p class="muted">No records found yet.</p>`}</div>`}
let adminRecoveryMode = false;

const pinFields = $("#pinLoginFields");
const recoveryFields = $("#adminRecoveryFields");
const recoveryToggle = $("#recoveryToggle");

recoveryToggle.onclick = () => {
  adminRecoveryMode = !adminRecoveryMode;

  pinFields.hidden = adminRecoveryMode;
  recoveryFields.hidden = !adminRecoveryMode;

  pinFields.querySelectorAll("input").forEach(input => {
    input.disabled = adminRecoveryMode;
    input.required = !adminRecoveryMode;
  });

  recoveryFields.querySelectorAll("input").forEach(input => {
    input.disabled = !adminRecoveryMode;
    input.required = adminRecoveryMode;
  });

  recoveryToggle.textContent = adminRecoveryMode
    ? "Back to mobile PIN login"
    : "Admin recovery login";

  $("#error").textContent = "";
};

$("#loginForm").onsubmit = async e => {
  e.preventDefault();
  $("#error").textContent = "";

  const form = new FormData(e.target);
  const b = adminRecoveryMode
    ? {
        email: form.get("email"),
        password: form.get("password")
      }
    : {
        mobile: form.get("mobile"),
        pin: form.get("pin")
      };

  try {
    await api("/login", {
      method: "POST",
      body: JSON.stringify(b)
    });

    S.user = (await api("/me")).user;
    appView();
  } catch (x) {
    $("#error").textContent = x.message;
  }
};
$("#logout").onclick=async()=>{await api("/logout",{method:"POST",body:"{}"}).catch(()=>{});S.user=null;loginView()};
(async()=>{try{S.user=(await api("/me")).user;appView()}catch{loginView()}})();
