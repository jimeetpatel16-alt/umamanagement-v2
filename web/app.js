
const $ = s => document.querySelector(s);

const S = {
  user: null,
  route: "dashboard"
};

const names = {
  dashboard: "Dashboard",
  records: "Add Delivery Record",
  bulk: "Bulk Add Records",
  companies: "Companies",
  drivers: "Drivers",
  labour: "Labour",
  days: "Delivery Days",
  submissions: "Driver Submissions",
  shifts: "Labour Shifts",
  users: "Login Accounts",
  invoices: "Invoices",
  blocks: "Delivery Blocks",
  assignments: "Driver Assignments",
  rates: "Rate Cards",
  profile: "My Profile"
};

const menus = {
  admin: Object.keys(names),

  manager: [
    "dashboard", "records", "bulk", "companies",
    "drivers", "labour", "days", "submissions",
    "shifts", "invoices", "blocks", "assignments",
    "rates", "profile"
  ],

  staff: [
    "dashboard", "records", "bulk", "drivers",
    "labour", "days", "submissions", "shifts",
    "blocks", "assignments", "profile"
  ],

  driver: ["submissions", "profile"],
  labour: ["shifts", "profile"]
};

const endpoints = {
  companies: "companies",
  drivers: "drivers",
  labour: "labour",
  days: "delivery-days",
  records: "delivery-records",
  submissions: "submissions",
  shifts: "labour-shifts",
  invoices: "invoices",
  blocks: "blocks",
  assignments: "assignments",
  rates: "rate-cards"
};

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };

  if (opts.body && !(opts.body instanceof FormData)) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch("/api" + path, {
    credentials: "same-origin",
    ...opts,
    headers
  });

  const data = await response.json();

  if (!response.ok) {
    throw Error(data.error || "Request failed");
  }

  return data;
}

function esc(value) {
  return String(value ?? "—").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function today() {
  const d = new Date();
  const local = new Date(
    d.getTime() - d.getTimezoneOffset() * 60000
  );
  return local.toISOString().slice(0, 10);
}

function loginView() {
  $("#login").classList.remove("hide");
  $("#app").classList.add("hide");
}

function appView() {
  $("#login").classList.add("hide");
  $("#app").classList.remove("hide");

  $("#who").textContent =
    S.user.name + " · " + S.user.role;

  drawNav();

  go((menus[S.user.role] || ["profile"])[0]);
}

function drawNav() {
  $("#nav").innerHTML = (menus[S.user.role] || [])
    .map(key => `
      <button
        data-r="${key}"
        class="${S.route === key ? "active" : ""}">
        ${names[key]}
      </button>
    `).join("");

  $("#nav").querySelectorAll("button").forEach(button => {
    button.onclick = () => go(button.dataset.r);
  });
}

function go(key) {
  if (!(menus[S.user.role] || []).includes(key)) return;

  S.route = key;

  drawNav();

  $("#title").textContent = names[key];

  $("#role").textContent =
    S.user.role.toUpperCase() + " PORTAL";

  render().catch(error => {
    $("#content").innerHTML = `
      <div class="notice">${esc(error.message)}</div>
    `;
  });
}

/* DASHBOARD */

async function dashboardPage() {
  const data = await api("/dashboard");

  $("#content").innerHTML = `
    <div class="hero">
      <h3>Welcome back, ${esc(S.user.name.split(" ")[0])}</h3>
      <p>Your operations snapshot across UMA Management.</p>
    </div>

    <div class="cards">
      ${[
        ["Companies", data.companies],
        ["Drivers", data.drivers],
        ["Labour", data.labour],
        ["Delivery Days", data.days],
        ["Delivery Records", data.records || 0],
        ["Submissions", data.submissions || 0],
        ["Labour Shifts", data.shifts || 0]
      ].map(item => `
        <div class="card">
          <small>${item[0]}</small>
          <strong>${item[1]}</strong>
        </div>
      `).join("")}
    </div>

    <div class="panel">
      <h3>Quick Actions</h3>
      <div class="actions">
        <button id="quickAdd">＋ Add Delivery Record</button>
        <button id="quickBulk">＋ Bulk Add Records</button>
      </div>
    </div>
  `;

  $("#quickAdd").onclick = () => go("records");
  $("#quickBulk").onclick = () => go("bulk");
}

/* DELIVERY RECORD ENTRY */

async function loadRecordData() {
  const [companies, drivers, days] = await Promise.all([
    api("/companies"),
    api("/drivers"),
    api("/delivery-days")
  ]);

  return { companies, drivers, days };
}

function makeCompanyOptions(companies) {
  return companies
    .filter(x => x.active !== 0)
    .map(x => `
      <option value="${esc(x.id)}">
        ${esc(x.name)}
      </option>
    `).join("");
}

function makeDriverOptions(drivers) {
  return drivers
    .filter(x => x.active !== 0)
    .map(x => `
      <option value="${esc(x.id)}">
        ${esc(x.name)}
      </option>
    `).join("");
}

async function findOrCreateDay(days, date, companyId) {
  let day = days.find(x =>
    x.work_date === date &&
    String(x.company_id || "") === String(companyId || "")
  );

  if (day) return day;

  /*
   * The current database schema has work_date UNIQUE.
   * If another company's day already exists for this date,
   * the database may reject this insert. Do not silently
   * attach the record to the wrong company.
   */

  const sameDate = days.find(x => x.work_date === date);

  if (sameDate && String(sameDate.company_id || "") !== String(companyId || "")) {
    throw new Error(
      "A delivery day already exists for this date under another company. " +
      "The database date uniqueness rule needs to be updated before using " +
      "multiple companies on the same date."
    );
  }

  return await api("/delivery-days", {
    method: "POST",
    body: JSON.stringify({
      work_date: date,
      company_id: companyId,
      status: "open"
    })
  });
}

async function recordPage() {
  const { companies, drivers, days } = await loadRecordData();

  const activeCompanies = companies.filter(x => x.active !== 0);

  if (!activeCompanies.length) {
    throw new Error("Please add a company first.");
  }

  $("#content").innerHTML = `
    <div class="panel">
      <h3>Add Delivery Record</h3>

      <form id="recordForm">

        <label>Work Date
          <input
            name="date"
            type="date"
            value="${today()}"
            required>
        </label>

        <label>Company
          <select name="company" required>
            <option value="">Select Company</option>
            ${makeCompanyOptions(activeCompanies)}
          </select>
        </label>

        <label>Driver
          <select name="driver" required>
            <option value="">Select Driver</option>
            ${makeDriverOptions(drivers)}
          </select>
        </label>

        <label>Block / Route
          <input
            name="block"
            placeholder="Block 1"
            required>
        </label>

        <label>Vehicle
          <select name="vehicle" required>
            <option value="Car">Car</option>
            <option value="Van">Van</option>
            <option value="Other">Other</option>
          </select>
        </label>

        <label>Parcels
          <input
            name="parcels"
            type="number"
            min="0"
            value="0"
            required>
        </label>

        <label>Delivered
          <input
            name="delivered"
            type="number"
            min="0"
            value="0"
            required>
        </label>

        <label>Failed
          <input
            name="failed"
            type="number"
            min="0"
            value="0"
            required>
        </label>

        <label>Bonus ($)
          <input
            name="bonus"
            type="number"
            step="0.01"
            value="0">
        </label>

        <label>Adjustment ($)
          <input
            name="adjustment"
            type="number"
            step="0.01"
            value="0">
        </label>

        <label>Payment Reference
          <input name="payment_ref">
        </label>

        <label>Notes
          <input name="notes">
        </label>

        <button type="submit">Save Delivery Record</button>

        <output id="recordMessage"></output>

      </form>
    </div>
  `;

  $("#recordForm").onsubmit = async event => {
    event.preventDefault();

    const form = new FormData(event.target);

    const driver = drivers.find(
      x => x.id === form.get("driver")
    );

    if (!driver) {
      alert("Please select a valid driver.");
      return;
    }

    const button = event.target.querySelector(
      'button[type="submit"]'
    );

    button.disabled = true;

    try {
      const day = await findOrCreateDay(
        days,
        form.get("date"),
        form.get("company")
      );

      await api("/delivery-records", {
        method: "POST",
        body: JSON.stringify({
          day_id: day.id,
          driver_id: driver.id,
          driver_name: driver.name,
          block_name: form.get("block"),
          vehicle: form.get("vehicle"),
          parcels: Number(form.get("parcels")),
          delivered: Number(form.get("delivered")),
          failed: Number(form.get("failed")),
          bonus: Number(form.get("bonus") || 0),
          adjustment: Number(form.get("adjustment") || 0),
          payment_ref: form.get("payment_ref"),
          notes: form.get("notes")
        })
      });

      $("#recordMessage").textContent =
        "Delivery record saved successfully.";

      event.target.reset();
      event.target.elements.date.value = today();

    } catch (error) {
      $("#recordMessage").textContent = error.message;

    } finally {
      button.disabled = false;
    }
  };
}

function parseBulkLine(line, drivers, index) {
  const clean = value => String(value || "").trim();
  const normal = value => clean(value).toLowerCase();

  const splitCells = (text, delimiter) => {
    const cells = [];
    let cell = "";
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (ch === '"' && text[i + 1] === '"' && quoted) {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = !quoted;
      } else if (ch === delimiter && !quoted) {
        cells.push(clean(cell));
        cell = "";
      } else {
        cell += ch;
      }
    }

    cells.push(clean(cell));
    return cells;
  };

  const knownDrivers = drivers
    .filter(d => d.active !== 0)
    .map(d => d.name)
    .sort((a, b) => b.length - a.length);

  const delimiter = line.includes("\t")
    ? "\t"
    : line.includes("|")
      ? "|"
      : line.includes(",")
        ? ","
        : null;

  // Structured Excel, CSV or pipe-separated row
  if (delimiter) {
    const c = splitCells(line, delimiter);

    const first = normal(c[0]);

    if (["driver", "driver name", "name"].includes(first)) {
      return null;
    }

    if (c.length >= 3) {
      const vehicleText = normal(c[2]);

      return {
        line: index + 1,
        driver: clean(c[0]),
        block: clean(c[1]),
        vehicle: /\bvan\b/.test(vehicleText)
          ? "Van"
          : /\bother\b/.test(vehicleText)
            ? "Other"
            : /\bcar\b/.test(vehicleText)
              ? "Car"
              : clean(c[2]),
        parcels: Number(c[3] || 0),
        delivered: Number(c[4] || 0),
        failed: Number(c[5] || 0)
      };
    }
  }

  // Free-text delivery notes
  const blockMatch = line.match(
    /\b(block|route|zone)\s*#?\s*([a-z0-9-]+)\b/i
  );

  const vehicleMatch = line.match(/\b(car|van|other)\b/i);

  const matchedDriver = knownDrivers.find(name =>
    new RegExp(
      "(^|[^a-z0-9])" +
      name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      "($|[^a-z0-9])",
      "i"
    ).test(line)
  );

  let driver = matchedDriver || "";

  if (!driver) {
    let candidate = line;

    if (blockMatch) {
      candidate = candidate.replace(blockMatch[0], " ");
    }

    if (vehicleMatch) {
      candidate = candidate.replace(vehicleMatch[0], " ");
    }

    candidate = candidate
      .replace(/\b\d+\s*(parcels?|deliveries|packages)\b/ig, " ")
      .replace(/\b(delivered|failed|parcels?|deliveries|packages)\b/ig, " ")
      .replace(/\b(bonus|adjustment|deduction)\s*[:=]?\s*\$?[\d.]+/ig, " ")
      .replace(/\s+/g, " ")
      .replace(/^[,;:\s-]+|[,;:\s-]+$/g, "")
      .trim();

    driver = candidate;
  }

  const numberAfter = (label) => {
    const match = line.match(
      new RegExp("\\b" + label + "\\s*[:=]?\\s*(\\d+)", "i")
    );
    return match ? Number(match[1]) : 0;
  };

  const parcelMatch = line.match(
    /\b(\d+)\s*(?:parcels?|packages)\b/i
  );

  return {
    line: index + 1,
    driver: clean(driver),
    block: blockMatch
      ? (blockMatch[1].toLowerCase() === "block"
          ? "Block "
          : blockMatch[1][0].toUpperCase() +
            blockMatch[1].slice(1).toLowerCase() + " ") +
        blockMatch[2]
      : "",
    vehicle: vehicleMatch
      ? vehicleMatch[1][0].toUpperCase() +
        vehicleMatch[1].slice(1).toLowerCase()
      : "Car",
    parcels: parcelMatch ? Number(parcelMatch[1]) : 0,
    delivered: numberAfter("delivered"),
    failed: numberAfter("failed")
  };
}

/* BULK ADD */

async function bulkPage() {
  const { companies, drivers, days } = await loadRecordData();

  const activeCompanies = companies.filter(x => x.active !== 0);

  if (!activeCompanies.length) {
    throw new Error("Please add a company first.");
  }

  $("#content").innerHTML = `
    <div class="panel">

      <h3>Bulk Add Delivery Records</h3>

      <p class="muted">
        Enter one driver per line using this format:
      </p>

      <p>
        Driver Name | Block | Vehicle | Parcels | Delivered | Failed
      </p>

      <label>Work Date
        <input
          id="bulkDate"
          type="date"
          value="${today()}"
          required>
      </label>

      <label>Company
        <select id="bulkCompany" required>
          <option value="">Select Company</option>
          ${makeCompanyOptions(activeCompanies)}
        </select>
      </label>

      <label>Paste Multiple Records
        <textarea
          id="bulkRows"
          rows="12"
          placeholder="Honey | Block 1 | Car | 120 | 115 | 5
Aashish | Block 2 | Car | 140 | 135 | 5
Bittu | Block 4 | Car | 110 | 108 | 2
Shilpa | Block 7 | Van | 180 | 175 | 5"></textarea>
      </label>

      <div class="actions">
        <button id="bulkPreview">Preview Records</button>
        <button id="bulkSave" disabled>Save All Records</button>
      </div>

      <p id="bulkMessage"></p>

      <div id="bulkPreviewTable" class="table"></div>

    </div>
  `;

  let parsed = [];

  $("#bulkPreview").onclick = () => {
    const company = $("#bulkCompany").value;

    if (!company) {
      alert("Please select a company.");
      return;
    }

    const text = $("#bulkRows").value.trim();

    if (!text) {
      alert("Please enter delivery records.");
      return;
    }

    
    parsed = text
      .split(/\r?\n/)
      .filter(line => line.trim())
      .map((line, index) =>
        parseBulkLine(line, drivers, index)
      )
      .filter(Boolean);


        return {
          line: index + 1,
          driver: columns[0]?.trim(),
          block: columns[1]?.trim(),
          vehicle: (columns[2] || "Car").trim(),
          parcels: Number(columns[3] || 0),
          delivered: Number(columns[4] || 0),
          failed: Number(columns[5] || 0)
        };
      });

    const invalid = parsed.filter(x =>
      !x.driver ||
      !x.block ||
      !["car", "van", "other"].includes(
        x.vehicle.toLowerCase()
      ) ||
      ![x.parcels, x.delivered, x.failed].every(
        Number.isFinite
      ) ||
      x.parcels < 0 ||
      x.delivered < 0 ||
      x.failed < 0
    );

    const unmatched = parsed.filter(x =>
      !drivers.some(d =>
        d.name.toLowerCase() === x.driver.toLowerCase()
      )
    );

    $("#bulkPreviewTable").innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Driver</th>
            <th>Block</th>
            <th>Vehicle</th>
            <th>Parcels</th>
            <th>Delivered</th>
            <th>Failed</th>
            <th>Driver Match</th>
          </tr>
        </thead>

        <tbody>
          ${parsed.map(x => {
            const match = drivers.find(d =>
              d.name.toLowerCase() === x.driver.toLowerCase()
            );

            return `
              <tr>
                <td>${esc(x.driver)}</td>
                <td>${esc(x.block)}</td>
                <td>${esc(x.vehicle)}</td>
                <td>${x.parcels}</td>
                <td>${x.delivered}</td>
                <td>${x.failed}</td>
                <td>${match ? "Matched" : "Name only"}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    `;

    if (invalid.length) {
      $("#bulkMessage").textContent =
        invalid.length + " invalid rows. Please correct them.";

      $("#bulkSave").disabled = true;
      return;
    }

    $("#bulkMessage").textContent =
      parsed.length + " records ready. " +
      unmatched.length + " driver names not matched to existing accounts.";

    $("#bulkSave").disabled = false;
  };

  $("#bulkSave").onclick = async () => {
    const date = $("#bulkDate").value;
    const company = $("#bulkCompany").value;

    if (!date || !company || !parsed.length) {
      alert("Select a date, company and preview the records.");
      return;
    }

    if (!confirm(
      "Save " + parsed.length + " delivery records?"
    )) return;

    const button = $("#bulkSave");
    button.disabled = true;

    let saved = 0;

    try {
      const day = await findOrCreateDay(
        days,
        date,
        company
      );

      for (const row of parsed) {
        const driver = drivers.find(d =>
          d.name.toLowerCase() === row.driver.toLowerCase()
        );

        await api("/delivery-records", {
          method: "POST",
          body: JSON.stringify({
            day_id: day.id,
            driver_id: driver?.id || null,
            driver_name: driver?.name || row.driver,
            block_name: row.block,
            vehicle: row.vehicle,
            parcels: row.parcels,
            delivered: row.delivered,
            failed: row.failed
          })
        });

        saved++;

        $("#bulkMessage").textContent =
          "Saving records: " + saved + " / " + parsed.length;
      }

      $("#bulkMessage").textContent =
        "Successfully saved " + saved + " records.";

      $("#bulkRows").value = "";
      $("#bulkPreviewTable").innerHTML = "";
      parsed = [];

    } catch (error) {
      $("#bulkMessage").textContent =
        "Saved " + saved + " records. Error: " + error.message +
        ". Check saved records before retrying.";

    } finally {
      button.disabled = false;
    }
  };
}

/* USERS */

async function usersPage() {
  if (S.user.role !== "admin") {
    throw Error("Admin only");
  }

  const rows = await api("/users");

  $("#content").innerHTML = `
    <div class="panel">
      <h3>
        Login Accounts
        <button id="addUser" style="float:right">
          ＋ Create Login
        </button>
      </h3>

      <div class="table">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Mobile</th>
              <th>Role</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>

          <tbody>
            ${rows.map(user => `
              <tr>
                <td>${esc(user.name)}</td>
                <td>${esc(user.email)}</td>
                <td>${esc(user.mobile || "Not set")}</td>
                <td>${esc(user.role)}</td>
                <td>${user.active ? "Active" : "Disabled"}</td>
                <td>
                  <div class="actions">

                    <button
                      data-pin="${user.id}"
                      data-name="${esc(user.name)}">
                      Set Mobile & PIN
                    </button>

                    ${user.active
                      ? `<button data-op="disable" data-id="${user.id}">Disable</button>`
                      : `<button data-op="enable" data-id="${user.id}">Enable</button>`
                    }

                    <button
                      class="danger"
                      data-op="delete"
                      data-id="${user.id}">
                      Delete
                    </button>

                  </div>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;

  $("#addUser").onclick = async () => {
    const name = prompt("Full name");
    if (!name) return;

    const email = prompt("Email address");
    if (!email) return;

    const role = prompt(
      "Role: staff, driver, labour, manager or admin",
      "staff"
    );

    if (!["staff", "driver", "labour", "manager", "admin"].includes(role)) {
      alert("Invalid role.");
      return;
    }

    const mobile = prompt("Mobile number");
    const pin = prompt("Four-digit PIN");

    if (!mobile || !/^\d{4}$/.test(pin || "")) {
      alert("Enter a valid mobile and four-digit PIN.");
      return;
    }

    const password = prompt(
      "Internal recovery password (minimum 14 characters)"
    );

    if (!password || password.length < 14) {
      alert("Password must contain at least 14 characters.");
      return;
    }

    try {
      await api("/users", {
        method: "POST",
        body: JSON.stringify({
          name,
          email,
          role,
          mobile,
          pin,
          password
        })
      });

      alert("Account created.");
      go("users");

    } catch (error) {
      alert(error.message);
    }
  };

  $("#content").querySelectorAll("[data-pin]").forEach(button => {
    button.onclick = async () => {
      const mobile = prompt(
        "Mobile number for " + button.dataset.name
      );

      if (!mobile) return;

      const pin = prompt("New four-digit PIN");

      if (!/^\d{4}$/.test(pin || "")) {
        alert("PIN must contain exactly four digits.");
        return;
      }

      try {
        await api(`/users/${button.dataset.pin}/pin`, {
          method: "POST",
          body: JSON.stringify({ mobile, pin })
        });

        alert("Mobile and PIN updated.");
        go("users");

      } catch (error) {
        alert(error.message);
      }
    };
  });

  $("#content").querySelectorAll("[data-op]").forEach(button => {
    button.onclick = async () => {
      const operation = button.dataset.op;

      if (!confirm("Confirm " + operation + " login?")) return;

      try {
        await api(
          `/users/${button.dataset.id}/${operation}`,
          {
            method: "POST",
            body: "{}"
          }
        );

        go("users");

      } catch (error) {
        alert(error.message);
      }
    };
  });
}

/* OTHER TABLE PAGES */

async function tablePage() {
  const endpoint = endpoints[S.route];

  if (!endpoint) {
    throw Error("Page not found.");
  }

  const rows = await api("/" + endpoint);

  const keys = rows.length
    ? Object.keys(rows[0])
        .filter(k => !["password_hash", "pin_hash"].includes(k))
        .slice(0, 10)
    : [];

  $("#content").innerHTML = `
    <div class="panel">

      <h3>
        ${names[S.route]}
        <span class="muted"> · ${rows.length} records</span>
      </h3>

      ${rows.length
        ? `
          <div class="table">
            <table>
              <thead>
                <tr>
                  ${keys.map(k => `
                    <th>${esc(k.replaceAll("_", " "))}</th>
                  `).join("")}
                </tr>
              </thead>

              <tbody>
                ${rows.map(row => `
                  <tr>
                    ${keys.map(k => `
                      <td>${esc(row[k])}</td>
                    `).join("")}
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `
        : `<p class="muted">No records found yet.</p>`
      }

    </div>
  `;
}

/* COMPANY MANAGEMENT */

async function companiesPage() {
  const companies = await api("/companies");

  $("#content").innerHTML = `
    <div class="panel">
      <h3>Add New Company</h3>
      <p class="muted">Register a delivery or labour company and configure its rates.</p>

      <form id="companyForm">

        <label>Company Name
          <input name="name" placeholder="Enter company name" required>
        </label>

        <label>Company Type
          <select name="type" required>
            <option value="delivery">Delivery</option>
            <option value="labour">Labour Supply</option>
            <option value="both">Both</option>
          </select>
        </label>

        <label>ABN
          <input name="abn" placeholder="Enter ABN">
        </label>

        <label>Contact Person
          <input name="contact_name" placeholder="Contact person name">
        </label>

        <label>Email
          <input name="email" type="email" placeholder="Company email">
        </label>

        <label>Phone
          <input name="phone" type="tel" placeholder="Company phone">
        </label>

        <label>Business Address
          <textarea name="address" rows="3" placeholder="Company address"></textarea>
        </label>

        <h3>Driver Payment Rates</h3>

        <label>Car Rate ($)
          <input name="car_rate" type="number" min="0" step="0.01" value="270">
        </label>

        <label>Van Rate ($)
          <input name="van_rate" type="number" min="0" step="0.01" value="330">
        </label>

        <label>Other Vehicle Rate ($)
          <input name="other_rate" type="number" min="0" step="0.01" value="0">
        </label>

        <label>Rate Type
          <select name="rate_type">
            <option value="fixed">Fixed Rate</option>
            <option value="per_parcel">Per Parcel</option>
          </select>
        </label>

        <button type="submit">Save Company</button>
        <output id="companyMessage"></output>
      </form>
    </div>

    <div class="panel">
      <h3>Registered Companies (${companies.length})</h3>

      ${companies.length ? `
        <div class="table">
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>ABN</th>
                <th>Contact</th>
                <th>Phone</th>
                <th>Car Rate</th>
                <th>Van Rate</th>
              </tr>
            </thead>
            <tbody>
              ${companies.map(c => `
                <tr>
                  <td>${esc(c.name)}</td>
                  <td>${esc(c.abn)}</td>
                  <td>${esc(c.contact_name)}</td>
                  <td>${esc(c.phone)}</td>
                  <td>$${esc(c.car_rate)}</td>
                  <td>$${esc(c.van_rate)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      ` : `<p class="muted">No companies registered yet.</p>`}
    </div>
  `;

  $("#companyForm").onsubmit = async event => {
    event.preventDefault();

    const form = new FormData(event.target);
    const data = Object.fromEntries(form.entries());

    ["car_rate", "van_rate", "other_rate"].forEach(key => {
      data[key] = Number(data[key] || 0);
    });

    data.active = 1;

    const message = $("#companyMessage");
    message.textContent = "Saving company...";

    try {
      await api("/companies", {
        method: "POST",
        body: JSON.stringify(data)
      });

      message.textContent = "Company saved successfully.";
      await companiesPage();

    } catch (error) {
      message.textContent = error.message;
    }
  };
}

/* MAIN RENDER */

async function render() {
  if (S.route === "companies") {
    return companiesPage();
  }
  if (S.route === "dashboard") {
    return dashboardPage();
  }

  if (S.route === "records") {
    return recordPage();
  }

  if (S.route === "bulk") {
    return bulkPage();
  }

  if (S.route === "users") {
    return usersPage();
  }

  if (S.route === "profile") {
    $("#content").innerHTML = `
      <div class="panel">
        <h3>My Profile</h3>
        <p>${esc(S.user.name)}</p>
        <p>${esc(S.user.email)}</p>
        <p class="muted">Role: ${esc(S.user.role)}</p>
      </div>
    `;
    return;
  }

  return tablePage();
}

/* LOGIN */

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

$("#loginForm").onsubmit = async event => {
  event.preventDefault();

  $("#error").textContent = "";

  const form = new FormData(event.target);

  const credentials = adminRecoveryMode
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
      body: JSON.stringify(credentials)
    });

    S.user = (await api("/me")).user;

    appView();

  } catch (error) {
    $("#error").textContent = error.message;
  }
};

/* LOGOUT */

$("#logout").onclick = async () => {
  await api("/logout", {
    method: "POST",
    body: "{}"
  }).catch(() => {});

  S.user = null;

  loginView();
};

/* RESTORE EXISTING SESSION */

(async () => {
  try {
    S.user = (await api("/me")).user;
    appView();
  } catch {
    loginView();
  }
})();
