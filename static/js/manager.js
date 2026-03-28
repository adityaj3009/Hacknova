import {
  addToWaitingQueue,
  addUrgentAlert,
  buildBedCard,
  buildTopbar,
  computeAlerts,
  computeStats,
  conditionCategoryOptions,
  doctorIdOptions,
  escapeHtml,
  formatDateTime,
  getDoctorName,
  getEmergencyRanking,
  getNextQueueSuggestion,
  getSortedBeds,
  getWardNames,
  initFirebase,
  listenActivity,
  listenAlerts,
  listenBeds,
  listenWaitingQueue,
  logout,
  markMedicineProvided,
  populateWardFilter,
  relativeTime,
  removeFromWaitingQueue,
  renderActivityItems,
  renderAlertStrips,
  renderEmergencyPanel,
  renderFatalState,
  renderPredictionSummary,
  renderWaitingQueue,
  requireAuth,
  reserveBed,
  resolveAlert,
  seedBedsIfNeeded,
  seedDoctorsIfNeeded,
  setHtml,
  setText,
  showToast,
  statusOptionsForManager,
  transferPatient,
  updateBedRecord,
} from "./firebase-utils.js";

const state = {
  user: null,
  beds: {},
  activity: [],
  waitingQueue: [],
  managerAlerts: [],
  ward: "all",
  search: "",
  activeBedId: null,
  emergencyMode: false,
  suggestion: null, // next queue patient to admit
};

/* ─── Emergency Mode ─── */

function toggleEmergency() {
  state.emergencyMode = !state.emergencyMode;
  const panel = document.getElementById("emergencyPanel");
  const btn = document.getElementById("emergencyBtn");
  if (state.emergencyMode) {
    panel.classList.remove("hidden");
    btn.classList.add("active");
    renderEmergencyContent();
  } else {
    panel.classList.add("hidden");
    btn.classList.remove("active");
  }
}

function renderEmergencyContent() {
  if (!state.emergencyMode) return;
  setHtml("emergencyContent", renderEmergencyPanel(state.beds, state.waitingQueue));
}

/* ─── Auto-suggestion banner ─── */

function renderSuggestionBanner() {
  const banner = document.getElementById("suggestionBanner");
  if (!banner) return;

  const availableBeds = Object.values(state.beds).filter(b => b.status === "available");
  const nextPatient = getNextQueueSuggestion(state.waitingQueue);

  if (availableBeds.length > 0 && nextPatient) {
    state.suggestion = nextPatient;
    const priorityLabel = { emergency: "🔴 Emergency", urgent: "🟡 Urgent", normal: "🟢 Normal" };
    banner.classList.remove("hidden");
    banner.innerHTML = `
      <div class="suggestion-inner">
        <span class="suggestion-pulse"></span>
        <div>
          <strong>💡 Bed Available — Auto-Suggestion</strong>
          <p>
            ${escapeHtml(availableBeds[0].id)} (${escapeHtml(availableBeds[0].ward)}) is ready.
            Next patient in queue: <strong>${escapeHtml(nextPatient.name)}</strong>
            · ${priorityLabel[nextPatient.priority] || "🟢 Normal"}
            · Waiting ${Math.round((Date.now() - (nextPatient.waitingSince || Date.now())) / 60000)} min
          </p>
        </div>
        <button class="btn btn-primary btn-sm" id="admitSuggestedBtn" type="button">Admit Now</button>
        <button class="btn btn-ghost btn-sm" id="dismissSuggestionBtn" type="button">Dismiss</button>
      </div>
    `;
    document.getElementById("admitSuggestedBtn")?.addEventListener("click", () => {
      openEditor(availableBeds[0].id);
      // Pre-fill patient name
      setTimeout(() => {
        const el = document.getElementById("managerPatientName");
        if (el && state.suggestion) el.value = state.suggestion.name;
        const docEl = document.getElementById("managerDoctorId");
        if (docEl && state.suggestion?.doctorId) docEl.value = state.suggestion.doctorId;
      }, 50);
    });
    document.getElementById("dismissSuggestionBtn")?.addEventListener("click", () => {
      banner.classList.add("hidden");
    });
  } else {
    banner.classList.add("hidden");
  }
}

/* ─── Rendering ─── */

function renderStats() {
  const stats = computeStats(state.beds, { ward: state.ward });
  setText("managerReadyBeds",    stats.available);
  setText("managerCleaningBeds", stats.cleaning);
  setText("managerReservedBeds", stats.reserved);
  setText("managerOccupiedBeds", stats.occupied);
  setText("managerTotalBeds",    stats.total);
  setText("managerWaiting",      state.waitingQueue.length);
}

function renderQueues() {
  const beds = getSortedBeds(state.beds, { ward: state.ward });
  const cleaning  = beds.filter((b) => b.status === "cleaning");
  const reserved  = beds.filter((b) => b.status === "reserved");
  const available = beds.filter((b) => b.status === "available");

  const renderQueue = (items, buttonLabel, targetId) => {
    const node = document.getElementById(targetId);
    if (!items.length) {
      node.innerHTML = '<div class="empty-state">No beds in this queue right now.</div>';
      return;
    }
    node.innerHTML = `
      <div class="queue-list">
        ${items.slice(0, 6).map((bed) => {
          const doctorInfo = bed.reservedDoctorId
            ? `<span class="doctor-id-chip">🩺 ${escapeHtml(bed.reservedDoctorId)} — ${escapeHtml(getDoctorName(bed.reservedDoctorId))}</span>`
            : "";
          return `
          <article class="queue-item">
            <div class="list-meta">
              <strong>${escapeHtml(bed.id)}</strong>
              <span>${escapeHtml(bed.ward)}</span>
              ${doctorInfo}
              <span>${escapeHtml(bed.notes || "No note added.")}</span>
            </div>
            <button class="btn btn-secondary btn-sm" type="button" data-bed-id="${escapeHtml(bed.id)}">
              ${buttonLabel}
            </button>
          </article>
        `}).join("")}
      </div>
    `;
    node.querySelectorAll("button[data-bed-id]").forEach((btn) => {
      btn.addEventListener("click", () => openEditor(btn.dataset.bedId));
    });
  };

  renderQueue(cleaning,  "Mark Available", "managerCleaningQueue");
  renderQueue(reserved,  "Review Booking", "managerReservedQueue");
  renderQueue(available, "Assign Patient", "managerReadyQueue");
}

function renderBeds() {
  const grid = document.getElementById("managerBedGrid");
  const beds = getSortedBeds(state.beds, { ward: state.ward, search: state.search });
  grid.innerHTML = "";
  if (!beds.length) {
    grid.innerHTML = '<div class="empty-state">No beds match the current filter.</div>';
    return;
  }
  beds.forEach((bed) => {
    const node = buildBedCard(bed, true);
    node.addEventListener("click", () => openEditor(bed.id));
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openEditor(bed.id);
      }
    });
    grid.appendChild(node);
  });
}

function renderAlerts(db) {
  const allAlerts = computeAlerts(state.beds, state.waitingQueue, state.managerAlerts)
    .filter((alert) => alert.sourceType !== "medicine");
  setHtml("managerAlerts", renderAlertStrips(allAlerts.slice(0, 10), true));
  // Wire resolve buttons
  document.querySelectorAll(".resolve-alert").forEach(btn => {
    btn.addEventListener("click", async () => {
      try {
        await resolveAlert(db, btn.dataset.id);
        showToast("Alert resolved.", "ok");
      } catch(e) { showToast(e.message, "err"); }
    });
  });
}

/* ─── Medicine Prescriptions (from doctors) ─── */

function renderMedicinePrescriptions(db) {
  const container = document.getElementById("managerMedicinePrescriptions");
  if (!container) return;
  // Only pending (unresolved) medicine alerts
  const medicines = state.managerAlerts.filter(a => a.type === "medicine");
  if (!medicines.length) {
    container.innerHTML = `<div class="empty-state">No pending medicine prescriptions from doctors.</div>`;
    return;
  }
  container.innerHTML = `
    <div class="alert-list">
      ${medicines.map(a => `
        <article class="alert-item medicine-alert-item" data-id="${escapeHtml(a.id)}">
          <div class="item-head">
            <h4 class="item-title">${escapeHtml(a.title)}</h4>
            <div class="alert-badges">
              <span class="escalation-flag">MEDICINE</span>
              <span class="status-chip info">Pending</span>
              <button class="btn btn-primary btn-sm provide-medicine-btn" data-id="${escapeHtml(a.id)}" type="button">
                ✓ Mark Provided
              </button>
            </div>
          </div>
          <p class="item-copy">${escapeHtml(a.medicine || a.copy)}${a.schedule ? ` · ${escapeHtml(a.schedule)}` : ""}</p>
          <div class="item-time">
            Patient: <strong>${escapeHtml(a.patientName || "—")}</strong>
            ${a.bedId ? ` · Bed: <strong>${escapeHtml(a.bedId)}</strong>` : ""}
            ${a.doctorId ? ` · Dr: <strong>${escapeHtml(getDoctorName(a.doctorId))}</strong>` : ""}
            · <span>${escapeHtml(relativeTime(a.createdAt))}</span>
          </div>
        </article>
      `).join("")}
    </div>
  `;
  // Wire provide buttons
  container.querySelectorAll(".provide-medicine-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Providing…";
      try {
        await markMedicineProvided(db, btn.dataset.id, state.user);
        showToast("Medicine marked as provided. Doctor notified.", "ok");
      } catch (e) {
        showToast(e.message, "err");
        btn.disabled = false;
        btn.textContent = "✓ Mark Provided";
      }
    });
  });
}

function renderActivity() {
  setHtml("managerActivity", renderActivityItems(state.activity));
}


function renderWaiting() {
  setHtml("managerWaitingQueue", renderWaitingQueue(state.waitingQueue, true));
  document.querySelectorAll(".remove-waiting").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await removeFromWaitingQueue(undefined, btn.dataset.id);
        showToast("Patient removed from queue.", "ok");
      } catch (e) { showToast(e.message, "err"); }
    });
  });
}

function renderPredictions() {
  setHtml("managerPredictions", renderPredictionSummary(state.beds));
}

function render(db) {
  populateWardFilter("managerWardFilter", getWardNames(state.beds));
  renderStats();
  renderQueues();
  renderBeds();
  renderPredictions();
  renderSuggestionBanner();
  renderEmergencyContent();
  renderAlerts(db);
  renderMedicinePrescriptions(db);
}


/* ─── Bed Editor ─── */

function openEditor(bedId) {
  const bed = state.beds[bedId];
  if (!bed) return;
  state.activeBedId = bedId;
  setText("managerDrawerTitle", `Update ${bed.id}`);
  setText("managerDrawerCopy", `${bed.ward} · Last updated ${formatDateTime(bed.updatedAt)}`);
  document.getElementById("managerStatus").innerHTML = statusOptionsForManager(bed.status);
  document.getElementById("managerConditionCategory").innerHTML = conditionCategoryOptions(bed.conditionCategory || "");
  document.getElementById("managerPatientName").value = bed.patientName || "";
  document.getElementById("managerDoctorId").innerHTML = doctorIdOptions(bed.assignedDoctor || bed.reservedDoctorId || "");
  document.getElementById("managerReservedFor").value = bed.reservedFor || "";
  document.getElementById("managerNotes").value = bed.notes || "";
  document.getElementById("managerDrawerOverlay").classList.add("open");
}

function closeEditor() {
  state.activeBedId = null;
  document.getElementById("managerDrawerOverlay").classList.remove("open");
}

function wireDrawer() {
  const overlay = document.getElementById("managerDrawerOverlay");
  document.getElementById("managerDrawerClose").addEventListener("click", closeEditor);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeEditor(); });
}

function wireForm(db) {
  const form = document.getElementById("managerBedForm");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.activeBedId) return;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Saving';

    try {
      const fd = new FormData(form);
      const newStatus = String(fd.get("status") || "available");
      const doctorId  = String(fd.get("doctorId") || "").trim();
      const patientName = String(fd.get("patientName") || "").trim();
      const reservedFor = String(fd.get("reservedFor") || "").trim();

      if (newStatus === "occupied" && (!patientName || !doctorId)) {
        throw new Error("Occupied beds need both patient name and doctor.");
      }

      if (newStatus === "reserved" && (!(reservedFor || patientName) || !doctorId)) {
        throw new Error("Reserved beds need an incoming patient name and doctor.");
      }

      await updateBedRecord(
        db,
        state.activeBedId,
        {
          status: newStatus,
          patientName,
          doctorId,
          reservedFor,
          notes: String(fd.get("notes") || "").trim(),
          conditionCategory: String(fd.get("conditionCategory") || ""),
        },
        state.user,
      );
      closeEditor();
      showToast("Bed updated for the whole team.", "ok");
    } catch (error) {
      console.error(error);
      showToast(error.message || "Could not save the bed.", "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Save update";
    }
  });
}

/* ─── Bed Reservation ─── */

function wireReservation(db) {
  const overlay = document.getElementById("reservationOverlay");
  const openBtn  = document.getElementById("openReservationBtn");
  const closeBtn = document.getElementById("reservationClose");
  const form     = document.getElementById("reservationForm");

  openBtn.addEventListener("click", () => {
    // Populate bed select with available beds
    const availBeds = Object.values(state.beds).filter(b => b.status === "available");
    const bedSelect = document.getElementById("reserveBedId");
    if (!availBeds.length) {
      showToast("No available beds to reserve.", "err");
      return;
    }
    bedSelect.innerHTML = availBeds.map(b =>
      `<option value="${escapeHtml(b.id)}">${escapeHtml(b.id)} — ${escapeHtml(b.ward)}</option>`
    ).join("");
    document.getElementById("reserveDoctorId").innerHTML = doctorIdOptions();
    overlay.classList.add("open");
  });
  closeBtn.addEventListener("click", () => overlay.classList.remove("open"));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.classList.remove("open"); });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const bedId     = String(fd.get("bedId") || "").trim();
    const patName   = String(fd.get("patientName") || "").trim();
    const doctorId  = String(fd.get("doctorId") || "").trim();
    const resTime   = String(fd.get("reservationTime") || "");

    if (!bedId || !patName || !doctorId) {
      showToast("All fields are required.", "err");
      return;
    }

    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Reserving';
    try {
      await reserveBed(db, bedId, {
        patientName: patName,
        doctorId,
        reservationTime: resTime ? new Date(resTime).getTime() : Date.now(),
      }, state.user);
      form.reset();
      overlay.classList.remove("open");
      showToast(`Bed ${bedId} reserved for ${patName}.`, "ok");
    } catch(err) {
      showToast(err.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Reserve Bed";
    }
  });
}

/* ─── Patient Transfer ─── */

function wireTransfer(db) {
  const overlay  = document.getElementById("transferOverlay");
  const openBtn  = document.getElementById("openTransferBtn");
  const closeBtn = document.getElementById("transferClose");
  const form     = document.getElementById("transferForm");

  openBtn.addEventListener("click", () => {
    const occupiedBeds  = Object.values(state.beds).filter(b => b.status === "occupied");
    const receiverBeds  = Object.values(state.beds).filter(b => b.status === "available" || b.status === "reserved");

    if (!occupiedBeds.length) { showToast("No occupied beds to transfer from.", "err"); return; }
    if (!receiverBeds.length) { showToast("No available/reserved beds to transfer to.", "err"); return; }

    document.getElementById("transferFromBed").innerHTML = occupiedBeds.map(b =>
      `<option value="${escapeHtml(b.id)}">${escapeHtml(b.id)} — ${escapeHtml(b.ward)} (${escapeHtml(b.patientName || "Patient")})</option>`
    ).join("");
    document.getElementById("transferToBed").innerHTML = receiverBeds.map(b =>
      `<option value="${escapeHtml(b.id)}">${escapeHtml(b.id)} — ${escapeHtml(b.ward)} (${escapeHtml(b.status)})</option>`
    ).join("");
    overlay.classList.add("open");
  });
  closeBtn.addEventListener("click", () => overlay.classList.remove("open"));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.classList.remove("open"); });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const fromId = String(fd.get("fromBed") || "").trim();
    const toId   = String(fd.get("toBed") || "").trim();
    const type   = String(fd.get("transferType") || "Ward Transfer");

    if (!fromId || !toId || fromId === toId) {
      showToast("Select different source and target beds.", "err");
      return;
    }

    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Transferring';
    try {
      await transferPatient(db, fromId, toId, type, state.user);
      form.reset();
      overlay.classList.remove("open");
      showToast(`Patient transferred ${fromId} → ${toId}.`, "ok");
    } catch(err) {
      showToast(err.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Transfer Patient";
    }
  });
}

/* ─── Add to Queue ─── */

function wireAddWaiting(db) {
  const overlay  = document.getElementById("addWaitingOverlay");
  const openBtn  = document.getElementById("managerAddWaiting");
  const closeBtn = document.getElementById("addWaitingClose");
  const form     = document.getElementById("addWaitingForm");

  openBtn.addEventListener("click", () => {
    document.getElementById("waitingDoctorId").innerHTML = doctorIdOptions();
    overlay.classList.add("open");
  });
  closeBtn.addEventListener("click", () => overlay.classList.remove("open"));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.classList.remove("open"); });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd   = new FormData(form);
    const name = String(fd.get("name") || "").trim();
    if (!name) { showToast("Patient name is required.", "err"); return; }

    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      await addToWaitingQueue(db, {
        name,
        condition: String(fd.get("condition") || "general"),
        priority: String(fd.get("priority") || "normal"),
        notes: String(fd.get("notes") || "").trim(),
        doctorId: String(fd.get("doctorId") || ""),
      });
      form.reset();
      overlay.classList.remove("open");
      showToast("Patient added to waiting queue.", "ok");
    } catch (err) {
      showToast(err.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Add to queue";
    }
  });
}

/* ─── Add Alert ─── */

function wireAddAlert(db) {
  const overlay  = document.getElementById("addAlertOverlay");
  const closeBtn = document.getElementById("addAlertClose");
  const form     = document.getElementById("addAlertForm");

  document.querySelectorAll('[data-open-alert-drawer="true"]').forEach((button) => {
    button.addEventListener("click", () => {
      document.getElementById("alertDoctorId").innerHTML = doctorIdOptions();
      overlay.classList.add("open");
    });
  });
  closeBtn.addEventListener("click", () => overlay.classList.remove("open"));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.classList.remove("open"); });



  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd   = new FormData(form);
    const patientName = String(fd.get("alertPatient") || "").trim();
    const doctorId    = String(fd.get("alertDoctorId") || "");
    const bedId       = String(fd.get("alertBedId") || "").trim();

    if (!patientName) { showToast("Patient name required.", "err"); return; }

    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      await addUrgentAlert(db, {
        patientName,
        description: String(fd.get("alertDescription") || "").trim(),
        doctorId,
        bedId,
      }, state.user);

      form.reset();
      overlay.classList.remove("open");
      showToast("Urgent alert added successfully.", "ok");
    } catch(err) {
      showToast(err.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Add Alert";
    }
  });
}

/* ─── Filters ─── */

function wireFilters() {
  document.getElementById("managerWardFilter").addEventListener("change", (e) => {
    state.ward = e.target.value;
    render();
  });

  let searchTimeout;
  document.getElementById("managerSearch").addEventListener("input", (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.search = e.target.value;
      renderBeds();
    }, 150);
  });
}

function wireEmergency() {
  document.getElementById("emergencyBtn")?.addEventListener("click", toggleEmergency);
  document.getElementById("emergencyClose")?.addEventListener("click", toggleEmergency);
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
  setText("managerGreeting", `${state.user.name}'s Operations Board`);
  setText("managerSubtitle",
    `${now.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} at ${now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`
  );
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

  wireDrawer();
  wireFilters();
  wireEmergency();
  wireForm(db);
  wireReservation(db);
  wireTransfer(db);
  wireAddWaiting(db);
  wireAddAlert(db);
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
        render(db);
      });

      listenActivity(db, (activity) => {
        state.activity = activity;
        renderActivity();
      });

      listenWaitingQueue(db, (queue) => {
        state.waitingQueue = queue;
        renderWaiting();
        renderSuggestionBanner();
        renderAlerts(db);
        renderStats();
      });

      listenAlerts(db, (alerts) => {
        state.managerAlerts = alerts;
        renderAlerts(db);
        renderMedicinePrescriptions(db);
      });


      window.setInterval(updateTimers, 1000);
      window.setInterval(() => {
        renderPredictions();
        renderEmergencyContent();
        renderAlerts(db);
        refreshHeader();
      }, 30000);
    },
    { allowRoles: ["manager"] },
  );
}

document.addEventListener("DOMContentLoaded", initPage);
