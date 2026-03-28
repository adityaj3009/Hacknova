import {
  buildBedCard,
  buildTopbar,
  computeAlerts,
  computeStats,
  conditionCategoryOptions,
  formatDateTime,
  getEmergencyRanking,
  getSortedBeds,
  getWardNames,
  initFirebase,
  listenActivity,
  listenBeds,
  listenWaitingQueue,
  logout,
  populateWardFilter,
  removeFromWaitingQueue,
  renderActivityItems,
  renderAlertStrips,
  renderEmergencyPanel,
  renderFatalState,
  renderPredictionSummary,
  renderWaitingQueue,
  requireAuth,
  seedBedsIfNeeded,
  setHtml,
  setText,
  showToast,
  statusOptions,
  updateBedRecord,
} from "./firebase-utils.js";

const state = {
  user: null,
  beds: {},
  activity: [],
  waitingQueue: [],
  ward: "all",
  search: "",
  activeBedId: null,
  emergencyMode: false,
};

let timerInterval = null;

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
  setHtml("emergencyContent", renderEmergencyPanel(state.beds));
}

/* ─── Modal ─── */

function wireModal() {
  const overlay = document.getElementById("doctorDrawerOverlay");
  const closeButton = document.getElementById("doctorDrawerClose");
  closeButton.addEventListener("click", closeEditor);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeEditor();
  });
}

function openEditor(bedId) {
  const bed = state.beds[bedId];
  if (!bed) return;

  state.activeBedId = bedId;
  setText("doctorDrawerTitle", `Update ${bed.id}`);
  setText("doctorDrawerCopy", `${bed.ward} bed last updated ${formatDateTime(bed.updatedAt)}.`);
  document.getElementById("doctorStatus").innerHTML = statusOptions(bed.status);
  document.getElementById("doctorConditionCategory").innerHTML = conditionCategoryOptions(bed.conditionCategory || "");
  document.getElementById("doctorPatientName").value = bed.patientName || "";
  document.getElementById("doctorAssignedDoctor").value = bed.assignedDoctor || state.user.name || "";
  document.getElementById("doctorReservedFor").value = bed.reservedFor || "";
  document.getElementById("doctorNotes").value = bed.notes || "";
  document.getElementById("doctorDrawerOverlay").classList.add("open");
}

function closeEditor() {
  state.activeBedId = null;
  document.getElementById("doctorDrawerOverlay").classList.remove("open");
}

/* ─── Rendering ─── */

function renderStats() {
  const stats = computeStats(state.beds, { ward: state.ward });
  setText("doctorTotalBeds", stats.total);
  setText("doctorOccupiedBeds", stats.occupied);
  setText("doctorAvailableBeds", stats.available);
  setText("doctorCleaningBeds", stats.cleaning);
  setText("doctorOccupancy", `${stats.occupancy}%`);
}

function renderBeds() {
  const grid = document.getElementById("doctorBedGrid");
  const beds = getSortedBeds(state.beds, { ward: state.ward, search: state.search });
  grid.innerHTML = "";

  if (!beds.length) {
    grid.innerHTML = '<div class="empty-state">No beds match the current filter.</div>';
    return;
  }

  beds.forEach((bed) => {
    const node = buildBedCard(bed, true);
    node.addEventListener("click", () => openEditor(bed.id));
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openEditor(bed.id);
      }
    });
    grid.appendChild(node);
  });
}

function renderAlerts() {
  const alerts = computeAlerts(state.beds, state.waitingQueue);
  setHtml("doctorAlerts", renderAlertStrips(alerts.slice(0, 8)));
}

function renderActivity() {
  setHtml("doctorActivity", renderActivityItems(state.activity));
}

function renderPredictions() {
  setHtml("doctorPredictions", renderPredictionSummary(state.beds));
}

function renderWaiting() {
  setHtml("doctorWaitingQueue", renderWaitingQueue(state.waitingQueue));
  /* Wire remove buttons */
  document.querySelectorAll(".remove-waiting").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await removeFromWaitingQueue(undefined, btn.dataset.id);
        showToast("Patient removed from queue.", "ok");
      } catch (e) {
        showToast(e.message, "err");
      }
    });
  });
}

/* Live timer updates (1-second interval) */
function updateTimers() {
  const now = Date.now();
  document.querySelectorAll(".waiting-timer[data-since]").forEach((el) => {
    const since = parseInt(el.dataset.since, 10);
    if (!since) return;
    const waitMin = Math.round((now - since) / 60000);
    el.textContent = `${waitMin} min`;
    if (waitMin >= 30) {
      el.classList.add("alert");
    }
  });
}

function refreshHeader() {
  const now = new Date();
  setText("doctorGreeting", `Welcome, ${state.user.name}`);
  setText(
    "doctorSubtitle",
    `${now.toLocaleDateString("en-IN", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
    })} at ${now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`,
  );
}

function render() {
  populateWardFilter("doctorWardFilter", getWardNames(state.beds));
  renderStats();
  renderBeds();
  renderAlerts();
  renderPredictions();
  renderEmergencyContent();
}

/* ─── Wiring ─── */

function wireFilters() {
  document.getElementById("doctorWardFilter").addEventListener("change", (e) => {
    state.ward = e.target.value;
    render();
  });

  let searchTimeout;
  document.getElementById("doctorSearch").addEventListener("input", (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.search = e.target.value;
      renderBeds();
    }, 150);
  });
}

function wireEmergency() {
  document.getElementById("emergencyBtn").addEventListener("click", toggleEmergency);
  document.getElementById("emergencyClose").addEventListener("click", toggleEmergency);
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
      await updateBedRecord(
        db,
        state.activeBedId,
        {
          status: String(fd.get("status") || "available"),
          patientName: String(fd.get("patientName") || "").trim(),
          assignedDoctor: String(fd.get("assignedDoctor") || "").trim(),
          reservedFor: String(fd.get("reservedFor") || "").trim(),
          notes: String(fd.get("notes") || "").trim(),
          conditionCategory: String(fd.get("conditionCategory") || ""),
        },
        state.user,
      );
      closeEditor();
      showToast("Bed updated in real-time.", "ok");
    } catch (error) {
      console.error(error);
      showToast(error.message || "Could not save the bed.", "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Save update";
    }
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
  wireEmergency();
  wireForm(db);
  document.getElementById("logoutButton").addEventListener("click", logout);

  requireAuth(
    async (session) => {
      state.user = session;
      /* Replace history so back-button can't reach login */
      window.history.replaceState(null, "", window.location.href);
      /* Block trackpad swipe-back gesture */
      window.history.pushState(null, "", window.location.href);
      window.addEventListener("popstate", () => {
        window.history.pushState(null, "", window.location.href);
      });
      buildTopbar(session.name, session.role);
      refreshHeader();
      await seedBedsIfNeeded(db);

      listenBeds(db, (beds) => {
        state.beds = beds;
        render();
      });

      listenActivity(db, (activity) => {
        state.activity = activity;
        renderActivity();
      });

      listenWaitingQueue(db, (queue) => {
        state.waitingQueue = queue;
        renderWaiting();
        renderAlerts(); /* Re-compute alerts with waiting data */
      });

      /* Live timer + predictions refresh every second */
      timerInterval = window.setInterval(() => {
        updateTimers();
      }, 1000);

      /* Refresh predictions and emergency every 30s */
      window.setInterval(() => {
        renderPredictions();
        renderEmergencyContent();
        renderAlerts();
        refreshHeader();
      }, 30000);
    },
    { allowRoles: ["doctor"] },
  );
}

document.addEventListener("DOMContentLoaded", initPage);
