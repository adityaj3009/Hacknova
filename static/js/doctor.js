import {
  buildBedCard,
  buildTopbar,
  computeAlerts,
  computeStats,
  escapeHtml,
  formatDateTime,
  getDoctorById,
  getDoctorName,
  getSortedBeds,
  getWardNames,
  initFirebase,
  listenAlerts,
  listenAllMedicineAlerts,
  listenBeds,
  listenWaitingQueue,
  logout,
  populateWardFilter,
  renderAlertStrips,
  renderFatalState,
  renderPredictionSummary,
  renderWaitingQueue,
  requireAuth,
  seedBedsIfNeeded,
  seedDoctorsIfNeeded,
  setHtml,
  setText,
  showToast,
  updatePatientStatus,
  addMedicineAlert,
  relativeTime,
} from "./firebase-utils.js";

const state = {
  user: null,
  beds: {},
  waitingQueue: [],
  managerAlerts: [],   // unresolved urgent alerts
  medicineAlerts: [],  // all medicine alerts (pending + provided)
  ward: "all",
  search: "",
  activeBedId: null,
};

let timerInterval = null;

/* ─── My Patients view (privacy-filtered) ─── */

function getMyBeds() {
  if (!state.user?.doctorId) return [];
  return getSortedBeds(state.beds, {
    ward: state.ward,
    doctorId: state.user.doctorId,
    search: state.search,
  });
}

function getMyReservedBeds() {
  if (!state.user?.doctorId) return [];
  return Object.values(state.beds).filter(
    (bed) => bed.status === "reserved" && bed.reservedDoctorId === state.user.doctorId
  );
}

/* ─── Rendering ─── */

function renderDoctorInfo() {
  const doctorId = state.user?.doctorId;
  if (!doctorId) {
    setText("doctorIdChip", "No Doctor ID assigned");
    setText("doctorSpec", "");
    return;
  }
  const doc = getDoctorById(doctorId);
  setText("doctorIdChip", doctorId);
  setText("doctorSpec", doc ? `${doc.specialization} · ${doc.ward}` : "");
}

function renderStats() {
  const myBeds = getMyBeds();
  const occupied = myBeds.filter(b => b.status === "occupied").length;
  const available = Object.values(state.beds).filter(b => b.status === "available").length;
  const cleaning  = Object.values(state.beds).filter(b => b.status === "cleaning").length;
  const reserved  = getMyReservedBeds().length;
  const total     = Object.values(state.beds).length;
  const occupancy = total ? Math.round((Object.values(state.beds).filter(b=>b.status==="occupied").length / total) * 100) : 0;

  setText("doctorMyPatients",   myBeds.filter(b => b.status === "occupied").length);
  setText("doctorReservedForMe", reserved);
  setText("doctorTotalBeds",    total);
  setText("doctorAvailableBeds", available);
  setText("doctorOccupancy",    `${occupancy}%`);
}

function renderMyPatientsBeds() {
  const grid = document.getElementById("doctorBedGrid");
  const myBeds = getMyBeds();
  grid.innerHTML = "";

  if (!myBeds.length) {
    grid.innerHTML = `<div class="empty-state">
      ${state.user?.doctorId
        ? "No patients assigned to your Doctor ID yet. Contact your Ward Manager."
        : "⚠️ No Doctor ID linked to your account. Please sign up with a Doctor ID or contact Admin."}
    </div>`;
    return;
  }

  myBeds.forEach((bed) => {
    const node = buildBedCard(bed, true);
    node.addEventListener("click", () => openEditor(bed.id));
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openEditor(bed.id); }
    });
    grid.appendChild(node);
  });
}

function renderReservedForMe() {
  const container = document.getElementById("doctorReservedList");
  const reserved = getMyReservedBeds();
  if (!reserved.length) {
    container.innerHTML = `<div class="empty-state">No beds currently reserved under your Doctor ID.</div>`;
    return;
  }
  container.innerHTML = `
    <div class="queue-list">
      ${reserved.map(bed => `
        <article class="queue-item reserved-item">
          <div class="list-meta">
            <strong>${escapeHtml(bed.id)}</strong>
            <span class="status-chip reserved">Reserved</span>
            <span>${escapeHtml(bed.ward)}</span>
            <span>${escapeHtml(bed.reservedFor || "Incoming patient")}</span>
            <span class="mono">${escapeHtml(relativeTime(bed.updatedAt))}</span>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function renderAlerts() {
  const systemAlerts = computeAlerts(state.beds, state.waitingQueue, state.managerAlerts);
  const doctorId = state.user?.doctorId;
  const myAlerts = systemAlerts.filter((a) => {
    if (!doctorId) return false;
    if (a.sourceType === "medicine") return false;
    return a.doctorId === doctorId;
  });
  setHtml("doctorAlerts", renderAlertStrips(myAlerts.slice(0, 8), false));
}

function renderMedicineAlerts() {
  const allMedicine = state.medicineAlerts;
  const doctorId = state.user?.doctorId;
  // Show medicines prescribed by this doctor (or all if no doctorId)
  const myMedicine = allMedicine.filter(a => !a.doctorId || a.doctorId === doctorId);

  const container = document.getElementById("doctorMedicineAlerts");
  if (!myMedicine.length) {
    container.innerHTML = `<div class="empty-state">No medicine prescriptions yet. Use "+ Prescribe" to add one.</div>`;
    return;
  }

  const pending  = myMedicine.filter(a => !a.resolved);
  const provided = myMedicine.filter(a =>  a.resolved);

  let html = `<div class="alert-list">`;

  pending.forEach(a => {
    html += `
      <article class="alert-item medicine-alert-item">
        <div class="item-head">
          <h4 class="item-title">${escapeHtml(a.title)}</h4>
          <div class="alert-badges">
            <span class="escalation-flag">MEDICINE</span>
            <span class="status-chip warning">Pending</span>
          </div>
        </div>
        <p class="item-copy">${escapeHtml(a.medicine || a.copy)}${a.schedule ? ` · ${escapeHtml(a.schedule)}` : ""}</p>
        <div class="item-time">⏳ Prescribed ${escapeHtml(relativeTime(a.createdAt))} · Awaiting Manager</div>
      </article>
    `;
  });

  provided.forEach(a => {
    html += `
      <article class="alert-item" style="opacity:0.7;">
        <div class="item-head">
          <h4 class="item-title">${escapeHtml(a.title)}</h4>
          <div class="alert-badges">
            <span class="escalation-flag" style="background:rgba(16,185,129,0.15);color:#065f46;">✓ PROVIDED</span>
          </div>
        </div>
        <p class="item-copy">${escapeHtml(a.medicine || a.copy)}${a.schedule ? ` · ${escapeHtml(a.schedule)}` : ""}</p>
        <div class="item-time">
          Provided by ${escapeHtml(a.resolvedBy || "Manager")} · ${escapeHtml(relativeTime(a.resolvedAt || a.createdAt))}
        </div>
      </article>
    `;
  });

  html += `</div>`;
  container.innerHTML = html;
}

function renderWaiting() {
  // Doctor sees queue read-only (no manage button)
  setHtml("doctorWaitingQueue", renderWaitingQueue(state.waitingQueue, false));
}


function renderPredictions() {
  setHtml("doctorPredictions", renderPredictionSummary(state.beds));
}

function updateTimers() {
  const now = Date.now();
  document.querySelectorAll(".waiting-timer[data-since]").forEach((el) => {
    const since = parseInt(el.dataset.since, 10);
    if (!since) return;
    const waitMin = Math.round((now - since) / 60000);
    el.textContent = `${waitMin} min`;
    if (waitMin >= 30) el.classList.add("alert");
  });
}

function refreshHeader() {
  const now = new Date();
  const doctorId = state.user?.doctorId;
  const docInfo = doctorId ? getDoctorById(doctorId) : null;
  setText("doctorGreeting", `Welcome, ${state.user.name}`);
  setText("doctorSubtitle", docInfo
    ? `${docInfo.specialization} · ${docInfo.ward} — ${now.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}`
    : now.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
  );
}

function render() {
  populateWardFilter("doctorWardFilter", getWardNames(state.beds));
  renderStats();
  renderDoctorInfo();
  renderMyPatientsBeds();
  renderReservedForMe();
  renderAlerts();
  renderMedicineAlerts();
  renderPredictions();
  renderWaiting();
}


/* ─── Editor (Doctor — patient status only) ─── */

function wireModal() {
  const overlay = document.getElementById("doctorDrawerOverlay");
  document.getElementById("doctorDrawerClose").addEventListener("click", closeEditor);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeEditor(); });

  const medOverlay = document.getElementById("addMedicineOverlay");
  document.getElementById("doctorAddMedicineBtn").addEventListener("click", openMedicineDrawer);
  document.getElementById("addMedicineClose").addEventListener("click", closeMedicineDrawer);
  medOverlay.addEventListener("click", (e) => { if (e.target === medOverlay) closeMedicineDrawer(); });
}

function openMedicineDrawer() {
  const select = document.getElementById("medicinePatientId");
  const myBeds = getMyBeds().filter(b => b.status === "occupied" && b.patientName);
  
  if (!myBeds.length) {
    showToast("You have no occupied patients to prescribe medicine to.", "err");
    return;
  }

  select.innerHTML = myBeds.map(b => `<option value="${b.id}">${b.id} — ${escapeHtml(b.patientName)}</option>`).join("");
  document.getElementById("addMedicineForm").reset();
  document.getElementById("addMedicineOverlay").classList.add("open");
}

function closeMedicineDrawer() {
  document.getElementById("addMedicineOverlay").classList.remove("open");
}

function openEditor(bedId) {
  const bed = state.beds[bedId];
  if (!bed) return;

  // Verify this is doctor's own bed
  if (bed.assignedDoctor && bed.assignedDoctor !== state.user?.doctorId) {
    showToast("You can only update your own patients.", "err");
    return;
  }

  state.activeBedId = bedId;
  setText("doctorDrawerTitle", `Update Patient — ${bed.id}`);
  setText("doctorDrawerCopy", `${bed.ward} · ${bed.patientName || "No patient"} · Last updated ${formatDateTime(bed.updatedAt)}.`);
  document.getElementById("doctorPatientName").value = bed.patientName || "";

  const statusSelect = document.getElementById("doctorPatientStatus");
  const currentStatus = bed.patientStatus || "";
  statusSelect.innerHTML = `
    <option value="" ${!currentStatus ? "selected" : ""}>— Select Status —</option>
    <option value="stable" ${currentStatus === "stable" ? "selected" : ""}>Stable</option>
    <option value="critical" ${currentStatus === "critical" ? "selected" : ""}>Critical</option>
    <option value="discharge_ready" ${currentStatus === "discharge_ready" ? "selected" : ""}>Discharge Ready</option>
    <option value="under_observation" ${currentStatus === "under_observation" ? "selected" : ""}>Under Observation</option>
    <option value="improving" ${currentStatus === "improving" ? "selected" : ""}>Improving</option>
  `;
  document.getElementById("doctorNotes").value = bed.notes || "";
  document.getElementById("doctorDrawerOverlay").classList.add("open");
}

function closeEditor() {
  state.activeBedId = null;
  document.getElementById("doctorDrawerOverlay").classList.remove("open");
}

function wireForm(db) {
  const form = document.getElementById("doctorBedForm");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.activeBedId) return;

    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Saving';

    try {
      const fd = new FormData(form);
      await updatePatientStatus(
        db,
        state.activeBedId,
        {
          patientStatus: String(fd.get("patientStatus") || ""),
          notes: String(fd.get("notes") || "").trim(),
        },
        state.user,
      );
      closeEditor();
      showToast("Patient status updated.", "ok");
    } catch (error) {
      console.error(error);
      showToast(error.message || "Could not save.", "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Save update";
    }
  });

  const medForm = document.getElementById("addMedicineForm");
  medForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = medForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Adding...';

    try {
      const fd = new FormData(medForm);
      const bedId = fd.get("bedId");
      const bed = state.beds[bedId];
      if (!bed) throw new Error("Bed not found");

      await addMedicineAlert(db, {
        patientName: bed.patientName,
        medicine: String(fd.get("medicine")).trim(),
        schedule: String(fd.get("schedule")).trim(),
        bedId: bedId,
        doctorId: state.user.doctorId,
      }, state.user);

      showToast("Medicine prescribed successfully.", "ok");
      closeMedicineDrawer();
    } catch (error) {
      console.error(error);
      showToast(error.message || "Failed to add medicine.", "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Prescribe Medicine";
    }
  });
}

function wireFilters() {
  document.getElementById("doctorWardFilter").addEventListener("change", (e) => {
    state.ward = e.target.value;
    renderMyPatientsBeds();
    renderStats();
  });

  let searchTimeout;
  document.getElementById("doctorSearch").addEventListener("input", (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.search = e.target.value;
      renderMyPatientsBeds();
    }, 150);
  });
}

/* ─── Init ─── */

async function initPage() {
  let db;
  try {
    ({ db } = initFirebase(window.WARDWATCH_CONFIG || {}));
  } catch (error) {
    renderFatalState("Firebase is not configured", error.message);
    return;
  }

  wireModal();
  wireFilters();
  wireForm(db);
  document.getElementById("logoutButton").addEventListener("click", logout);

  requireAuth(
    async (session) => {
      state.user = session;
      window.history.replaceState(null, "", window.location.href);
      window.history.pushState(null, "", window.location.href);
      window.addEventListener("popstate", () => {
        window.history.pushState(null, "", window.location.href);
      });
      buildTopbar(session.name, session.role);
      refreshHeader();
      await seedBedsIfNeeded(db);
      await seedDoctorsIfNeeded(db);

      listenBeds(db, (beds) => {
        state.beds = beds;
        render();
      });

      listenWaitingQueue(db, (queue) => {
        state.waitingQueue = queue;
        renderWaiting();
        renderAlerts();
      });

      listenAlerts(db, (alerts) => {
        state.managerAlerts = alerts;
        renderAlerts();
      });

      // Separate listener for medicine prescriptions (includes resolved/provided)
      listenAllMedicineAlerts(db, (medicines) => {
        state.medicineAlerts = medicines;
        renderMedicineAlerts();
      });

      timerInterval = window.setInterval(updateTimers, 1000);
      window.setInterval(() => {
        renderPredictions();
        renderAlerts();
        refreshHeader();
      }, 30000);
    },
    { allowRoles: ["doctor"] },
  );
}

document.addEventListener("DOMContentLoaded", initPage);
