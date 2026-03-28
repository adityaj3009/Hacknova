import {
  addToWaitingQueue,
  buildBedCard,
  buildTopbar,
  computeAlerts,
  computeStats,
  formatDateTime,
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
  renderFatalState,
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
};

/* ─── Rendering ─── */

function renderStats() {
  const stats = computeStats(state.beds, { ward: state.ward });
  setText("staffReadyBeds", stats.available);
  setText("staffCleaningBeds", stats.cleaning);
  setText("staffReservedBeds", stats.reserved);
  setText("staffOccupiedBeds", stats.occupied);
}

function renderQueues() {
  const beds = getSortedBeds(state.beds, { ward: state.ward });
  const cleaning = beds.filter((b) => b.status === "cleaning");
  const reserved = beds.filter((b) => b.status === "reserved");
  const available = beds.filter((b) => b.status === "available");

  const renderQueue = (items, buttonLabel, targetId) => {
    const node = document.getElementById(targetId);
    if (!items.length) {
      node.innerHTML = '<div class="empty-state">No beds in this queue right now.</div>';
      return;
    }
    node.innerHTML = `
      <div class="queue-list">
        ${items.slice(0, 6).map((bed) => `
          <article class="queue-item">
            <div class="list-meta">
              <strong>${bed.id}</strong>
              <span>${bed.ward}</span>
              <span>${bed.notes || "No note added."}</span>
            </div>
            <button class="btn btn-secondary btn-sm" type="button" data-bed-id="${bed.id}">
              ${buttonLabel}
            </button>
          </article>
        `).join("")}
      </div>
    `;
    node.querySelectorAll("button[data-bed-id]").forEach((btn) => {
      btn.addEventListener("click", () => openEditor(btn.dataset.bedId));
    });
  };

  renderQueue(cleaning, "Update progress", "staffCleaningQueue");
  renderQueue(reserved, "Review booking", "staffReservedQueue");
  renderQueue(available, "Mark occupied", "staffReadyQueue");
}

function renderBeds() {
  const grid = document.getElementById("staffBedGrid");
  const beds = getSortedBeds(state.beds, { ward: state.ward, search: state.search });
  grid.innerHTML = "";

  if (!beds.length) {
    grid.innerHTML = '<div class="empty-state">No beds match the current filter.</div>';
    return;
  }

  beds.forEach((bed) => {
    const node = buildBedCard(bed, true);
    node.addEventListener("click", () => openEditor(bed.id));
    grid.appendChild(node);
  });
}

function renderAlerts() {
  setHtml("staffAlerts", renderAlertStrips(computeAlerts(state.beds, state.waitingQueue).slice(0, 6)));
}

function renderActivity() {
  setHtml("staffActivity", renderActivityItems(state.activity));
}

function renderWaiting() {
  setHtml("staffWaitingQueue", renderWaitingQueue(state.waitingQueue));
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

function render() {
  populateWardFilter("staffWardFilter", getWardNames(state.beds));
  renderStats();
  renderQueues();
  renderBeds();
  renderAlerts();
}

/* ─── Editor ─── */

function openEditor(bedId) {
  const bed = state.beds[bedId];
  if (!bed) return;
  state.activeBedId = bedId;
  setText("staffDrawerTitle", `Update ${bed.id}`);
  setText("staffDrawerCopy", `${bed.ward} bed last updated ${formatDateTime(bed.updatedAt)}.`);
  document.getElementById("staffStatus").innerHTML = statusOptions(bed.status);
  document.getElementById("staffPatientName").value = bed.patientName || "";
  document.getElementById("staffAssignedDoctor").value = bed.assignedDoctor || "";
  document.getElementById("staffReservedFor").value = bed.reservedFor || "";
  document.getElementById("staffNotes").value = bed.notes || "";
  document.getElementById("staffDrawerOverlay").classList.add("open");
}

function closeEditor() {
  state.activeBedId = null;
  document.getElementById("staffDrawerOverlay").classList.remove("open");
}

/* ─── Wiring ─── */

function wireDrawer() {
  const overlay = document.getElementById("staffDrawerOverlay");
  document.getElementById("staffDrawerClose").addEventListener("click", closeEditor);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeEditor(); });
}

function wireAddWaiting(db) {
  const overlay = document.getElementById("addWaitingOverlay");
  const closeBtn = document.getElementById("addWaitingClose");
  const addBtn = document.getElementById("staffAddWaiting");

  addBtn.addEventListener("click", () => overlay.classList.add("open"));
  closeBtn.addEventListener("click", () => overlay.classList.remove("open"));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.classList.remove("open"); });

  const form = document.getElementById("addWaitingForm");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const name = String(fd.get("name") || "").trim();
    if (!name) { showToast("Patient name is required.", "err"); return; }

    try {
      await addToWaitingQueue(db, {
        name,
        condition: String(fd.get("condition") || "general"),
        notes: String(fd.get("notes") || "").trim(),
      });
      form.reset();
      overlay.classList.remove("open");
      showToast("Patient added to waiting queue.", "ok");
    } catch (err) {
      showToast(err.message, "err");
    }
  });
}

function wireFilters() {
  document.getElementById("staffWardFilter").addEventListener("change", (e) => {
    state.ward = e.target.value;
    render();
  });

  let searchTimeout;
  document.getElementById("staffSearch").addEventListener("input", (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.search = e.target.value;
      renderBeds();
    }, 150);
  });
}

function wireForm(db) {
  const form = document.getElementById("staffBedForm");
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
        },
        state.user,
      );
      closeEditor();
      showToast("Queue updated for the whole team.", "ok");
    } catch (error) {
      console.error(error);
      showToast(error.message || "Could not save the bed.", "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Save update";
    }
  });
}

function refreshHeader() {
  const now = new Date();
  setText("staffGreeting", `${state.user.name}'s Operations Board`);
  setText(
    "staffSubtitle",
    `${now.toLocaleDateString("en-IN", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
    })} at ${now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`,
  );
}

/* Timer updates */
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
  wireForm(db);
  wireAddWaiting(db);
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
        renderAlerts();
      });

      window.setInterval(updateTimers, 1000);
      window.setInterval(refreshHeader, 30000);
    },
    { allowRoles: ["staff"] },
  );
}

document.addEventListener("DOMContentLoaded", initPage);
