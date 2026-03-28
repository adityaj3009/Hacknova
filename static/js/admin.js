import {
  buildBedCard,
  buildTopbar,
  computeAlerts,
  computeStats,
  computeWardStats,
  getSortedBeds,
  initFirebase,
  listenActivity,
  listenBeds,
  listenWaitingQueue,
  logout,
  renderActivityItems,
  renderAlertStrips,
  renderFatalState,
  renderPredictionSummary,
  renderWaitingQueue,
  requireAuth,
  seedBedsIfNeeded,
  setHtml,
  setText,
} from "./firebase-utils.js";

const state = {
  user: null,
  beds: {},
  activity: [],
  waitingQueue: [],
};

function renderSummary() {
  const stats = computeStats(state.beds);
  const alerts = computeAlerts(state.beds, state.waitingQueue);

  setText("adminTotalBeds", stats.total);
  setText("adminOccupiedBeds", stats.occupied);
  setText("adminAvailableBeds", stats.available);
  setText("adminOccupancy", `${stats.occupancy}%`);
  setText("adminAlertCount", alerts.length);

  setHtml("adminAlerts", renderAlertStrips(alerts));
}

function renderWardList() {
  const wards = computeWardStats(state.beds);
  const node = document.getElementById("adminWardList");

  if (!wards.length) {
    node.innerHTML = '<div class="empty-state">No ward data available yet.</div>';
    return;
  }

  node.innerHTML = `
    <div class="ward-list">
      ${wards.map((ward) => `
        <article class="ward-item">
          <div class="item-head">
            <h4 class="item-title">${ward.ward}</h4>
            <span class="status-chip ${ward.occupancy >= 90 ? "critical" : ward.occupancy >= 80 ? "warning" : ward.occupancy >= 70 ? "cleaning" : "available"}">
              ${ward.occupancy}% occupied
            </span>
          </div>
          <div class="ward-stats">
            <div class="mini-stat"><strong>${ward.total}</strong><span>Total beds</span></div>
            <div class="mini-stat"><strong>${ward.occupied}</strong><span>Occupied</span></div>
            <div class="mini-stat"><strong>${ward.available}</strong><span>Available</span></div>
            <div class="mini-stat"><strong>${ward.cleaning}</strong><span>Cleaning</span></div>
          </div>
          <div class="meter"><span style="width: ${ward.occupancy}%"></span></div>
        </article>
      `).join("")}
    </div>
  `;
}

function renderBeds() {
  const node = document.getElementById("adminBedGrid");
  const beds = getSortedBeds(state.beds);
  node.innerHTML = "";

  if (!beds.length) {
    node.innerHTML = '<div class="empty-state">No beds available for the live board yet.</div>';
    return;
  }

  beds.forEach((bed) => {
    node.appendChild(buildBedCard(bed, false));
  });
}

function renderPredictions() {
  setHtml("adminPredictions", renderPredictionSummary(state.beds));
}

function renderActivity() {
  setHtml("adminActivity", renderActivityItems(state.activity));
}

function renderWaiting() {
  setHtml("adminWaitingQueue", renderWaitingQueue(state.waitingQueue));
  /* Remove the delete buttons for admin (read-only) */
  document.querySelectorAll("#adminWaitingQueue .remove-waiting").forEach((btn) => {
    btn.style.display = "none";
  });
}

function refreshHeader() {
  const now = new Date();
  setText("adminGreeting", `Command center for ${state.user.name}`);
  setText(
    "adminSubtitle",
    `${now.toLocaleDateString("en-IN", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
    })} at ${now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`,
  );
}

function render() {
  renderSummary();
  renderWardList();
  renderBeds();
  renderPredictions();
}

/* Timer updates for waiting queue */
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

async function initPage() {
  let db;
  try {
    ({ db } = initFirebase(window.WARDWATCH_CONFIG || {}));
  } catch (error) {
    renderFatalState("Firebase is not configured", error.message);
    return;
  }

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
        renderSummary(); /* Refresh alerts with waiting data */
      });

      window.setInterval(updateTimers, 1000);
      window.setInterval(refreshHeader, 30000);
    },
    { allowRoles: ["admin"] },
  );
}

document.addEventListener("DOMContentLoaded", initPage);
